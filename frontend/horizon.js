(() => {
  "use strict";

  const config = window.HORIZON_CONFIG;
  const grid = document.getElementById("app-grid");
  const secondaryGrid = document.getElementById("secondary-app-grid");
  if (!config || !Array.isArray(config.tiles) || !grid || !secondaryGrid) return;

  const home = document.getElementById("home-screen");
  const settings = document.getElementById("settings-screen");
  const browser = document.getElementById("browser-screen");
  const searchOpen = document.getElementById("search-open");
  const watchSection = document.getElementById("watch-section");
  const watchHost = document.getElementById("watch-cards");
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
  const defaults = { wallpaper: wallpapers[0]?.id, slideshow: true, accent: "cyan" };
  const options = {
    accent: [{ value: "cyan", label: "Pearl" }, { value: "violet", label: "Violet" }, { value: "ice", label: "Ice" }],
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
  let searchOpening = false;
  let watchRows = [];
  let watchIndex = 0;
  const topTileCount = config.tiles.filter(tile => tile.favorite !== false).length;
  const tileButton = index => index < topTileCount ? grid.children[index] : secondaryGrid.children[index - topTileCount];
  function revealFocus(element) { element?.scrollIntoView?.({ block: "nearest", inline: "nearest" }); }
  let paired = false;
  let pairingRequired = false;
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

  function openSearch(source = "search-open") {
    if (searchOpening || !searchOpen) return;
    const localPreview = ["localhost", "127.0.0.1"].includes(location.hostname) && location.port === "4173";
    const target = localPreview ? "/universal-search/index.html?mock=1&from=home-local" : config.searchUrl;
    if (typeof target !== "string" || !target) { showNotice("Search is unavailable."); return; }
    searchOpening = true;
    try { sessionStorage.setItem("horizon.home.searchFocus", source); } catch (_error) {}
    try { location.assign(target); }
    catch (_error) { searchOpening = false; showNotice("Search could not open."); }
  }

  function validWatchRow(row) {
    const positive = value => Number.isInteger(value) && value > 0 && value <= 999999999;
    if (!row || !["tv", "movie"].includes(row.type) || !positive(row.id)
        || typeof row.title !== "string" || !row.title || row.title.length > 160
        || !Number.isFinite(row.at) || row.at < 0 || row.at > 8640000000000000
        || (row.type === "tv" && (!positive(row.season) || !positive(row.episode)))) return null;
    const artwork = value => typeof value === "string" && /^\/[a-zA-Z0-9._-]{1,90}$/.test(value) ? value : null;
    return { type: row.type, id: row.id, title: row.title, season: row.type === "tv" ? row.season : null,
      episode: row.type === "tv" ? row.episode : null, subtitle: row.subtitle === "on" ? "on" : "off",
      at: row.at, poster: artwork(row.poster), backdrop: artwork(row.backdrop),
      episodeTitle: typeof row.episodeTitle === "string" ? row.episodeTitle.slice(0, 160) : "",
      tvdbId: row.type === "tv" && positive(row.tvdbId) ? row.tvdbId : null };
  }

  function readWatchRows() {
    const key = "horizon.watch.home.v1";
    let parsed = null;
    try {
      const fragment = location.hash || "";
      parsed = fragment.startsWith("#watch=") && fragment.length < 7000
        ? JSON.parse(decodeURIComponent(fragment.slice(7))) : JSON.parse(localStorage.getItem(key) || "null");
    } catch (_error) { return []; }
    if (!parsed || parsed.version !== 2 || !Array.isArray(parsed.items) || parsed.items.length > 6) return [];
    const seen = new Set();
    const rows = parsed.items.map(validWatchRow).filter(row => {
      if (!row) return false;
      const id = `${row.type}:${row.id}`;
      if (seen.has(id)) return false;
      seen.add(id); return true;
    });
    if ((location.hash || "").startsWith("#watch=")) {
      try { localStorage.setItem(key, JSON.stringify({ version: 2, items: rows })); } catch (_error) {}
    }
    return rows;
  }

  function openWatchRow(row) {
    if (searchOpening) return;
    const localPreview = ["localhost", "127.0.0.1"].includes(location.hostname) && location.port === "4173";
    const watchUrl = localPreview ? "/universal-search/index.html?mock=1&from=home-local" : config.searchUrl;
    try { sessionStorage.setItem("horizon.watch.returnFocus", `${row.type}:${row.id}`); } catch (_error) {}
    if (row.type === "movie") {
      searchOpening = true;
      try { location.assign(watchUrl + "&open=movie&id=" + row.id); }
      catch (_error) { searchOpening = false; showNotice("Movie details could not open."); }
      return;
    }
    const url = watchUrl + "&play=tv&id=" + row.id + "&season=" + row.season + "&episode="
      + row.episode + "&sub=" + row.subtitle + "&name=" + encodeURIComponent(row.title.slice(0, 160))
      + (row.poster ? "&poster=" + encodeURIComponent(row.poster) : "")
      + (row.backdrop ? "&backdrop=" + encodeURIComponent(row.backdrop) : "")
      + (row.episodeTitle ? "&episodeTitle=" + encodeURIComponent(row.episodeTitle) : "")
      + (row.tvdbId ? "&tvdb=" + row.tvdbId : "");
    searchOpening = true;
    try { location.assign(url);
      const fresh = { ...row, at: Date.now() };
      watchRows = [fresh, ...watchRows.filter(other => other.type !== row.type || other.id !== row.id)].slice(0, 6);
      try { localStorage.setItem("horizon.watch.home.v1", JSON.stringify({ version: 2, items: watchRows })); } catch (_error) {}
    } catch (_error) { searchOpening = false; showNotice("Player could not open."); }
  }

  function renderWatchRows() {
    if (!watchHost || !watchSection) return;
    watchRows = readWatchRows(); watchHost.replaceChildren();
    watchSection.hidden = !watchRows.length;
    watchRows.forEach((row, index) => {
      const card = document.createElement("button"); card.type = "button"; card.className = "watch-card";
      card.dataset.watchIndex = String(index);
      const art = document.createElement("span"); art.className = "watch-card-art";
      const showFallback = () => {
        const fallback = document.createElement("img"); fallback.className = "watch-card-fallback";
        fallback.src = "assets/horizon-watch.svg"; fallback.alt = "";
        art.replaceChildren(fallback);
      };
      if (row.poster || row.backdrop) {
        const image = document.createElement("img"); image.loading = "lazy"; image.alt = "";
        image.className = "watch-card-poster";
        image.src = "https://image.tmdb.org/t/p/" + (row.poster ? "w500" + row.poster : "w780" + row.backdrop);
        image.onerror = () => {
          if (row.poster && row.backdrop && image.src.indexOf(row.backdrop) < 0) {
            image.src = "https://image.tmdb.org/t/p/w780" + row.backdrop;
          } else showFallback();
        };
        art.append(image);
      } else showFallback();
      const copy = document.createElement("span"); copy.className = "watch-card-copy";
      const title = document.createElement("strong"); title.textContent = row.title;
      const detail = document.createElement("small"); detail.textContent = row.type === "tv"
        ? `S${row.season} E${row.episode}${row.episodeTitle ? " · " + row.episodeTitle : ""}` : "Movie";
      copy.append(title, detail); card.append(art, copy);
      card.setAttribute("aria-label", row.title + ", " + detail.textContent);
      card.addEventListener("focus", () => { watchIndex = index; markFocused(card); });
      card.addEventListener("blur", () => blurFocused(card));
      card.addEventListener("click", () => openWatchRow(row));
      watchHost.append(card);
    });
  }

  function focusWatch(index) {
    if (!watchRows.length) return false;
    watchIndex = Math.max(0, Math.min(watchRows.length - 1, index));
    const card = watchHost.children[watchIndex];
    focusElement(card);
    revealFocus(card);
    return true;
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
    return config.tiles.filter(tile => tile.favorite !== false).concat(config.tiles.filter(tile => tile.favorite === false));
  }

  function currentTileIndex() {
    const id = document.activeElement?.dataset?.id;
    const found = tiles.findIndex(tile => tile.id === id);
    return found >= 0 ? found : activeIndex;
  }

  function updateSelection(tile) {
    const status = tile.kind === "watch" ? "Search movies and TV"
      : tile.kind === "browser" ? "Browser coming soon"
      : tile.kind === "settings" ? "Personalize Horizon"
      : tile.launchState === "supported" ? (localControllerPage ? "Press OK to open"
        : cloudControllerPage ? (paired ? "Press OK to open" : pairingRequired ? "Pair this TV to open" : "Launch service unavailable") : "Controller required")
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
    if (!cloudControllerPage || localControllerPage || !pairingRequired) return;
    pairing.hidden = false;
    focusElement(pairingRetry);
    if (!pairingBusy && pairingCode.textContent === "—") startPairing();
  }

  function closePairing() {
    pairing.hidden = true;
    focusElement(tileButton(activeIndex));
  }

  async function startPairing() {
    if (pairingBusy || paired) return;
    pairingBusy = true;
    const generation = ++pairingGeneration;
    clearTimeout(pairingTimer);
    pairingCode.textContent = "—";
    pairingCode.hidden = true;
    pairingStatus.textContent = "Creating a short-lived code…";
    try {
      const result = await cloudJson("/api/pair/start", {
        method: "POST", headers: { "X-Horizon-Action": "pair" },
      });
      if (generation !== pairingGeneration) return;
      if (!/^[A-Z0-9]{10}$/.test(result.code || "")) throw new Error("Pairing service returned no usable code. Try again later.");
      pairingCode.textContent = result.code;
      pairingCode.hidden = false;
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
            focusElement(tileButton(activeIndex));
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
      pairingStatus.textContent = error.message === "Cloud sign-in or launch service is unavailable."
        ? "Pairing service unavailable. Try New code later, or select Back to Horizon."
        : error.message || "Could not start pairing. Try New code later.";
    } finally { pairingBusy = false; }
  }

  async function checkCloudSession() {
    if (!cloudControllerPage || localControllerPage) return;
    try {
      const response = await fetch("/api/pair/session", { cache: "no-store" });
      if (!response.headers.get("content-type")?.includes("application/json")) return;
      const state = await response.json();
      if (response.ok && state?.state === "paired") {
        pairingRequired = false;
        paired = true;
        pairing.hidden = true;
        if (tiles[activeIndex]) updateSelection(tiles[activeIndex]);
        if (state.rotationDue) {
          try { await cloudJson("/api/pair/rotate", {
            method: "POST", headers: { "X-Horizon-Action": "pair" },
          }); } catch (error) {
            if (error.message === cloudErrors.not_authorized) {
              paired = false; pairingRequired = true; showPairing();
            }
            /* A service outage is not evidence that the validated session expired. */
          }
        }
        return;
      }
      if (response.status === 401 && state?.code === "not_authorized") {
        pairingRequired = true;
        paired = false;
        showPairing();
      }
    } catch (_error) { /* Service failure is not evidence that pairing is required. */ }
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
      if (pairingRequired) showPairing();
      else showNotice("Cloud launch service is unavailable. Try again later.");
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
        pairingRequired = true;
        showPairing();
      }
    } finally {
      launchPending = false;
    }
  }

  function activate(tile) {
    if (tile.kind === "watch") { openSearch(tile.id); return; }
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
    secondaryGrid.replaceChildren();
    for (const [index, tile] of tiles.entries()) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "app-tile";
      button.dataset.id = tile.id;
      button.setAttribute("aria-label", `${tile.name}, ${tile.kind === "watch" ? "open Horizon Watch" : tile.kind === "browser" ? "browser coming soon" : tile.kind === "settings" ? "open settings" : tile.launchState === "supported" ? "open native app" : "native launch unverified"}`);

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
      (index < topTileCount ? grid : secondaryGrid).append(button);
    }
    const restored = restoreId ? tiles.findIndex(tile => tile.id === restoreId) : -1;
    activeIndex = restored >= 0 ? restored : Math.min(activeIndex, tiles.length - 1);
    if (!home.hidden) {
      focusElement(tileButton(activeIndex));
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
    focusElement(tileButton(activeIndex));
  }

  function closeBrowser() {
    browser.hidden = true;
    home.hidden = false;
    const restored = tiles.findIndex(tile => tile.id === returnTileId);
    activeIndex = restored >= 0 ? restored : 0;
    focusElement(tileButton(activeIndex));
  }

  function moveTile(key) {
    const current = currentTileIndex();
    const top = current < topTileCount;
    const start = top ? 0 : topTileCount;
    const count = top ? topTileCount : tiles.length - topTileCount;
    const local = current - start;
    let next = current;
    if (key === "ArrowLeft" && local > 0) next--;
    if (key === "ArrowRight" && local + 1 < count) next++;
    if (key === "ArrowUp") {
      if (top) { activeIndex = current; focusElement(settingsOpen); home.scrollTop = 0; return true; }
      if (watchRows.length) return focusWatch(Math.min(watchRows.length - 1, local));
      next = Math.min(topTileCount - 1, local);
    }
    if (key === "ArrowDown") {
      if (top && watchRows.length) return focusWatch(Math.min(watchRows.length - 1, local));
      if (top) next = topTileCount + local;
    }
    if (next === current) return false;
    const beforeFocusScroll = diagnostics ? home.scrollTop : 0;
    const target = tileButton(next);
    focusElement(target);
    revealFocus(target);
    diagnostics?.focusScroll(home.scrollTop - beforeFocusScroll);
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
  searchOpen?.addEventListener("focus", () => markFocused(searchOpen));
  searchOpen?.addEventListener("blur", () => blurFocused(searchOpen));
  searchOpen?.addEventListener("click", () => openSearch());
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
      if (document.activeElement !== tileButton(0)) focusElement(tileButton(0));
      focusChanged = true;
    } else if (key === "OK") {
      event.preventDefault();
      if (document.activeElement === searchOpen) { if (!event.repeat) openSearch(); }
      else if (document.activeElement?.dataset?.watchIndex !== undefined) {
        if (!event.repeat) openWatchRow(watchRows[watchIndex]);
      }
      else if (document.activeElement === settingsOpen) openSettings();
      else if (tiles[currentTileIndex()]) activate(tiles[currentTileIndex()]);
    } else if (key.startsWith("Arrow")) {
      event.preventDefault();
      if (document.activeElement === settingsOpen) {
        if (key === "ArrowDown") { focusElement(tileButton(activeIndex)); revealFocus(tileButton(activeIndex)); focusChanged = true; }
        else if (key === "ArrowLeft") { focusElement(searchOpen); home.scrollTop = 0; focusChanged = true; }
        else if (key === "ArrowUp") { home.scrollTop = 0; focusChanged = true; }
      } else if (document.activeElement === searchOpen) {
        if (key === "ArrowDown") { focusElement(tileButton(activeIndex)); revealFocus(tileButton(activeIndex)); focusChanged = true; }
        else if (key === "ArrowRight") { focusElement(settingsOpen); home.scrollTop = 0; focusChanged = true; }
        else if (key === "ArrowUp") { home.scrollTop = 0; focusChanged = true; }
      } else if (document.activeElement?.dataset?.watchIndex !== undefined) {
        if (key === "ArrowLeft") focusChanged = focusWatch(watchIndex - 1);
        else if (key === "ArrowRight") focusChanged = focusWatch(watchIndex + 1);
        else if (key === "ArrowUp") {
          const target = tileButton(Math.min(topTileCount - 1, watchIndex));
          focusElement(target); revealFocus(target); focusChanged = true;
        } else if (key === "ArrowDown") {
          const target = tileButton(Math.min(tiles.length - 1, topTileCount + watchIndex));
          focusElement(target); revealFocus(target); focusChanged = true;
        }
      } else focusChanged = moveTile(key);
    }
    diagnostics?.handled(receivedAt, focusChanged);
  }, { passive: false });

  applyPreferences();
  if (wallpapers.length) showWallpaper(Math.max(0, wallpapers.findIndex(wallpaper => wallpaper.id === preferences.wallpaper)));
  renderTiles();
  renderWatchRows();
  if (/(?:^|[?&])return=search(?:&|$)/.test(location.search || "")) {
    let returnFocus = null;
    try { returnFocus = sessionStorage.getItem("horizon.watch.returnFocus"); sessionStorage.removeItem("horizon.watch.returnFocus"); } catch (_error) {}
    const returnedIndex = watchRows.findIndex(row => `${row.type}:${row.id}` === returnFocus);
    if (returnedIndex >= 0) focusWatch(returnedIndex);
    else {
      let searchFocus = null;
      try { searchFocus = sessionStorage.getItem("horizon.home.searchFocus"); } catch (_error) {}
      focusElement(searchFocus === "horizon-watch" ? tileButton(0) : searchOpen);
    }
    try { sessionStorage.removeItem("horizon.home.searchFocus"); } catch (_error) {}
    window.history?.replaceState?.(null, "", location.pathname || "/");
  } else if ((location.hash || "").startsWith("#watch=")) {
    window.history?.replaceState?.(null, "", location.pathname || "/");
  }
  checkCloudSession();
  updateClock();
  setInterval(updateClock, 60000);
})();
