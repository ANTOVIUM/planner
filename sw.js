/* Static app shell only. No task or note data enters Cache Storage. */
const APP_BASE = new URL('./', self.location.href);
const CACHE_PREFIX = `poryadok-shell:${APP_BASE.pathname}:`;
// BEGIN GENERATED PRECACHE
const VERSION = '0a3c30d89769e1fc';
const PRECACHE = [
  [
    "./",
    "sha256-FUdddIHQ0cn49WKuZWVcJjuIx5Yvy399GNmhK27AlTY="
  ],
  [
    "./index.html",
    "sha256-FUdddIHQ0cn49WKuZWVcJjuIx5Yvy399GNmhK27AlTY="
  ],
  [
    "./styles.css",
    "sha256-Xi4LwuCbZQE7tXFVunzdYIVbrIChL8YoL2tEzF3o7SA="
  ],
  [
    "./script.js",
    "sha256-QNLwelfTBcei17J8Bl49S3YRjrCasra7g1oPaICgFbI="
  ],
  [
    "./core.js",
    "sha256-Ctv4MJmlDiRSmuzKwUQW0eDHfSlYGve9fCZ7iuXOMsE="
  ],
  [
    "./quotes.js",
    "sha256-sDgvopVeCofJH65pBzj1qFV0xrFhOAuxMEEm9jqY6xo="
  ],
  [
    "./offline.js",
    "sha256-7eIxMgP06KrCT3TN3JQ/j4kW50GTOJXKRbDYvbjPm4U="
  ],
  [
    "./manifest.webmanifest",
    "sha256-/MvY1IJfuwHc0zpiwGT3pa4dm0Y1XVgWWvrmAPUAEIE="
  ],
  [
    "./favicon.svg",
    "sha256-dZcEEZh3xe/lFqWHVMxVpMM2xEzX6bPPC0G00eqsHo4="
  ],
  [
    "./icons/icon-192.png",
    "sha256-R1c26DAAJZmyHxdslmCP97//snMT8CxVCP6Av4rxzq4="
  ],
  [
    "./icons/icon-512.png",
    "sha256-1NEAdfgtJigJBsmqiLT+4DZpFS/qcOf7TIjVYRuzk/Q="
  ],
  [
    "./icons/apple-touch.png",
    "sha256-oF5tZHmpy5B9MssY7HPmMLY1tmEqIiiYaahGWlMRimM="
  ],
  [
    "./fonts/inter-cyrillic.woff2",
    "sha256-cdXuk8wenx1SCjqLZkVt4Yx4edjfCdV/zS6v91/vAHU="
  ],
  [
    "./fonts/inter-cyrillic-ext.woff2",
    "sha256-yhVwYzOaxK1BjyFPOr/tEZsHmKtNN3OGzlyeWnpDXr0="
  ],
  [
    "./fonts/inter-latin.woff2",
    "sha256-MQDndehhbNJhG+7PojpCY9cDdYZ4m0PwNSNqLm+9TGI="
  ],
  [
    "./fonts/inter-latin-ext.woff2",
    "sha256-NLnFBMq3pz43t0Y0OkSRMuVs97VIGvLLgdx03P8lyVY="
  ]
];
// END GENERATED PRECACHE
const CACHE_NAME = `${CACHE_PREFIX}${VERSION}`;
const assetURLs = new Set(PRECACHE.map(([path]) => new URL(path, APP_BASE).href));
const requests = () => PRECACHE.map(([path, integrity]) => new Request(new URL(path, APP_BASE), { cache: 'reload', integrity }));

async function saveShell() {
  const cache = await caches.open(CACHE_NAME);
  // addAll is an atomic batch; a missing or mismatched file rejects the install.
  await cache.addAll(requests());
}
async function shellStatus() {
  const cache = await caches.open(CACHE_NAME);
  const entries = await Promise.all([...assetURLs].map(url => cache.match(url)));
  return { ready: entries.every(Boolean) && entries.length > 0, version: VERSION, count: entries.filter(Boolean).length, total: assetURLs.size };
}

self.addEventListener('install', event => { event.waitUntil(saveShell()); });
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== APP_BASE.origin) return;
  const isAppNavigation = request.mode === 'navigate' && [APP_BASE.pathname, `${APP_BASE.pathname}index.html`].includes(url.pathname);
  url.search = ''; url.hash = '';
  if (!isAppNavigation && !assetURLs.has(url.href)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(isAppNavigation ? new URL('./index.html', APP_BASE).href : url.href);
    return cached || fetch(request);
  })());
});
self.addEventListener('message', event => {
  const type = event.data?.type;
  if (type === 'SKIP_WAITING') { event.waitUntil(self.skipWaiting()); return; }
  if (!['GET_STATUS', 'REPAIR_CACHE'].includes(type)) return;
  event.waitUntil((async () => {
    try {
      if (type === 'REPAIR_CACHE') await saveShell();
      event.ports?.[0]?.postMessage(await shellStatus());
    } catch {
      event.ports?.[0]?.postMessage({ ready: false, version: VERSION, error: 'incomplete-cache' });
    }
  })());
});
