(function (root) {
  "use strict";

  var HORIZON_HOME = "https://horizon-vizio.ali-al-anbari.workers.dev/";
  var SOURCES = {
    original: {
      name: "Original · MDN flower",
      url: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
    },
    mp4: {
      name: "Sintel · W3C external",
      url: "https://media.w3.org/2010/05/sintel/trailer.mp4",
    },
    relay: {
      name: "Sintel · Cloudflare relay",
      url: "media/relay/sintel.mp4",
    },
    flowerRelay: {
      name: "Flower · Cloudflare relay",
      url: "media/relay/flower.mp4",
    },
    local: {
      name: "Sintel · same bytes, preview host",
      url: "media/sintel-original.mp4",
    },
    faststart: {
      name: "Sintel · faststart, preview host",
      url: "media/sintel-faststart.mp4",
    },
    compat: {
      name: "Sintel · Baseline/AAC, preview host",
      url: "media/sintel-compat.mp4",
    },
    long: {
      name: "25-minute continuity test",
      url: "media/horizon-25min.mp4",
    },
    hls: {
      name: "HLS · Apple Bip Bop",
      url: "https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_16x9/bipbop_16x9_variant.m3u8",
    },
  };
  var SOURCE_KEYS = ["original", "mp4", "relay", "flowerRelay", "local", "faststart", "compat", "long", "hls"];
  var BUTTONS = SOURCE_KEYS.map(function (name) { return "source-" + name; })
    .concat(["seek-back", "play", "seek-forward", "checkpoint", "fullscreen", "exit"]);
  var CHECKPOINTS = [300, 600, 900, 1200, 1440];

  // Match the tested Browser Lab key names, including embedded-TV keyCode fallbacks.
  function keyName(event) {
    var key = event && event.key;
    if (key === "Enter" || key === "Select" || key === "OK" || key === "NumpadEnter") return "OK";
    if (key === "Escape" || key === "Backspace" || key === "BrowserBack" || key === "GoBack") return "Back";
    if (key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown") return key;
    var code = event && (event.keyCode || event.which);
    if (code === 13) return "OK";
    if (code === 8 || code === 27 || code === 4) return "Back";
    if (code >= 37 && code <= 40) return ["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"][code - 37];
    return key || "Unknown";
  }

  function seekTarget(current, duration, change) {
    if (!isFinite(current) || !isFinite(duration) || duration <= 0) return null;
    return Math.max(0, Math.min(duration, current + change));
  }

  function formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) return "--:--";
    var whole = Math.floor(seconds);
    return Math.floor(whole / 60) + ":" + ("0" + (whole % 60)).slice(-2);
  }

  function errorText(code) {
    return ({ 1: "Playback was aborted", 2: "Network error while loading media",
      3: "Media decoding failed", 4: "Media source or format is unsupported" })[code]
      || "Media playback failed";
  }

  function safeDetail(value) {
    return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 150) : "";
  }

  function mediaErrorText(error) {
    var code = error && Number(error.code) || 0;
    var message = safeDetail(error && error.message);
    return "Media error " + code + " (" + errorText(code) + ")" + (message ? ": " + message : "") + ".";
  }

  function playErrorText(error) {
    var name = safeDetail(error && error.name) || "unknown";
    var message = safeDetail(error && error.message);
    return "Play rejected (" + name + ")" + (message ? ": " + message : "") + ".";
  }

  function createLab(doc, nav) {
    var get = function (id) { return doc.getElementById(id); };
    var video = get("video");
    if (!video) return null;
    var player = get("player");
    var status = get("status");
    var progress = get("progress");
    var time = get("time");
    var sourceLabel = get("source-label");
    var capabilities = get("capabilities");
    var buttons = BUTTONS.map(get);
    var focused = SOURCE_KEYS.length + 1;
    var selected = null;
    var checkpointIndex = 0;
    var disposed = false;
    var viewportFullscreen = false;
    var previousFocus = null;
    var diagnostics = get("diagnostics");
    var showDiagnostics = /(?:^|[?&])diagnostics=1(?:&|$)/.test(nav.search || "");
    var recentEvents = [];
    diagnostics.hidden = !showDiagnostics;

    function say(message) { if (!disposed && status.textContent !== message) status.textContent = message; }
    function record(eventName) {
      if (!showDiagnostics || disposed) return;
      recentEvents.push(eventName);
      if (recentEvents.length > 6) recentEvents.shift();
      var ready = ["HAVE_NOTHING", "HAVE_METADATA", "HAVE_CURRENT_DATA", "HAVE_FUTURE_DATA", "HAVE_ENOUGH_DATA"];
      var network = ["EMPTY", "IDLE", "LOADING", "NO_SOURCE"];
      get("media-state").textContent = "readyState " + video.readyState + " (" + (ready[video.readyState] || "unknown")
        + ") · networkState " + video.networkState + " (" + (network[video.networkState] || "unknown")
        + ") · currentSrc: " + (safeDetail(video.currentSrc) || "(empty)");
      get("media-events").textContent = "Recent events: " + recentEvents.join(" → ");
    }
    function fullscreenActive() { return viewportFullscreen; }
    function updateTime() {
      var duration = video.duration;
      var current = video.currentTime || 0;
      time.textContent = formatTime(current) + " / " + formatTime(duration);
      var finiteDuration = isFinite(duration) && duration > 0;
      progress.max = finiteDuration ? duration : 1;
      progress.value = finiteDuration ? Math.max(0, Math.min(duration, current)) : 0;
    }
    function updatePlay() { get("play").textContent = video.paused ? "Play" : "Pause"; }
    function probeRelay(name) {
      if (!showDiagnostics) return;
      var output = get("relay-http");
      output.textContent = "";
      if (name !== "relay" && name !== "flowerRelay") return;
      if (typeof root.fetch !== "function") { output.textContent = "Relay HEAD check unavailable."; return; }
      output.textContent = "Checking relay HEAD…";
      root.fetch(SOURCES[name].url, { method: "HEAD", credentials: "omit" }).then(function (response) {
        if (disposed || selected !== name) return;
        var type = response.headers && response.headers.get("Content-Type") || "unknown type";
        output.textContent = "Relay HEAD " + response.status + " · " + safeDetail(type)
          + ". GET and Range playback must be checked separately.";
      }).catch(function () {
        if (!disposed && selected === name) output.textContent = "Relay HEAD unavailable; check media events.";
      });
    }
    function choose(name) {
      if (disposed || !SOURCES[name] || selected === name) return;
      if (selected !== null) video.pause();
      selected = name;
      checkpointIndex = 0;
      video.loop = name !== "long";
      say("Loading " + SOURCES[name].name + ". Press Play when ready.");
      video.src = SOURCES[name].url;
      video.load();
      SOURCE_KEYS.forEach(function (key) {
        get("source-" + key).setAttribute("aria-pressed", String(name === key));
      });
      sourceLabel.textContent = "Selected: " + SOURCES[name].name;
      updatePlay();
      updateTime();
      record("source:" + name);
      probeRelay(name);
    }
    function togglePlay() {
      if (disposed) return;
      if (!video.paused) { video.pause(); updatePlay(); say("Paused."); return; }
      try {
        var result = video.play();
        if (result && typeof result.catch === "function") {
          result.catch(function (error) { record("play-rejected"); say(playErrorText(error)); });
        }
        say("Play requested. Confirm picture and sound on the TV.");
      } catch (error) { record("play-threw"); say(playErrorText(error)); }
    }
    function seek(change) {
      if (disposed) return;
      var target = seekTarget(video.currentTime, video.duration, change);
      if (target === null) { say("Seeking unavailable until a finite duration is loaded."); return; }
      try { video.currentTime = target; updateTime(); say("Seek requested to " + formatTime(target) + "."); }
      catch (_error) { say("This media cannot be seeked."); }
    }
    function nextCheckpoint() {
      if (disposed) return;
      if (selected !== "long" || !isFinite(video.duration) || video.duration < 1490) {
        say("Checkpoints are available after the 25-minute video loads.");
        return;
      }
      var target = CHECKPOINTS[checkpointIndex];
      try {
        video.currentTime = target;
        checkpointIndex = (checkpointIndex + 1) % CHECKPOINTS.length;
        updateTime();
        say("Seek requested to " + formatTime(target) + ". Check picture and the next audio cue.");
      } catch (_error) { say("Checkpoint seek failed."); }
    }
    function leaveFullscreen() {
      if (!viewportFullscreen) return;
      viewportFullscreen = false;
      player.classList.remove("viewport-fullscreen");
      doc.body.classList.remove("video-fullscreen");
      get("fullscreen").textContent = "Fullscreen";
      var restoreIndex = buttons.indexOf(previousFocus);
      previousFocus = null;
      focus(restoreIndex < 0 ? SOURCE_KEYS.length + 4 : restoreIndex);
      say("Fullscreen closed. Playback continues.");
    }
    function toggleFullscreen() {
      if (disposed) return;
      if (viewportFullscreen) { leaveFullscreen(); return; }
      previousFocus = doc.activeElement;
      viewportFullscreen = true;
      player.classList.add("viewport-fullscreen");
      doc.body.classList.add("video-fullscreen");
      get("fullscreen").textContent = "Exit fullscreen";
      focus(SOURCE_KEYS.length + 4);
      say("Viewport fullscreen active. Back returns to the Video Lab.");
    }
    function cleanup() {
      if (disposed) return;
      disposed = true;
      if (viewportFullscreen) {
        viewportFullscreen = false;
        player.classList.remove("viewport-fullscreen");
        doc.body.classList.remove("video-fullscreen");
      }
      try { video.pause(); video.removeAttribute("src"); video.load(); }
      catch (_error) { /* Page is leaving; no media work remains. */ }
    }
    function exit() { if (disposed) return; cleanup(); nav.replace(HORIZON_HOME); }
    function activate(index) {
      if (index < SOURCE_KEYS.length) choose(SOURCE_KEYS[index]);
      else if (index === SOURCE_KEYS.length) seek(-10);
      else if (index === SOURCE_KEYS.length + 1) togglePlay();
      else if (index === SOURCE_KEYS.length + 2) seek(10);
      else if (index === SOURCE_KEYS.length + 3) nextCheckpoint();
      else if (index === SOURCE_KEYS.length + 4) toggleFullscreen();
      else if (index === SOURCE_KEYS.length + 5) exit();
    }
    function focus(index) {
      focused = Math.max(0, Math.min(buttons.length - 1, index));
      try { buttons[focused].focus({ preventScroll: true }); }
      catch (_error) { buttons[focused].focus(); }
    }
    function onKey(event) {
      if (disposed) return;
      var key = keyName(event);
      if (key !== "OK" && key !== "Back" && key.indexOf("Arrow") !== 0) return;
      event.preventDefault();
      if (typeof event.stopPropagation === "function") event.stopPropagation();
      if (key === "Back") {
        if (event.repeat) return;
        if (fullscreenActive()) leaveFullscreen();
        else exit();
      } else if (key === "OK") {
        if (!event.repeat) activate(focused);
      } else if (key === "ArrowUp") focus(viewportFullscreen ? SOURCE_KEYS.length + 1 : 0);
      else if (key === "ArrowDown") focus(SOURCE_KEYS.length + 1);
      else if (key === "ArrowLeft") focus(Math.max(viewportFullscreen || focused >= SOURCE_KEYS.length
        ? SOURCE_KEYS.length : 0, focused - 1));
      else if (key === "ArrowRight") focus(Math.min(viewportFullscreen || focused >= SOURCE_KEYS.length
        ? buttons.length - 1 : SOURCE_KEYS.length - 1, focused + 1));
    }

    buttons.forEach(function (button, index) {
      button.addEventListener("focus", function () { focused = index; });
      button.addEventListener("click", function () { activate(index); });
    });
    doc.addEventListener("keydown", onKey);
    video.addEventListener("loadstart", function () { record("loadstart"); });
    video.addEventListener("loadedmetadata", function () { record("loadedmetadata"); updateTime(); say("Metadata loaded. Press Play and check picture and sound."); });
    video.addEventListener("canplay", function () { record("canplay"); say("Can play event received. Press Play and check the TV."); });
    video.addEventListener("playing", function () { record("playing"); updatePlay(); say("Playing reported. Confirm picture and audible sound on the TV."); });
    video.addEventListener("pause", updatePlay);
    video.addEventListener("timeupdate", updateTime);
    video.addEventListener("waiting", function () { record("waiting"); say("Buffering…"); });
    video.addEventListener("stalled", function () { record("stalled"); say("Media download stalled."); });
    video.addEventListener("seeking", function () { record("seeking"); });
    video.addEventListener("seeked", function () {
      record("seeked"); updateTime(); say("Seek completed at " + formatTime(video.currentTime) + ".");
    });
    video.addEventListener("ended", function () { record("ended"); updatePlay(); say("Playback reached the end of the selected video."); });
    video.addEventListener("error", function () { record("error"); if (!disposed) say(mediaErrorText(video.error)); });
    root.addEventListener("pagehide", cleanup);

    var hint = typeof video.canPlayType === "function" ? function (type) { return video.canPlayType(type) || "no"; }
      : function () { return "unavailable"; };
    var flowerHint = hint('video/mp4; codecs="avc1.64001f, mp4a.40.2"');
    var sintelHint = hint('video/mp4; codecs="avc1.64001e, mp4a.40.2"');
    var nativeHls = hint("application/vnd.apple.mpegurl");
    var mse = typeof root.MediaSource === "function";
    capabilities.textContent = "Hints only: MP4 " + hint("video/mp4") + " · native HLS " + nativeHls
      + " · MSE " + (mse ? "present" : "absent") + ". These hints never block a playback attempt.";
    if (showDiagnostics) {
      var mseType = mse && typeof root.MediaSource.isTypeSupported === "function"
        ? String(root.MediaSource.isTypeSupported('video/mp4; codecs="avc1.64001e, mp4a.40.2"')) : "unavailable";
      get("media-hints").textContent = "canPlayType: flower H.264 High@3.1/AAC " + flowerHint
        + " · Sintel High@3.0/AAC " + sintelHint + " · HLS Apple MIME " + nativeHls
        + " · HLS x-mpegURL " + hint("application/x-mpegURL") + " · MSE MP4 type " + mseType + ".";
    }
    choose("mp4");
    focus(focused);
    return { choose: choose, activate: activate, cleanup: cleanup, onKey: onKey };
  }

  root.HorizonVideoLab = { createLab: createLab, keyName: keyName, seekTarget: seekTarget,
    formatTime: formatTime, errorText: errorText, sources: SOURCES };
  if (typeof document !== "undefined") createLab(document, location);
})(typeof window !== "undefined" ? window : globalThis);
