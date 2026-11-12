/* Future — account, spazio condiviso, partner e notifiche su Supabase.
   Offre all'app la stessa interfaccia dati di prima (collection().doc().set(), onSnapshot...),
   ma ogni dato appartiene a uno "spazio": il tuo, ed eventualmente quello condiviso con il partner. */
(function () {
  'use strict';
  const CFG = window.FUTURE_CONFIG || {};
  // chiave pubblica delle notifiche (pubblica per definizione: può stare qui)
  if (!CFG.VAPID_PUBLIC_KEY) CFG.VAPID_PUBLIC_KEY = 'BOrZthGwdwGBWx-pcfUsYqlX3OvAuYlEssp7HDQggulO3jT5eyi0WgXtmty_Ngp3hNSXYiwhKyIeDDHsMTYztt8';
  const TABLE = 'future_docs';
  const clone = o => (o == null ? o : JSON.parse(JSON.stringify(o)));
  const LS = {
    get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} },
    del: k => { try { localStorage.removeItem(k); } catch (e) {} }
  };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

  let sb = null, session = null, spaceId = '', members = [], channel = null;
  const memberL = new Set();
  const cache = {}, loaded = {}, collL = {}, docL = {}, errL = {};
  const cacheKey = () => 'future_cache_v2_' + (session ? session.user.id : '');

  /* ---------- invito dal link (?invito=CODICE) ---------- */
  (function grabInvite() {
    try {
      const u = new URL(location.href); const c = (u.searchParams.get('invito') || '').trim().toUpperCase();
      if (c) { LS.set('future_invite', c); u.searchParams.delete('invito'); history.replaceState(null, '', u.pathname + (u.search || '') + u.hash); }
    } catch (e) {}
  })();
  const pendingInvite = () => LS.get('future_invite') || '';

  /* ---------- cache locale ---------- */
  function readCache() { try { return JSON.parse(LS.get(cacheKey()) || '{}') || {}; } catch (e) { return {}; } }
  let saveT = 0;
  function writeCache() { clearTimeout(saveT); saveT = setTimeout(() => LS.set(cacheKey(), JSON.stringify({s: spaceId, c: cache})), 300); }

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

  /* ---------- lettura ---------- */
  const loading = {};
  function load(coll) {
    if (loading[coll]) return loading[coll];
    loading[coll] = (async () => {
      const all = {}; let from = 0; const step = 1000;
      for (;;) {
        const {data, error} = await sb.from(TABLE).select('id,data').eq('space_id', spaceId).eq('coll', coll).range(from, from + step - 1);
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
  function reloadAll() { watched().forEach(load); loadMembers(); }

  /* ---------- membri dello spazio ---------- */
  async function loadMembers() {
    const {data, error} = await sb.from('members').select('user_id,role,name,space_id').order('joined_at');
    if (error) return members;
    const before = JSON.stringify(members);
    members = data || [];
    const mine = members.find(m => m.user_id === session.user.id);
    if (!mine) { location.reload(); return members; }          // scollegato dallo spazio
    if (mine.space_id !== spaceId) { location.reload(); return members; }
    if (JSON.stringify(members) !== before) memberL.forEach(cb => { try { cb(info()); } catch (e) {} });
    return members;
  }
  function info() {
    const uid = session ? session.user.id : '';
    const me = members.find(m => m.user_id === uid) || {};
    const partner = members.find(m => m.user_id !== uid) || null;
    const owner = members.find(m => m.role === 'owner') || {};
    return {uid, email: session ? session.user.email : '', spaceId, name: me.name || '', role: me.role || '',
      partner: partner ? {name: partner.name, role: partner.role, user_id: partner.user_id} : null, ownerName: owner.name || '',
      names: Object.fromEntries(members.map(m => [m.user_id, m.name]))};
  }

  function startRealtime() {
    if (channel) return;
    channel = sb.channel('future-' + spaceId)
      .on('postgres_changes', {event: '*', schema: 'public', table: TABLE, filter: 'space_id=eq.' + spaceId}, p => {
        const row = p.eventType === 'DELETE' ? p.old : p.new;
        if (!row || !row.coll) { reloadAll(); return; }
        cache[row.coll] = cache[row.coll] || {};
        if (p.eventType === 'DELETE') delete cache[row.coll][row.id]; else cache[row.coll][row.id] = row.data;
        emit(row.coll, false);
      })
      .on('postgres_changes', {event: '*', schema: 'public', table: 'members', filter: 'space_id=eq.' + spaceId}, () => loadMembers())
      .subscribe(st => { if (st === 'SUBSCRIBED') reloadAll(); });
  }

  /* ---------- scrittura ---------- */
  function errCode(error) {
    const msg = String((error && (error.message || error)) || '');
    if (error && (error.code === '42501' || /row-level security|permission denied/i.test(msg))) return 'invalid_argument';
    if (/429|too many/i.test(msg)) return 'resource_exhausted';
    return 'unavailable';
  }
  async function write(coll, id, data) {
    const prev = cache[coll] && Object.prototype.hasOwnProperty.call(cache[coll], id) ? cache[coll][id] : undefined;
    cache[coll] = cache[coll] || {};
    if (data === null) delete cache[coll][id]; else cache[coll][id] = clone(data);
    emit(coll, false);
    const q = data === null
      ? sb.from(TABLE).delete().eq('space_id', spaceId).eq('coll', coll).eq('id', id)
      : sb.from(TABLE).upsert({space_id: spaceId, coll, id, data: clone(data), updated_at: new Date().toISOString()}, {onConflict: 'space_id,coll,id'});
    const {error} = await q;
    if (error) {
      if (prev === undefined) delete cache[coll][id]; else cache[coll][id] = prev;
      emit(coll, false);
      const e = new Error(error.message || 'errore'); e.code = errCode(error); throw e;
    }
    return true;
  }

  /* ---------- interfaccia dati per l'app ---------- */
  function docRef(coll, id) {
    return {
      id, set: d => write(coll, id, d), delete: () => write(coll, id, null),
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
  const db = {collection: collRef, doc: path => { const i = path.indexOf('/'); return docRef(path.slice(0, i), path.slice(i + 1)); }};
  const user = {
    id: async () => (session ? session.user.id : ''),
    can: async () => true,
    isOwner: () => info().role === 'owner',
    me: async () => ({name: info().name}),
    profiles: async ids => { const n = info().names; const o = {}; (ids || []).forEach(id => { if (n[id]) o[id] = {name: n[id]}; }); return o; }
  };

  /* ---------- schermate (accesso, registrazione, messaggi) ---------- */
  const CSS = `
#fc-login{position:fixed;inset:0;z-index:99999;background:#030305;color:#f4f4f8;display:flex;align-items:center;justify-content:center;padding:24px;padding-top:max(24px,env(safe-area-inset-top));font-family:Inter,-apple-system,system-ui,sans-serif;overflow:auto}
#fc-login .box{width:100%;max-width:360px}
#fc-login .logo{width:76px;height:76px;border-radius:20px;display:block;margin:0 auto 16px;box-shadow:0 10px 40px rgba(46,229,157,.25)}
#fc-login h1{font-size:28px;font-weight:800;text-align:center;margin:0 0 6px;letter-spacing:-.02em}
#fc-login p{font-size:14px;color:#9a9aae;text-align:center;margin:0 0 20px;line-height:1.45}
#fc-login .inv{background:rgba(46,229,157,.1);border:1px solid rgba(46,229,157,.35);color:#c9fbe6;border-radius:14px;padding:12px 14px;font-size:14px;line-height:1.45;margin:0 0 18px;text-align:center}
#fc-login .tabs{display:flex;background:rgba(255,255,255,.06);border-radius:14px;padding:4px;margin:0 0 18px}
#fc-login .tabs button{flex:1;background:none;color:#9a9aae;padding:10px;font-size:15px;border-radius:11px;margin:0}
#fc-login .tabs button.on{background:rgba(255,255,255,.12);color:#fff}
#fc-login label{display:block;font-size:12px;color:#9a9aae;margin:0 0 6px;font-weight:600}
#fc-login input{width:100%;box-sizing:border-box;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);border-radius:14px;color:#fff;font-size:17px;padding:14px 16px;margin:0 0 14px;outline:none;font-family:inherit}
#fc-login input:focus{border-color:#2EE59D}
#fc-login button{width:100%;border:0;border-radius:14px;padding:15px;font-size:17px;font-weight:700;background:#2EE59D;color:#03130c;font-family:inherit;cursor:pointer;margin-top:4px}
#fc-login button.ghost{background:rgba(255,255,255,.08);color:#fff}
#fc-login button:disabled{opacity:.6}
#fc-login .err{color:#FF8A9E;font-size:14px;text-align:center;min-height:20px;margin:12px 0 0;line-height:1.4}
#fc-login .msg{color:#c9fbe6;font-size:14px;text-align:center;margin:12px 0 0;line-height:1.45}
#fc-login .cfg{background:rgba(255,94,122,.1);border:1px solid rgba(255,94,122,.35);border-radius:14px;padding:14px;font-size:14px;line-height:1.5;color:#ffd0d8}`;
  function injectCss() { if (document.getElementById('fc-css')) return; const s = document.createElement('style'); s.id = 'fc-css'; s.textContent = CSS; document.head.appendChild(s); }
  function overlay(html) { injectCss(); let d = document.getElementById('fc-login'); if (!d) { d = document.createElement('div'); d.id = 'fc-login'; document.body.appendChild(d); } d.innerHTML = `<div class="box"><img class="logo" src="icons/icon-192.png" alt="">${html}</div>`; return d; }
  function closeOverlay() { const d = document.getElementById('fc-login'); if (d) d.remove(); }
  function showConfigError(msg) { overlay(`<h1>Future</h1><div class="cfg">${msg}</div>`); }

  function authError(m) {
    m = String(m || '');
    if (/invalid login|invalid credentials/i.test(m)) return 'Email o password sbagliate.';
    if (/already registered|already exists/i.test(m)) return 'Esiste già un account con questa email: usa “Entra”.';
    if (/signups? not allowed|signup is disabled/i.test(m)) return 'Le registrazioni sono chiuse. In Supabase attiva “Allow new users to sign up”.';
    if (/password/i.test(m) && /(6|short|least)/i.test(m)) return 'La password deve avere almeno 6 caratteri.';
    if (/email not confirmed|confirm/i.test(m)) return 'Devi prima confermare l’email: apri il messaggio che ti è arrivato e poi entra.';
    if (/fetch|network/i.test(m)) return 'Nessuna connessione: riprova quando sei online.';
    if (/rate limit|too many/i.test(m)) return 'Troppi tentativi: aspetta qualche minuto.';
    return 'Non riuscito: ' + m;
  }

  async function inviteInfo(code) {
    try { const {data} = await sb.rpc('invite_info', {p_code: code}); const r = Array.isArray(data) ? data[0] : data; return r || null; } catch (e) { return null; }
  }

  function showAuth() {
    return new Promise(async resolve => {
      const code = pendingInvite();
      const inv = code ? await inviteInfo(code) : null;
      let mode = code ? 'signup' : 'login';
      const draw = (msg) => {
        const d = overlay(`<h1>Future</h1>
          ${inv && inv.valid ? `<div class="inv"><b>${esc(inv.inviter)}</b> ti ha invitato su Future.<br>${mode === 'signup' ? 'Crea il tuo account' : 'Entra con il tuo account'} e sarete collegati.</div>`
            : code ? `<div class="inv" style="border-color:rgba(255,94,122,.4);background:rgba(255,94,122,.1);color:#ffd0d8">Questo invito non è più valido. Chiedi un nuovo link.</div>`
            : `<p>Entrate, uscite e obiettivi, da soli o in coppia.</p>`}
          <div class="tabs"><button type="button" data-m="login" class="${mode === 'login' ? 'on' : ''}">Entra</button><button type="button" data-m="signup" class="${mode === 'signup' ? 'on' : ''}">Crea account</button></div>
          <form autocomplete="on">
            ${mode === 'signup' ? '<label for="fc-n">Il tuo nome</label><input id="fc-n" autocomplete="given-name" required maxlength="30" placeholder="Come ti chiami?">' : ''}
            <label for="fc-e">Email</label><input id="fc-e" type="email" autocomplete="username" inputmode="email" autocapitalize="off" required>
            <label for="fc-p">Password</label><input id="fc-p" type="password" autocomplete="${mode === 'signup' ? 'new-password' : 'current-password'}" required ${mode === 'signup' ? 'minlength="6" placeholder="Almeno 6 caratteri"' : ''}>
            <button type="submit">${mode === 'signup' ? 'Crea account' : 'Entra'}</button>
            <div class="${msg && msg.ok ? 'msg' : 'err'}" id="fc-err">${msg ? esc(msg.t) : ''}</div>
          </form>`);
        d.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { mode = b.dataset.m; draw(); });
        const f = d.querySelector('form'), btn = f.querySelector('button[type=submit]'), err = d.querySelector('#fc-err');
        f.onsubmit = async ev => {
          ev.preventDefault(); err.className = 'err'; err.textContent = ''; btn.disabled = true; btn.textContent = '…';
          const email = d.querySelector('#fc-e').value.trim(), password = d.querySelector('#fc-p').value;
          let res;
          try {
            if (mode === 'signup') {
              const name = d.querySelector('#fc-n').value.trim().slice(0, 30);
              if (!name) { err.textContent = 'Scrivi il tuo nome.'; btn.disabled = false; btn.textContent = 'Crea account'; return; }
              res = await sb.auth.signUp({email, password, options: {data: {display_name: name}, emailRedirectTo: location.origin + location.pathname}});
              if (!res.error && !res.data.session) { mode = 'login'; draw({ok: true, t: 'Account creato. Ti è arrivata un’email: conferma l’indirizzo, poi torna qui ed entra.'}); return; }
            } else {
              res = await sb.auth.signInWithPassword({email, password});
            }
          } catch (e) { res = {error: e}; }
          if (res.error) { btn.disabled = false; btn.textContent = mode === 'signup' ? 'Crea account' : 'Entra'; err.textContent = authError(res.error.message); return; }
          session = res.data.session; resolve();
        };
        setTimeout(() => { const i = d.querySelector(mode === 'signup' ? '#fc-n' : '#fc-e'); if (i) i.focus(); }, 150);
      };
      draw();
    });
  }

  function askConfirm(title, text, okLabel) {
    return new Promise(res => {
      const d = overlay(`<h1 style="font-size:22px">${esc(title)}</h1><p>${text}</p><button data-x="ok">${esc(okLabel)}</button><button class="ghost" data-x="no">Annulla</button>`);
      d.querySelector('[data-x=ok]').onclick = () => res(true);
      d.querySelector('[data-x=no]').onclick = () => res(false);
    });
  }

  const myName = () => { const m = (session && session.user.user_metadata) || {}; return String(m.display_name || m.name || (session ? session.user.email.split('@')[0] : '')).slice(0, 30); };

  async function joinWith(code, force) {
    const {data, error} = await sb.rpc('join_space', {p_code: code, p_name: myName(), p_force: !!force});
    if (error) {
      const m = String(error.message || '');
      if (/HAS_DATA/.test(m)) return {needForce: true};
      if (/HAS_PARTNER/.test(m)) return {error: 'Hai già un partner collegato: scollegalo prima di unirti a un altro spazio.'};
      if (/FULL/.test(m)) return {error: 'Questo spazio ha già un partner collegato.'};
      if (/INVALID|EXPIRED/.test(m)) return {error: 'Questo invito non è valido o è scaduto. Chiedi un nuovo link.'};
      return {error: 'Collegamento non riuscito: ' + m};
    }
    return {ok: true, space: data};
  }

  async function ensureSpace() {
    const code = pendingInvite();
    if (code) {
      let r = await joinWith(code, false);
      if (r.needForce) {
        const ok = await askConfirm('Collegarti allo spazio condiviso?', 'Hai già dei dati tuoi in Future. Collegandoti allo spazio di chi ti ha invitato, <b>i tuoi dati attuali verranno eliminati</b> e vedrete gli stessi conti.', 'Collegami ed elimina i miei dati');
        r = ok ? await joinWith(code, true) : {cancel: true};
      }
      LS.del('future_invite');
      if (r.error) await askConfirm('Invito non usato', esc(r.error), 'Continua');
    }
    await loadMembersRaw();
    if (!members.find(m => m.user_id === session.user.id)) {
      const {error} = await sb.rpc('create_space', {p_name: myName()});
      if (error) throw error;
      await loadMembersRaw();
    }
    const mine = members.find(m => m.user_id === session.user.id);
    if (!mine) throw new Error('Spazio non trovato');
    spaceId = mine.space_id;
  }
  async function loadMembersRaw() {
    const {data, error} = await sb.from('members').select('user_id,role,name,space_id').order('joined_at');
    if (error) throw error;
    members = data || [];
  }

  /* ---------- avvio ---------- */
  async function connect() {
    if (!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY) || /INCOLLA/.test(CFG.SUPABASE_URL + CFG.SUPABASE_ANON_KEY)) {
      showConfigError('Manca il collegamento a Supabase.<br>Apri il file <b>config.js</b> su GitHub e incolla <b>Project URL</b> e <b>anon key</b>.'); return null;
    }
    if (!window.supabase || !window.supabase.createClient) { showConfigError('Serve internet per la prima apertura. Collegati e riapri Future.'); return null; }
    sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {auth: {persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'future-auth'}});
    try { const r = await sb.auth.getSession(); session = r.data.session; } catch (e) { session = null; }
    if (!session) await showAuth();
    overlay('<h1>Future</h1><p>Apro il tuo spazio…</p>');
    try { await ensureSpace(); } catch (e) {
      console.error(e);
      showConfigError('Non riesco ad aprire il tuo spazio.<br>Controlla la connessione e che in Supabase sia stato eseguito <b>4-multiutente.sql</b>.<br><small>' + esc(e.message || e) + '</small>'); return null;
    }
    closeOverlay();
    const c = readCache();
    if (c && c.c && c.s === spaceId) Object.keys(c.c).forEach(k => { cache[k] = c.c[k]; });

    sb.auth.onAuthStateChange((ev, s) => { if (ev === 'SIGNED_OUT') { location.reload(); return; } if (s) session = s; });
    startRealtime();
    let last = Date.now();
    const refresh = () => { if (Date.now() - last < 3000) return; last = Date.now(); reloadAll(); };
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
    window.addEventListener('online', refresh);
    window.addEventListener('pageshow', e => { if (e.persisted) refresh(); });
    refreshPushSub();
    return {db, user};
  }

  /* ---------- partner ---------- */
  async function createInvite() {
    const {data, error} = await sb.rpc('create_invite');
    if (error) { const m = String(error.message || ''); throw new Error(/FULL/.test(m) ? 'Hai già un partner collegato.' : /OWNER/.test(m) ? 'Solo chi ha creato lo spazio può invitare.' : m); }
    const code = String(data);
    return {code, link: location.origin + location.pathname + '?invito=' + encodeURIComponent(code)};
  }
  async function unlinkPartner() {
    const {error} = await sb.rpc('unlink_partner');
    if (error) throw new Error(error.message);
    LS.del(cacheKey());
    if (info().role === 'partner') { location.reload(); return; }
    await loadMembers();
  }
  async function useCode(code) {
    LS.set('future_invite', String(code || '').trim().toUpperCase());
    LS.del(cacheKey()); location.reload();
  }
  async function rename(name) {
    name = String(name || '').trim().slice(0, 30); if (!name) return false;
    const {error} = await sb.from('members').update({name}).eq('user_id', session.user.id);
    if (error) return false;
    try { await sb.auth.updateUser({data: {display_name: name}}); } catch (e) {}
    await loadMembers(); return true;
  }

  /* ---------- notifiche push ---------- */
  const b64u = s => { const p = '='.repeat((4 - s.length % 4) % 4); const b = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(b, c => c.charCodeAt(0)); };
  const standalone = () => (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  async function pushState() {
    if (!CFG.VAPID_PUBLIC_KEY || /INCOLLA/.test(CFG.VAPID_PUBLIC_KEY)) return 'nokey';
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return isIOS() && !standalone() ? 'need-install' : 'unsupported';
    if (isIOS() && !standalone()) return 'need-install';
    if (Notification.permission === 'denied') return 'denied';
    try { const reg = await navigator.serviceWorker.getRegistration(); const sub = reg && await reg.pushManager.getSubscription(); return sub && Notification.permission === 'granted' ? 'on' : 'off'; } catch (e) { return 'off'; }
  }
  async function saveSub(sub) {
    const j = sub.toJSON();
    const {error} = await sb.from('push_subs').upsert({endpoint: j.endpoint, user_id: session.user.id, p256dh: j.keys.p256dh, auth: j.keys.auth, ua: navigator.userAgent.slice(0, 200)}, {onConflict: 'endpoint'});
    return !error;
  }
  async function enablePush() {
    const p = await Notification.requestPermission();
    if (p !== 'granted') return false;
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({userVisibleOnly: true, applicationServerKey: b64u(CFG.VAPID_PUBLIC_KEY)});
    return saveSub(sub);
  }
  async function refreshPushSub() {
    try { if ((await pushState()) !== 'on') return; const reg = await navigator.serviceWorker.getRegistration(); const sub = await reg.pushManager.getSubscription(); if (sub) await saveSub(sub); } catch (e) {}
  }
  async function notify(msg) {
    if (!info().partner) return {ok: false, sent: 0};
    try {
      const {data, error} = await sb.functions.invoke('notify', {body: Object.assign({}, msg, {url: msg.url || './'})});
      if (error) return {ok: false, sent: 0};
      return Object.assign({ok: true}, data || {});
    } catch (e) { return {ok: false, sent: 0}; }
  }

  async function logout() {
    try { await sb.auth.signOut(); } catch (e) {}
    LS.del(cacheKey()); location.reload();
  }

  window.FutureCloud = {
    connect, logout, info, onMembers: cb => memberL.add(cb),
    createInvite, unlinkPartner, useCode, rename,
    pushState, enablePush, notify, isIOS, standalone,
    enabled: () => !!CFG.SUPABASE_URL, email: () => (session && session.user.email) || ''
  };
})();
