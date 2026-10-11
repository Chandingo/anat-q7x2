/* Offline support: service-worker registration, tiered image download, and an honest status
   that is computed from what is actually in Cache Storage. Exposed as window.CadaverOffline. */
(function (global) {
  "use strict";

  var MEDIA_CACHE = "cadaver-media-v1";
  var SHELL_CACHE_PREFIX = "cadaver-shell-";
  var manifest = null;
  var listeners = [];
  var running = null;

  function supported() {
    return "serviceWorker" in navigator && "caches" in window && window.isSecureContext;
  }

  function why() {
    if (!window.isSecureContext) return "Offline use needs HTTPS (or localhost). Open the app via its https:// address.";
    if (!("serviceWorker" in navigator)) return "This browser does not support service workers.";
    if (!("caches" in window)) return "This browser does not support Cache Storage.";
    return "";
  }

  function register() {
    if (!supported()) return Promise.resolve(null);
    return navigator.serviceWorker.register("sw.js", { scope: "./" }).catch(function () { return null; });
  }

  function loadManifest() {
    if (manifest) return Promise.resolve(manifest);
    return fetch("data/offline_manifest.json", { cache: "no-cache" })
      .then(function (r) { if (!r.ok) throw new Error("manifest " + r.status); return r.json(); })
      .then(function (m) { manifest = m; return m; });
  }

  function absolute(url) { return new URL(url, document.baseURI).href; }

  /* Count which files of each tier are really in the media cache. */
  function status() {
    if (!supported()) return Promise.resolve({ supported: false, reason: why() });
    return Promise.all([loadManifest(), caches.open(MEDIA_CACHE), caches.keys(),
      navigator.serviceWorker.getRegistration()]).then(function (res) {
      var m = res[0], cache = res[1], keys = res[2], reg = res[3];
      return cache.keys().then(function (reqs) {
        var have = {};
        reqs.forEach(function (r) { have[r.url] = 1; });
        var tiers = {};
        Object.keys(m.tiers).forEach(function (k) {
          var files = m.tiers[k].files, n = 0, bytes = 0, total = 0;
          files.forEach(function (f) { total += f.bytes; if (have[absolute(f.url)]) { n++; bytes += f.bytes; } });
          tiers[k] = { label: m.tiers[k].label, cached: n, count: files.length, cachedBytes: bytes, totalBytes: total };
        });
        var shellReady = keys.some(function (k) { return k.indexOf(SHELL_CACHE_PREFIX) === 0; }) &&
          !!(reg && reg.active);
        return { supported: true, shellReady: shellReady, tiers: tiers, version: m.version };
      });
    });
  }

  function summarize(st) {
    if (!st.supported) return { level: "off", text: "Online only", detail: st.reason };
    var a = st.tiers.answers;
    if (st.shellReady && a.cached === a.count) return { level: "ok", text: "Offline ready",
      detail: "App and all " + a.count + " verified answer images are stored on this device." };
    if (a.cached > 0) return { level: "partial", text: "Partly offline",
      detail: a.cached + " of " + a.count + " answer images stored." + (st.shellReady ? "" : " App files not yet stored.") };
    return { level: "none", text: "Online only", detail: "No images downloaded for offline use yet." };
  }

  /* Download every file of the given tiers into the media cache, 6 at a time, then re-verify from the cache. */
  function download(tierKeys, onProgress) {
    if (running) return running;
    var cancelled = false;
    running = loadManifest().then(function (m) {
      return caches.open(MEDIA_CACHE).then(function (cache) {
        return cache.keys().then(function (reqs) {
          var have = {};
          reqs.forEach(function (r) { have[r.url] = 1; });
          var todo = [];
          tierKeys.forEach(function (k) { m.tiers[k].files.forEach(function (f) { if (!have[absolute(f.url)]) todo.push(f); }); });
          var total = todo.length, done = 0, failed = 0, i = 0;
          function worker() {
            if (cancelled || i >= todo.length) return Promise.resolve();
            var f = todo[i++];
            return fetch(f.url, { cache: "no-cache" }).then(function (r) {
              if (!r.ok) throw new Error(r.status);
              return cache.put(f.url, r);
            }).catch(function () { failed++; }).then(function () {
              done++;
              if (onProgress) onProgress(done, total, failed);
              return worker();
            });
          }
          var ws = [];
          for (var w = 0; w < 6; w++) ws.push(worker());
          return Promise.all(ws).then(function () { return { total: total, failed: failed }; });
        });
      });
    }).then(function (r) {
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
      return r;
    }).finally(function () { running = null; notify(); });
    running.cancel = function () { cancelled = true; };
    return running;
  }

  function removeTier(tierKey) {
    return Promise.all([loadManifest(), caches.open(MEDIA_CACHE)]).then(function (res) {
      var files = res[0].tiers[tierKey].files;
      return Promise.all(files.map(function (f) { return res[1].delete(f.url); }));
    }).then(notify);
  }

  /* Remove cached media no longer referenced by the current manifest (after a data update). */
  function pruneStale() {
    if (!supported()) return Promise.resolve(0);
    return Promise.all([loadManifest(), caches.open(MEDIA_CACHE)]).then(function (res) {
      var keep = {};
      Object.keys(res[0].tiers).forEach(function (k) { res[0].tiers[k].files.forEach(function (f) { keep[absolute(f.url)] = 1; }); });
      return res[1].keys().then(function (reqs) {
        var stale = reqs.filter(function (r) { return !keep[r.url]; });
        return Promise.all(stale.map(function (r) { return res[1].delete(r); })).then(function () { return stale.length; });
      });
    });
  }

  function storageEstimate() {
    if (!(navigator.storage && navigator.storage.estimate)) return Promise.resolve(null);
    return Promise.all([navigator.storage.estimate(),
      navigator.storage.persisted ? navigator.storage.persisted() : Promise.resolve(false)])
      .then(function (r) { return { usage: r[0].usage, quota: r[0].quota, persisted: r[1] }; })
      .catch(function () { return null; });
  }

  function onChange(fn) { listeners.push(fn); }
  function notify() { listeners.forEach(function (fn) { try { fn(); } catch (e) { /* ignore */ } }); }

  global.CadaverOffline = {
    supported: supported, why: why, register: register, status: status, summarize: summarize,
    download: download, removeTier: removeTier, pruneStale: pruneStale, storageEstimate: storageEstimate,
    onChange: onChange, MEDIA_CACHE: MEDIA_CACHE,
  };
})(window);
