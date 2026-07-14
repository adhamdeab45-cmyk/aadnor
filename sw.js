const CACHE='adnor-v302-firebase-only-v1';
const ASSETS=['./','./index.html','./offline.html','./assets/css/main.css','./assets/js/firebase-config.js','./assets/js/firebase-only.js','./assets/js/i18n.js','./assets/js/ui.js','./assets/js/app.js','./assets/icons/icon-192.png','./assets/icons/icon-512.png'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{if(e.request.method!=='GET'||e.request.url.includes('googleapis.com')||e.request.url.includes('firebaseio.com'))return;e.respondWith(fetch(e.request).then(r=>{const copy=r.clone();caches.open(CACHE).then(c=>c.put(e.request,copy));return r}).catch(()=>caches.match(e.request).then(r=>r||caches.match('./offline.html'))))});
