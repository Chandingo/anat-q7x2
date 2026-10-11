/* Service worker for Cadaver ID.
   - App shell (HTML/CSS/JS/icons/data JSON): network-first, falling back to the cached copy offline,
     so updates arrive whenever the server is reachable.
   - Images (/media/...): cache-first. Image URLs carry a content hash (?v=...), so a cached image
     can never be a stale version of a changed file. Viewed images are kept for offline use too. */
"use strict";

var SHELL = "cadaver-shell-v5";
var MEDIA = "cadaver-media-v1";
var SHELL_FILES = [
  "./", "index.html", "css/app.css", "js/logic.js", "js/viewer.js", "js/offline.js", "js/app.js",
  "manifest.webmanifest", "icons/icon-180.png", "icons/icon-192.png", "icons/icon-512.png",
  "data/structures.json", "data/offline_manifest.json",
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(SHELL).then(function (c) {
      return c.addAll(SHELL_FILES.map(function (u) { return new Request(u, { cache: "no-cache" }); }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k.indexOf("cadaver-shell-") === 0 && k !== SHELL; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

function fetchWithTimeout(req, ms) {
  return new Promise(function (resolve, reject) {
    var t = setTimeout(function () { reject(new Error("timeout")); }, ms);
    fetch(req, { cache: "no-cache" }).then(function (r) { clearTimeout(t); resolve(r); },
      function (e) { clearTimeout(t); reject(e); });
  });
}

function networkFirst(req) {
  return caches.open(SHELL).then(function (cache) {
    return fetchWithTimeout(req, 4000).then(function (res) {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    }).catch(function () {
      return cache.match(req, { ignoreSearch: true }).then(function (hit) {
        if (hit) return hit;
        if (req.mode === "navigate") return cache.match("index.html");
        return Response.error();
      });
    });
  });
}

function cacheFirst(req) {
  return caches.open(MEDIA).then(function (cache) {
    return cache.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      });
    });
  });
}

self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.indexOf("/media/") >= 0) { event.respondWith(cacheFirst(req)); return; }
  event.respondWith(networkFirst(req));
});
