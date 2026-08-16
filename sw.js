/* PONKEY service worker
   目的:
   ・「ホーム画面に追加」の要件(fetchハンドラ付きSW)を満たす
   ・オフラインでもアプリが開ける(DIALOGUE等は外部依存が少なく完全オフライン動作)
   方針:
   ・HTML(ドキュメント)は network-first → 更新を即反映、オフライン時はキャッシュ
   ・フォント等の静的リソースは cache-first(変わらないので)
   ・DUET の Magenta/TensorFlow CDN は大きいのでキャッシュしない(要ネットのまま)
*/
const CACHE = 'ponkey-v6';
const CORE = [
  './', './index.html',
  './lesson.html',
  './sync.html', './sequence.html', './loops.html', './groove.html', './groove-engine.js',
  './invaders.html', './trance.html', './dialogue.html', './duet.html',
  './ponkey-sound-guide.html',
  './manifest.json', './icon-192.png', './icon-512.png', './icon-180.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.allSettled(CORE.map(u => c.add(u))))  // 1つ失敗しても他は続行
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // HTMLドキュメント: network-first(新しい版を優先、ダメならキャッシュ)
  if (req.mode === 'navigate' || req.destination === 'document') {
    e.respondWith(
      fetch(req)
        .then(r => { const cp = r.clone(); caches.open(CACHE).then(c => c.put(req, cp)); return r; })
        .catch(() => caches.match(req).then(m => m || caches.match('./index.html')))
    );
    return;
  }

  // フォント等の静的: cache-first(なければ取得してランタイムキャッシュ)
  e.respondWith(
    caches.match(req).then(m => m || fetch(req).then(r => {
      const okToCache = r.ok && (url.origin === location.origin || /gstatic\.com$/.test(url.host));
      if (okToCache) { const cp = r.clone(); caches.open(CACHE).then(c => c.put(req, cp)); }
      return r;
    }).catch(() => m))
  );
});
