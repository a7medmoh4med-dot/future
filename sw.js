/* Future — service worker: l'app si apre anche senza rete.
   Quando pubblichi una nuova versione, cambia il numero qui sotto (v1 → v2): i telefoni scaricano tutto di nuovo. */
const VERSION = 'future-v24';
const SHELL = ['./', 'index.html', 'config.js', 'future-cloud.js', 'manifest.webmanifest',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname.endsWith('supabase.co') || url.hostname.endsWith('supabase.in')) return; // dati: sempre dalla rete
  const isPage = req.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname.endsWith('config.js') || url.pathname.endsWith('future-cloud.js');
  if (isPage) {
    // prima la rete (così vedi subito gli aggiornamenti), se non c'è la copia salvata
    e.respondWith(fetch(req).then(r => { const cp = r.clone(); caches.open(VERSION).then(c => c.put(req, cp)); return r; })
      .catch(() => caches.match(req).then(r => r || caches.match('index.html'))));
    return;
  }
  // icone, font, libreria: prima la copia salvata
  e.respondWith(caches.match(req).then(r => r || fetch(req).then(res => {
    if (res && (res.ok || res.type === 'opaque')) { const cp = res.clone(); caches.open(VERSION).then(c => c.put(req, cp)); }
    return res;
  })));
});

/* notifiche push: arrivano anche ad app chiusa */
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = {body: e.data ? e.data.text() : ''}; }
  e.waitUntil(self.registration.showNotification(d.title || 'Future', {
    body: d.body || '', icon: 'icons/icon-192.png', badge: 'icons/icon-192.png',
    tag: d.tag || undefined, renotify: !!d.tag, data: {url: d.url || './'}
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({type: 'window', includeUncontrolled: true}).then(cs => {
    for (const c of cs) { if ('focus' in c) { c.postMessage({type: 'open', url}); return c.focus(); } }
    return self.clients.openWindow(url);
  }));
});
