// Cache only the public app shell. Auth, conversations, drafts, and model responses are never cached here.
const CACHE = 'artemis-shell-v2';
const FILES = ['/', '/index.html', '/liftoff.css', '/liftoff.js', '/styles.css', '/main.js', '/artemis-theme.css', '/mobile.css', '/workspace.css', '/app.js', '/polish.js', '/chat-stream.js', '/chat-render.js', '/workspace.js', '/artemis-icon.svg', '/artemis-icon-192.png', '/artemis-icon-512.png', '/manifest.webmanifest', '/chat/', '/chat/index.html', '/account/', '/account/index.html', '/products/', '/products/index.html'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES))));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('artemis-shell-') && key !== CACHE).map(key => caches.delete(key))))));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !FILES.includes(url.pathname)) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) { const copy = response.clone(); event.waitUntil(caches.open(CACHE).then(cache => cache.put(event.request, copy))); }
    return response;
  }).catch(() => caches.match(event.request)));
});
