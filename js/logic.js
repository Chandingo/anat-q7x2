/* Pure study logic: filters, non-repeating queue, search, persistence helpers.
   No DOM access, so it can be unit-tested in app/tests.html. Exposed as window.CadaverLogic. */
(function (global) {
  "use strict";

  // ---------------------------------------------------------------- text + search
  function normalize(s) {
    return String(s || "")
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function buildSearchIndex(structures) {
    return structures.map(function (s) {
      var primary = normalize(s.name);
      var fields = [s.name].concat(s.mssNames || [], s.synonyms || []);
      var text = fields.map(normalize).join(" | ");
      var tokens = text.split(/[ |]+/).filter(Boolean);
      return { id: s.id, primary: primary, text: text, tokens: tokens, alt: (s.mssNames || []).concat(s.synonyms || []).map(normalize) };
    });
  }

  /* Every query word must be the start of some word in the structure's name, MSS wording or verified synonyms.
     Ranked: exact name > name starts with query > all words in name > match via MSS wording/synonym. */
  function search(index, query, limit) {
    var q = normalize(query);
    if (!q) return [];
    var qt = q.split(" ");
    var out = [];
    for (var i = 0; i < index.length; i++) {
      var e = index[i];
      var ok = qt.every(function (t) { return e.tokens.some(function (w) { return w.indexOf(t) === 0; }); });
      if (!ok) continue;
      var pt = e.primary.split(" ");
      var inName = qt.every(function (t) { return pt.some(function (w) { return w.indexOf(t) === 0; }); });
      var score = e.primary === q ? 0 : e.primary.indexOf(q) === 0 ? 1 : inName ? 2 : 3;
      if (score === 3 && e.alt.some(function (a) { return a === q; })) score = 1.5;
      out.push({ id: e.id, score: score, len: e.primary.length });
    }
    out.sort(function (a, b) { return a.score - b.score || a.len - b.len || (a.id < b.id ? -1 : 1); });
    return out.slice(0, limit || 50).map(function (r) { return r.id; });
  }

  // ---------------------------------------------------------------- filters
  /* filters: { regions:[], groups:[], specimen:[], images:'with'|'all'|'without', review:'all'|'marked'|'unseen' }
     Empty arrays mean "any". */
  function defaultFilters() {
    return { regions: [], groups: [], specimen: [], images: "with", review: "all" };
  }

  function matches(s, f, marks, seen) {
    if (f.regions && f.regions.length && f.regions.indexOf(s.region) < 0) return false;
    if (f.groups && f.groups.length && f.groups.indexOf(s.categoryGroup) < 0) return false;
    if (f.specimen && f.specimen.length && !s.specimen.some(function (m) { return f.specimen.indexOf(m) >= 0; })) return false;
    var has = s.images.length > 0;
    if (f.images === "with" && !has) return false;
    if (f.images === "without" && has) return false;
    if (f.review === "marked" && !(marks && marks[s.id])) return false;
    if (f.review === "unseen" && seen && seen.indexOf(s.id) >= 0) return false;
    return true;
  }

  function pool(structures, f, marks, seen) {
    return structures.filter(function (s) { return matches(s, f, marks, seen); }).map(function (s) { return s.id; });
  }

  // ---------------------------------------------------------------- randomness
  function rng(seed) { // mulberry32, so tests are deterministic; app seeds from crypto/time
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffle(arr, rand) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rand() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  // ---------------------------------------------------------------- session / queue
  /* Session shape:
       queue   : ids still to show this round (front = next)
       roundSeen: ids already shown in the current round (so a structure never repeats within a round)
       seen    : ids shown at any time in this session (for the "not yet reviewed" filter)
       history : ids in display order; cursor = index of the structure on screen
       round   : round number (a round ends when the current pool is exhausted) */
  function newSession() {
    return { queue: [], roundSeen: [], seen: [], history: [], cursor: -1, round: 1 };
  }

  /* Rebuild the remaining queue for a (possibly new) pool, keeping what has already been shown this round. */
  function requeue(sess, poolIds, rand) {
    var shown = {};
    sess.roundSeen.forEach(function (id) { shown[id] = 1; });
    var current = sess.history[sess.cursor];
    sess.queue = shuffle(poolIds.filter(function (id) { return !shown[id] && id !== current; }), rand);
    return sess;
  }

  /* Advance to the next structure. Returns { id, newRound, revisit } or null if the pool is empty.
     isEligible(id) re-checks filters at draw time (e.g. a structure unmarked while in review-only mode). */
  function next(sess, poolIds, isEligible, rand) {
    if (sess.cursor < sess.history.length - 1) { // moving forward again after "Previous"
      sess.cursor++;
      return { id: sess.history[sess.cursor], newRound: false, revisit: true };
    }
    if (!poolIds.length) return null;
    var newRound = false;
    var id = null;
    for (var guard = 0; guard < 2 && id === null; guard++) {
      while (sess.queue.length) {
        var cand = sess.queue.shift();
        if (isEligible(cand)) { id = cand; break; }
      }
      if (id === null) { // pool exhausted: start a new round, avoiding an immediate repeat of the current one
        var current = sess.history[sess.cursor];
        sess.round++;
        sess.roundSeen = [];
        newRound = true;
        var fresh = shuffle(poolIds, rand);
        if (fresh.length > 1 && fresh[0] === current) { fresh.push(fresh.shift()); }
        sess.queue = fresh;
      }
    }
    if (id === null) return null;
    show(sess, id);
    return { id: id, newRound: newRound, revisit: false };
  }

  /* Display a specific structure now (search jump or first draw). It counts as shown for this round. */
  function show(sess, id) {
    sess.history = sess.history.slice(0, sess.cursor + 1);
    sess.history.push(id);
    if (sess.history.length > 500) sess.history = sess.history.slice(-500);
    sess.cursor = sess.history.length - 1;
    if (sess.roundSeen.indexOf(id) < 0) sess.roundSeen.push(id);
    if (sess.seen.indexOf(id) < 0) sess.seen.push(id);
    sess.queue = sess.queue.filter(function (q) { return q !== id; });
    return sess;
  }

  function previous(sess) {
    if (sess.cursor <= 0) return null;
    sess.cursor--;
    return sess.history[sess.cursor];
  }

  function peekNext(sess, isEligible) {
    if (sess.cursor < sess.history.length - 1) return sess.history[sess.cursor + 1];
    for (var i = 0; i < sess.queue.length; i++) if (isEligible(sess.queue[i])) return sess.queue[i];
    return null;
  }

  /* Drop ids that no longer exist after a data update. */
  function sanitize(sess, knownIds) {
    var k = {};
    knownIds.forEach(function (id) { k[id] = 1; });
    var f = function (id) { return k[id]; };
    var cur = sess.history[sess.cursor];
    sess.queue = (sess.queue || []).filter(f);
    sess.roundSeen = (sess.roundSeen || []).filter(f);
    sess.seen = (sess.seen || []).filter(f);
    sess.history = (sess.history || []).filter(f);
    var idx = sess.history.lastIndexOf(cur);
    sess.cursor = idx >= 0 ? idx : sess.history.length - 1;
    if (!sess.round) sess.round = 1;
    return sess;
  }

  // ---------------------------------------------------------------- storage (never throws)
  function makeStore(storage, prefix) {
    function key(k) { return prefix + k; }
    return {
      get: function (k, fallback) {
        try {
          var v = storage && storage.getItem(key(k));
          return v == null ? fallback : JSON.parse(v);
        } catch (e) { return fallback; }
      },
      set: function (k, v) {
        try { storage && storage.setItem(key(k), JSON.stringify(v)); return true; } catch (e) { return false; }
      },
      remove: function (k) { try { storage && storage.removeItem(key(k)); } catch (e) { /* ignore */ } },
    };
  }

  function parseMarksImport(text, knownIds) {
    var obj = JSON.parse(text);
    var src = obj && obj.marks ? obj.marks : obj;
    if (!src || typeof src !== "object") throw new Error("Not a review-marker file");
    var known = {};
    knownIds.forEach(function (id) { known[id] = 1; });
    var out = {}, skipped = 0;
    Object.keys(src).forEach(function (id) {
      if (known[id]) out[id] = typeof src[id] === "number" ? src[id] : Date.now();
      else skipped++;
    });
    return { marks: out, skipped: skipped };
  }

  global.CadaverLogic = {
    normalize: normalize, buildSearchIndex: buildSearchIndex, search: search,
    defaultFilters: defaultFilters, matches: matches, pool: pool,
    rng: rng, shuffle: shuffle,
    newSession: newSession, requeue: requeue, next: next, show: show, previous: previous, peekNext: peekNext,
    sanitize: sanitize, makeStore: makeStore, parseMarksImport: parseMarksImport,
  };
})(typeof window !== "undefined" ? window : globalThis);
