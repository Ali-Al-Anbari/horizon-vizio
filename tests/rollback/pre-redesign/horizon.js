(() => {
  "use strict";

  const config = window.HORIZON_CONFIG;
  const grid = document.getElementById("app-grid");
  const notice = document.getElementById("notice");
  const buttons = [];
  const diagnostics = window.HorizonDiagnostics?.start();
  let activeIndex = 0;
  let noticeTimer;
  let columns = window.innerWidth <= 580 ? 1 : window.innerWidth <= 1000 ? 2 : config?.columns || 3;

  if (!config || !Array.isArray(config.tiles)) return;

  document.getElementById("app-count").textContent = `${config.tiles.length} tiles`;
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
    button.addEventListener("focus", () => { activeIndex = index; });
    button.addEventListener("click", () => activate(tile));
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

  function nextIndex(index, key) {
    const rowStart = Math.floor(index / columns) * columns;
    if (key === "ArrowLeft") return index > rowStart ? index - 1 : index;
    if (key === "ArrowRight") return index + 1 < Math.min(rowStart + columns, buttons.length) ? index + 1 : index;
    if (key === "ArrowUp") return index >= columns ? index - columns : index;
    if (key === "ArrowDown") return index + columns < buttons.length ? index + columns : index;
    return index;
  }

  window.addEventListener("resize", () => {
    columns = window.innerWidth <= 580 ? 1 : window.innerWidth <= 1000 ? 2 : config.columns || 3;
  });

  function keyName(event) {
    if (event.key === "Enter" || event.key === "Select" || event.key === "OK") return "OK";
    if (event.key === "Escape" || event.key === "Backspace" || event.key === "BrowserBack" || event.key === "GoBack") return "Back";
    return event.key || "Unknown";
  }

  window.addEventListener("keydown", (event) => {
    const receivedAt = performance.now();
    const key = keyName(event);
    diagnostics?.received(key, event, receivedAt);

    let focusChanged = false;
    if (key === "Back") {
      event.preventDefault();
      focusChanged = document.activeElement !== buttons[0];
      buttons[0].focus();
      announce("Horizon home");
    } else if (key === "OK") {
      event.preventDefault();
      buttons[activeIndex].click();
    } else if (key === "ArrowUp" || key === "ArrowDown" || key === "ArrowLeft" || key === "ArrowRight") {
      event.preventDefault();
      const next = nextIndex(activeIndex, key);
      focusChanged = next !== activeIndex;
      if (focusChanged) buttons[next].focus();
    }

    diagnostics?.handled(receivedAt, focusChanged);
  }, { passive: false });

  buttons[0]?.focus();
})();
