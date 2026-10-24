(() => {
  "use strict";

  function queryValue(name) {
    const match = new RegExp(`(?:^|[?&])${name}(?:=([^&]*))?(?:&|$)`).exec(location.search || "");
    return match ? (match[1] || "1") : null;
  }

  function clock() {
    return typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now() : Date.now();
  }

  function percentile(values, fraction) {
    if (!values.length) return "—";
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.ceil(fraction * sorted.length) - 1].toFixed(0);
  }

  window.HorizonDiagnostics = {
    profile() {
      const selected = queryValue("perf");
      if (selected === "baseline") return "baseline";
      if (selected === "minimal") return "minimal";
      return "optimized";
    },
    start(profile) {
      if (queryValue("diagnostics") === null) return null;
      const panel = document.getElementById("diagnostics");
      if (!panel) return null;
      panel.hidden = false;
      const nodes = {};
      for (const name of ["indicator", "key", "arrival", "focus", "frame", "fps", "long-frames", "pending", "memory"]) {
        nodes[name] = document.getElementById(`diag-${name}`);
      }
      const summary = document.createElement("div");
      summary.className = "diagnostics-summary";
      panel.append(summary);
      const launchSummary = document.createElement("div");
      launchSummary.className = "diagnostics-summary";
      panel.append(launchSummary);
      let launch = null;

      function renderLaunch() {
        if (!launch) return;
        const elapsed = value => Number.isFinite(value) ? `${Math.round(value)} ms` : "pending";
        const serverDelta = (end, start) => Number.isFinite(end) && Number.isFinite(start) && end >= start
          ? end - start : null;
        const parts = [`${launch.name}: OK→send ${elapsed(launch.sent === null ? null : launch.sent - launch.started)}`];
        if (launch.queuedResponse !== null) parts.push(`send→queue response ${elapsed(launch.queuedResponse - launch.sent)}`);
        const pickupMs = serverDelta(launch.claimedAt, launch.queuedAt);
        const processingMs = serverDelta(launch.finishedAt, launch.claimedAt);
        if (pickupMs !== null) {
          parts.push(`queue→claim ${elapsed(pickupMs)} (server)`);
        }
        if (processingMs !== null) {
          parts.push(`claim→result ${elapsed(processingMs)} (server)`);
        }
        if (launch.observed !== null) parts.push(`OK→${launch.state} observed ${elapsed(launch.observed - launch.started)}`);
        launchSummary.textContent = parts.join(" | ");
      }
      const frameSamples = [];
      const keySamples = [];
      const pendingSamples = [];
      const maxSamples = 120;
      const nextFrame = typeof requestAnimationFrame === "function"
        ? requestAnimationFrame.bind(window)
        : callback => setTimeout(() => callback(clock()), 33);
      const frameSource = typeof requestAnimationFrame === "function" ? "rAF" : "timer proxy";
      let frameCount = 0;
      let longFrames = 0;
      let gapsOver100 = 0;
      let multiKeyFrames = 0;
      let quickPairs = 0;
      let repeats = 0;
      let lastArrowAt = 0;
      let lastArrowGap = "none";
      let lastFrame = 0;
      let lastFrameGap = null;
      let sampleStart = clock();
      let activeSample = null;
      let lastWallpaper = "none";
      let lastWallpaperAt = 0;
      let lastImage = "none";
      let lastImageAt = 0;
      let lastScroll = "none";
      let focusScrolls = 0;
      let flash = false;
      let framePosition = 0;
      let keyPosition = 0;

      function keep(list, value) {
        if (list.length < maxSamples) list.push(value);
        else if (list === frameSamples) list[framePosition++ % maxSamples] = value;
        else list[keyPosition++ % maxSamples] = value;
      }

      function sampleFrame() {
        const at = clock();
        if (lastFrame) {
          const gap = at - lastFrame;
          keep(frameSamples, gap);
          lastFrameGap = gap;
          if (gap > 50) longFrames++;
          if (gap > 100) gapsOver100++;
        }
        lastFrame = at;
        frameCount += 1;
        if (pendingSamples.length > 1) multiKeyFrames++;
        let lastSample = null;
        for (const sample of pendingSamples) {
          sample.frameMs = at - sample.at;
          if (sample.focusAt !== null) sample.focusToFrameMs = at - sample.focusAt;
          keep(keySamples, sample);
          lastSample = sample;
        }
        if (lastSample) nodes.frame.textContent = lastSample.frameMs.toFixed(1);
        if (pendingSamples.length) {
          pendingSamples.length = 0;
          nodes.pending.textContent = "0";
        }
        if (at - sampleStart >= 1000) {
          nodes.fps.textContent = String(Math.round(frameCount * 1000 / (at - sampleStart)));
          nodes["long-frames"].textContent = String(longFrames);
          frameCount = 0;
          sampleStart = at;
        }
        nextFrame(sampleFrame);
      }
      nextFrame(sampleFrame);

      const memory = typeof performance !== "undefined" ? performance.memory : null;
      nodes.memory.textContent = memory?.usedJSHeapSize
        ? `Heap ${(memory.usedJSHeapSize / 1048576).toFixed(1)} MB`
        : "Heap n/a";

      setInterval(() => {
        const handlers = keySamples.map(sample => sample.handlerMs).filter(value => value !== null);
        const frameTimes = keySamples.map(sample => sample.frameMs);
        const focusFrames = keySamples.map(sample => sample.focusToFrameMs)
          .filter(value => value !== null);
        const moves = keySamples.filter(sample => sample.arrow);
        const focusMismatch = moves.filter(sample => sample.moved && sample.focusChanges !== 1).length;
        summary.textContent = `${profile || "baseline"} · ${frameSource} | keys ${keySamples.length} (last ${maxSamples})`
          + ` | handler p95 ${percentile(handlers, .95)} ms | next frame p95 ${percentile(frameTimes, .95)} ms`
          + ` | focus→frame p95 ${percentile(focusFrames, .95)} ms`
          + ` | frame gap p95 ${percentile(frameSamples, .95)} ms; >100 ms ${gapsOver100}`
          + ` | last arrow gap ${lastArrowGap}; repeats ${repeats}`
          + ` | quick arrow pairs ${quickPairs}; multiple keys before frame ${multiKeyFrames}`
          + ` | unexpected focus count ${focusMismatch}; native focus scrolls ${focusScrolls}`
          + ` | last frame gap ${lastFrameGap === null ? "none" : `${lastFrameGap.toFixed(0)} ms`}; explicit scroll ${lastScroll}`
          + ` | image ${lastImage}${lastImageAt ? ` (${((clock() - lastImageAt) / 1000).toFixed(0)}s ago)` : ""}`
          + ` | wallpaper ${lastWallpaper}${lastWallpaperAt ? ` (${((clock() - lastWallpaperAt) / 1000).toFixed(0)}s ago)` : ""}`;
      }, 1000);

      return {
        launchStage(stage, data) {
          const at = clock();
          if (stage === "ok") {
            launch = { name: String(data || "app").slice(0, 24), started: at,
              sent: null, queuedResponse: null, queuedAt: null, claimedAt: null,
              finishedAt: null, observed: null, state: "result" };
          } else if (launch) {
            if (stage === "send") launch.sent = at;
            if (stage === "queued") {
              launch.queuedResponse = at;
              launch.queuedAt = Number.isFinite(data?.queuedAt) ? data.queuedAt : null;
            }
            if (stage === "processing" && launch.claimedAt === null) {
              launch.claimedAt = Number.isFinite(data?.claimedAt) ? data.claimedAt : null;
            }
            if (stage === "terminal") {
              launch.claimedAt = Number.isFinite(data?.claimedAt) ? data.claimedAt : launch.claimedAt;
              launch.finishedAt = Number.isFinite(data?.finishedAt) ? data.finishedAt : null;
              launch.observed = at;
              launch.state = data?.state || "result";
            }
            if (stage === "failed") {
              launch.observed = at;
              launch.state = "failure";
            }
          }
          renderLaunch();
        },
        received(key, event, receivedAt) {
          flash = !flash;
          nodes.indicator.className = flash ? "event-indicator is-on" : "event-indicator";
          nodes.key.textContent = `${key}${event.repeat ? " (repeat)" : ""}`;
          const delay = typeof event.timeStamp === "number" && event.timeStamp > 0
            ? receivedAt - event.timeStamp : -1;
          nodes.arrival.textContent = delay >= 0 && delay < 10000 ? `${delay.toFixed(1)} ms event→handler` : "n/a";
          const arrow = key.startsWith("Arrow");
          if (event.repeat) repeats++;
          if (arrow && lastArrowAt) {
            const gap = receivedAt - lastArrowAt;
            lastArrowGap = `${gap.toFixed(0)} ms`;
            if (gap < 120) quickPairs++;
          }
          if (arrow) lastArrowAt = receivedAt;
          activeSample = { at: receivedAt, arrow, handlerMs: null, frameMs: null,
            focusAt: null, focusToFrameMs: null,
            focusChanges: 0, moved: false };
          if (pendingSamples.length === maxSamples) pendingSamples.shift();
          pendingSamples.push(activeSample);
          nodes.pending.textContent = String(pendingSamples.length);
        },
        focusChanged() {
          if (activeSample) {
            activeSample.focusChanges++;
            activeSample.focusAt = clock();
          }
        },
        handled(receivedAt, focusChanged) {
          if (activeSample) {
            activeSample.handlerMs = clock() - receivedAt;
            activeSample.moved = focusChanged;
            nodes.focus.textContent = activeSample.handlerMs.toFixed(1);
          }
          activeSample = null;
        },
        scroll(duration) { lastScroll = `${duration.toFixed(1)} ms`; },
        focusScroll(delta) { if (delta) focusScrolls++; },
        imageLoaded(duration, ok) {
          lastImage = ok ? `${duration.toFixed(0)} ms` : "failed";
          lastImageAt = clock();
        },
        wallpaperChanged(duration) {
          lastWallpaper = `${duration.toFixed(1)} ms work`;
          lastWallpaperAt = clock();
        },
      };
    },
  };
})();
