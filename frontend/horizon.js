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
  const pairing = document.getElementById("pairing-screen");
  const pairingCode = document.getElementById("pairing-code");
  const pairingUrl = document.getElementById("pairing-url");
  const pairingStatus = document.getElementById("pairing-status");
  const pairingRetry = document.getElementById("pairing-retry");
  const pairingClose = document.getElementById("pairing-close");
  const settingRows = [...document.querySelectorAll(".setting-row")];
  const notice = document.getElementById("notice");
  const selectionName = document.getElementById("selection-name");
  const selectionStatus = document.getElementById("selection-status");
  const perfProfile = window.HorizonDiagnostics?.profile() || "baseline";
  const leanFocus = perfProfile !== "baseline";
  document.body.dataset.perfProfile = perfProfile;
  const diagnostics = window.HorizonDiagnostics?.start(perfProfile);
  const now = () => typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now() : Date.now();
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
  const cloudControllerPage = location.protocol === "https:"
    || (location.port === "8787" && ["localhost", "127.0.0.1"].includes(location.hostname));
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
  let paired = false;
  let pairingTimer = 0;
  let pairingGeneration = 0;
  let pairingBusy = false;
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
      element?.classList.add("is-focused");
      diagnostics?.focusChanged();
    } else if (!leanFocus) {
      element?.classList.add("is-focused");
    }
  }

  function blurFocused(element) {
    if (leanFocus && focusedElement === element) focusedElement = null;
    element.classList.remove("is-focused");
  }

  function focusElement(element) {
    if (!element) return;
    if (!leanFocus || document.activeElement !== element) element.focus({ preventScroll: true });
    if (!leanFocus || focusedElement !== element) markFocused(element);
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
    const started = diagnostics ? now() : 0;
    image.onload = () => { diagnostics?.imageLoaded(now() - started, true); done(true, image); };
    image.onerror = () => { diagnostics?.imageLoaded(now() - started, false); done(false, image); };
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
    if (perfProfile === "minimal" || !wallpapers.length || wallpaperLayers.length !== 2) return;
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
        const changedAt = diagnostics ? now() : 0;
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
        diagnostics?.wallpaperChanged(now() - changedAt);
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
    const status = tile.kind === "browser" ? "Browser coming soon"
      : tile.kind === "settings" ? "Personalize Horizon"
      : tile.launchState === "supported" ? (localControllerPage ? "Press OK to open"
        : cloudControllerPage ? (paired ? "Press OK to open" : "Pair this TV to open") : "Controller required")
      : "Native launch unverified";
    if (!leanFocus || selectionName.textContent !== tile.name) selectionName.textContent = tile.name;
    if (!leanFocus || selectionStatus.textContent !== status) selectionStatus.textContent = status;
  }

  const cloudErrors = {
    not_authorized: "This TV needs pairing before it can open apps.",
    rate_limited: "Too many pairing attempts. Try again later.",
    pairing_busy: "Pairing is busy. Try again in a few minutes.",
    authorization_unconfigured: "Cloud launch authorization is not configured.",
    queue_unavailable: "Cloud launch service is unavailable.",
    controller_unconfigured: "Cloud launch controller is not configured.",
    unsupported_app: "This native app has not been verified.",
    staging_app_disabled: "Only YouTube is enabled for this staging test.",
    busy: "Another app is opening. Please wait.",
    cooldown: "Please wait before opening another app.",
    controller_offline: "The home controller did not respond.",
    controller_timeout: "The home controller did not finish the launch.",
    tv_rejected: "The TV rejected the app launch.",
    tv_unconfirmed: "The TV accepted the request but did not confirm the app opened.",
    tv_unavailable: "The home controller could not reach the TV.",
    controller_error: "The home controller could not process the request.",
    result_unavailable: "The launch result is no longer available.",
  };

  async function cloudJson(path, options) {
    let response;
    try { response = await fetch(path, { cache: "no-store", ...options }); }
    catch (_error) { throw new Error("Cloud sign-in or launch service is unavailable."); }
    if (response.status === 401 || response.status === 403) throw new Error(cloudErrors.not_authorized);
    if (!response.headers.get("content-type")?.includes("application/json")) {
      throw new Error("Cloud sign-in or launch service is unavailable.");
    }
    const result = await response.json();
    if (!response.ok) throw new Error(cloudErrors[result.code] || "Cloud launch failed.");
    return result;
  }

  function showPairing() {
    if (!cloudControllerPage || localControllerPage) return;
    pairing.hidden = false;
    focusElement(pairingRetry);
    if (!pairingBusy && pairingCode.textContent === "—") startPairing();
  }

  function closePairing() {
    pairing.hidden = true;
    focusElement(grid.children[activeIndex]);
  }

  async function startPairing() {
    if (pairingBusy || paired) return;
    pairingBusy = true;
    const generation = ++pairingGeneration;
    clearTimeout(pairingTimer);
    pairingCode.textContent = "—";
    pairingStatus.textContent = "Creating a short-lived code…";
    try {
      const result = await cloudJson("/api/pair/start", {
        method: "POST", headers: { "X-Horizon-Action": "pair" },
      });
      if (generation !== pairingGeneration) return;
      pairingCode.textContent = result.code;
      pairingUrl.textContent = result.pairingUrl;
      pairingStatus.textContent = "Waiting for your approval. This code expires in five minutes.";
      const poll = async () => {
        if (generation !== pairingGeneration || paired) return;
        try {
          const status = await cloudJson("/api/pair/status", {
            method: "POST", headers: { "X-Horizon-Action": "pair" },
          });
          if (status.state === "paired") {
            paired = true;
            pairingCode.textContent = "—";
            pairingStatus.textContent = "TV paired.";
            pairing.hidden = true;
            focusElement(grid.children[activeIndex]);
            if (tiles[activeIndex]) updateSelection(tiles[activeIndex]);
            showNotice("This TV is paired and ready.");
            return;
          }
          if (status.state === "rejected" || status.state === "expired" || status.state === "unpaired") {
            pairingStatus.textContent = status.state === "rejected" ? "Pairing was rejected. Select New code to try again."
              : "Pairing expired. Select New code to try again.";
            return;
          }
        } catch (_error) { pairingStatus.textContent = "Cannot reach the pairing service. Retrying…"; }
        pairingTimer = setTimeout(poll, 3000);
      };
      pairingTimer = setTimeout(poll, 3000);
    } catch (error) {
      pairingStatus.textContent = error.message || "Could not start pairing.";
    } finally { pairingBusy = false; }
  }

  async function checkCloudSession() {
    if (!cloudControllerPage || localControllerPage) return;
    try {
      const response = await fetch("/api/pair/session", { cache: "no-store" });
      const state = response.ok ? await response.json() : null;
      if (state?.state === "paired") {
        if (state.rotationDue) await cloudJson("/api/pair/rotate", {
          method: "POST", headers: { "X-Horizon-Action": "pair" },
        });
        paired = true;
        pairing.hidden = true;
        if (tiles[activeIndex]) updateSelection(tiles[activeIndex]);
        return;
      }
    } catch (_error) { /* The pairing panel reports connection failure. */ }
    showPairing();
  }

  async function launchCloudApp(tile) {
    diagnostics?.launchStage("send");
    const queued = await cloudJson("/api/apps/launch", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Horizon-Action": "launch-app" },
      body: JSON.stringify({ app: tile.controllerAppId }),
    });
    if (!queued.id) throw new Error("Cloud launch returned no command ID.");
    diagnostics?.launchStage("queued", queued);
    let result = queued;
    for (let attempt = 0; attempt < 40 && ["queued", "processing"].includes(result.state); attempt++) {
      selectionStatus.textContent = result.state === "queued" ? "Waiting for controller…" : "Opening…";
      await new Promise(resolve => setTimeout(resolve, 2000));
      result = await cloudJson(`/api/apps/commands/${encodeURIComponent(queued.id)}`);
      if (result.state === "processing") diagnostics?.launchStage("processing", result);
    }
    diagnostics?.launchStage("terminal", result);
    if (result.state !== "verified") {
      throw new Error(cloudErrors[result.code] || "The app launch could not be confirmed.");
    }
  }

  async function launchNative(tile) {
    if (launchPending || launchConfirmed) return;
    if (cloudControllerPage && !localControllerPage && !paired) {
      showPairing();
      return;
    }
    if (!localControllerPage && !cloudControllerPage) {
      showNotice("Open Horizon through its controller to launch apps.");
      return;
    }
    launchPending = true;
    diagnostics?.launchStage("ok", tile.name);
    selectionStatus.textContent = "Opening…";
    showNotice(`Opening ${tile.name}…`);
    try {
      if (cloudControllerPage && !localControllerPage) {
        await launchCloudApp(tile);
      } else {
        diagnostics?.launchStage("send");
        const response = await fetch("/api/apps/launch", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Horizon-Action": "launch-app" },
          body: JSON.stringify({ app: tile.controllerAppId }),
          cache: "no-store",
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.message || "The TV did not open the app.");
        diagnostics?.launchStage("terminal", { state: "verified" });
      }
      launchConfirmed = true;
      selectionStatus.textContent = "Opened";
    } catch (error) {
      diagnostics?.launchStage("failed");
      const message = error instanceof TypeError || error instanceof SyntaxError
        ? (localControllerPage ? "Local controller is offline or unavailable." : "Cloud launch service is unavailable.")
        : error.message;
      selectionStatus.textContent = message;
      showNotice(message);
      if (message === cloudErrors.not_authorized) {
        paired = false;
        showPairing();
      }
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
      if (perfProfile !== "minimal") {
        const image = document.createElement("img");
        image.src = `assets/${tile.artwork}`;
        image.alt = "";
        image.draggable = false;
        icon.append(image);
      }

      const name = document.createElement("span");
      name.className = "tile-label";
      name.textContent = tile.name;
      button.append(icon, name);
      button.addEventListener("focus", () => {
        activeIndex = tiles.findIndex(item => item.id === tile.id);
        markFocused(button);
        updateSelection(tile);
      });
      button.addEventListener("blur", () => blurFocused(button));
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
    const beforeFocusScroll = diagnostics ? home.scrollTop : 0;
    focusElement(grid.children[next]);
    diagnostics?.focusScroll(home.scrollTop - beforeFocusScroll);
    if (Math.floor(next / cols) !== Math.floor(current / cols)) {
      const started = diagnostics ? now() : 0;
      home.scrollTop = next < cols ? 0 : Math.round(window.innerHeight * .43 * Math.floor(next / cols));
      diagnostics?.scroll(now() - started);
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
  settingsOpen.addEventListener("blur", () => blurFocused(settingsOpen));
  settingsClose.addEventListener("focus", () => markFocused(settingsClose));
  settingsClose.addEventListener("blur", () => blurFocused(settingsClose));
  browserClose.addEventListener("focus", () => markFocused(browserClose));
  browserClose.addEventListener("blur", () => blurFocused(browserClose));
  settingsOpen.addEventListener("click", openSettings);
  settingsClose.addEventListener("click", closeSettings);
  browserClose.addEventListener("click", closeBrowser);
  pairingRetry.addEventListener("focus", () => markFocused(pairingRetry));
  pairingRetry.addEventListener("blur", () => blurFocused(pairingRetry));
  pairingClose.addEventListener("focus", () => markFocused(pairingClose));
  pairingClose.addEventListener("blur", () => blurFocused(pairingClose));
  pairingRetry.addEventListener("click", startPairing);
  pairingClose.addEventListener("click", closePairing);
  settingRows.forEach(row => {
    row.addEventListener("focus", () => markFocused(row));
    row.addEventListener("blur", () => blurFocused(row));
    row.addEventListener("click", () => setPreference(row.dataset.setting));
  });

  window.addEventListener("keydown", event => {
    const receivedAt = now();
    const key = keyName(event);
    diagnostics?.received(key, event, receivedAt);
    let focusChanged = false;

    if (!pairing.hidden) {
      if (key === "Back") { event.preventDefault(); closePairing(); focusChanged = true; }
      else if (key === "OK") {
        event.preventDefault();
        if (document.activeElement === pairingClose) closePairing();
        else startPairing();
      } else if (key.startsWith("Arrow")) {
        event.preventDefault();
        focusElement(document.activeElement === pairingRetry ? pairingClose : pairingRetry);
        focusChanged = true;
      }
    } else if (!browser.hidden) {
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
  checkCloudSession();
  updateClock();
  setInterval(updateClock, 60000);
})();
