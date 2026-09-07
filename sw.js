/*
 * 每次發佈有靜態檔案變更的版本時，請更新 SHELL_VERSION。
 * 新的 Service Worker 會先建立新快取，再於啟用時移除舊版本。
 */
const SHELL_VERSION = "2026-09-07-2";
const CACHE_PREFIX = "stock-journal-shell-";
const CACHE_NAME = `${CACHE_PREFIX}${SHELL_VERSION}`;

const APP_ROOT_URL = new URL("./", self.registration.scope).href;
const INDEX_URL = new URL("./index.html", self.registration.scope).href;
const SHELL_URLS = [
  APP_ROOT_URL,
  INDEX_URL,
  new URL("./styles.css", self.registration.scope).href,
  new URL("./app.js", self.registration.scope).href,
  new URL("./ledger.js", self.registration.scope).href,
  new URL("./performance.js", self.registration.scope).href,
  new URL("./storage.js", self.registration.scope).href,
  new URL("./tiingo.js", self.registration.scope).href,
  new URL("./tw-quotes.js", self.registration.scope).href,
  new URL("./icon.svg", self.registration.scope).href,
  new URL("./manifest.webmanifest", self.registration.scope).href,
];
const SHELL_PATHS = new Set(SHELL_URLS.map((url) => new URL(url).pathname));

function isCacheableResponse(response) {
  return response && response.ok && response.type === "basic";
}

function isKnownShellRequest(url) {
  return url.origin === self.location.origin && SHELL_PATHS.has(url.pathname);
}

function isApiRequest(url) {
  return (
    url.origin !== self.location.origin ||
    /(^|\/)api(\/|$)/i.test(url.pathname) ||
    /tiingo/i.test(url.hostname)
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        Promise.all(
          SHELL_URLS.map(async (url) => {
            const response = await fetch(new Request(url, { cache: "reload" }));
            if (!isCacheableResponse(response)) {
              throw new Error(`無法預先快取：${url}`);
            }
            await cache.put(url, response);
          }),
        ),
      )
      ,
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

async function networkFirstNavigation(request) {
  const cache = await caches.open(CACHE_NAME);

  try {
    const response = await fetch(request);
    if (isCacheableResponse(response)) {
      await cache.put(INDEX_URL, response.clone());
    }
    return response;
  } catch (error) {
    const cached =
      (await cache.match(INDEX_URL)) || (await cache.match(APP_ROOT_URL));
    if (cached) return cached;
    throw error;
  }
}

async function cacheFirstShell(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) return cached;

  const response = await fetch(request);
  if (isCacheableResponse(response)) {
    await cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // 所有外站與 API（包含 Tiingo）一律直接連線，不寫入 Cache Storage。
  if (isApiRequest(url)) {
    event.respondWith(fetch(request));
    return;
  }

  if (request.mode === "navigate") {
    // Keep HTML and modules from the same installed version. A newly installed
    // worker activates after old app tabs close, avoiding mixed schemas/UI.
    event.respondWith(cacheFirstShell(new Request(INDEX_URL)));
    return;
  }

  // 僅允許明確列入清單的同網域靜態檔進入離線快取。
  if (isKnownShellRequest(url)) {
    event.respondWith(cacheFirstShell(request));
  }
});
