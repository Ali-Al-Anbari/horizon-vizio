(() => {
  "use strict";

  const config = window.HORIZON_CONFIG;
  const grid = document.getElementById("app-grid");
  const home = document.getElementById("home-screen");
  const settings = document.getElementById("settings-screen");
  const settingsOpen = document.getElementById("settings-open");
  const settingsClose = document.getElementById("settings-close");
  const settingRows = [...document.querySelectorAll(".setting-row")];
  const notice = document.getElementById("notice");
  const diagnostics = window.HorizonDiagnostics?.start();
  const storageKey = "horizon.preferences.v1";
  const defaults = { wallpaper: "night", accent: "cyan", arrangement: "original" };
  const options = {
    wallpaper: [{ value: "night", label: "Night" }, { value: "ocean", label: "Ocean" }, { value: "graphite", label: "Graphite" }],
    accent: [{ value: "cyan", label: "Cyan" }, { value: "violet", label: "Violet" }, { value: "ice", label: "Ice" }],
    arrangement: [{ value: "original", label: "Original" }, { value: "reverse", label: "Reverse" }, { value: "alphabetical", label: "A–Z" }],
  };
  let storageAvailable = true;
  const iconArt = {
    youtube: '<svg viewBox="0 0 80 56" aria-hidden="true"><rect x="2" y="2" width="76" height="52" rx="16" fill="#f21d2f"/><path d="M34 17.5v21L51 28 34 17.5Z" fill="white"/></svg>',
    plex: '<svg viewBox="0 0 100 100" aria-hidden="true"><path d="M25 14h27c18 0 29 10 29 26S70 66 52 66h-8v20H25V14Zm19 16v20h8c7 0 11-3 11-10s-4-10-11-10h-8Z" fill="#f2ad32"/><path d="m67 67 12 19H61l-9-14 8-5Z" fill="#f5f7fc"/></svg>',
    "prime-video": '<svg viewBox="0 0 120 100" aria-hidden="true"><text x="60" y="53" fill="white" font-family="Arial,sans-serif" font-size="33" font-weight="600" letter-spacing="-1.5" text-anchor="middle">prime</text><path d="M29 66c19 17 47 20 68 5" fill="none" stroke="#bceaff" stroke-width="5" stroke-linecap="round"/><path d="m90 65 9 5-9 6" fill="none" stroke="#bceaff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    "disney-plus": '<svg viewBox="0 0 120 100" aria-hidden="true"><path d="M22 36c18-25 58-31 76-4" fill="none" stroke="#cbd8ff" stroke-width="3.5" stroke-linecap="round"/><text x="57" y="62" fill="white" font-family="Georgia,serif" font-size="26" font-weight="600" letter-spacing="-1.5" text-anchor="middle">Disney</text><path d="M94 56h12m-6-6v12" stroke="#a8c5ff" stroke-width="3" stroke-linecap="round"/></svg>',
    internet: '<svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="34" fill="none" stroke="white" stroke-width="4"/><path d="M16 50h68M50 16c12 12 17 23 17 34S62 72 50 84M50 16C38 28 33 39 33 50s5 22 17 34M23 31h54M23 69h54" fill="none" stroke="white" stroke-width="3" opacity=".92"/></svg>',
    "live-tv": '<svg viewBox="0 0 100 100" aria-hidden="true"><path d="m35 23 15 14 15-14" fill="none" stroke="white" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><rect x="18" y="38" width="64" height="43" rx="8" fill="none" stroke="white" stroke-width="5"/><path d="M38 89h24M50 81v8" stroke="white" stroke-width="5" stroke-linecap="round"/></svg>',
  };
  let preferences = loadPreferences();
  let tiles = [];
  let activeIndex = 0;
  let returnTileId = null;
  let noticeTimer = 0;
  let focusedElement = null;

  if (!config || !Array.isArray(config.tiles) || !grid) return;

  function loadPreferences() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || "{}");
      const merged = { ...defaults, ...saved };
      for (const key of Object.keys(options)) {
        if (!options[key].some(option => option.value === merged[key])) merged[key] = defaults[key];
      }
      return merged;
    } catch (_error) {
      storageAvailable = false;
      return { ...defaults };
    }
  }

  function markFocused(element) {
    if (focusedElement !== element) {
      focusedElement?.classList.remove("is-focused");
      focusedElement = element;
    }
    element?.classList.add("is-focused");
  }

  function focusElement(element) {
    if (!element) return;
    element.focus();
    markFocused(element);
  }

  function savePreferences() {
    try {
      localStorage.setItem(storageKey, JSON.stringify(preferences));
      storageAvailable = true;
    } catch (_error) {
      storageAvailable = false;
    }
    document.getElementById("settings-storage").textContent = storageAvailable
      ? "Changes are saved on this device."
      : "Device storage is unavailable; changes last until Horizon closes.";
  }

  function showNotice(message) {
    notice.textContent = message;
    notice.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { notice.hidden = true; }, 2400);
  }

  function labelFor(key, value) {
    return options[key].find(option => option.value === value)?.label || "";
  }

  function applyPreferences() {
    document.body.dataset.wallpaper = preferences.wallpaper;
    document.body.dataset.accent = preferences.accent;
    for (const key of Object.keys(options)) {
      const value = document.querySelector(`[data-value="${key}"]`);
      if (value) value.textContent = labelFor(key, preferences[key]);
    }
    if (!storageAvailable) {
      document.getElementById("settings-storage").textContent = "Device storage is unavailable; changes last until Horizon closes.";
    }
  }

  function orderedFavorites() {
    const favorites = config.tiles.filter(tile => tile.favorite !== false);
    if (preferences.arrangement === "reverse") return favorites.slice().reverse();
    if (preferences.arrangement === "alphabetical") return favorites.slice().sort((a, b) => a.name.localeCompare(b.name));
    return favorites;
  }

  function activate(tile) {
    if (tile.kind === "browser") {
      showNotice("Internet browser is coming soon. Web browsing is not implemented yet.");
      return;
    }
    if (tile.appName) {
      showNotice(`${tile.name} app launch is not configured yet.`);
      return;
    }
    showNotice(`${tile.name} is a placeholder.`);
  }

  function setPreference(key) {
    const choices = options[key];
    const current = choices.findIndex(choice => choice.value === preferences[key]);
    preferences[key] = choices[(current + 1) % choices.length].value;
    applyPreferences();
    savePreferences();
    if (key === "arrangement") renderTiles(returnTileId || tiles[currentTileIndex()]?.id);
  }

  function renderTiles(restoreId) {
    tiles = orderedFavorites();
    focusedElement = null;
    grid.replaceChildren();
    for (const tile of tiles) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "app-tile";
      button.dataset.id = tile.id;
      button.dataset.placeholder = tile.kind === "browser" ? "true" : "false";
      const availability = tile.kind === "browser"
        ? "browser coming soon"
        : tile.appName ? "app launch not configured" : "placeholder";
      button.setAttribute("aria-label", `${tile.name}, ${availability}`);

      const icon = document.createElement("span");
      icon.className = `tile-icon icon-${tile.id}`;
      icon.setAttribute("aria-hidden", "true");
      icon.innerHTML = iconArt[tile.id] || "";
      const name = document.createElement("span");
      name.className = "tile-label";
      name.textContent = tile.name;
      button.append(icon, name);
      button.addEventListener("focus", () => {
        activeIndex = tiles.findIndex(item => item.id === tile.id);
        markFocused(button);
      });
      button.addEventListener("blur", () => button.classList.remove("is-focused"));
      button.addEventListener("click", () => activate(tile));
      grid.append(button);
    }
    const restored = restoreId ? tiles.findIndex(tile => tile.id === restoreId) : -1;
    activeIndex = restored >= 0 ? restored : Math.min(activeIndex, tiles.length - 1);
    focusElement(grid.children[activeIndex]);
  }

  function openSettings() {
    returnTileId = tiles[currentTileIndex()]?.id || tiles[0]?.id;
    home.hidden = true;
    settings.hidden = false;
    focusElement(settingRows[0]);
  }

  function closeSettings() {
    settings.hidden = true;
    home.hidden = false;
    const restore = tiles.findIndex(tile => tile.id === returnTileId);
    activeIndex = restore >= 0 ? restore : 0;
    focusElement(grid.children[activeIndex]);
  }

  function columns() {
    if (window.innerWidth <= 560) return 2;
    if (window.innerWidth <= 860) return 2;
    if (window.innerWidth <= 1400) return 3;
    return 6;
  }

  function currentTileIndex() {
    const id = document.activeElement?.dataset?.id;
    const focused = tiles.findIndex(tile => tile.id === id);
    return focused >= 0 ? focused : Math.min(activeIndex, Math.max(tiles.length - 1, 0));
  }

  function currentSettingIndex() {
    const key = document.activeElement?.dataset?.setting;
    const focused = settingRows.findIndex(row => row.dataset.setting === key);
    return focused >= 0 ? focused : 0;
  }

  function moveTile(key) {
    const count = tiles.length;
    const cols = columns();
    activeIndex = currentTileIndex();
    let next = activeIndex;
    if (key === "ArrowLeft" && activeIndex % cols > 0) next -= 1;
    if (key === "ArrowRight" && activeIndex + 1 < count && activeIndex % cols < cols - 1) next += 1;
    if (key === "ArrowUp") {
      if (activeIndex - cols >= 0) next -= cols;
      else { focusElement(settingsOpen); return true; }
    }
    if (key === "ArrowDown" && activeIndex + cols < count) {
      const nextRowStart = Math.floor(activeIndex / cols + 1) * cols;
      const nextRowLength = Math.min(cols, count - nextRowStart);
      next = nextRowStart + Math.min(activeIndex % cols, nextRowLength - 1);
    }
    if (next === activeIndex) return false;
    focusElement(grid.children[next]);
    return true;
  }

  function keyName(event) {
    if (["Enter", "Select", "OK", "NumpadEnter"].includes(event.key)) return "OK";
    if (["Escape", "Backspace", "BrowserBack", "GoBack"].includes(event.key)) return "Back";
    return event.key || "Unknown";
  }

  function updateClock() {
    const now = new Date();
    document.getElementById("clock-time").textContent = new Intl.DateTimeFormat(undefined, {
      hour: "numeric", minute: "2-digit",
    }).format(now);
    document.getElementById("clock-date").textContent = new Intl.DateTimeFormat(undefined, {
      weekday: "long", month: "long", day: "numeric",
    }).format(now);
  }

  settingsOpen.addEventListener("focus", () => markFocused(settingsOpen));
  settingsOpen.addEventListener("blur", () => settingsOpen.classList.remove("is-focused"));
  settingsClose.addEventListener("focus", () => markFocused(settingsClose));
  settingsClose.addEventListener("blur", () => settingsClose.classList.remove("is-focused"));
  settingsOpen.addEventListener("click", openSettings);
  settingsClose.addEventListener("click", closeSettings);
  settingRows.forEach(row => {
    row.addEventListener("focus", () => markFocused(row));
    row.addEventListener("blur", () => row.classList.remove("is-focused"));
    row.addEventListener("click", () => setPreference(row.dataset.setting));
  });

  window.addEventListener("keydown", event => {
    const receivedAt = performance.now();
    const key = keyName(event);
    diagnostics?.received(key, event, receivedAt);
    let focusChanged = false;

    if (!settings.hidden) {
      if (key === "Back") {
        event.preventDefault();
        closeSettings();
        focusChanged = true;
      } else if (key === "OK") {
        event.preventDefault();
        if (document.activeElement === settingsClose) closeSettings();
        else setPreference(document.activeElement.dataset.setting);
      } else if (key === "ArrowUp" || key === "ArrowDown") {
        event.preventDefault();
        const onClose = document.activeElement === settingsClose;
        const index = currentSettingIndex();
        if (key === "ArrowUp" && index === 0 && !onClose) focusElement(settingsClose);
        else if (key === "ArrowDown" && onClose) focusElement(settingRows[0]);
        else if (key === "ArrowDown" && index < settingRows.length - 1) focusElement(settingRows[index + 1]);
        else if (key === "ArrowUp" && index > 0) focusElement(settingRows[index - 1]);
        focusChanged = document.activeElement !== settingsClose && document.activeElement.dataset.setting !== undefined;
      } else if (key === "ArrowLeft" || key === "ArrowRight") {
        event.preventDefault();
        if (document.activeElement !== settingsClose) setPreference(document.activeElement.dataset.setting);
      }
    } else if (key === "Back") {
      event.preventDefault();
      if (document.activeElement !== grid.children[0]) focusElement(grid.children[0]);
      focusChanged = true;
    } else if (key === "OK") {
      event.preventDefault();
      if (document.activeElement === settingsOpen) openSettings();
      else tiles[currentTileIndex()] && activate(tiles[currentTileIndex()]);
    } else if (key.startsWith("Arrow")) {
      event.preventDefault();
      if (document.activeElement === settingsOpen) {
        if (key === "ArrowDown") focusElement(grid.children[activeIndex]);
      } else if (key === "ArrowUp") {
        focusChanged = moveTile(key);
      } else {
        focusChanged = moveTile(key);
      }
    }
    diagnostics?.handled(receivedAt, focusChanged);
  }, { passive: false });

  window.addEventListener("resize", () => {
    // Navigation uses viewport breakpoints on the next key event; no DOM rebuild.
  }, { passive: true });

  applyPreferences();
  renderTiles();
  updateClock();
  setInterval(updateClock, 60000);
})();
