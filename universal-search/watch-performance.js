(function (root) {
  "use strict";
  // Temporary, opt-in TV diagnostic. No image URL, title, history, or key log is kept.
  function create(doc, clock) {
    var active = false, upCount = 0, upAt = 0, frame = 0, ticker = 0;
    var panel = null, samples = [], inputSamples = [], lastFrame = 0, started = 0;
    var posterLoads = 0, heroLoads = 0, imageErrors = 0, maxNodes = 0;
    var imageStarts = typeof WeakMap === "function" ? new WeakMap() : null;
    var imageDurations = [], observer = null;
    function now() { return clock.performance && clock.performance.now ? clock.performance.now() : Date.now(); }
    function add(list, value) { if (!Number.isFinite(value)) return;
      if (list.length >= 128) list.shift(); list.push(Math.round(value * 10) / 10); }
    function median(list) { if (!list.length) return "n/a";
      var copy = list.slice().sort(function (a, b) { return a - b; });
      return copy[Math.floor(copy.length / 2)].toFixed(1) + "ms"; }
    function sampleNodes() { maxNodes = Math.max(maxNodes, doc.querySelectorAll("*").length); }
    function paint() {
      if (!active) return;
      sampleNodes();
      var slow = samples.filter(function (value) { return value > 50; }).length;
      var heap = clock.performance && clock.performance.memory
        && Number.isFinite(clock.performance.memory.usedJSHeapSize)
        ? Math.round(clock.performance.memory.usedJSHeapSize / 1048576) + " MB" : "unavailable";
      panel.textContent = "WATCH PERFORMANCE · Back closes · OK resets\n"
        + "Input→next frame: " + median(inputSamples) + " (" + inputSamples.length + " samples)\n"
        + "Frame interval: " + median(samples) + " · >50ms: " + slow + "/" + samples.length + "\n"
        + "Poster loads: " + posterLoads + " · Hero loads: " + heroLoads + " · Errors: " + imageErrors + "\n"
        + "Observed image load timing: " + median(imageDurations) + "\n"
        + "DOM nodes: " + doc.querySelectorAll("*").length + " · Peak: " + maxNodes
        + " · Heap: " + heap + "\nSession: " + Math.floor((now() - started) / 1000) + "s";
    }
    function loop(time) {
      if (!active) return;
      if (lastFrame) add(samples, time - lastFrame);
      lastFrame = time;
      if (clock.requestAnimationFrame) frame = clock.requestAnimationFrame(loop);
    }
    function imageEvent(event) {
      if (!active || !event.target || event.target.tagName !== "IMG") return;
      var image = event.target;
      if (!image.closest || !image.closest("#watch-view")) return;
      if (event.type === "error") imageErrors++;
      else if (image.closest(".watch-hero-art")) heroLoads++;
      else if (image.closest(".home-card")) posterLoads++;
      var began = imageStarts && imageStarts.get(image);
      if (began && event.type === "load") add(imageDurations, now() - began);
      if (began) imageStarts.delete(image);
    }
    function reset() { samples = []; inputSamples = []; imageDurations = [];
      posterLoads = 0; heroLoads = 0; imageErrors = 0; maxNodes = 0; started = now(); paint(); }
    function open() {
      if (active) return;
      panel = doc.createElement("pre"); panel.className = "watch-performance-panel";
      panel.setAttribute("aria-label", "Watch performance diagnostics");
      doc.getElementById("watch-view").appendChild(panel);
      active = true; reset();
      doc.addEventListener("load", imageEvent, true);
      doc.addEventListener("error", imageEvent, true);
      if (imageStarts && typeof clock.MutationObserver === "function") {
        observer = new clock.MutationObserver(function (changes) {
          changes.forEach(function (change) { if (change.target.tagName === "IMG")
            imageStarts.set(change.target, now()); });
        });
        observer.observe(doc.getElementById("watch-view"), { subtree: true, attributes: true, attributeFilter: ["src"] });
      }
      if (clock.requestAnimationFrame) frame = clock.requestAnimationFrame(loop);
      ticker = clock.setInterval(paint, 1000);
    }
    function close() {
      if (!active) return;
      active = false; if (frame && clock.cancelAnimationFrame) clock.cancelAnimationFrame(frame);
      clock.clearInterval(ticker);
      doc.removeEventListener("load", imageEvent, true); doc.removeEventListener("error", imageEvent, true);
      if (observer) { observer.disconnect(); observer = null; }
      panel.remove(); panel = null; lastFrame = 0;
    }
    function handle(key, view, focused) {
      if (active) {
        if (key === "Back") { close(); return true; }
        if (key === "OK") { reset(); return true; }
        if (view !== "watch") close();
        return false;
      }
      if (view !== "watch" || !focused || focused.id !== "watch-toggle" || key !== "ArrowUp") {
        upCount = 0; return false;
      }
      var stamp = now();
      upCount = stamp - upAt > 2200 ? 1 : upCount + 1;
      upAt = stamp;
      if (upCount === 5) { upCount = 0; open(); return true; }
      return false;
    }
    function input() { if (!active) return;
      var began = now();
      if (clock.requestAnimationFrame) clock.requestAnimationFrame(function () {
        if (active) add(inputSamples, now() - began);
      });
    }
    function heroStart() { return active ? now() : 0; }
    function heroEnd(began, failed) { if (!active || !began) return;
      if (failed) imageErrors++; else { heroLoads++; add(imageDurations, now() - began); }
    }
    return { handle: handle, input: input, close: close, heroStart: heroStart, heroEnd: heroEnd,
      active: function () { return active; } };
  }
  root.HorizonWatchPerformance = { create: create };
})(typeof window !== "undefined" ? window : globalThis);
