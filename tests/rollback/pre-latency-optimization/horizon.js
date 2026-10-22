(() => {
  "use strict";

  const config = window.HORIZON_CONFIG;
  const grid = document.querySelector("#app-grid");
  const notice = document.querySelector("#notice");
  const diagnostics = document.querySelector("#diagnostics");
  const buttons = [];
  let noticeTimer;
  let frameCount = 0;
  let frameStart = performance.now();
  let diagTimer;

  if (!config || !Array.isArray(config.tiles)) return;

  document.querySelector("#app-count").textContent = `${config.tiles.length} tiles`;
  for (const [index, tile] of config.tiles.entries()) {
    const button = document.createElement("button");
    button.className = "app-tile";
    button.type = "button";
    button.dataset.index = String(index);
    button.dataset.id = tile.id;
    button.setAttribute("aria-label", `${tile.name}, ${tile.detail}`);

    const icon = document.createElement("span");
    icon.className = `tile-icon accent-${tile.accent}${tile.icon.length > 2 ? " is-word" : ""}`;
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = tile.icon;
    const copy = document.createElement("span");
    copy.className = "tile-copy";
    const name = document.createElement("span");
    name.className = "tile-name";
    name.textContent = tile.name;
    const detail = document.createElement("span");
    detail.className = "tile-detail";
    detail.textContent = tile.detail;
    copy.append(name, detail);
    const arrow = document.createElement("span");
    arrow.className = "tile-arrow";
    arrow.setAttribute("aria-hidden", "true");
    arrow.textContent = "›";
    button.append(icon, copy, arrow);
    button.addEventListener("click", () => activate(tile));
    button.addEventListener("focus", () => button.scrollIntoView({ block: "nearest", inline: "nearest" }));
    buttons.push(button);
    grid.append(button);
  }

  function announce(message) {
    notice.textContent = message;
    notice.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { notice.hidden = true; }, 2600);
  }

  function activate(tile) {
    if (tile.kind === "browser") {
      announce("Internet browser is ready for the next development step.");
    } else {
      announce(`${tile.name} is configured. Connect the companion app controller to launch it.`);
    }
  }

  function moveFocus(origin, key) {
    const from = origin.getBoundingClientRect();
    const x = from.left + from.width / 2;
    const y = from.top + from.height / 2;
    let candidate = null;
    let best = Infinity;
    for (const button of buttons) {
      if (button === origin) continue;
      const rect = button.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const primary = key === "ArrowLeft" ? x - cx
        : key === "ArrowRight" ? cx - x
        : key === "ArrowUp" ? y - cy : cy - y;
      if (primary <= 0) continue;
      const secondary = key === "ArrowLeft" || key === "ArrowRight" ? Math.abs(cy - y) : Math.abs(cx - x);
      const score = primary + secondary * 1.7;
      if (score < best) { best = score; candidate = button; }
    }
    (candidate || origin).focus();
  }

  function keyName(event) {
    if (event.key === "Enter" || event.key === "Select" || event.key === "OK") return "OK";
    if (["Escape", "Backspace", "BrowserBack", "GoBack"].includes(event.key)) return "Back";
    return event.key;
  }

  window.addEventListener("keydown", (event) => {
    const started = performance.now();
    const key = keyName(event);
    if (key === "Back") {
      event.preventDefault();
      const focused = document.activeElement;
      if (focused instanceof HTMLButtonElement) focused.blur();
      buttons[0]?.focus();
      announce("Horizon home");
    } else if (key === "OK" && document.activeElement instanceof HTMLButtonElement) {
      event.preventDefault();
      document.activeElement.click();
    } else if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(key)
      && document.activeElement instanceof HTMLButtonElement) {
      event.preventDefault();
      moveFocus(document.activeElement, key);
    }
    if (!diagnostics.hidden) requestAnimationFrame(() => {
      document.querySelector("#diag-latency").textContent = (performance.now() - started).toFixed(1);
    });
  }, { passive: false });

  if (new URLSearchParams(location.search).has("diagnostics")) {
    diagnostics.hidden = false;
    const fpsNode = document.querySelector("#diag-fps");
    function sampleFrames(now) {
      frameCount += 1;
      if (now - frameStart >= 1000) {
        fpsNode.textContent = Math.round(frameCount * 1000 / (now - frameStart));
        frameCount = 0;
        frameStart = now;
      }
      requestAnimationFrame(sampleFrames);
    }
    requestAnimationFrame(sampleFrames);
    const memoryNode = document.querySelector("#diag-memory");
    const updateMemory = () => {
      const memory = performance.memory;
      memoryNode.textContent = memory?.usedJSHeapSize
        ? `Heap ${(memory.usedJSHeapSize / 1048576).toFixed(1)} MB`
        : "Heap n/a";
    };
    updateMemory();
    diagTimer = setInterval(updateMemory, 5000);
  }

  buttons[0]?.focus();
  window.addEventListener("pagehide", () => clearInterval(diagTimer), { once: true });
})();
