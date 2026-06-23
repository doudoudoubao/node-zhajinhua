'use strict';

/**
 * 炸金花 PWA Service Worker。
 * 仅缓存本目录的静态资源；所有 /api/（含 SSE 长连接）一律走网络，绝不缓存。
 */

const CACHE = 'zjh-v1';
const ASSETS = ['./', './index.html', './style.css', './game.js', './manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.includes('/api/')) return; // API 与 SSE：交给网络，不拦截
  if (!url.pathname.startsWith('/zhajinhua/')) return; // 只接管游戏目录

  // stale-while-revalidate：先回缓存，后台再更新
  e.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(req).then((cached) => {
        const network = fetch(req).then((resp) => {
          if (resp && resp.status === 200) cache.put(req, resp.clone());
          return resp;
        }).catch(() => cached);
        return cached || network;
      })
    )
  );
});
