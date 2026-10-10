// Service worker: serves the contents of the "website" folder at the site root
// (the URL never changes) and keeps a full copy in the cache so it works offline.

const VERSION = 2;                                          // the launcher checks this via "ping"
const CACHE = 'website-offline-v1';
const scopeURL = new URL(self.registration.scope);          // e.g. https://user.github.io/repo/
const scopePath = scopeURL.pathname;                        // /repo/
const siteURL = new URL('website/', scopeURL);              // /repo/website/
const sitePath = siteURL.pathname;
const indexURL = new URL('index.html', siteURL).href;
const readyKey = new URL('__offline-ready', siteURL).href;  // marks a finished download
const FRESH_WINDOW = 60 * 1000;                             // skip the update check for page loads right after a successful one
const WAIT_BUDGET = 3000;                                   // never delay a page load by more than this while checking for updates
const FILE_TIMEOUT = 120 * 1000;                            // max time for a single file

const log = (...args) => console.log('[offline]', ...args);

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(Promise.all([caches.delete('launcher-shell-v1'), self.clients.claim()]));
});

// ---------------------------------------------------------------- routing
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || !url.pathname.startsWith(scopePath)) return;

  let rel = url.pathname.slice(scopePath.length);
  if (rel === 'sw.js') return;
  const nav = req.mode === 'navigate';
  const isRoot = rel === '' || rel === 'index.html';
  if (!isRoot && rel.startsWith('website/')) rel = rel.slice('website/'.length);

  if (nav) {
    // Page load / reload: look for a newer version first, but never wait longer than
    // WAIT_BUDGET (the update keeps running in the background and shows up on the next load)
    const fresh = freshen(req);
    e.waitUntil(fresh);
    const settled = Promise.race([fresh, new Promise((r) => setTimeout(r, WAIT_BUDGET))]);
    e.respondWith(settled.then(() => (isRoot ? rootPage() : serveSite(req, url, rel, nav))));
    return;
  }
  e.respondWith(serveSite(req, url, rel, nav));
});

const listeners = new Set();
const emit = (m) => listeners.forEach((f) => { try { f(m); } catch (err) {} });

self.addEventListener('message', (e) => {
  const d = e.data || {};
  const port = e.ports && e.ports[0];
  if (!port) return;
  if (d.type === 'ping') {
    port.postMessage({ ok: true, version: VERSION });
  } else if (d.type === 'sync') {
    const listener = (m) => port.postMessage(m);
    listeners.add(listener);
    e.waitUntil(
      runSync()
        .then(
          () => port.postMessage({ ok: true }),
          (err) => port.postMessage({ ok: false, error: err.message })
        )
        .finally(() => listeners.delete(listener))
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
    return await fetch(new URL('index.html', scopeURL).href, { cache: 'no-cache' }); // the launcher
  } catch (err) {
    return offlinePage();
  }
}

function offlinePage() {
  const html =
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="color-scheme" content="dark"><title>No connection</title>' +
    '<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#000;color:#aaa;' +
    'font:16px system-ui,sans-serif;text-align:center;padding:24px">' +
    '<p>No connection. Connect to the internet once to load the site.</p>' +
    '<script>addEventListener("online",function(){location.reload()})<\/script>';
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// ---------------------------------------------------------------- serving files
async function serveSite(req, url, rel, nav) {
  const cache = await caches.open(CACHE);
  const target = new URL(rel, siteURL);
  const search = target.search;
  target.search = ''; target.hash = '';
  const p = target.pathname;
  if (!p.startsWith(sitePath)) return new Response('Not found', { status: 404 });

  // 1) cache: exact file, "page.html" (extensionless URL) or "folder/index.html"
  const tries = p.endsWith('/') ? [p + 'index.html'] : [p, p + '.html'];
  for (const t of tries) {
    const hit = await cache.match(location.origin + t);
    if (hit) return withRange(req, hit);
  }
  // folder requested without the trailing slash: redirect so relative links keep working
  if (nav && !p.endsWith('/') && (await cache.match(location.origin + p + '/index.html'))) {
    return Response.redirect(new URL(url.pathname + '/' + url.search, location.origin).href, 302);
  }

  // 2) network
  try {
    const res = await fetch(location.origin + p + search);
    if (res.redirected && nav) {
      return new Response(await res.blob(), { status: res.status, headers: res.headers });
    }
    return res;
  } catch (err) {
    // 3) offline and not cached
    if (nav) {
      const fb = (await cache.match(location.origin + sitePath + '404.html')) || (await cache.match(indexURL));
      if (fb) return fb;
    }
    return new Response('This file is not available offline.', {
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

// ---------------------------------------------------------------- download / update
let current = null;
let lastUpdate = 0;
const runSync = () => current || (current = doSync().finally(() => { current = null; }));

// Re-downloads the site when a page is loaded. A reload (F5 / hard reload) always checks;
// other loads are skipped if a check succeeded in the last minute.
async function freshen(req) {
  if (!navigator.onLine || !(await isReady())) return;
  const forced = req.cache === 'reload' || req.cache === 'no-cache';
  if (!forced && Date.now() - lastUpdate < FRESH_WINDOW) return;
  try {
    await runSync();
    lastUpdate = Date.now();
  } catch (e) {
    log('update check failed: ' + e.message);
  }
}

// Fetch with a limit on the time to receive the response headers
function get(u, ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return fetch(u, { cache: 'no-cache', signal: c.signal }).finally(() => clearTimeout(t));
}

function extractRefs(text, type) {
  const out = new Set();
  const add = (r) => {
    r = (r || '').trim();
    if (!r || r.length > 300 || /^(data:|mailto:|tel:|javascript:|blob:|about:|#)/i.test(r)) return;
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
    const lit = /["'`]((?:\.{0,2}\/)?[\w@%+~\-.\/]{1,200}\.(?:html?|css|m?js|json|png|jpe?g|gif|webp|avif|svg|ico|mp3|wav|ogg|mp4|webm|woff2?|ttf|otf|wasm|txt|xml|glb|gltf|bin|pdf)(?:\?[^"'`\s]{0,100})?)["'`]/gi;
    while ((m = lit.exec(text))) add(m[1]);
  }
  return out;
}

async function doSync() {
  const cache = await caches.open(CACHE);
  const seen = new Set(), queue = [], ok = new Set();
  let active = 0, done = 0, missing = 0, indexText = '';
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

  // 1) index.html first: it doubles as the connection test (4 s limit)
  log('checking connection and downloading website/index.html...');
  let first;
  try { first = await get(indexURL, 4000); }
  catch (e) { throw new Error('No internet connection.'); }
  if (!first.ok) throw new Error('website/index.html not found (HTTP ' + first.status + ').');
  const firstCopy = first.clone();
  await cache.put(indexURL, first);
  ok.add(indexURL); seen.add(indexURL); done = 1;
  indexText = await firstCopy.text();
  parse(indexText, 'text/html', indexURL);
  emit({ type: 'progress', done, total: seen.size });

  // 2) optional file list (files.json)
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
  add(new URL('404.html', siteURL).href);   // used as the offline "page not found"

  // 3) download everything, following the references found in each file
  async function one(href) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FILE_TIMEOUT);
    try {
      const dir = href.endsWith('/');
      const res = await fetch(href, { cache: 'no-cache', signal: ctl.signal });
      const ct = res.headers.get('content-type') || '';
      if (dir) {                     // directory listing, when the server provides one
        if (res.ok && /html/i.test(ct)) {
          const t = await res.text();
          if (t !== indexText) parse(t, ct, href);
        }
        return;
      }
      if (!res.ok) { if (!href.endsWith('/404.html')) missing++; return; }
      const path = new URL(href).pathname;
      if (res.redirected) {          // e.g. "folder" -> "folder/": keep only the slash version
        const to = new URL(res.url);
        if (to.pathname === path + '/') enqueue(to);
        return;
      }
      if (/text\/html/i.test(ct) && !/\.html?$/i.test(path)) {
        if ((await res.clone().text()) === indexText) return;   // server returned the home page
      }
      const copy = res.clone();
      await cache.put(href, res);
      ok.add(href);
      if (isText(ct)) parse(await copy.text(), ct, href);
    } finally {
      clearTimeout(timer);
    }
  }

  await Promise.all(Array.from({ length: 6 }, async () => {
    for (;;) {
      if (queue.length) {
        const h = queue.shift();
        active++;
        try { await one(h); } catch (e) { missing++; }
        active--; done++;
        emit({ type: 'progress', done, total: seen.size });
      } else if (active === 0) {
        return;
      } else {
        await new Promise((r) => setTimeout(r, 25));
      }
    }
  }));

  // 4) mark as complete and drop anything that no longer exists on the site
  await cache.put(readyKey, new Response('1'));
  ok.add(readyKey);
  for (const req of await cache.keys()) {
    if (!ok.has(req.url)) await cache.delete(req);
  }
  log('done: ' + (ok.size - 1) + ' files cached' + (missing ? ', ' + missing + ' references not found (ignored)' : '') + '.');
}
