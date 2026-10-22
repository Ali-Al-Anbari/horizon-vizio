(() => {
  "use strict";

  window.HorizonDiagnostics = {
    start() {
      if (!new URLSearchParams(location.search).has("diagnostics")) return null;
      const panel = document.getElementById("diagnostics");
      if (!panel) return null;
      panel.hidden = false;
      const nodes = {};
      for (const name of ["indicator", "key", "arrival", "focus", "frame", "fps", "long-frames", "pending", "memory"]) {
        nodes[name] = document.getElementById(`diag-${name}`);
      }
      let frameCount = 0;
      let longFrames = 0;
      let lastFrame = 0;
      let sampleStart = performance.now();
      let pending = 0;
      let flash = false;

      function sampleFrame(now) {
        if (lastFrame && now - lastFrame > 50) longFrames += 1;
        lastFrame = now;
        frameCount += 1;
        if (now - sampleStart >= 1000) {
          nodes.fps.textContent = String(Math.round(frameCount * 1000 / (now - sampleStart)));
          nodes["long-frames"].textContent = String(longFrames);
          frameCount = 0;
          sampleStart = now;
        }
        requestAnimationFrame(sampleFrame);
      }
      requestAnimationFrame(sampleFrame);

      const memory = performance.memory;
      nodes.memory.textContent = memory?.usedJSHeapSize
        ? `Heap ${(memory.usedJSHeapSize / 1048576).toFixed(1)} MB`
        : "Heap n/a";

      return {
        received(key, event, receivedAt) {
          // This changes before navigation work, so it exposes delays before JS receives a key.
          flash = !flash;
          nodes.indicator.className = flash ? "event-indicator is-on" : "event-indicator";
          nodes.key.textContent = `${key}${event.repeat ? " (repeat)" : ""}`;
          nodes.arrival.textContent = `+${receivedAt.toFixed(1)} ms`;
          const navigation = key === "Back" || key.startsWith("Arrow");
          if (navigation) pending += 1;
          nodes.pending.textContent = String(pending);
          requestAnimationFrame(() => {
            nodes.frame.textContent = (performance.now() - receivedAt).toFixed(1);
            if (navigation) pending -= 1;
            nodes.pending.textContent = String(pending);
          });
        },
        handled(receivedAt, focusChanged) {
          nodes.focus.textContent = focusChanged ? (performance.now() - receivedAt).toFixed(1) : "—";
        },
      };
    },
  };
})();
