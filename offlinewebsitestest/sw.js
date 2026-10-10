// Service worker: serve os arquivos da pasta "website" a partir do cache (offline).
const CACHE = 'website-offline-v1';   // mesmo nome usado no index.html
const SHELL = 'launcher-shell-v1';    // guarda o próprio index.html para abrir offline

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL).then((c) => c.addAll(['./', 'index.html'])).catch(() => {}).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (req.headers.get('X-Offline-Sync')) return; // downloads do launcher vão direto à rede

  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  const scopePath = new URL(self.registration.scope).pathname;
  const sitePath = scopePath + 'website/';

  // Launcher (index.html): rede primeiro, cache se estiver offline
  if (url.pathname === scopePath || url.pathname === scopePath + 'index.html') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() =>
          caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match(scopePath + 'index.html'))
        )
    );
    return;
  }

  // Site: cache primeiro, rede como reserva
  if (url.pathname.startsWith(sitePath)) {
    e.respondWith(serveSite(req, url));
  }
});

async function serveSite(req, url) {
  const cache = await caches.open(CACHE);
  let hit = await cache.match(req, { ignoreSearch: true });
  if (!hit && url.pathname.endsWith('/')) {
    hit = await cache.match(url.pathname + 'index.html');
  }
  if (!hit) {
    try {
      return await fetch(req);
    } catch (err) {
      return new Response('Este arquivo não está disponível offline.', {
        status: 504,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
  }

  // Áudio e vídeo pedem trechos (Range); o cache devolve o arquivo inteiro, então recortamos
  const range = req.headers.get('range');
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      const buf = await hit.arrayBuffer();
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? parseInt(m[2], 10) + 1 : buf.byteLength;
      return new Response(buf.slice(start, end), {
        status: 206,
        headers: {
          'Content-Type': hit.headers.get('Content-Type') || 'application/octet-stream',
          'Content-Range': `bytes ${start}-${end - 1}/${buf.byteLength}`,
        },
      });
    }
  }
  return hit;
}
