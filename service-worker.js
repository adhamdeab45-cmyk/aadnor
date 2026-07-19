'use strict';
const CACHE='adnor-v221-wheel-account-repair-1';
const SHELL=[
  '/', '/index.html', '/app.html', '/offline.html', '/manifest.webmanifest',
  '/favicon.svg', '/apple-touch-icon.png', '/terms.html', '/privacy.html', '/responsible-play.html',
  '/assets/icons/icon-96.png','/assets/icons/icon-192.png','/assets/icons/icon-512.png','/assets/icons/icon-maskable-512.png',
  '/install-app.js'
];
self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch',event=>{
  const req=event.request;
  if(req.method!=='GET') return;
  const url=new URL(req.url);
  if(url.origin!==self.location.origin) return;
  if(url.pathname.startsWith('/api')||url.pathname.includes('firebase')) return;
  if(url.pathname==='/exchange-admin.html'||url.pathname==='/admin-command-center.html'||url.pathname==='/energy-admin.html'||url.pathname==='/public-admin.html'||url.pathname==='/admin-agents.html'){
    event.respondWith(fetch(req,{cache:'no-store'}).catch(()=>caches.match('/offline.html')));
    return;
  }
  if(req.mode==='navigate'){
    event.respondWith(fetch(req).then(res=>{const copy=res.clone();caches.open(CACHE).then(c=>c.put(req,copy));return res}).catch(()=>caches.match(req).then(r=>r||caches.match('/offline.html'))));
    return;
  }
  event.respondWith(caches.match(req).then(cached=>cached||fetch(req).then(res=>{if(res.ok){const copy=res.clone();caches.open(CACHE).then(c=>c.put(req,copy));}return res;})));
});
self.addEventListener('message',event=>{if(event.data==='SKIP_WAITING') self.skipWaiting();});
