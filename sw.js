const CACHE = 'starfold-v22';

const ASSETS = [
  '/starnight/',
  '/starnight/index.html',
  '/starnight/manifest.json',
  '/starnight/moon.png',
  '/starnight/star.png',
  '/starnight/icons/icon-192.png',
  '/starnight/icons/icon-512.png'
];

// 安裝
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

// 啟用
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// 改良 fetch 策略
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);

  // 🔴 不快取 API / webhook（很重要）
  if (url.pathname.includes('/webhook')) return;

  // 🟡 HTML → network first（避免舊版本卡住）
  if (e.request.headers.get('accept')?.includes('text/html')) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // 🟢 靜態資源 → cache first
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;

      return fetch(e.request).then(res => {
        if (res && res.status === 200 && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      });
    })
  );
});