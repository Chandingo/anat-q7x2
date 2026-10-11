/* Touch image viewer: pinch-zoom, pan, double-tap zoom, swipe between images.
   Uses Pointer Events (iPadOS Safari 13+). Images are shown with their original proportions
   (contain-fit); nothing is cropped or redrawn. Exposed as window.CadaverViewer. */
(function (global) {
  "use strict";

  var MAX_SCALE = 6;
  var SWIPE_PX = 60;

  function Viewer(root, opts) {
    this.root = root;
    this.opts = opts || {};
    this.items = [];
    this.index = 0;
    this.scale = 1; this.tx = 0; this.ty = 0;
    this.pointers = new Map();
    this.gesture = null;
    this.lastTap = 0;

    root.classList.add("vw");
    root.innerHTML =
      '<div class="vw-stage" role="img">' +
      '  <img class="vw-img" alt="" draggable="false" decoding="async">' +
      '  <div class="vw-loading" hidden>Loading image…</div>' +
      '  <div class="vw-error" hidden>Image could not be loaded. Check your connection or offline download.</div>' +
      "</div>" +
      '<button class="vw-nav vw-prev" type="button" aria-label="Previous image">‹</button>' +
      '<button class="vw-nav vw-next" type="button" aria-label="Next image">›</button>' +
      '<div class="vw-dots" aria-hidden="true"></div>';
    this.stage = root.querySelector(".vw-stage");
    this.img = root.querySelector(".vw-img");
    this.loading = root.querySelector(".vw-loading");
    this.error = root.querySelector(".vw-error");
    this.dots = root.querySelector(".vw-dots");
    this.prevBtn = root.querySelector(".vw-prev");
    this.nextBtn = root.querySelector(".vw-next");

    var self = this;
    this.prevBtn.addEventListener("click", function () { self.go(self.index - 1); });
    this.nextBtn.addEventListener("click", function () { self.go(self.index + 1); });
    this.img.addEventListener("load", function () {
      self.loading.hidden = true; self.error.hidden = true; self.img.style.visibility = "visible"; self.reset();
    });
    this.img.addEventListener("error", function () {
      self.loading.hidden = true; self.error.hidden = false; self.img.style.visibility = "hidden";
    });
    this.stage.addEventListener("pointerdown", function (e) { self.onDown(e); });
    this.stage.addEventListener("pointermove", function (e) { self.onMove(e); });
    ["pointerup", "pointercancel", "pointerleave"].forEach(function (t) {
      self.stage.addEventListener(t, function (e) { self.onUp(e); });
    });
    window.addEventListener("resize", function () { self.reset(); });
  }

  Viewer.prototype.setItems = function (items, index) {
    this.items = items || [];
    this.go(index || 0, true);
  };

  Viewer.prototype.go = function (i, force) {
    if (!this.items.length) return;
    var n = Math.max(0, Math.min(this.items.length - 1, i));
    if (n === this.index && !force) return;
    this.index = n;
    var it = this.items[n];
    this.error.hidden = true;
    if (this.img.getAttribute("src") !== it.src) {
      this.loading.hidden = false;
      this.img.style.visibility = "hidden";
      this.img.src = it.src;
    }
    this.img.alt = it.alt || "";
    this.stage.setAttribute("aria-label", it.alt || "image");
    this.reset();
    this.renderChrome();
    // warm neighbours so swiping is instant
    [n - 1, n + 1].forEach(function (k) {
      if (this.items[k]) { var p = new Image(); p.decoding = "async"; p.src = this.items[k].src; }
    }, this);
    if (this.opts.onChange) this.opts.onChange(n, it);
  };

  Viewer.prototype.renderChrome = function () {
    var multi = this.items.length > 1;
    this.prevBtn.hidden = !multi || this.index === 0;
    this.nextBtn.hidden = !multi || this.index === this.items.length - 1;
    var html = "";
    if (multi) for (var i = 0; i < this.items.length; i++) html += '<span class="' + (i === this.index ? "on" : "") + '"></span>';
    this.dots.innerHTML = html;
  };

  // ------------------------------------------------------------- geometry
  Viewer.prototype.reset = function () { this.scale = 1; this.tx = 0; this.ty = 0; this.apply(false); };

  Viewer.prototype.clamp = function () {
    var r = this.stage.getBoundingClientRect();
    // the <img> box fills the stage and uses object-fit: contain, so compute the visible picture size
    var nw = this.img.naturalWidth || 16, nh = this.img.naturalHeight || 9;
    var fit = Math.min(r.width / nw, r.height / nh);
    var w = nw * fit, h = nh * fit; // fitted (unscaled) size
    var maxX = Math.max(0, (w * this.scale - r.width) / 2);
    var maxY = Math.max(0, (h * this.scale - r.height) / 2);
    this.tx = Math.max(-maxX, Math.min(maxX, this.tx));
    this.ty = Math.max(-maxY, Math.min(maxY, this.ty));
  };

  Viewer.prototype.apply = function (animate) {
    this.img.style.transition = animate ? "transform 180ms ease-out" : "none";
    this.img.style.transform = "translate(" + this.tx + "px," + this.ty + "px) scale(" + this.scale + ")";
    this.root.classList.toggle("zoomed", this.scale > 1.01);
  };

  Viewer.prototype.zoomAt = function (newScale, cx, cy) {
    var r = this.stage.getBoundingClientRect();
    var ox = cx - (r.left + r.width / 2), oy = cy - (r.top + r.height / 2);
    var s = Math.max(1, Math.min(MAX_SCALE, newScale));
    var k = s / this.scale;
    this.tx = ox - (ox - this.tx) * k;
    this.ty = oy - (oy - this.ty) * k;
    this.scale = s;
    if (s <= 1.001) { this.tx = 0; this.ty = 0; }
    this.clamp();
  };

  // ------------------------------------------------------------- gestures
  Viewer.prototype.onDown = function (e) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    try { this.stage.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) {
      var p = Array.from(this.pointers.values());
      this.gesture = { type: "pinch", d0: dist(p[0], p[1]), s0: this.scale, moved: true };
    } else if (this.pointers.size === 1) {
      this.gesture = { type: "drag", x0: e.clientX, y0: e.clientY, tx0: this.tx, ty0: this.ty, moved: false, t0: Date.now() };
    }
  };

  Viewer.prototype.onMove = function (e) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    var g = this.gesture;
    if (!g) return;
    if (g.type === "pinch" && this.pointers.size >= 2) {
      var p = Array.from(this.pointers.values());
      var mid = { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 };
      this.zoomAt(g.s0 * dist(p[0], p[1]) / g.d0, mid.x, mid.y);
      this.apply(false);
    } else if (g.type === "drag") {
      var dx = e.clientX - g.x0, dy = e.clientY - g.y0;
      if (Math.abs(dx) > 6 || Math.abs(dy) > 6) g.moved = true;
      if (this.scale > 1.01) {
        this.tx = g.tx0 + dx; this.ty = g.ty0 + dy; this.clamp(); this.apply(false);
      } else if (this.items.length > 1) {
        this.img.style.transition = "none";
        this.img.style.transform = "translateX(" + dx * 0.6 + "px)"; // swipe feedback
      }
    }
  };

  Viewer.prototype.onUp = function (e) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    var g = this.gesture;
    if (!g) return;
    if (g.type === "pinch") {
      if (this.pointers.size === 1) { // continue as a pan with the remaining finger
        var q = Array.from(this.pointers.values())[0];
        this.gesture = { type: "drag", x0: q.x, y0: q.y, tx0: this.tx, ty0: this.ty, moved: true, t0: Date.now() };
      } else { this.gesture = null; }
      if (this.scale < 1.05) { this.reset(); }
      return;
    }
    if (this.pointers.size > 0) return;
    this.gesture = null;
    var dx = e.clientX - g.x0, dy = e.clientY - g.y0;
    if (!g.moved) { // tap: double-tap toggles zoom
      var now = Date.now();
      if (now - this.lastTap < 300) {
        if (this.scale > 1.01) { this.reset(); this.apply(true); }
        else { this.zoomAt(2.5, e.clientX, e.clientY); this.apply(true); }
        this.lastTap = 0;
      } else { this.lastTap = now; }
      return;
    }
    if (this.scale <= 1.01) {
      if (this.items.length > 1 && Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy)) {
        this.go(this.index + (dx < 0 ? 1 : -1));
      } else { this.reset(); this.apply(true); }
    }
  };

  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y) || 1; }

  global.CadaverViewer = Viewer;
})(window);
