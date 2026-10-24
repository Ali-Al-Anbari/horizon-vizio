(function () {
  "use strict";
  var core = window.HorizonBrowserCore;
  var HORIZON_HOME = "https://horizon-vizio.ali-al-anbari.workers.dev/";
  var $ = function (id) { return document.getElementById(id); };
  var home = $("back-home");
  var navBack = $("nav-back");
  var navForward = $("nav-forward");
  var navRefresh = $("nav-refresh");
  var localButton = $("show-local");
  var address = $("address");
  var edit = $("edit-address");
  var go = $("go-address");
  var direct = $("direct-open");
  var frameButton = $("focus-frame");
  var upButton = $("scroll-up");
  var downButton = $("scroll-down");
  var cursorButton = $("enter-cursor");
  var toolbar = [home, navBack, navForward, navRefresh, localButton, address,
    edit, go, direct, frameButton, upButton, downButton, cursorButton];
  var viewer = $("viewer");
  var localPage = $("local-page");
  var frame = $("external-frame");
  var cursorElement = $("remote-cursor");
  var cursorToolbar = $("cursor-toolbar");
  var status = $("lab-status");
  var loading = $("loading-indicator");
  var historyLabel = $("history-label");
  var embeddingNote = $("embedding-note");
  var embeddingMessage = $("embedding-message");
  var directConfirm = $("direct-confirm");
  var directCancel = $("direct-cancel");
  var directContinue = $("direct-continue");
  var modeLabel = $("mode-label");
  var testInput = $("test-input");
  var dropdown = $("test-select");
  var dropdownPanel = $("test-options");
  var dropdownOptions = [$("test-option-movies"), $("test-option-series"), $("test-option-live")];
  var dropdownNames = ["Movies", "Series", "Live TV"];
  var selectedOption = 0;
  var highlightedOption = 0;
  var dropdownReturnMode = "cursor";
  var video = $("test-video");
  var mode = "toolbar";
  var returnMode = "toolbar";
  var toolbarIndex = 0;
  var loadedExternal = false;
  var loadTimer = null;
  var attempt = 0;
  var history = [{ kind: "local", url: null }];
  var historyIndex = 0;
  var keyboardReturnTimer = null;
  var suppressToolbarClickUntil = 0;
  var directChoice = 0;
  var buttonCount = 0;
  var lastButtonAt = -1000;
  var cursor = { x: 40, y: 40, lastKey: "", lastAt: -1000, streak: 0 };
  var cursorPositioned = false;
  var bounds = { width: 100, height: 100 };
  var keyboard = new window.HorizonTVKeyboard(
    $("keyboard-panel"), $("keyboard-preview"), $("keyboard-grid"), function (input, submitted) {
      if (submitted && input === address) submitAddress();
      if (keyboardReturnTimer) clearTimeout(keyboardReturnTimer);
      if (submitted) {
        // Keep the just-used keyboard key from transferring the same Enter
        // activation to a newly focused toolbar control on older webviews.
        mode = "keyboard-transition";
        suppressToolbarClickUntil = clock() + 400;
        keyboardReturnTimer = setTimeout(restoreKeyboardFocus, 180);
      } else {
        restoreKeyboardFocus();
        say("Keyboard closed. Text remains in the selected field.");
      }
    });

  function restoreKeyboardFocus() {
    keyboardReturnTimer = null;
    mode = returnMode;
    modeLabel.textContent = mode === "cursor" ? "Cursor mode" : "Toolbar mode";
    if (mode === "cursor") {
      try { viewer.focus({ preventScroll: true }); } catch (_error) { viewer.focus(); }
    } else focusToolbar(toolbar.indexOf(address));
  }

  function clock() {
    return typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now() : Date.now();
  }

  function say(message) { status.textContent = message; }

  function focusToolbar(index) {
    toolbarIndex = core.clamp(index, 0, toolbar.length - 1);
    var target = toolbar[toolbarIndex];
    try { target.focus({ preventScroll: true }); } catch (_error) { target.focus(); }
  }

  function updateBounds() {
    bounds.width = Math.max(24, viewer.clientWidth);
    bounds.height = Math.max(24, viewer.clientHeight);
    cursor.x = core.clamp(cursor.x, 12, bounds.width - 12);
    cursor.y = core.clamp(cursor.y, 12, bounds.height - 12);
    paintCursor();
  }

  function paintCursor() {
    cursorElement.style.transform = "translate3d(" + (cursor.x - 11) + "px," + (cursor.y - 11) + "px,0)";
  }

  function enterCursor() {
    mode = "cursor";
    viewer.classList.add("cursor-mode");
    cursorElement.hidden = false;
    cursorToolbar.hidden = false;
    cursor.lastKey = "";
    cursor.streak = 0;
    updateBounds();
    if (!loadedExternal && !cursorPositioned) {
      var target = $("test-link").getBoundingClientRect();
      var surface = viewer.getBoundingClientRect();
      cursor.x = core.clamp(target.left + target.width / 2 - surface.left, 12, bounds.width - 12);
      cursor.y = core.clamp(target.top + target.height / 2 - surface.top, 12, bounds.height - 12);
      cursorPositioned = true;
      paintCursor();
    }
    try { viewer.focus({ preventScroll: true }); } catch (_error) { viewer.focus(); }
    modeLabel.textContent = "Cursor mode";
    say(loadedExternal
      ? "Cursor is visible, but cross-origin sites cannot receive its synthetic clicks. Try Focus frame separately."
      : "Cursor ready. Arrows move, OK selects, Back returns to toolbar.");
  }

  function leaveCursor() {
    mode = "toolbar";
    viewer.classList.remove("cursor-mode");
    cursorElement.hidden = true;
    cursorToolbar.hidden = true;
    cursor.lastKey = "";
    cursor.streak = 0;
    modeLabel.textContent = "Toolbar mode";
    focusToolbar(toolbar.indexOf(edit));
    say("Toolbar ready. Edit is focused for an address or Google search.");
  }

  function highlightOption(index) {
    highlightedOption = core.clamp(index, 0, dropdownOptions.length - 1);
    for (var i = 0; i < dropdownOptions.length; i++) {
      if (i === highlightedOption) dropdownOptions[i].classList.add("is-highlighted");
      else dropdownOptions[i].classList.remove("is-highlighted");
    }
    try { dropdownOptions[highlightedOption].focus({ preventScroll: true }); }
    catch (_error) { dropdownOptions[highlightedOption].focus(); }
  }

  function openDropdown() {
    if (mode === "dropdown") return;
    dropdownReturnMode = mode;
    mode = "dropdown";
    dropdownPanel.hidden = false;
    cursorToolbar.hidden = true;
    dropdown.setAttribute("aria-expanded", "true");
    modeLabel.textContent = "Dropdown mode";
    highlightOption(selectedOption);
    say("Dropdown open. Up or Down chooses an option; OK selects; Back cancels.");
  }

  function closeDropdown(accept) {
    if (mode !== "dropdown") return;
    if (accept) {
      selectedOption = highlightedOption;
      dropdown.textContent = dropdownNames[selectedOption] + " ▾";
    }
    for (var i = 0; i < dropdownOptions.length; i++)
      dropdownOptions[i].setAttribute("aria-selected", i === selectedOption ? "true" : "false");
    dropdownPanel.hidden = true;
    dropdown.setAttribute("aria-expanded", "false");
    mode = dropdownReturnMode;
    cursorToolbar.hidden = mode !== "cursor";
    modeLabel.textContent = mode === "cursor" ? "Cursor mode" : "Toolbar mode";
    if (mode === "cursor") {
      try { viewer.focus({ preventScroll: true }); } catch (_error) { viewer.focus(); }
    } else focusToolbar(toolbar.indexOf(edit));
    say(accept ? "Dropdown selected: " + dropdownNames[selectedOption] + "." : "Dropdown closed without changing selection.");
  }

  function scrollPage(direction, quiet) {
    if (loadedExternal) {
      say("External frame scrolling must be tested with native remote focus; parent controls cannot scroll its page.");
      return;
    }
    var distance = direction * Math.max(160, Math.round(localPage.clientHeight * .55));
    try { localPage.scrollBy({ top: distance, behavior: "smooth" }); }
    catch (_error) { localPage.scrollTop += distance; }
    if (!quiet) say(direction > 0 ? "Local page scrolling down." : "Local page scrolling up.");
  }

  function updateHistoryLabel() {
    historyLabel.textContent = "History " + (historyIndex + 1) + "/" + history.length
      + " · Horizon-controlled pages only";
  }

  function showEmbeddingNote(message) {
    embeddingMessage.textContent = message;
    embeddingNote.hidden = false;
  }

  function displayEntry(entry) {
    attempt++;
    if (loadTimer) clearTimeout(loadTimer);
    loadTimer = null;
    embeddingNote.hidden = true;
    loading.hidden = true;
    if (entry.kind === "local") {
      frame.hidden = true;
      frame.removeAttribute("src");
      localPage.hidden = false;
      loadedExternal = false;
      localPage.scrollTop = 0;
      address.value = "";
      say("Browser Home ready. Its controls can be activated by the Horizon cursor.");
    } else {
      var current = attempt;
      loadedExternal = true;
      localPage.hidden = true;
      frame.hidden = false;
      address.value = entry.url;
      loading.hidden = false;
      if (entry.kind === "search") {
        showEmbeddingNote("Google Search currently advertises X-Frame-Options: SAMEORIGIN. A cross-origin frame may be blocked. Direct test requires an explicit confirmation.");
      }
      say("Trying embedded HTTPS navigation. A frame load event does not prove that the page rendered.");
      frame.src = entry.url;
      loadTimer = setTimeout(function () {
        if (attempt !== current) return;
        loading.hidden = true;
        if (embeddingNote.hidden) showEmbeddingNote("No load signal arrived. The website may be offline, blocked, or incompatible with this webview.");
        say("No iframe load signal after 10 seconds. The result is indeterminate; inspect the screen.");
      }, 10000);
    }
    updateHistoryLabel();
  }

  function pushEntry(entry) {
    var previous = history[historyIndex];
    if (previous.kind === entry.kind && previous.url === entry.url) {
      displayEntry(previous);
      return;
    }
    history.length = historyIndex + 1;
    history.push(entry);
    if (history.length > 32) history.shift();
    historyIndex = history.length - 1;
    displayEntry(entry);
  }

  function showLocal() {
    pushEntry({ kind: "local", url: null });
  }

  function historyBack() {
    if (historyIndex === 0) { say("No earlier Horizon-controlled page in this session."); return false; }
    historyIndex--;
    displayEntry(history[historyIndex]);
    return true;
  }

  function historyForward() {
    if (historyIndex >= history.length - 1) { say("No forward Horizon-controlled page in this session."); return false; }
    historyIndex++;
    displayEntry(history[historyIndex]);
    return true;
  }

  function refreshPage() {
    displayEntry(history[historyIndex]);
  }

  function openKeyboard(input) {
    returnMode = mode;
    mode = "keyboard";
    modeLabel.textContent = "Keyboard mode";
    keyboard.open(input);
    say("TV keyboard open. Arrows move, OK types, Back closes.");
  }

  function submitAddress() {
    var result = core.resolveInput(address.value);
    if (result.kind === "empty") return;
    if (result.kind === "invalid") {
      say("Enter search text or a valid HTTPS address. Other URL schemes are blocked.");
      return;
    }
    pushEntry({ kind: result.kind, url: result.url });
  }

  function focusExternalFrame() {
    if (!loadedExternal) {
      say("Open an HTTPS iframe first.");
      return;
    }
    mode = "frame";
    modeLabel.textContent = "External frame focus requested";
    say("Frame focus requested. Try arrows and OK. Back may not reach Horizon; use TV Home or the verified iHeart shortcut if needed.");
    try { frame.focus({ preventScroll: true }); } catch (_error) { frame.focus(); }
  }

  function openDirectConfirm() {
    if (!history[historyIndex].url) {
      say("Navigate to an HTTPS page or search first.");
      return;
    }
    directChoice = 0;
    directConfirm.hidden = false;
    mode = "direct-confirm";
    modeLabel.textContent = "Direct navigation confirmation";
    try { directCancel.focus({ preventScroll: true }); } catch (_error) { directCancel.focus(); }
  }

  function cancelDirect() {
    directConfirm.hidden = true;
    mode = "toolbar";
    modeLabel.textContent = "Toolbar mode";
    focusToolbar(toolbar.indexOf(direct));
  }

  function continueDirect() {
    if (directConfirm.hidden) return;
    var entry = history[historyIndex];
    if (!entry.url || !core.httpsAddress(entry.url)) { cancelDirect(); return; }
    // Explicitly leaves the lab. No claim is made about Conjure's Back behavior.
    window.location.assign(entry.url);
  }

  function toolbarAction(target) {
    if (target === home) returnToHorizon();
    else if (target === navBack) historyBack();
    else if (target === navForward) historyForward();
    else if (target === navRefresh) refreshPage();
    else if (target === localButton) showLocal();
    else if (target === address) {
      if (address.value.trim()) submitAddress();
      else openKeyboard(address);
    }
    else if (target === edit) openKeyboard(address);
    else if (target === go) submitAddress();
    else if (target === direct) openDirectConfirm();
    else if (target === frameButton) focusExternalFrame();
    else if (target === upButton) scrollPage(-1);
    else if (target === downButton) scrollPage(1);
    else if (target === cursorButton) enterCursor();
  }

  function returnToHorizon() {
    var host = window.location.hostname;
    window.location.assign(host === "localhost" || host === "127.0.0.1" ? "./" : HORIZON_HOME);
  }

  function editableTarget(element) {
    while (element && element !== viewer) {
      if (/^(A|BUTTON|INPUT|SELECT|VIDEO)$/.test(element.tagName || "")) return element;
      element = element.parentNode;
    }
    return null;
  }

  function hitTarget(x, y) {
    var element = typeof document.elementFromPoint === "function" ? document.elementFromPoint(x, y) : null;
    var target = editableTarget(element);
    if (target) return target;
    if (!cursorToolbar.hidden) {
      var exitRect = cursorToolbar.getBoundingClientRect();
      if (x >= exitRect.left && x <= exitRect.right && y >= exitRect.top && y <= exitRect.bottom)
        return cursorToolbar;
    }
    // Older webviews may lack elementFromPoint. This fallback stays inside our
    // controlled same-origin page and runs only on OK, never on every arrow.
    var items = localPage.querySelectorAll("a, button, input, select, video");
    for (var index = 0; index < items.length; index++) {
      var rect = items[index].getBoundingClientRect();
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return items[index];
    }
    return null;
  }

  function cursorActivate() {
    if (loadedExternal) {
      say("Cross-origin iframe controls cannot be clicked by the Horizon cursor. Use Focus frame to test native remote interaction.");
      return;
    }
    var rect = viewer.getBoundingClientRect();
    var target = hitTarget(rect.left + cursor.x, rect.top + cursor.y);
    if (!target) { say("No local control under the cursor."); return; }
    if (target === cursorToolbar) { leaveCursor(); return; }
    if (target === dropdown) { openDropdown(); return; }
    if (target.tagName === "INPUT") { openKeyboard(target); return; }
    if (target.tagName === "VIDEO") {
      try {
        if (target.paused) {
          var result = target.play();
          if (result && typeof result.catch === "function") result.catch(function () {
            say("Video playback rejected or unsupported. Check codec, policy, and network on the TV.");
          });
          say("Video play requested from remote OK. Confirm visible playback on the TV.");
        } else { target.pause(); say("Video paused."); }
      } catch (_error) { say("Video playback is unavailable in this browser."); }
      return;
    }
    if (typeof target.click === "function") {
      target.click();
      say("Synthetic activation requested on the local " + target.tagName.toLowerCase() + ". Check its visible result.");
    }
  }

  function moveRemoteCursor(key, event) {
    var next = core.moveCursor(cursor, key, event.repeat === true, clock(), bounds.width, bounds.height);
    cursor = next;
    paintCursor();
    if (next.edgeY && !loadedExternal) scrollPage(next.edgeY > 0 ? 1 : -1, true);
  }

  window.addEventListener("keydown", function (event) {
    var key = core.keyName(event);
    if (key !== "OK" && key !== "Back" && key.indexOf("Arrow") !== 0) return;
    event.preventDefault();
    if (typeof event.stopPropagation === "function") event.stopPropagation();
    if (key === "Back" && event.repeat) return;
    if (mode === "keyboard-transition") return;
    if (mode === "dropdown") {
      if (key === "Back") closeDropdown(false);
      else if (key === "ArrowUp") highlightOption(highlightedOption - 1);
      else if (key === "ArrowDown") highlightOption(highlightedOption + 1);
      else if (key === "OK" && !event.repeat) closeDropdown(true);
      return;
    }
    if (mode === "direct-confirm") {
      if (key === "Back") cancelDirect();
      else if (key === "ArrowLeft" || key === "ArrowRight") {
        directChoice = key === "ArrowRight" ? 1 : 0;
        (directChoice ? directContinue : directCancel).focus();
      } else if (key === "OK" && !event.repeat) {
        if (directChoice) continueDirect();
        else cancelDirect();
      }
      return;
    }
    if (mode === "keyboard") {
      if (key === "Back") keyboard.close();
      else if (key === "OK" && !event.repeat) keyboard.press();
      else if (key.indexOf("Arrow") === 0) keyboard.move(key);
      return;
    }
    if (mode === "cursor") {
      if (key === "Back") leaveCursor();
      else if (key === "OK" && !event.repeat) cursorActivate();
      else if (key.indexOf("Arrow") === 0) moveRemoteCursor(key, event);
      return;
    }
    if (mode === "frame") {
      if (key === "Back") { mode = "toolbar"; modeLabel.textContent = "Toolbar mode"; focusToolbar(toolbarIndex); }
      return;
    }
    if (key === "Back") {
      historyBack();
    }
    else if (key === "OK" && !event.repeat) toolbarAction(toolbar[toolbarIndex]);
    else if (key === "ArrowLeft") focusToolbar(toolbarIndex - 1);
    else if (key === "ArrowRight") focusToolbar(toolbarIndex + 1);
    else if (key === "ArrowDown") enterCursor();
  }, { passive: false, capture: true });

  toolbar.forEach(function (button, index) {
    button.addEventListener("focus", function () { toolbarIndex = index; });
    button.addEventListener("click", function () {
      if (clock() < suppressToolbarClickUntil && (button === home || button === address || button === go)) return;
      toolbarIndex = index;
      toolbarAction(button);
    });
  });
  cursorToolbar.addEventListener("click", function () { if (mode === "cursor") leaveCursor(); });
  dropdown.addEventListener("click", openDropdown);
  dropdownOptions.forEach(function (option, index) {
    option.addEventListener("click", function () {
      if (mode !== "dropdown") return;
      highlightedOption = index;
      closeDropdown(true);
    });
  });
  directCancel.addEventListener("focus", function () { directChoice = 0; });
  directContinue.addEventListener("focus", function () { directChoice = 1; });
  directCancel.addEventListener("click", cancelDirect);
  directContinue.addEventListener("click", continueDirect);
  $("test-button").addEventListener("click", function () {
    var at = clock();
    if (at - lastButtonAt < 120) return;
    lastButtonAt = at;
    $("button-count").textContent = String(++buttonCount);
  });
  frame.addEventListener("load", function () {
    if (!loadedExternal) return;
    if (loadTimer) clearTimeout(loadTimer);
    loading.hidden = true;
    say("Iframe load event received. Inspect visible content; this does not prove that embedding or interaction succeeded.");
  });
  frame.addEventListener("error", function () {
    if (loadedExternal) {
      loading.hidden = true;
      showEmbeddingNote("The frame reported a load error. The site may block embedding or the network may be unavailable.");
      say("Iframe reported a load error. Inspect whether the site blocks embedding or the network failed.");
    }
  });
  window.addEventListener("resize", updateBounds);
  updateBounds();
  updateHistoryLabel();
  focusToolbar(0);
})();
