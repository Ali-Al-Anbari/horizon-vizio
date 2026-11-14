(function (root) {
  "use strict";
  // Temporary, opt-in TV diagnostic. No image URL, title, history, or key log is kept.
  function create(doc, clock) {
    var modes = [
      { label: "Baseline", delay: 110 }, { label: "Immediate", delay: 0 },
      { label: "150ms", delay: 150 }, { label: "250ms", delay: 250 },
      { label: "300ms", delay: 300 }, { label: "400ms", delay: 400 },
      { label: "500ms", delay: 500 }, { label: "Fixed Hero", fixed: true }
    ];
    var active = false, configuring = false, downCount = 0, downAt = 0;
    var modeIndex = 0, choice = 0, modeChanged = null, frame = 0, ticker = 0;
    var panel = null, samples = [], inputSamples = [], focusSamples = [], handlerSamples = [];
    var heroWorkSamples = [], heroLatencySamples = [];
    var lastFrame = 0, started = 0, keyAt = 0;
    var posterLoads = 0, heroLoads = 0, heroLoadStarts = 0, heroAttempts = 0, heroSwaps = 0;
    var decodeAttempts = 0, decodeCompleted = 0, imageErrors = 0, maxNodes = 0;
    var longTasks = 0, longTaskSupported = false, longObserver = null;
    var imageStarts = typeof WeakMap === "function" ? new WeakMap() : null;
    var imageDurations = [], observer = null;
    function now() { return clock.performance && clock.performance.now ? clock.performance.now() : Date.now(); }
    function add(list, value) { if (!Number.isFinite(value)) return;
      if (list.length >= 128) list.shift(); list.push(Math.round(value * 10) / 10); }
    function percentile(list, fraction) { if (!list.length) return "n/a";
      var copy = list.slice().sort(function (a, b) { return a - b; });
      return copy[Math.min(copy.length - 1, Math.floor(copy.length * fraction))].toFixed(1) + "ms"; }
    function median(list) { return percentile(list, .5); }
    function sampleNodes() { maxNodes = Math.max(maxNodes, doc.querySelectorAll("*").length); }
    function paint() {
      if (!active) return;
      if (configuring) {
        panel.textContent = "WATCH HERO TEST · Select a mode\n"
          + "◀/▶ or ▲/▼ choose · OK apply · Back cancel\n\n"
          + modes.map(function (item, index) {
            return (index === choice ? "▶ " : "  ") + item.label
              + (index === modeIndex ? " · current" : "");
          }).join("\n");
        return;
      }
      sampleNodes();
      var slow = samples.filter(function (value) { return value > 50; }).length;
      var missed = samples.reduce(function (total, value) {
        return total + (value > 25 ? Math.max(0, Math.floor(value / 16.7) - 1) : 0);
      }, 0);
      var heap = clock.performance && clock.performance.memory
        && Number.isFinite(clock.performance.memory.usedJSHeapSize)
        ? Math.round(clock.performance.memory.usedJSHeapSize / 1048576) + " MB" : "unavailable";
      panel.textContent = "WATCH HERO TEST · " + modes[modeIndex].label
        + " · Back hides · Settings rail: Down ×5 changes mode\n"
        + "Key→focus p50/p95: " + median(focusSamples) + "/" + percentile(focusSamples, .95) + "\n"
        + "Handler p50/p95: " + median(handlerSamples) + "/" + percentile(handlerSamples, .95) + "\n"
        + "Key→next frame p50/p95: " + median(inputSamples) + "/" + percentile(inputSamples, .95) + "\n"
        + "Frame p50/p95: " + median(samples) + "/" + percentile(samples, .95)
        + " · >50ms: " + slow + "/" + samples.length + " · est. missed: " + missed + "\n"
        + "Hero attempts/swaps: " + heroAttempts + "/" + heroSwaps
        + " · Loads: " + heroLoads + "/" + heroLoadStarts
        + " · Decode: " + decodeCompleted + "/" + decodeAttempts + "\n"
        + "Hero setup p95: " + percentile(heroWorkSamples, .95)
        + " · settle p95: " + percentile(heroLatencySamples, .95) + "\n"
        + "Poster loads: " + posterLoads + " · Errors: " + imageErrors
        + " · Long tasks: " + (longTaskSupported ? longTasks : "unsupported") + "\n"
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
    function reset() { samples = []; inputSamples = []; focusSamples = []; handlerSamples = []; imageDurations = [];
      heroWorkSamples = []; heroLatencySamples = [];
      posterLoads = 0; heroLoads = 0; heroLoadStarts = 0; heroAttempts = 0; heroSwaps = 0;
      decodeAttempts = 0; decodeCompleted = 0; imageErrors = 0; longTasks = 0;
      maxNodes = 0; started = now(); lastFrame = 0; paint(); }
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
      if (typeof clock.PerformanceObserver === "function") {
        try { longObserver = new clock.PerformanceObserver(function (list) {
          longTasks += list.getEntries().length;
        }); longObserver.observe({ entryTypes: ["longtask"] }); longTaskSupported = true;
        } catch (_error) { longObserver = null; }
      }
    }
    function close() {
      if (!active) return;
      active = false; if (frame && clock.cancelAnimationFrame) clock.cancelAnimationFrame(frame);
      clock.clearInterval(ticker);
      doc.removeEventListener("load", imageEvent, true); doc.removeEventListener("error", imageEvent, true);
      if (observer) { observer.disconnect(); observer = null; }
      if (longObserver) { longObserver.disconnect(); longObserver = null; }
      panel.remove(); panel = null; lastFrame = 0;
      configuring = false; keyAt = 0;
    }
    function handle(key, view, focused, repeat) {
      if (view !== "watch") { downCount = 0; if (active) close(); return false; }
      if (configuring) {
        if (key === "Back") { configuring = false; paint(); return true; }
        if (key === "ArrowRight" || key === "ArrowDown") choice = (choice + 1) % modes.length;
        else if (key === "ArrowLeft" || key === "ArrowUp") choice = (choice + modes.length - 1) % modes.length;
        else if (key === "OK") {
          modeIndex = choice; configuring = false; reset();
          if (modeChanged) modeChanged(modes[modeIndex]);
          return true;
        } else return true;
        paint(); return true;
      }
      // Down is normally a no-op on the last rail control, even on SmartCast.
      if (focused && focused.id === "settings-toggle" && key === "ArrowDown") {
        if (repeat) { downCount = 0; return false; }
        var stamp = now();
        downCount = stamp - downAt > 2200 ? 1 : downCount + 1;
        downAt = stamp;
        if (downCount === 5) {
          downCount = 0; if (!active) open();
          choice = modeIndex; configuring = true; paint(); return true;
        }
      } else downCount = 0;
      if (active && key === "Back") { close(); return true; }
      return false;
    }
    function keyStart(key) {
      if (!active || configuring || key.indexOf("Arrow") !== 0) return 0;
      keyAt = now(); return keyAt;
    }
    function focusApplied() {
      if (keyAt) { add(focusSamples, now() - keyAt); keyAt = 0; }
    }
    function keyEnd(began) {
      if (!active || !began) return;
      add(handlerSamples, now() - began);
      if (clock.requestAnimationFrame) clock.requestAnimationFrame(function () {
        if (active) add(inputSamples, now() - began);
      });
      keyAt = 0;
    }
    // Older cached Watch assets still call input(); keep that diagnostic hook inert-safe.
    function input() {
      if (!active || !clock.requestAnimationFrame) return;
      var began = now();
      clock.requestAnimationFrame(function () { if (active) add(inputSamples, now() - began); });
    }
    function heroAttempt() { if (active) { heroAttempts++; return now(); } return 0; }
    function heroWork(began) { if (active && began) add(heroWorkSamples, now() - began); }
    function heroSettled(began) { if (active && began) add(heroLatencySamples, now() - began); }
    function heroSwap() { if (active) heroSwaps++; }
    function decodeStart() { if (active) { decodeAttempts++; return now(); } return 0; }
    function decodeEnd(began, failed) {
      if (!active || !began) return;
      if (!failed) decodeCompleted++;
    }
    function report() {
      return { mode: modes[modeIndex].label, delay: modes[modeIndex].delay,
        focusP50: median(focusSamples), focusP95: percentile(focusSamples, .95),
        handlerP95: percentile(handlerSamples, .95), frameP95: percentile(samples, .95),
        frames: samples.length, over50: samples.filter(function (value) { return value > 50; }).length,
        heroAttempts: heroAttempts, heroSwaps: heroSwaps, heroLoads: heroLoads,
        heroLoadStarts: heroLoadStarts,
        decodeAttempts: decodeAttempts, decodeCompleted: decodeCompleted,
        posterLoads: posterLoads, longTasks: longTaskSupported ? longTasks : null,
        nodes: doc.querySelectorAll("*").length, peakNodes: maxNodes };
    }
    function onModeChange(callback) { modeChanged = callback; }
    function mode() { return modes[modeIndex]; }
    function heroStart() { if (active) { heroLoadStarts++; return now(); } return 0; }
    function heroEnd(began, failed) { if (!active || !began) return;
      if (failed) imageErrors++; else { heroLoads++; add(imageDurations, now() - began); }
    }
    return { handle: handle, input: input, keyStart: keyStart, keyEnd: keyEnd, focusApplied: focusApplied,
      heroStart: heroStart, heroEnd: heroEnd, heroAttempt: heroAttempt, heroSwap: heroSwap,
      heroWork: heroWork, heroSettled: heroSettled,
      decodeStart: decodeStart, decodeEnd: decodeEnd, onModeChange: onModeChange,
      mode: mode, report: report, close: close, active: function () { return active; } };
  }
  root.HorizonWatchPerformance = { create: create };
})(typeof window !== "undefined" ? window : globalThis);
