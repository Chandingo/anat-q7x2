/* Cadaver ID — UI controller. Depends on CadaverLogic, CadaverViewer, CadaverOffline. */
(function () {
  "use strict";
  var L = window.CadaverLogic;
  var $ = function (id) { return document.getElementById(id); };

  var REVEAL_GUARD_MS = 450; // ignore a reveal tap that lands right after navigating (double taps)
  var IMAGE_FILTERS = [["with", "With verified image"], ["all", "All testable"], ["without", "Without image"]];
  var REVIEW_FILTERS = [["all", "All"], ["marked", "Marked for review"], ["unseen", "Not yet seen this session"]];
  var RELATION_TEXT = {
    part_of: "Shows a part of this structure (head / tendon)",
    group_member: "Shows one member of this muscle group",
    component: "Shows one member of this set",
    regional_variant: "Shown on a specific vertebra",
    co_labelled: "Image labels several structures",
  };

  // ------------------------------------------------------------------ state
  var store = L.makeStore(safeLocalStorage(), "cadaverID.");
  var data = null, byId = {}, index = [];
  var marks = store.get("marks", {}) || {};
  var settings = store.get("settings", null) || { filters: L.defaultFilters(), hideName: false, screen: "setup" };
  var sess = store.get("session", null) || L.newSession();
  var rand = L.rng(seed());
  var ui = { revealed: false, showQuestion: false, lastNavAt: 0, imgIndex: 0 };
  var viewer, hintViewer, fullViewer;
  var storageWarned = false;

  function safeLocalStorage() { try { return window.localStorage; } catch (e) { return null; } }
  function seed() {
    try { var a = new Uint32Array(1); crypto.getRandomValues(a); return a[0]; } catch (e) { return Date.now() >>> 0; }
  }
  function save() {
    var ok = store.set("marks", marks) & store.set("settings", settings) & store.set("session", sess);
    if (!ok && !storageWarned) { storageWarned = true; toast("This browser mode cannot save review markers (private browsing?)."); }
  }
  function current() { return byId[sess.history[sess.cursor]] || null; }

  // ------------------------------------------------------------------ boot
  function boot() {
    document.addEventListener("gesturestart", function (e) { e.preventDefault(); }); // no accidental page zoom
    viewer = new window.CadaverViewer($("viewer"), { onChange: onImageChange });
    hintViewer = new window.CadaverViewer($("hintViewer"));
    fullViewer = new window.CadaverViewer($("fullViewer"), { onChange: function (i) { syncFullCaption(i); } });
    wire();
    fetch("data/structures.json", { cache: "no-cache" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (d) {
        data = d;
        d.structures.forEach(function (s) { byId[s.id] = s; });
        index = L.buildSearchIndex(d.structures);
        marks = filterKnown(marks);
        sess = L.sanitize(sess, d.structures.map(function (s) { return s.id; }));
        settings.filters = Object.assign(L.defaultFilters(), settings.filters || {});
        renderSetup();
        if (settings.screen === "study" && current()) goStudy(false); else goSetup();
        save();
      })
      .catch(function (e) {
        $("loadingMsg").textContent = "Could not load the structure list (" + e.message + "). " +
          "If you are offline, open the app once while connected and download it for offline use.";
      });
    window.CadaverOffline.register().then(refreshOffline);
    window.CadaverOffline.onChange(refreshOffline);
    window.CadaverOffline.pruneStale().catch(function () {});
    document.addEventListener("visibilitychange", save);
  }

  function filterKnown(obj) {
    var out = {};
    Object.keys(obj || {}).forEach(function (k) { if (byId[k]) out[k] = obj[k]; });
    return out;
  }

  // ------------------------------------------------------------------ pool helpers
  function filters() { return settings.filters; }
  function poolIds() { return L.pool(data.structures, filters(), marks, sess.seen); }
  function eligible(id) { return !!byId[id] && L.matches(byId[id], filters(), marks, sess.seen); }

  function filterSummary() {
    var f = filters(), parts = [];
    parts.push(f.regions.length ? f.regions.join(", ") : "All regions");
    if (f.groups.length) parts.push(f.groups.join(", "));
    if (f.specimen.length) parts.push(f.specimen.join("/"));
    if (f.review === "marked") parts.push("Marked only");
    if (f.review === "unseen") parts.push("Not yet seen");
    if (f.images === "without") parts.push("No-image structures");
    return parts.join(" · ");
  }

  // ------------------------------------------------------------------ setup screen
  function renderSetup() {
    var all = data.structures;
    var f = filters();
    function count(pred) { return all.filter(pred).length; }
    function chipRow(el, values, selected, countFn, onToggle) {
      el.innerHTML = "";
      values.forEach(function (v) {
        var b = document.createElement("button");
        b.type = "button"; b.className = "chip";
        b.setAttribute("aria-pressed", selected.indexOf(v) >= 0 ? "true" : "false");
        b.innerHTML = esc(v) + ' <span class="n">' + countFn(v) + "</span>";
        b.addEventListener("click", function () { onToggle(v); });
        el.appendChild(b);
      });
    }
    var regions = uniq(all.map(function (s) { return s.region; }));
    var groups = uniq(all.map(function (s) { return s.categoryGroup; }));
    var specimen = uniq([].concat.apply([], all.map(function (s) { return s.specimen; })));
    chipRow($("fRegions"), regions, f.regions, function (v) { return count(function (s) { return s.region === v; }); },
      function (v) { toggleIn(f.regions, v); afterFilterChange(); });
    chipRow($("fGroups"), groups, f.groups, function (v) { return count(function (s) { return s.categoryGroup === v; }); },
      function (v) { toggleIn(f.groups, v); afterFilterChange(); });
    chipRow($("fSpecimen"), specimen, f.specimen, function (v) { return count(function (s) { return s.specimen.indexOf(v) >= 0; }); },
      function (v) { toggleIn(f.specimen, v); afterFilterChange(); });
    seg($("fImages"), IMAGE_FILTERS, f.images, function (v) {
      return v === "all" ? all.length : count(function (s) { return v === "with" ? s.images.length : !s.images.length; });
    }, function (v) { f.images = v; afterFilterChange(); });
    seg($("fReview"), REVIEW_FILTERS, f.review, function (v) {
      return v === "all" ? "" : v === "marked" ? Object.keys(marks).length : all.length - sess.seen.length;
    }, function (v) { f.review = v; afterFilterChange(); });

    var n = poolIds().length;
    $("poolCount").innerHTML = n ? "<b>" + n + "</b> structure" + (n === 1 ? "" : "s") + " match" + (n === 1 ? "es" : "") +
      '<br><span class="muted small">' + esc(filterSummary()) + "</span>"
      : "<b>0</b> structures match these filters.";
    $("btnStart").disabled = n === 0;
    $("btnResume").hidden = !current();
    var mc = Object.keys(marks).length;
    $("markCount").textContent = mc + " structure" + (mc === 1 ? "" : "s") + " marked for review.";
    var withImg = all.filter(function (s) { return s.images.length; }).length;
    $("dataInfo").textContent = "Data version " + data.version + " · imported " + data.generated.slice(0, 16).replace("T", " ") +
      " · " + all.length + " MSS structures, " + withImg + " with verified Anki answer images · Phase 2 mapping " +
      data.source.phase2_mapping_generated.slice(0, 16).replace("T", " ") + ".";
    $("poolSummary").textContent = "Cadaver ID";
    $("progress").textContent = "";
  }

  function seg(el, opts, value, countFn, onPick) {
    el.innerHTML = "";
    opts.forEach(function (o) {
      var b = document.createElement("button");
      b.type = "button"; b.className = "chip";
      b.setAttribute("aria-pressed", o[0] === value ? "true" : "false");
      var c = countFn(o[0]);
      b.innerHTML = esc(o[1]) + (c !== "" ? ' <span class="n">' + c + "</span>" : "");
      b.addEventListener("click", function () { onPick(o[0]); });
      el.appendChild(b);
    });
  }

  function afterFilterChange() { save(); renderSetup(); }
  function toggleIn(arr, v) { var i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); else arr.push(v); }
  function uniq(a) { return a.filter(function (v, i) { return a.indexOf(v) === i; }); }

  // ------------------------------------------------------------------ navigation
  function goSetup() {
    settings.screen = "setup"; save();
    $("app").dataset.screen = "setup";
    renderSetup();
  }

  function goStudy(drawIfEmpty) {
    settings.screen = "study";
    $("app").dataset.screen = "study";
    if (!current() && drawIfEmpty !== false) { nextStructure(); return; }
    render();
    save();
  }

  function startReview() {
    var ids = poolIds();
    if (!ids.length) { toast("No structures match these filters."); return; }
    sess.history = sess.history.slice(0, sess.cursor + 1); // Start always draws a new structure
    L.requeue(sess, ids, rand);
    settings.screen = "study";
    $("app").dataset.screen = "study";
    nextStructure(true);
  }

  function nextStructure(fromStart) {
    var ids = poolIds();
    var cur = current();
    // when starting, don't re-show the structure already on screen
    var r = L.next(sess, ids, function (id) { return eligible(id) && !(fromStart && cur && id === cur.id); }, rand);
    if (!r) { toast("No structures match these filters. Change them in Filters."); render(); return; }
    if (r.newRound) toast("Round " + (sess.round - 1) + " complete — all " + ids.length + " structures covered. Starting round " + sess.round + ".");
    ui.lastNavAt = Date.now();
    render(); save();
  }

  function previousStructure() {
    if (L.previous(sess) === null) { toast("This is the first structure of the session."); return; }
    ui.lastNavAt = Date.now();
    render(); save();
  }

  function jumpTo(id) {
    L.show(sess, id);
    settings.screen = "study";
    $("app").dataset.screen = "study";
    ui.lastNavAt = Date.now();
    render(); save();
  }

  // ------------------------------------------------------------------ study rendering
  function render() {
    var s = current();
    if (!s) return;
    ui.revealed = false; ui.showQuestion = false; ui.imgIndex = 0;
    $("stageCover").hidden = false;
    $("stageAnswer").hidden = true;
    $("stageHint").hidden = true;

    $("sName").textContent = s.name;
    var mss = s.mssNames.filter(function (n) { return L.normalize(n) !== L.normalize(s.name); });
    var mssText = mss.length ? "MSS list: " + mss.join(" / ") : "";
    var shown = mss.concat([s.name]).map(L.normalize);
    var syn = s.synonyms.filter(function (n) {
      var k = L.normalize(n);
      return !shown.some(function (m) { return m === k || m.indexOf(k + " ") === 0 || m.indexOf(" " + k) >= 0; });
    });
    if (syn.length) mssText += (mssText ? " · " : "") + "Also: " + syn.join(", ");
    $("sMss").textContent = mssText;
    $("sMss").hidden = !mssText;
    $("sRegion").textContent = s.region + (s.alsoRegions.length ? " (also " + s.alsoRegions.join(", ") + ")" : "");
    $("sCategory").textContent = s.category;
    $("sGuide").textContent = s.guide.join(" | ") + (s.listedUnder.length ? " · under " + s.listedUnder.join(", ") : "");
    var chips = s.specimen.map(function (m) { return '<span class="tag">Tested on: ' + esc(m) + "</span>"; });
    if (!s.images.length) chips.push('<span class="tag warn">No verified Anki image</span>');
    if (s.partialOnly) chips.push('<span class="tag warn">Image shows a part/member only</span>');
    $("sChips").innerHTML = chips.join("");

    applyHide();
    var n = s.images.length;
    $("revealSub").textContent = n ? (n === 1 ? "1 verified Anki image" : n + " verified Anki images — swipe between them")
      : "No verified Anki image — the answer will be shown as text";
    $("btnHint").disabled = !n;
    $("btnHint").textContent = n ? "Location hint" : "No location hint";
    renderMark();
    renderRelated(s);
    renderProgress();
    preload(s);
  }

  function renderProgress() {
    var ids = poolIds();
    var inPool = {};
    ids.forEach(function (id) { inPool[id] = 1; });
    var done = sess.roundSeen.filter(function (id) { return inPool[id]; }).length;
    $("poolSummary").textContent = filterSummary();
    $("progress").textContent = "Round " + sess.round + " · " + done + " of " + ids.length + " seen" +
      (sess.cursor < sess.history.length - 1 ? " · viewing earlier structure" : "");
  }

  function applyHide() {
    var h = !!settings.hideName;
    $("infoBody").hidden = h;
    $("infoHidden").hidden = !h;
    $("btnHide").textContent = h ? "Show name" : "Hide name";
    $("btnHide").setAttribute("aria-pressed", h ? "true" : "false");
    $("relatedBox").classList.toggle("is-hidden-name", h);
    if (h) $("relatedBox").hidden = true; else if (current()) $("relatedBox").hidden = !current().related.length;
  }

  function renderMark() {
    var s = current();
    var on = !!(s && marks[s.id]);
    $("btnMark").setAttribute("aria-pressed", on ? "true" : "false");
    $("btnMark").textContent = on ? "★ Marked for review" : "☆ Mark for review";
  }

  function renderRelated(s) {
    var box = $("relatedBox"), list = $("relatedList");
    list.innerHTML = "";
    box.open = false;
    box.hidden = !s.related.length || !!settings.hideName;
    $("relatedSummary").textContent = "Related Anki cards (" + s.related.length + ")";
    s.related.forEach(function (r) {
      var li = document.createElement("li");
      var b = document.createElement("button");
      b.type = "button";
      b.innerHTML = '<span class="rt">' + esc(r.type) + "</span>" + esc(r.keywords);
      b.addEventListener("click", function () {
        openFull([{ src: r.a, alt: r.type + " card: " + r.keywords, caption: r.type + " card " + r.card + " · " + r.keywords +
          " (related card — not part of the verified answer key)" }], 0);
      });
      li.appendChild(b); list.appendChild(li);
    });
  }

  function imageItems(s, useQuestion) {
    return s.images.map(function (im, i) {
      var flags = [];
      if (RELATION_TEXT[im.relation]) flags.push(RELATION_TEXT[im.relation]);
      if (im.multiLabel && im.relation !== "co_labelled") flags.push("Image labels several structures");
      if (im.modality && im.modality !== "non-imaging") flags.push(im.modality);
      return {
        src: useQuestion ? im.q : im.a,
        alt: (useQuestion ? "Question image " : "Answer image ") + (i + 1) + " for " + s.name,
        caption: (useQuestion ? "Question image (unlabelled) · " : "") + "Anki card " + im.card + " · “" + im.keywords + "”" +
          (flags.length ? " · " + flags.join(" · ") : ""),
      };
    });
  }

  function reveal() {
    if (Date.now() - ui.lastNavAt < REVEAL_GUARD_MS) return;
    var s = current();
    if (!s) return;
    ui.revealed = true;
    $("stageCover").hidden = true;
    $("stageHint").hidden = true;
    $("stageAnswer").hidden = false;
    var has = s.images.length > 0;
    $("viewer").hidden = !has;
    $("noImage").hidden = has;
    $("btnQA").hidden = !has; $("btnFull").hidden = !has;
    if (has) {
      ui.showQuestion = false;
      $("btnQA").textContent = "Show question image";
      viewer.setItems(imageItems(s, false), 0);
    } else {
      $("noImageName").textContent = s.name;
      $("noImageWhy").textContent = s.notes || "";
      $("imgCounter").textContent = "";
      $("imgCaption").textContent = "Answer shown as text only.";
    }
  }

  function hideAnswer() {
    ui.revealed = false;
    $("stageAnswer").hidden = true;
    $("stageCover").hidden = false;
  }

  function onImageChange(i, it) {
    ui.imgIndex = i;
    var s = current();
    $("imgCounter").textContent = s && s.images.length > 1 ? (i + 1) + " / " + s.images.length : "";
    $("imgCaption").textContent = it.caption;
  }

  function toggleQA() {
    var s = current();
    if (!s || !s.images.length) return;
    ui.showQuestion = !ui.showQuestion;
    $("btnQA").textContent = ui.showQuestion ? "Show answer image" : "Show question image";
    viewer.setItems(imageItems(s, ui.showQuestion), ui.imgIndex);
  }

  function openHint() {
    var s = current();
    if (!s || !s.images.length) return;
    $("stageCover").hidden = true;
    $("stageAnswer").hidden = true;
    $("stageHint").hidden = false;
    hintViewer.setItems(imageItems(s, true), 0);
  }
  function closeHint() { $("stageHint").hidden = true; if (ui.revealed) $("stageAnswer").hidden = false; else $("stageCover").hidden = false; }

  var fullItems = [];
  function openFull(items, i) {
    fullItems = items;
    $("ovFull").hidden = false;
    fullViewer.setItems(items, i);
    syncFullCaption(i);
  }
  function syncFullCaption(i) { var it = fullItems[i]; $("fullCaption").textContent = it ? it.caption : ""; }

  function toggleMark() {
    var s = current(); if (!s) return;
    if (marks[s.id]) { delete marks[s.id]; toast("Unmarked: " + s.name); }
    else { marks[s.id] = Date.now(); toast("Marked for review: " + s.name); }
    renderMark(); save();
  }

  function preload(s) {
    var urls = [];
    if (s.images[0]) urls.push(s.images[0].a);
    var nid = L.peekNext(sess, eligible);
    if (nid && byId[nid] && byId[nid].images[0]) urls.push(byId[nid].images[0].a);
    urls.forEach(function (u) { var im = new Image(); im.decoding = "async"; im.src = u; });
  }

  // ------------------------------------------------------------------ search
  function openSearch() {
    $("ovSearch").hidden = false;
    $("inpSearch").value = "";
    renderSearch("");
    setTimeout(function () { $("inpSearch").focus(); }, 50);
  }
  function renderSearch(q) {
    var ul = $("searchResults");
    ul.innerHTML = "";
    if (!q.trim()) { ul.innerHTML = '<li class="empty">Type part of a name, MSS list wording or synonym (e.g. “profundus”, “peroneus”, “C2”).</li>'; return; }
    var ids = L.search(index, q, 60);
    if (!ids.length) { ul.innerHTML = '<li class="empty">No structure on the MSS list matches “' + esc(q) + "”.</li>"; return; }
    ids.forEach(function (id) {
      var s = byId[id];
      var li = document.createElement("li");
      var b = document.createElement("button");
      b.type = "button";
      var alt = s.mssNames.concat(s.synonyms).filter(function (n) { return L.normalize(n) !== L.normalize(s.name); });
      b.innerHTML = '<span class="r-name">' + esc(s.name) + (marks[id] ? ' <span class="r-flag">★</span>' : "") + "</span>" +
        '<span class="r-sub">' + esc(s.region + " · " + s.category) + (alt.length ? " · " + esc(alt.join(", ")) : "") +
        (s.images.length ? "" : ' · <span class="r-flag">no verified image</span>') + "</span>";
      b.addEventListener("click", function () { $("ovSearch").hidden = true; jumpTo(id); });
      li.appendChild(b); ul.appendChild(li);
    });
  }

  // ------------------------------------------------------------------ offline panel
  function refreshOffline() {
    var O = window.CadaverOffline;
    O.status().then(function (st) {
      var sum = O.summarize(st);
      var chip = $("btnOffline");
      chip.classList.remove("ok", "partial", "off");
      chip.classList.add(sum.level === "ok" ? "ok" : sum.level === "partial" ? "partial" : sum.level === "off" ? "off" : "none");
      $("offlineText").textContent = sum.text;
      if (!$("ovOffline").hidden) renderOfflinePanel(st, sum);
    }).catch(function () { $("offlineText").textContent = "Online only"; });
  }

  function mb(b) { return (b / 1048576).toFixed(b < 10485760 ? 1 : 0) + " MB"; }

  function renderOfflinePanel(st, sum) {
    $("offStatus").textContent = sum.text + " — " + sum.detail;
    var box = $("offTiers");
    box.innerHTML = "";
    if (!st.supported) { $("offStorage").textContent = ""; return; }
    Object.keys(st.tiers).forEach(function (k) {
      var t = st.tiers[k];
      var div = document.createElement("div");
      div.className = "off-tier";
      var full = t.cached === t.count;
      div.innerHTML = '<div class="t-name"><b>' + esc(t.label) + "</b>" + t.cached + " of " + t.count + " stored · " +
        mb(t.cachedBytes) + " of " + mb(t.totalBytes) + "</div>";
      var dl = document.createElement("button");
      dl.type = "button"; dl.className = "btn btn-primary btn-md";
      dl.textContent = full ? "Downloaded ✓" : "Download (" + mb(t.totalBytes - t.cachedBytes) + ")";
      dl.disabled = full;
      dl.addEventListener("click", function () { startDownload([k]); });
      var rm = document.createElement("button");
      rm.type = "button"; rm.className = "btn btn-ghost btn-md";
      rm.textContent = "Remove";
      rm.disabled = t.cached === 0;
      rm.addEventListener("click", function () { window.CadaverOffline.removeTier(k); });
      div.appendChild(dl); div.appendChild(rm);
      box.appendChild(div);
    });
    window.CadaverOffline.storageEstimate().then(function (e) {
      $("offStorage").textContent = e ? "Browser storage used: " + mb(e.usage) + (e.quota ? " of about " + mb(e.quota) + " allowed" : "") +
        (e.persisted ? " · protected from automatic clearing" : "") : "";
    });
  }

  function openOffline() {
    $("ovOffline").hidden = false;
    var O = window.CadaverOffline;
    if (!O.supported()) {
      $("offStatus").textContent = "Online only — " + O.why();
      $("offTiers").innerHTML = ""; $("offStorage").textContent = "";
      return;
    }
    $("offStatus").textContent = "Checking what is stored on this device…";
    O.status().then(function (st) { renderOfflinePanel(st, O.summarize(st)); });
  }

  function startDownload(keys) {
    var prog = $("offProgress"), bar = prog.querySelector(".bar span"), txt = prog.querySelector("p");
    prog.hidden = false; bar.style.width = "0";
    txt.textContent = "Starting download… keep this screen open.";
    window.CadaverOffline.download(keys, function (done, total, failed) {
      bar.style.width = (total ? Math.round(100 * done / total) : 100) + "%";
      txt.textContent = done + " of " + total + " images" + (failed ? " · " + failed + " failed" : "");
    }).then(function (r) {
      txt.textContent = r.failed ? r.failed + " images failed — tap Download again to retry." : "Download complete. Verified in storage.";
      refreshOffline();
    }).catch(function (e) { txt.textContent = "Download stopped: " + e.message; });
  }

  // ------------------------------------------------------------------ markers import/export
  function exportMarks() {
    var payload = { app: "Cadaver ID", exported: new Date().toISOString(), dataVersion: data.version, marks: marks };
    var blob = new Blob([JSON.stringify(payload, null, 1)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "cadaver-review-markers-" + new Date().toISOString().slice(0, 10) + ".json";
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function importMarks(file) {
    var fr = new FileReader();
    fr.onload = function () {
      try {
        var r = L.parseMarksImport(String(fr.result), data.structures.map(function (s) { return s.id; }));
        Object.keys(r.marks).forEach(function (k) { marks[k] = r.marks[k]; });
        save(); renderSetup();
        toast("Imported " + Object.keys(r.marks).length + " markers" + (r.skipped ? " (" + r.skipped + " unknown skipped)" : "") + ".");
      } catch (e) { toast("That file is not a review-marker export."); }
    };
    fr.readAsText(file);
  }

  // ------------------------------------------------------------------ wiring
  function wire() {
    $("btnStart").addEventListener("click", startReview);
    $("btnResume").addEventListener("click", function () { goStudy(false); });
    $("btnFilters").addEventListener("click", goSetup);
    $("btnNext").addEventListener("click", function () { nextStructure(false); });
    $("btnPrev").addEventListener("click", previousStructure);
    $("btnReveal").addEventListener("click", reveal);
    $("btnHideAnswer").addEventListener("click", hideAnswer);
    $("btnQA").addEventListener("click", toggleQA);
    $("btnFull").addEventListener("click", function () {
      var s = current(); if (s) openFull(imageItems(s, ui.showQuestion), ui.imgIndex);
    });
    $("btnCloseFull").addEventListener("click", function () { $("ovFull").hidden = true; });
    $("btnHint").addEventListener("click", openHint);
    $("btnCloseHint").addEventListener("click", closeHint);
    $("btnMark").addEventListener("click", toggleMark);
    $("btnHide").addEventListener("click", function () { settings.hideName = !settings.hideName; applyHide(); save(); });
    $("btnSearch").addEventListener("click", openSearch);
    $("btnCloseSearch").addEventListener("click", function () { $("ovSearch").hidden = true; });
    $("inpSearch").addEventListener("input", function (e) { renderSearch(e.target.value); });
    $("btnOffline").addEventListener("click", openOffline);
    $("btnCloseOffline").addEventListener("click", function () { $("ovOffline").hidden = true; });
    $("btnClearFilters").addEventListener("click", function () {
      var keep = settings.filters.images;
      settings.filters = L.defaultFilters(); settings.filters.images = keep; afterFilterChange();
    });
    $("btnNewSession").addEventListener("click", function () {
      if (!confirm("Start a new session? Review markers are kept; the list of structures seen so far is cleared.")) return;
      sess = L.newSession(); save(); renderSetup(); toast("New session started.");
    });
    $("btnExportMarks").addEventListener("click", exportMarks);
    $("inpImportMarks").addEventListener("change", function (e) { if (e.target.files[0]) importMarks(e.target.files[0]); e.target.value = ""; });
    $("btnClearMarks").addEventListener("click", function () {
      if (!confirm("Remove all review markers?")) return;
      marks = {}; save(); renderSetup(); renderMark(); toast("All markers cleared.");
    });
    document.addEventListener("keydown", function (e) { // convenience on a laptop; never required
      if (e.target && /input|textarea/i.test(e.target.tagName)) return;
      if (!$("ovFull").hidden && e.key === "Escape") { $("ovFull").hidden = true; return; }
      if ($("app").dataset.screen !== "study" || !$("ovSearch").hidden || !$("ovOffline").hidden) return;
      if (e.key === "ArrowRight") nextStructure(false);
      else if (e.key === "ArrowLeft") previousStructure();
      else if (e.key === " " || e.key === "Enter") { e.preventDefault(); if (ui.revealed) hideAnswer(); else reveal(); }
    });
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $("toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 3200);
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // test hook (used by the automated browser checks; harmless in normal use)
  window.__cadaverDebug = {
    state: function () { return { sess: sess, settings: settings, marks: marks, ui: ui, current: current() && current().id }; },
  };

  boot();
})();
