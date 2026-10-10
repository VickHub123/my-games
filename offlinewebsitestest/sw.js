// Service worker: mostra o conteúdo da pasta "website" na raiz do site (a URL não muda)
// e guarda tudo no cache para funcionar offline.

const CACHE = 'website-offline-v1';
const scopeURL = new URL(self.registration.scope);        // ex.: https://usuario.github.io/repo/
const scopePath = scopeURL.pathname;                      // /repo/
const siteURL = new URL('website/', scopeURL);            // /repo/website/
const sitePath = siteURL.pathname;
const indexURL = new URL('index.html', siteURL).href;
const readyKey = new URL('__offline-ready', siteURL).href; // marca que o download terminou
const UPDATE_EVERY = 5 * 60 * 1000;                       // atualização em segundo plano, no máx. a cada 5 min

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(Promise.all([caches.delete('launcher-shell-v1'), self.clients.claim()]));
});

// ---------------------------------------------------------------- roteamento
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || !url.pathname.startsWith(scopePath)) return;

  let rel = url.pathname.slice(scopePath.length);
  if (rel === 'sw.js') return;
  const nav = req.mode === 'navigate';

  // Raiz da página: site (se já foi baixado) ou launcher (primeira visita)
  if (nav && (rel === '' || rel === 'index.html')) {
    e.waitUntil(backgroundUpdate());
    e.respondWith(rootPage());
    return;
  }

  if (rel.startsWith('website/')) rel = rel.slice('website/'.length);
  e.respondWith(serveSite(req, url, rel, nav));
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'sync' && e.ports[0]) {
    const port = e.ports[0];
    e.waitUntil(
      runSync().then(
        () => port.postMessage({ ok: true }),
        (err) => port.postMessage({ ok: false, error: err.message })
      )
    );
  }
});

const isReady = async () => !!(await (await caches.open(CACHE)).match(readyKey));

async function rootPage() {
  const cache = await caches.open(CACHE);
  if (await cache.match(readyKey)) {
    const home = await cache.match(indexURL);
    if (home) return home;
  }
  try {
    return await fetch(new URL('index.html', scopeURL).href, { cache: 'no-cache' }); // launcher
  } catch (err) {
    return offlinePage();
  }
}

function offlinePage() {
  const html =
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="color-scheme" content="dark"><title>Sem conexão</title>' +
    '<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#000;color:#aaa;' +
    'font:16px system-ui,sans-serif;text-align:center;padding:24px">' +
    '<p>Sem conexão. Conecte-se à internet uma vez para carregar o site.</p>' +
    '<script>addEventListener("online",function(){location.reload()})<\/script>';
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// ---------------------------------------------------------------- servir arquivos
async function serveSite(req, url, rel, nav) {
  const cache = await caches.open(CACHE);
  const target = new URL(rel, siteURL);
  const search = target.search;
  target.search = ''; target.hash = '';
  const p = target.pathname;
  if (!p.startsWith(sitePath)) return new Response('Não encontrado', { status: 404 });

  // 1) cache: arquivo exato, "página.html" (URL sem extensão) ou "pasta/index.html"
  const tries = p.endsWith('/') ? [p + 'index.html'] : [p, p + '.html'];
  for (const t of tries) {
    const hit = await cache.match(location.origin + t);
    if (hit) return withRange(req, hit);
  }
  // pasta pedida sem a barra final: redireciona para que links relativos funcionem
  if (nav && !p.endsWith('/') && (await cache.match(location.origin + p + '/index.html'))) {
    return Response.redirect(new URL(url.pathname + '/' + url.search, location.origin).href, 302);
  }

  // 2) rede
  try {
    const res = await fetch(location.origin + p + search);
    if (res.redirected && nav) {
      return new Response(await res.blob(), { status: res.status, headers: res.headers });
    }
    return res;
  } catch (err) {
    // 3) offline e não está no cache
    if (nav) {
      const fb = (await cache.match(location.origin + sitePath + '404.html')) || (await cache.match(indexURL));
      if (fb) return fb;
    }
    return new Response('Este arquivo não está disponível offline.', {
      status: 504, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

async function withRange(req, hit) {
  const range = req.headers.get('range');
  const m = range && /bytes=(\d*)-(\d*)/.exec(range);
  if (!m) return hit;
  const buf = await hit.arrayBuffer();
  const start = m[1] ? parseInt(m[1], 10) : 0;
  const end = m[2] ? Math.min(parseInt(m[2], 10) + 1, buf.byteLength) : buf.byteLength;
  return new Response(buf.slice(start, end), {
    status: 206,
    headers: {
      'Content-Type': hit.headers.get('Content-Type') || 'application/octet-stream',
      'Content-Range': 'bytes ' + start + '-' + (end - 1) + '/' + buf.byteLength,
    },
  });
}

// ---------------------------------------------------------------- download / atualização
let current = null;
let lastUpdate = 0;
const runSync = () => current || (current = doSync().finally(() => { current = null; }));

async function backgroundUpdate() {
  if (!(await isReady()) || !navigator.onLine) return;
  if (Date.now() - lastUpdate < UPDATE_EVERY) return;
  lastUpdate = Date.now();
  try { await runSync(); } catch (e) { lastUpdate = 0; }
}

function get(u, ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return fetch(u, { cache: 'no-cache', signal: c.signal }).finally(() => clearTimeout(t));
}

function extractRefs(text, type) {
  const out = new Set();
  const add = (r) => {
    r = (r || '').trim();
    if (!r || /^(data:|mailto:|tel:|javascript:|blob:|about:|#)/i.test(r)) return;
    out.add(r);
  };
  let m;
  if (/html|xml|svg/i.test(type)) {
    const attr = /\b(?:src|href|poster|manifest|action)\s*=\s*["']([^"']+)["']/gi;
    while ((m = attr.exec(text))) add(m[1]);
    const ss = /\bsrcset\s*=\s*["']([^"']+)["']/gi;
    while ((m = ss.exec(text))) m[1].split(',').forEach((p) => add(p.trim().split(/\s+/)[0]));
  }
  const u = /url\(\s*["']?([^"')]+?)["']?\s*\)/gi;
  while ((m = u.exec(text))) add(m[1]);
  const imp = /@import\s+["']([^"']+)["']/gi;
  while ((m = imp.exec(text))) add(m[1]);
  if (/javascript|ecmascript|json|html/i.test(type)) {
    const lit = /["'`]((?:\.{0,2}\/)?[\w@%+~\-.\/]+\.(?:html?|css|m?js|json|png|jpe?g|gif|webp|avif|svg|ico|mp3|wav|ogg|mp4|webm|woff2?|ttf|otf|wasm|txt|xml|glb|gltf|bin|pdf)(?:\?[^"'`]*)?)["'`]/gi;
    while ((m = lit.exec(text))) add(m[1]);
  }
  return out;
}

async function doSync() {
  const cache = await caches.open(CACHE);
  const seen = new Set(), queue = [], ok = new Set();
  let active = 0, indexText = '';
  const isText = (ct) => /html|css|javascript|ecmascript|json|xml|svg|text\/plain/i.test(ct);

  const add = (h) => { if (!seen.has(h)) { seen.add(h); queue.push(h); } };
  function enqueue(u) {
    if (u.origin !== location.origin || !u.pathname.startsWith(sitePath)) return;
    u.hash = ''; u.search = '';
    add(u.href);
    if (u.pathname.endsWith('/')) add(new URL('index.html', u).href);
  }
  function parse(text, ct, from) {
    const code = /javascript|ecmascript|json|html/i.test(ct);
    for (const r of extractRefs(text, ct)) {
      try { enqueue(new URL(r, from)); if (code) enqueue(new URL(r, siteURL)); } catch (e) {}
    }
  }

  // 1) index.html primeiro: serve também como teste de conexão (4 s)
  let first;
  try { first = await get(indexURL, 4000); }
  catch (e) { throw new Error('Sem conexão com a internet.'); }
  if (!first.ok) throw new Error('website/index.html não encontrado (HTTP ' + first.status + ').');
  const firstCopy = first.clone();
  await cache.put(indexURL, first);
  ok.add(indexURL); seen.add(indexURL);
  indexText = await firstCopy.text();
  parse(indexText, 'text/html', indexURL);

  // 2) lista opcional de arquivos (files.json)
  for (const m of [new URL('files.json', siteURL).href, new URL('files.json', scopeURL).href]) {
    try {
      const r = await get(m, 5000);
      if (!r.ok) continue;
      const j = await r.json();
      const list = Array.isArray(j) ? j : j.files;
      if (Array.isArray(list)) {
        list.forEach((p) => { try { enqueue(new URL(typeof p === 'string' ? p : p.path, siteURL)); } catch (e) {} });
      }
    } catch (e) {}
  }
  enqueue(siteURL);

  // 3) baixa tudo, seguindo as referências encontradas
  async function one(href) {
    const dir = href.endsWith('/');
    const res = await get(href, 20000);
    const ct = res.headers.get('content-type') || '';
    if (dir) {                       // listagem de diretório, quando o servidor oferece
      if (res.ok && /html/i.test(ct)) {
        const t = await res.text();
        if (t !== indexText) parse(t, ct, href);
      }
      return;
    }
    if (!res.ok) return;
    const path = new URL(href).pathname;
    if (res.redirected) {            // ex.: "pasta" -> "pasta/": guarda só a versão com barra
      const to = new URL(res.url);
      if (to.pathname === path + '/') enqueue(to);
      return;
    }
    if (/text\/html/i.test(ct) && !/\.html?$/i.test(path)) {
      if ((await res.clone().text()) === indexText) return;   // servidor devolveu a página inicial
    }
    const copy = res.clone();
    await cache.put(href, res);
    ok.add(href);
    if (isText(ct)) parse(await copy.text(), ct, href);
  }

  await Promise.all(Array.from({ length: 6 }, async () => {
    for (;;) {
      if (queue.length) {
        const h = queue.shift();
        active++;
        try { await one(h); } catch (e) {}
        active--;
      } else if (active === 0) {
        return;
      } else {
        await new Promise((r) => setTimeout(r, 25));
      }
    }
  }));

  // 4) marca como concluído e remove do cache o que não existe mais no site
  await cache.put(readyKey, new Response('1'));
  ok.add(readyKey);
  for (const req of await cache.keys()) {
    if (!ok.has(req.url)) await cache.delete(req);
  }
}
