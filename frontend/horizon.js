(() => {
  "use strict";

  const config = window.HORIZON_CONFIG;
  const grid = document.getElementById("app-grid");
  if (!config || !Array.isArray(config.tiles) || !grid) return;

  const home = document.getElementById("home-screen");
  const settings = document.getElementById("settings-screen");
  const browser = document.getElementById("browser-screen");
  const settingsOpen = document.getElementById("settings-open");
  const settingsClose = document.getElementById("settings-close");
  const browserClose = document.getElementById("browser-close");
  const settingRows = [...document.querySelectorAll(".setting-row")];
  const notice = document.getElementById("notice");
  const selectionName = document.getElementById("selection-name");
  const selectionStatus = document.getElementById("selection-status");
  const diagnostics = window.HorizonDiagnostics?.start();
  const wallpapers = window.HORIZON_WALLPAPERS || [];
  const wallpaperLayers = [...document.querySelectorAll(".wallpaper-layer")];
  const wallpaperInterval = 60000;
  const storageKey = "horizon.preferences.v1";
  const defaults = { wallpaper: wallpapers[0]?.id, slideshow: true, accent: "cyan", arrangement: "original" };
  const options = {
    accent: [{ value: "cyan", label: "Pearl" }, { value: "violet", label: "Violet" }, { value: "ice", label: "Ice" }],
    arrangement: [{ value: "original", label: "Original" }, { value: "reverse", label: "Reverse" }, { value: "alphabetical", label: "A–Z" }],
  };
  const localControllerPage = location.protocol === "http:" && location.port === "8765";
  let storageAvailable = true;
  let preferences = loadPreferences();
  let tiles = [];
  let activeIndex = 0;
  let returnTileId = null;
  let noticeTimer = 0;
  let focusedElement = null;
  let wallpaperIndex = -1;
  let activeWallpaperLayer = 0;
  let wallpaperTimer = 0;
  let wallpaperCleanupTimer = 0;
  let wallpaperRequest = 0;
  let nextWallpaper = null;
  let launchPending = false;
  let launchConfirmed = false;
  const failedWallpapers = new Set();

  function loadPreferences() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || "{}");
      const merged = { ...defaults, ...saved };
      for (const key of Object.keys(options)) {
        if (!options[key].some(option => option.value === merged[key])) merged[key] = defaults[key];
      }
      if (!wallpapers.some(wallpaper => wallpaper.id === merged.wallpaper)) merged.wallpaper = defaults.wallpaper;
      if (typeof merged.slideshow !== "boolean") merged.slideshow = true;
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
    element.focus({ preventScroll: true });
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

  function applyPreferences() {
    document.body.dataset.accent = preferences.accent;
    const current = wallpapers[wallpaperIndex] || wallpapers.find(wallpaper => wallpaper.id === preferences.wallpaper);
    document.querySelector('[data-value="wallpaper"]').textContent = current?.label || "Unavailable";
    document.querySelector('[data-value="slideshow"]').textContent = preferences.slideshow ? "On" : "Off";
    for (const key of Object.keys(options)) {
      const value = document.querySelector(`[data-value="${key}"]`);
      if (value) value.textContent = options[key].find(option => option.value === preferences[key])?.label || "";
    }
    if (!storageAvailable) {
      document.getElementById("settings-storage").textContent = "Device storage is unavailable; changes last until Horizon closes.";
    }
  }

  function nextAvailableIndex(after) {
    for (let step = 1; step <= wallpapers.length; step++) {
      const index = (after + step) % wallpapers.length;
      if (!failedWallpapers.has(index)) return index;
    }
    return -1;
  }

  function loadWallpaper(index, done) {
    const image = new Image();
    image.onload = () => done(true, image);
    image.onerror = () => done(false, image);
    image.src = wallpapers[index].src;
  }

  function preloadNextWallpaper() {
    nextWallpaper = null;
    if (!preferences.slideshow || wallpapers.length < 2 || wallpaperIndex < 0) return;
    const index = nextAvailableIndex(wallpaperIndex);
    if (index < 0 || index === wallpaperIndex) return;
    loadWallpaper(index, (loaded, image) => {
      if (wallpaperIndex < 0 || !preferences.slideshow) return;
      if (!loaded) {
        failedWallpapers.add(index);
        preloadNextWallpaper();
      } else if (index === nextAvailableIndex(wallpaperIndex)) {
        nextWallpaper = { index, image };
      }
    });
  }

  function scheduleWallpaper() {
    clearTimeout(wallpaperTimer);
    if (!preferences.slideshow || wallpapers.length < 2 || wallpaperIndex < 0) return;
    wallpaperTimer = setTimeout(() => {
      const index = nextAvailableIndex(wallpaperIndex);
      if (index >= 0 && index !== wallpaperIndex) showWallpaper(index);
    }, wallpaperInterval);
  }

  function showWallpaper(requestedIndex) {
    if (!wallpapers.length || wallpaperLayers.length !== 2) return;
    const request = ++wallpaperRequest;
    const tryIndex = (index, attempts) => {
      if (index < 0 || attempts >= wallpapers.length) return;
      const ready = nextWallpaper?.index === index ? nextWallpaper.image : null;
      const finish = (loaded, image) => {
        if (request !== wallpaperRequest) return;
        if (!loaded) {
          failedWallpapers.add(index);
          nextWallpaper = null;
          tryIndex(nextAvailableIndex(index), attempts + 1);
          return;
        }
        clearTimeout(wallpaperCleanupTimer);
        const incoming = wallpaperIndex < 0 ? activeWallpaperLayer : 1 - activeWallpaperLayer;
        const outgoing = activeWallpaperLayer;
        wallpaperLayers[incoming].style.backgroundImage = `url("${wallpapers[index].src}")`;
        wallpaperLayers[incoming].style.opacity = "1";
        if (wallpaperIndex >= 0) {
          wallpaperLayers[outgoing].style.opacity = "0";
          wallpaperCleanupTimer = setTimeout(() => {
            wallpaperLayers[outgoing].style.backgroundImage = "none";
          }, 1000);
        }
        activeWallpaperLayer = incoming;
        wallpaperIndex = index;
        preferences.wallpaper = wallpapers[index].id;
        document.body.style.setProperty("--current-wallpaper", `url("${wallpapers[index].src}")`);
        applyPreferences();
        savePreferences();
        scheduleWallpaper();
        nextWallpaper = null;
        preloadNextWallpaper();
      };
      if (ready) finish(true, ready);
      else loadWallpaper(index, finish);
    };
    tryIndex(requestedIndex, 0);
  }

  function orderedTiles() {
    const favorites = config.tiles.filter(tile => tile.favorite !== false);
    const additional = config.tiles.filter(tile => tile.favorite === false);
    if (preferences.arrangement === "reverse") favorites.reverse();
    if (preferences.arrangement === "alphabetical") favorites.sort((a, b) => a.name.localeCompare(b.name));
    return favorites.concat(additional);
  }

  function currentTileIndex() {
    const id = document.activeElement?.dataset?.id;
    const found = tiles.findIndex(tile => tile.id === id);
    return found >= 0 ? found : activeIndex;
  }

  function updateSelection(tile) {
    selectionName.textContent = tile.name;
    selectionStatus.textContent = tile.kind === "browser" ? "Browser coming soon"
      : tile.kind === "settings" ? "Personalize Horizon"
      : tile.launchState === "supported" ? (localControllerPage ? "Press OK to open" : "Local controller required")
      : "Native launch unverified";
  }

  async function launchNative(tile) {
    if (launchPending || launchConfirmed) return;
    if (!localControllerPage) {
      showNotice("Open Horizon from the local controller to launch apps.");
      return;
    }
    launchPending = true;
    selectionStatus.textContent = "Opening…";
    showNotice(`Opening ${tile.name}…`);
    try {
      const response = await fetch("/api/apps/launch", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Horizon-Action": "launch-app" },
        body: JSON.stringify({ app: tile.controllerAppId }),
        cache: "no-store",
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "The TV did not open the app.");
      launchConfirmed = true;
      selectionStatus.textContent = "Opened";
    } catch (error) {
      const message = error instanceof TypeError || error instanceof SyntaxError
        ? "Local controller is offline or unavailable."
        : error.message;
      selectionStatus.textContent = message;
      showNotice(message);
    } finally {
      launchPending = false;
    }
  }

  function activate(tile) {
    if (tile.kind === "browser") {
      returnTileId = tile.id;
      notice.hidden = true;
      home.hidden = true;
      browser.hidden = false;
      focusElement(browserClose);
      return;
    }
    if (tile.kind === "settings") {
      openSettings();
      return;
    }
    if (tile.launchState === "supported" && tile.controllerAppId) {
      launchNative(tile);
      return;
    }
    showNotice(`${tile.name} native launch has not been verified on this TV.`);
  }

  function renderTiles(restoreId) {
    tiles = orderedTiles();
    focusedElement = null;
    grid.replaceChildren();
    for (const tile of tiles) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "app-tile";
      button.dataset.id = tile.id;
      button.setAttribute("aria-label", `${tile.name}, ${tile.kind === "browser" ? "browser coming soon" : tile.kind === "settings" ? "open settings" : tile.launchState === "supported" ? "open native app" : "native launch unverified"}`);

      const icon = document.createElement("span");
      icon.className = `tile-icon icon-${tile.id}`;
      icon.setAttribute("aria-hidden", "true");
      const image = document.createElement("img");
      image.src = `assets/${tile.artwork}`;
      image.alt = "";
      image.draggable = false;
      icon.append(image);

      const name = document.createElement("span");
      name.className = "tile-label";
      name.textContent = tile.name;
      button.append(icon, name);
      button.addEventListener("focus", () => {
        activeIndex = tiles.findIndex(item => item.id === tile.id);
        markFocused(button);
        updateSelection(tile);
      });
      button.addEventListener("blur", () => button.classList.remove("is-focused"));
      button.addEventListener("click", () => activate(tile));
      grid.append(button);
    }
    const restored = restoreId ? tiles.findIndex(tile => tile.id === restoreId) : -1;
    activeIndex = restored >= 0 ? restored : Math.min(activeIndex, tiles.length - 1);
    if (!home.hidden) {
      focusElement(grid.children[activeIndex]);
      updateSelection(tiles[activeIndex]);
    }
  }

  function setPreference(key) {
    if (key === "wallpaper") {
      const index = nextAvailableIndex(wallpaperIndex);
      if (index >= 0) showWallpaper(index);
      return;
    }
    if (key === "slideshow") {
      preferences.slideshow = !preferences.slideshow;
      applyPreferences();
      savePreferences();
      scheduleWallpaper();
      if (preferences.slideshow) preloadNextWallpaper();
      else nextWallpaper = null;
      return;
    }
    if (!options[key]) return;
    const choices = options[key];
    const current = choices.findIndex(choice => choice.value === preferences[key]);
    preferences[key] = choices[(current + 1) % choices.length].value;
    applyPreferences();
    savePreferences();
    if (key === "arrangement") renderTiles(returnTileId || tiles[currentTileIndex()]?.id);
  }

  function openSettings() {
    returnTileId = tiles[currentTileIndex()]?.id || tiles[0]?.id;
    notice.hidden = true;
    home.hidden = true;
    settings.hidden = false;
    focusElement(settingRows[0]);
  }

  function closeSettings() {
    settings.hidden = true;
    home.hidden = false;
    const restored = tiles.findIndex(tile => tile.id === returnTileId);
    activeIndex = restored >= 0 ? restored : 0;
    focusElement(grid.children[activeIndex]);
  }

  function closeBrowser() {
    browser.hidden = true;
    home.hidden = false;
    const restored = tiles.findIndex(tile => tile.id === returnTileId);
    activeIndex = restored >= 0 ? restored : 0;
    focusElement(grid.children[activeIndex]);
  }

  function columns() { return window.innerWidth <= 700 ? 3 : 6; }

  function moveTile(key) {
    const count = tiles.length;
    const cols = columns();
    const current = currentTileIndex();
    let next = current;
    if (key === "ArrowLeft" && current % cols > 0) next--;
    if (key === "ArrowRight" && current + 1 < count && current % cols < cols - 1) next++;
    if (key === "ArrowUp") {
      if (current - cols >= 0) next -= cols;
      else { focusElement(settingsOpen); return true; }
    }
    if (key === "ArrowDown" && current + cols < count) {
      const rowStart = Math.floor(current / cols + 1) * cols;
      next = rowStart + Math.min(current % cols, Math.min(cols, count - rowStart) - 1);
    }
    if (next === current) return false;
    focusElement(grid.children[next]);
    if (Math.floor(next / cols) !== Math.floor(current / cols)) {
      home.scrollTop = next < cols ? 0 : Math.round(window.innerHeight * .43 * Math.floor(next / cols));
    }
    return true;
  }

  function keyName(event) {
    if (["Enter", "Select", "OK", "NumpadEnter"].includes(event.key)) return "OK";
    if (["Escape", "Backspace", "BrowserBack", "GoBack"].includes(event.key)) return "Back";
    return event.key || "Unknown";
  }

  function updateClock() {
    const formatted = new Intl.DateTimeFormat(undefined, {
      hour: "numeric", minute: "2-digit",
    }).format(new Date());
    document.getElementById("clock-time").textContent = formatted.replace(/\s?(AM|PM)$/i, "");
  }

  settingsOpen.addEventListener("focus", () => markFocused(settingsOpen));
  settingsOpen.addEventListener("blur", () => settingsOpen.classList.remove("is-focused"));
  settingsClose.addEventListener("focus", () => markFocused(settingsClose));
  settingsClose.addEventListener("blur", () => settingsClose.classList.remove("is-focused"));
  browserClose.addEventListener("focus", () => markFocused(browserClose));
  browserClose.addEventListener("blur", () => browserClose.classList.remove("is-focused"));
  settingsOpen.addEventListener("click", openSettings);
  settingsClose.addEventListener("click", closeSettings);
  browserClose.addEventListener("click", closeBrowser);
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

    if (!browser.hidden) {
      if (key === "Back" || key === "OK") {
        event.preventDefault();
        closeBrowser();
        focusChanged = true;
      }
    } else if (!settings.hidden) {
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
        const current = settingRows.indexOf(document.activeElement);
        if (key === "ArrowUp" && current === 0) focusElement(settingsClose);
        else if (key === "ArrowDown" && document.activeElement === settingsClose) focusElement(settingRows[0]);
        else if (key === "ArrowDown" && current < settingRows.length - 1) focusElement(settingRows[current + 1]);
        else if (key === "ArrowUp" && current > 0) focusElement(settingRows[current - 1]);
        focusChanged = true;
      } else if (key === "ArrowLeft" || key === "ArrowRight") {
        event.preventDefault();
        if (document.activeElement !== settingsClose) setPreference(document.activeElement.dataset.setting);
      }
    } else if (key === "Back") {
      event.preventDefault();
      home.scrollTop = 0;
      if (document.activeElement !== grid.children[0]) focusElement(grid.children[0]);
      focusChanged = true;
    } else if (key === "OK") {
      event.preventDefault();
      if (document.activeElement === settingsOpen) openSettings();
      else if (tiles[currentTileIndex()]) activate(tiles[currentTileIndex()]);
    } else if (key.startsWith("Arrow")) {
      event.preventDefault();
      if (document.activeElement === settingsOpen) {
        if (key === "ArrowDown") { focusElement(grid.children[activeIndex]); focusChanged = true; }
      } else focusChanged = moveTile(key);
    }
    diagnostics?.handled(receivedAt, focusChanged);
  }, { passive: false });

  applyPreferences();
  if (wallpapers.length) showWallpaper(Math.max(0, wallpapers.findIndex(wallpaper => wallpaper.id === preferences.wallpaper)));
  renderTiles();
  updateClock();
  setInterval(updateClock, 60000);
})();
