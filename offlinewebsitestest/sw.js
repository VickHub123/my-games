// Service worker: serves the contents of the "website" folder at the site root
// (the URL never changes) and keeps a full copy in the cache so it works offline.

const VERSION = 3;                                          // the launcher checks this via "ping"
const CACHE = 'website-offline-v1';
const scopeURL = new URL(self.registration.scope);          // e.g. https://user.github.io/repo/
const scopePath = scopeURL.pathname;                        // /repo/
const siteURL = new URL('website/', scopeURL);              // /repo/website/
const sitePath = siteURL.pathname;
const indexURL = new URL('index.html', siteURL).href;
const readyKey = new URL('__offline-ready', siteURL).href;  // marks a finished download
const FRESH_WINDOW = 10 * 1000;                             // loads within 10 s of the previous check reuse it (reloads always check)
const WAIT_BUDGET = 800;                                    // normal limit a page load waits for the update check
const WAIT_CHANGED = 2500;                                  // ...extended to this when the check found something new (so it shows right away)
const WAIT_UNKNOWN = 1500;                                  // ...or this when the server has not answered yet
const FILE_TIMEOUT = 120 * 1000;                            // max time for a single file

const log = (...args) => console.log('[offline]', ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
log('service worker v' + VERSION + ' running');

let upgrading = false;                                      // true when this worker replaces an older one

self.addEventListener('install', () => {
  upgrading = !!self.registration.active;
  return self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    await caches.delete('launcher-shell-v1');
    await self.clients.claim();
    if (upgrading) {
      // New worker version: reload the open pages once so they use it right away
      log('service worker updated - reloading open pages');
      const windows = await self.clients.matchAll({ type: 'window' });
      windows.forEach((c) => { try { c.navigate(c.url).catch(() => {}); } catch (err) {} });
    }
  })());
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

  // Visiting /?reset clears the offline copy and downloads everything again
  if (nav && isRoot && url.searchParams.has('reset')) {
    e.respondWith(caches.delete(CACHE).then(() => {
      log('offline copy cleared');
      return Response.redirect(scopeURL.href, 302);
    }));
    return;
  }

  if (nav) {
    // Page load / reload: look for a newer version first, with a short time limit
    // (an unfinished update keeps running in the background and shows up on the next load)
    const fresh = freshen(req);
    e.waitUntil(fresh);
    e.respondWith(waitForUpdate(fresh).then(() => (isRoot ? rootPage() : serveSite(req, url, rel, nav))));
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
    const res = await fetch(location.origin + p + search, { cache: 'no-cache' });
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

// Waits for the update check, but only briefly. If the check already found a newer
// index.html, it waits a bit longer so that the new version is shown in this very load.
let indexState = null;                                      // null = unknown, 'same' or 'changed'
async function waitForUpdate(fresh) {
  const late = () => 'late';
  if ((await Promise.race([fresh, sleep(WAIT_BUDGET).then(late)])) !== 'late') return;
  const extra = indexState === 'changed' ? WAIT_CHANGED : indexState === null ? WAIT_UNKNOWN : 0;
  if (extra > WAIT_BUDGET && (await Promise.race([fresh, sleep(extra - WAIT_BUDGET).then(late)])) !== 'late') return;
  log('page shown from the cache; the update is still downloading and will show on the next load');
}

// Re-downloads the site when a page is loaded. A reload (F5 / hard reload) always checks;
// other loads are skipped if a check succeeded in the last minute.
async function freshen(req) {
  if (!navigator.onLine || !(await isReady())) return;
  const forced = req.cache === 'reload' || req.cache === 'no-cache';
  if (!forced && Date.now() - lastUpdate < FRESH_WINDOW) { log('page load: update check skipped (done less than a minute ago)'); return; }
  log('page load' + (forced ? ' (reload)' : '') + ': checking for a newer version...');
  try {
    await runSync();
    lastUpdate = Date.now();
  } catch (e) {
    log('update check failed: ' + e.message);
  }
}

// HTML pages always bypass the browser cache and get a throwaway query parameter, so neither
// the HTTP cache nor a CDN can hand back an old copy. Other files are revalidated (cheap 304s).
function isPage(href) {
  const p = new URL(href).pathname;
  return p.endsWith('/') || /\.html?$/i.test(p) || !/\.[a-z0-9]+$/i.test(p.split('/').pop());
}
function netURL(href) {
  if (!isPage(href)) return href;
  const u = new URL(href);
  u.searchParams.set('_t', Date.now());
  return u.href;
}
const netInit = (href, extra) => Object.assign({ cache: isPage(href) ? 'reload' : 'no-cache' }, extra);

// Conditional request headers: the server answers "304 Not Modified" (no body) for unchanged files
function condHeaders(old) {
  const h = {};
  const etag = old && old.headers.get('etag');
  const modified = old && old.headers.get('last-modified');
  if (etag) h['If-None-Match'] = etag;
  else if (modified) h['If-Modified-Since'] = modified;
  return h;
}

// Fetch with a limit on the time to receive the response headers
function get(u, ms, headers) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return fetch(netURL(u), netInit(u, { signal: c.signal, headers: headers || {} })).finally(() => clearTimeout(t));
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
  const updated = [];
  let active = 0, done = 0, missing = 0, indexText = '';
  const isText = (ct) => /html|css|javascript|ecmascript|json|xml|svg|text\/plain/i.test(ct);

  const add = (h) => { if (!seen.has(h)) { seen.add(h); queue.push(h); } };
  const sig = (r) => r.headers.get('etag') || r.headers.get('last-modified') || '';
  async function save(href, res) {              // stores a file and notes whether it changed
    const old = await cache.match(href);
    if (!old || !sig(res) || sig(old) !== sig(res)) updated.push(new URL(href).pathname.slice(sitePath.length) || '/');
    await cache.put(href, res);
  }
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
  const t0 = Date.now();
  indexState = null;
  log('checking for updates...');
  const oldIndex = await cache.match(indexURL);
  let first;
  try { first = await get(indexURL, 4000, condHeaders(oldIndex)); }
  catch (e) { throw new Error('No internet connection.'); }
  if (first.status === 304 && oldIndex) {
    indexText = await oldIndex.text();                 // unchanged: reuse the copy we already have
  } else {
    if (!first.ok) throw new Error('website/index.html not found (HTTP ' + first.status + ').');
    const firstCopy = first.clone();
    await save(indexURL, first);
    indexText = await firstCopy.text();
  }
  ok.add(indexURL); seen.add(indexURL); done = 1;
  indexState = updated.length ? 'changed' : 'same';
  log('website/index.html: ' + (indexState === 'changed' ? 'NEW version found' : 'unchanged on the server') +
    ' (' + (Date.now() - t0) + ' ms, last-modified: ' +
    (first.headers.get('last-modified') || (oldIndex && oldIndex.headers.get('last-modified')) || 'n/a') + ')');
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
      const old = dir ? null : await cache.match(href);
      const res = await fetch(netURL(href), netInit(href, { signal: ctl.signal, headers: condHeaders(old) }));
      if (res.status === 304 && old) {   // unchanged: keep the cached file, but still follow its references
        ok.add(href);
        const octype = old.headers.get('content-type') || '';
        if (isText(octype)) parse(await old.text(), octype, href);
        return;
      }
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
      await save(href, res);
      ok.add(href);
      if (isText(ct)) parse(await copy.text(), ct, href);
    } finally {
      clearTimeout(timer);
    }
  }

  await Promise.all(Array.from({ length: 10 }, async () => {
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
  log('done in ' + (Date.now() - t0) + ' ms: ' + (ok.size - 1) + ' files' + (missing ? ', ' + missing + ' references not found (ignored)' : '') + '. ' +
    (updated.length ? updated.length + ' new or changed: ' + updated.slice(0, 8).join(', ') + (updated.length > 8 ? ', ...' : '') : 'Nothing changed.'));
}
