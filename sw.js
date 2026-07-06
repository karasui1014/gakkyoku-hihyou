/* Service Worker ── オフライン対応(PWA) */
"use strict";

const CACHE_NAME = "gakkyoku-hihyou-v1";
const ASSETS = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/analyzer.js",
  "./js/lyrics.js",
  "./js/database.js",
  "./js/critique.js",
  "./js/app.js",
  "./manifest.webmanifest",
  "./assets/favicon.svg",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
  "./assets/apple-touch-icon.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then(cached => {
      if (cached) return cached;
      return fetch(req).then(res => {
        if (res.ok && res.type === "basic") {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
        }
        return res;
      }).catch(() => {
        if (req.mode === "navigate") return caches.match("./index.html");
        return Response.error();
      });
    })
  );
});
