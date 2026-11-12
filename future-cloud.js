/* Future — collegamento ai dati su Supabase.
   Offre all'app la stessa interfaccia che aveva dentro claude.ai
   (collection().doc().set(), onSnapshot, ...), così il resto dell'app non cambia.
   Tabella usata: public.future_docs (coll, id, data jsonb). */
(function () {
  'use strict';
  const CFG = window.FUTURE_CONFIG || {};
  const CACHE_KEY = 'future_cache_v1';
  const TABLE = 'future_docs';
  const clone = o => (o == null ? o : JSON.parse(JSON.stringify(o)));
  const ok = () => !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY && window.supabase && window.supabase.createClient);

  let sb = null, session = null;
  const cache = {};          // coll -> { id: data }
  const loaded = {};         // coll -> true quando arrivato dal server
  const collL = {};          // coll -> Set(cb)
  const docL = {};           // 'coll/id' -> Set(cb)
  const errL = {};           // coll -> Set(errCb)
  let channel = null;

  /* ---------- cache locale (per aprire l'app anche senza rete, in sola lettura) ---------- */
  function readCache() { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') || {}; } catch (e) { return {}; } }
  let saveT = 0;
  function writeCache() {
    clearTimeout(saveT);
    saveT = setTimeout(() => { try { localStorage.setItem(CACHE_KEY, JSON.stringify({uid: session && session.user.id, c: cache})); } catch (e) {} }, 300);
  }

  /* ---------- notifiche verso l'app ---------- */
  function collSnap(coll, fromCache) {
    const m = cache[coll] || {};
    const docs = Object.keys(m).map(id => ({id, exists: true, data: () => clone(m[id])}));
    return {docs, size: docs.length, empty: !docs.length, metadata: {fromCache: !!fromCache}, forEach: f => docs.forEach(f)};
  }
  function docSnap(coll, id, fromCache) {
    const m = cache[coll] || {}; const has = Object.prototype.hasOwnProperty.call(m, id);
    return {id, exists: has, data: () => (has ? clone(m[id]) : undefined), metadata: {fromCache: !!fromCache}};
  }
  function emit(coll, fromCache) {
    (collL[coll] || new Set()).forEach(cb => { try { cb(collSnap(coll, fromCache)); } catch (e) { console.error(e); } });
    Object.keys(docL).forEach(k => {
      const i = k.indexOf('/'); if (k.slice(0, i) !== coll) return;
      docL[k].forEach(cb => { try { cb(docSnap(coll, k.slice(i + 1), fromCache)); } catch (e) { console.error(e); } });
    });
    if (!fromCache) writeCache();
  }
  function emitErr(coll, code) { (errL[coll] || new Set()).forEach(cb => { try { cb({code}); } catch (e) {} }); }

  /* ---------- lettura dal server ---------- */
  const loading = {};
  async function load(coll) {
    if (loading[coll]) return loading[coll];
    loading[coll] = (async () => {
      const all = {}; let from = 0; const step = 1000;
      for (;;) {
        const {data, error} = await sb.from(TABLE).select('id,data').eq('coll', coll).range(from, from + step - 1);
        if (error) throw error;
        (data || []).forEach(r => { all[r.id] = r.data; });
        if (!data || data.length < step) break;
        from += step;
      }
      cache[coll] = all; loaded[coll] = true; emit(coll, false);
    })().catch(e => { console.warn('Future: lettura non riuscita', coll, e); emitErr(coll, 'unavailable'); })
      .finally(() => { loading[coll] = null; });
    return loading[coll];
  }
  function watched() { const s = new Set(Object.keys(collL)); Object.keys(docL).forEach(k => s.add(k.split('/')[0])); return [...s]; }
  function reloadAll() { watched().forEach(load); }

  function startRealtime() {
    if (channel) return;
    channel = sb.channel('future-docs')
      .on('postgres_changes', {event: '*', schema: 'public', table: TABLE}, p => {
        const row = p.eventType === 'DELETE' ? p.old : p.new;
        if (!row || !row.coll) { reloadAll(); return; }
        cache[row.coll] = cache[row.coll] || {};
        if (p.eventType === 'DELETE') delete cache[row.coll][row.id];
        else cache[row.coll][row.id] = row.data;
        emit(row.coll, false);
      })
      .subscribe(st => { if (st === 'SUBSCRIBED') reloadAll(); });
  }

  /* ---------- scrittura ---------- */
  function errCode(error) {
    const msg = String((error && (error.message || error)) || '');
    if (error && (error.code === '42501' || /row-level security|permission denied/i.test(msg))) return 'invalid_argument';
    if (error && error.code === '54000') return 'quota_exceeded';
    if (/429|too many/i.test(msg)) return 'resource_exhausted';
    return 'unavailable';
  }
  async function write(coll, id, data) {
    const prev = cache[coll] && Object.prototype.hasOwnProperty.call(cache[coll], id) ? cache[coll][id] : undefined;
    cache[coll] = cache[coll] || {};
    if (data === null) delete cache[coll][id]; else cache[coll][id] = clone(data);
    emit(coll, false);
    const q = data === null
      ? sb.from(TABLE).delete().eq('coll', coll).eq('id', id)
      : sb.from(TABLE).upsert({coll, id, data: clone(data), updated_at: new Date().toISOString()}, {onConflict: 'coll,id'});
    const {error} = await q;
    if (error) {
      if (prev === undefined) delete cache[coll][id]; else cache[coll][id] = prev;
      emit(coll, false);
      const e = new Error(error.message || 'errore'); e.code = errCode(error); throw e;
    }
    return true;
  }

  /* ---------- interfaccia uguale a quella di claude.ai ---------- */
  function docRef(coll, id) {
    return {
      id,
      set: d => write(coll, id, d),
      delete: () => write(coll, id, null),
      get: async () => { if (!loaded[coll]) await load(coll); return docSnap(coll, id, false); },
      onSnapshot(cb, onErr) {
        const k = coll + '/' + id; (docL[k] = docL[k] || new Set()).add(cb);
        if (onErr) (errL[coll] = errL[coll] || new Set()).add(onErr);
        if (cache[coll]) cb(docSnap(coll, id, !loaded[coll]));
        if (!loaded[coll]) load(coll);
        return () => { docL[k].delete(cb); if (onErr && errL[coll]) errL[coll].delete(onErr); };
      }
    };
  }
  function collRef(coll) {
    return {
      doc: id => docRef(coll, id),
      get: async () => { if (!loaded[coll]) await load(coll); return collSnap(coll, false); },
      onSnapshot(cb, onErr) {
        (collL[coll] = collL[coll] || new Set()).add(cb);
        if (onErr) (errL[coll] = errL[coll] || new Set()).add(onErr);
        if (cache[coll]) cb(collSnap(coll, !loaded[coll]));
        if (!loaded[coll]) load(coll);
        return () => { collL[coll].delete(cb); if (onErr && errL[coll]) errL[coll].delete(onErr); };
      }
    };
  }
  const db = {
    collection: collRef,
    doc: path => { const i = path.indexOf('/'); return docRef(path.slice(0, i), path.slice(i + 1)); }
  };
  const user = {
    id: async () => (session ? session.user.id : ''),
    can: async () => true,
    isOwner: () => false,           // ogni account la prima volta dice chi è (Ahmed o Miro), poi viene riconosciuto
    me: async () => ({name: person()}),
    profiles: async () => ({})
  };

  /* ---------- schermata di accesso ---------- */
  const CSS = `
#fc-login{position:fixed;inset:0;z-index:99999;background:#030305;color:#f4f4f8;display:flex;align-items:center;justify-content:center;padding:24px;padding-top:max(24px,env(safe-area-inset-top));font-family:Inter,-apple-system,system-ui,sans-serif}
#fc-login .box{width:100%;max-width:360px}
#fc-login .logo{width:72px;height:72px;border-radius:20px;display:block;margin:0 auto 18px}
#fc-login h1{font-size:28px;font-weight:800;text-align:center;margin:0 0 6px;letter-spacing:-.02em}
#fc-login p{font-size:14px;color:#9a9aae;text-align:center;margin:0 0 26px;line-height:1.45}
#fc-login label{display:block;font-size:12px;color:#9a9aae;margin:0 0 6px;font-weight:600}
#fc-login input{width:100%;box-sizing:border-box;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);border-radius:14px;color:#fff;font-size:17px;padding:14px 16px;margin:0 0 16px;outline:none;font-family:inherit}
#fc-login input:focus{border-color:#2EE59D}
#fc-login button{width:100%;border:0;border-radius:14px;padding:15px;font-size:17px;font-weight:700;background:#2EE59D;color:#03130c;font-family:inherit;cursor:pointer}
#fc-login button:disabled{opacity:.6}
#fc-login .err{color:#FF6B8A;font-size:14px;text-align:center;min-height:20px;margin:12px 0 0;line-height:1.4}
#fc-login .cfg{background:rgba(255,94,122,.1);border:1px solid rgba(255,94,122,.35);border-radius:14px;padding:14px;font-size:14px;line-height:1.5;color:#ffd0d8}`;
  function injectCss() { if (document.getElementById('fc-css')) return; const s = document.createElement('style'); s.id = 'fc-css'; s.textContent = CSS; document.head.appendChild(s); }

  function showConfigError(msg) {
    injectCss();
    const d = document.createElement('div'); d.id = 'fc-login';
    d.innerHTML = `<div class="box"><img class="logo" src="icons/icon-192.png" alt=""><h1>Future</h1><div class="cfg">${msg}</div></div>`;
    document.body.appendChild(d);
  }

  function showLogin() {
    return new Promise(resolve => {
      injectCss();
      const d = document.createElement('div'); d.id = 'fc-login';
      d.innerHTML = `<form class="box" autocomplete="on">
        <img class="logo" src="icons/icon-192.png" alt="">
        <h1>Future</h1>
        <p>Entra con la tua email e la tua password.<br>Lo chiede solo la prima volta su questo telefono.</p>
        <label for="fc-e">Email</label><input id="fc-e" type="email" autocomplete="username" inputmode="email" autocapitalize="off" required>
        <label for="fc-p">Password</label><input id="fc-p" type="password" autocomplete="current-password" required>
        <button type="submit">Entra</button>
        <div class="err" id="fc-err"></div></form>`;
      document.body.appendChild(d);
      const f = d.querySelector('form'), btn = d.querySelector('button'), err = d.querySelector('#fc-err');
      f.addEventListener('submit', async ev => {
        ev.preventDefault(); err.textContent = ''; btn.disabled = true; btn.textContent = 'Entro…';
        const email = d.querySelector('#fc-e').value.trim(), password = d.querySelector('#fc-p').value;
        let res;
        try { res = await sb.auth.signInWithPassword({email, password}); } catch (e) { res = {error: e}; }
        btn.disabled = false; btn.textContent = 'Entra';
        if (res.error) {
          const m = String(res.error.message || '');
          err.textContent = /invalid login|invalid credentials/i.test(m) ? 'Email o password sbagliate.'
            : /fetch|network/i.test(m) ? 'Nessuna connessione: riprova quando sei online.'
            : /confirm/i.test(m) ? 'Account non confermato: in Supabase spunta “Auto Confirm User” quando lo crei.'
            : 'Accesso non riuscito: ' + m;
          return;
        }
        session = res.data.session; d.remove(); resolve();
      });
      setTimeout(() => { const e = d.querySelector('#fc-e'); if (e) e.focus(); }, 200);
    });
  }

  /* ---------- avvio ---------- */
  async function connect() {
    if (!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY) || /INCOLLA/.test(CFG.SUPABASE_URL + CFG.SUPABASE_ANON_KEY)) {
      showConfigError('Manca il collegamento a Supabase.<br>Apri il file <b>config.js</b> su GitHub e incolla <b>Project URL</b> e <b>anon key</b> del tuo progetto Supabase (vedi LEGGIMI).');
      return null;
    }
    if (!window.supabase || !window.supabase.createClient) {
      // libreria non scaricata (prima apertura senza rete)
      const c = readCache();
      if (c && c.c) { Object.assign(cache, c.c); return offlineOnly(c.uid); }
      showConfigError('Serve internet per la prima apertura. Collegati e riapri Future.');
      return null;
    }
    sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
      auth: {persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'future-auth'}
    });
    try { const r = await sb.auth.getSession(); session = r.data.session; } catch (e) { session = null; }
    if (!session) await showLogin();

    // dati dell'ultima apertura: l'app si vede subito, poi arrivano quelli aggiornati
    const c = readCache();
    if (c && c.c && c.uid === session.user.id) Object.keys(c.c).forEach(k => { cache[k] = c.c[k]; });

    sb.auth.onAuthStateChange((ev, s) => {
      if (ev === 'SIGNED_OUT') { try { localStorage.removeItem(CACHE_KEY); } catch (e) {} location.reload(); return; }
      if (s) session = s;
    });
    startRealtime();
    let lastReload = Date.now();
    const refresh = () => { if (Date.now() - lastReload < 3000) return; lastReload = Date.now(); reloadAll(); };
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
    window.addEventListener('online', refresh);
    window.addEventListener('pageshow', e => { if (e.persisted) refresh(); });
    return {db, user};
  }
  // senza libreria e senza rete: mostra gli ultimi dati, scritture rifiutate
  function offlineOnly(uid) {
    const ro = Object.assign({}, db);
    const fail = async () => { const e = new Error('offline'); e.code = 'unavailable'; throw e; };
    const wrapDoc = r => Object.assign({}, r, {set: fail, delete: fail});
    ro.collection = c => { const r = collRef(c); return Object.assign({}, r, {doc: id => wrapDoc(r.doc(id))}); };
    ro.doc = p => wrapDoc(db.doc(p));
    Object.keys(cache).forEach(k => { loaded[k] = true; });
    return {db: ro, user: Object.assign({}, user, {id: async () => uid || ''})};
  }

  async function logout() {
    if (!sb) return;
    try { await sb.auth.signOut(); } catch (e) {}
    try { localStorage.removeItem(CACHE_KEY); } catch (e) {}
    location.reload();
  }

  // nome della persona scritto nell'utente Supabase (Display name): Ahmed o Miro
  function person() {
    const m = (session && session.user && session.user.user_metadata) || {};
    return m.display_name || m.name || m.full_name || '';
  }
  window.FutureCloud = {connect, logout, person, enabled: () => !!(CFG.SUPABASE_URL), email: () => (session && session.user.email) || ''};
})();
