(function (root) {
  "use strict";

  var AVC_AAC = 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"';
  var AVC_MAIN_AAC = 'video/mp4; codecs="avc1.4D401F, mp4a.40.2"';
  var TS_AVC_AAC = 'video/mp2t; codecs="avc1.42E01E, mp4a.40.2"';
  function safeEventValue(value, maxLength) {
    if (typeof value !== "string" || !value || value.length > maxLength
        || /https?:|[\/?=&@]|token|signature|secret|credential/i.test(value)
        || !/^[A-Za-z0-9 _.-]+$/.test(value)) return "(redacted)";
    return value;
  }

  function create(host, doc, frame, clock) {
    var mediaSource = host.MediaSource || host.WebKitMediaSource || null;
    var video = null;
    try { video = doc.createElement("video"); } catch (_error) { /* Capability unavailable. */ }
    function canPlay(type) {
      try {
        if (!video || typeof video.canPlayType !== "function") return "unknown";
        return video.canPlayType(type) || "no";
      } catch (_error) { return "unknown"; }
    }
    function mse(type) {
      try {
        if (!mediaSource) return "absent";
        if (typeof mediaSource.isTypeSupported !== "function") return "unknown";
        return mediaSource.isTypeSupported(type) ? "yes" : "no";
      } catch (_error) { return "unknown"; }
    }
    function attribute(name) {
      try { return frame && typeof frame.getAttribute === "function" ? frame.getAttribute(name) : null; }
      catch (_error) { return null; }
    }
    function now() {
      return clock.performance && typeof clock.performance.now === "function"
        ? clock.performance.now() : Date.now();
    }
    var hlsApple = canPlay("application/vnd.apple.mpegurl");
    var hlsAlternate = canPlay("application/x-mpegURL");
    var mseAvc = mse(AVC_AAC);
    var mseMain = mse(AVC_MAIN_AAC);
    var mseTs = mse(TS_AVC_AAC);
    var html5 = "MP4 AVC/AAC " + canPlay(AVC_AAC) + "; Main AVC/AAC "
      + canPlay(AVC_MAIN_AAC) + "; AAC " + canPlay('audio/mp4; codecs="mp4a.40.2"');
    var userAgent = host.navigator && typeof host.navigator.userAgent === "string"
      ? host.navigator.userAgent.slice(0, 240) : "unavailable";
    function permissions() {
      var pointer = "unknown";
      try { if (typeof host.getComputedStyle === "function") pointer = host.getComputedStyle(frame).pointerEvents || "unknown"; }
      catch (_error) { /* Optional host probe. */ }
      return "allow: " + (attribute("allow") || "absent")
        + "; fullscreen: " + (frame && (frame.allowFullscreen || attribute("allowfullscreen") !== null) ? "yes" : "no")
        + "; sandbox: " + (attribute("sandbox") === null ? "absent" : "present")
        + "; referrer: " + (attribute("referrerpolicy") || "default")
        + "; pointer events: " + pointer;
    }
    var startedAt = now();
    var provider = "yapgrid";
    var events = [];
    var frameEvents = [];
    var rejectedOrigin = 0;
    var rejectedEnvelope = 0;
    var rejectedEnvelopeType = null;
    var riftAccepted = 0;
    var riftRejected = 0;
    var riftLastRejected = null;
    var riftRecentRejections = [];
    var riftServerInfo = null;
    var riftLastProgressAt = null;
    var riftLastPosition = null;
    var riftLastIncreaseAt = null;
    var riftLastSent = null;
    var mediaDataCount = 0;
    var sources = [];
    var sourceCount = 0;
    var sourceTransitions = 0;
    var lastSource = null;
    var ready = false;
    var play = false;
    var lastError = null;

    function reset(nextProvider) {
      provider = nextProvider;
      startedAt = now();
      events = [];
      frameEvents = [];
      rejectedOrigin = 0;
      rejectedEnvelope = 0;
      rejectedEnvelopeType = null;
      riftAccepted = 0;
      riftRejected = 0;
      riftLastRejected = null;
      riftRecentRejections = [];
      riftServerInfo = null;
      riftLastProgressAt = null;
      riftLastPosition = null;
      riftLastIncreaseAt = null;
      riftLastSent = null;
      mediaDataCount = 0;
      sources = [];
      sourceCount = 0;
      sourceTransitions = 0;
      lastSource = null;
      ready = false;
      play = false;
      lastError = null;
    }
    function recordFrame(kind) {
      if ((provider !== "cinesrc" && provider !== "vidfast" && provider !== "vidlink"
          && provider !== "vidrift" && provider !== "vidbolt") || (kind !== "load" && kind !== "error")) return;
      frameEvents.push("+" + Math.max(0, Math.floor((now() - startedAt) / 1000)) + "s iframe " + kind);
      if (frameEvents.length > 4) frameEvents.shift();
    }
    function recordRejected(kind, event) {
      if (provider !== "cinesrc" && provider !== "vidfast" && provider !== "vidlink"
          && provider !== "vidrift" && provider !== "vidbolt") return;
      if (provider === "vidrift") {
        riftRejected = Math.min(9999, riftRejected + 1);
        var rawType = event && event.data && event.data.type;
        var safeType = typeof rawType === "string" && /^vidrift:[a-z-]{1,24}$/.test(rawType)
          ? rawType.replace(":", ".") : "unknown";
        riftLastRejected = kind + " " + safeType;
        riftRecentRejections.push(riftLastRejected);
        if (riftRecentRejections.length > 4) riftRecentRejections.shift();
      }
      if (kind === "origin") rejectedOrigin = Math.min(9999, rejectedOrigin + 1);
      if (kind === "envelope") {
        rejectedEnvelope = Math.min(9999, rejectedEnvelope + 1);
        if (event && event.data) {
          var raw = event.data;
          if (typeof raw === "string") {
            try { raw = JSON.parse(raw); } catch (_e) { rejectedEnvelopeType = "string"; return; }
          }
          if (raw && typeof raw === "object" && !Array.isArray(raw)) {
            var rawType = typeof raw.type === "string" ? raw.type : (typeof raw.event === "string" ? raw.event : null);
            if (rawType) rejectedEnvelopeType = safeEventValue(rawType, 24);
          }
        }
      }
    }
    function record(message) {
      if (!message || (provider !== "cinesrc" && provider !== "vidfast" && provider !== "vidlink"
          && provider !== "vidrift" && provider !== "vidbolt")) return;
      var type = message.type || "";
      if (provider === "vidrift" || provider === "vidbolt") {
        var prefix = provider + ":";
        if (type.indexOf(prefix) !== 0) return;
        if (provider === "vidrift") riftAccepted = Math.min(9999, riftAccepted + 1);
        var action = type.slice(prefix.length);
        if (provider === "vidrift") {
          if (typeof message.currentTime === "number" && isFinite(message.currentTime)) {
            if (riftLastPosition !== null && message.currentTime > riftLastPosition + 0.25)
              riftLastIncreaseAt = now();
            riftLastPosition = message.currentTime;
          }
          if (action === "progress") riftLastProgressAt = now();
          if (action === "state") {
            riftServerInfo = "server " + (message.server || "unknown") + "; source "
              + (message.source || "unknown") + "; options "
              + (message.servers && message.servers.length
                ? message.servers.map(function (item) { return item.value + " " + item.state; }).join(", ")
                : "none reported");
          }
        }
        if (action === "state" || action === "ready") ready = true;
        if (action === "unpaused" || action === "play") play = true;
        if (action === "paused" || action === "pause" || action === "ended") play = false;
        if (action === "command-error") lastError = message.reason || "other";
        if (action !== "progress" && action !== "timeupdate") {
          var detail = action;
          if (provider === "vidrift" && action === "state")
            detail += " paused " + message.paused + "; muted " + message.muted
              + "; volume " + Math.round(message.volume * 100) + "%" + "; time " + Math.floor(message.currentTime) + "s";
          if (provider === "vidrift" && action === "command-error")
            detail += " " + message.command + (message.field ? " " + message.field : "") + " " + lastError
              + (riftLastSent ? "; last sent " + riftLastSent : "");
          else if (action === "command-error") detail += " " + lastError;
          events.push("+" + Math.max(0, Math.floor((now() - startedAt) / 1000)) + "s "
            + detail);
          if (events.length > (provider === "vidrift" ? 10 : 6)) events.shift();
        } else if (!events.length || !/ progress$| timeupdate$/.test(events[events.length - 1])) {
          events.push("+" + Math.max(0, Math.floor((now() - startedAt) / 1000)) + "s " + action);
          if (events.length > 6) events.shift();
        }
        return;
      }
      if (provider === "vidlink") {
        if (type.indexOf("vidlink:") !== 0) return;
        var linkEvent = type.slice(8);
        if (linkEvent === "media_data") mediaDataCount = Math.min(9999, mediaDataCount + 1);
        if (linkEvent === "play") play = true;
        if (linkEvent === "pause" || linkEvent === "ended") play = false;
        if (linkEvent === "error") lastError = message.error || "provider_error";
        if (linkEvent !== "timeupdate" || events.length === 0 || !/timeupdate/.test(events[events.length - 1])) {
          events.push("+" + Math.max(0, Math.floor((now() - startedAt) / 1000)) + "s " + linkEvent);
          if (events.length > 6) events.shift();
        }
        return;
      }
      if (provider === "vidfast") {
        var ev = message.event || (type.indexOf("vidfast:") === 0 ? type.slice(8) : type);
        if (ev === "play") play = true;
        if (ev === "pause") play = false;
        if (ev === "status") {
          if (typeof message.statusCode === "number") {
            if (message.statusCode >= 400) lastError = "status_" + message.statusCode;
            events.push("+" + Math.max(0, Math.floor((now() - startedAt) / 1000)) + "s status " + message.statusCode);
          }
        } else if (ev === "media_data") {
          mediaDataCount += 1;
          if (mediaDataCount === 1 || mediaDataCount % 5 === 0) {
            events.push("+" + Math.max(0, Math.floor((now() - startedAt) / 1000)) + "s sync (" + mediaDataCount + ")");
          }
        } else {
          events.push("+" + Math.max(0, Math.floor((now() - startedAt) / 1000)) + "s " + ev);
        }
        if (events.length > 6) events.shift();
        return;
      }
      if (type !== "cinesrc:ready" && type !== "cinesrc:play"
          && type !== "cinesrc:sourceused" && type !== "cinesrc:error") return;
      var detail = type.slice(8);
      if (type === "cinesrc:ready") ready = true;
      if (type === "cinesrc:play") play = true;
      if (type === "cinesrc:sourceused") {
        play = false; // A play report from an earlier server does not confirm this one.
        sourceCount += 1;
        var sourceId = safeEventValue(message.sourceId, 40);
        if (lastSource !== null && sourceId !== lastSource) sourceTransitions += 1;
        lastSource = sourceId;
        sources.push(sourceId);
        if (sources.length > 8) sources.shift();
        detail += " " + sourceId;
      }
      if (type === "cinesrc:error") {
        lastError = safeEventValue(message.error, 80);
        detail += " " + lastError;
      }
      events.push("+" + Math.max(0, Math.floor((now() - startedAt) / 1000)) + "s " + detail);
      if (events.length > 6) events.shift();
    }
    function assessment() {
      if (provider === "vidrift" || provider === "vidbolt") {
        if (lastError) return "Provider reported " + lastError + "; command outcome requires TV verification.";
        if (play) return "Provider reported play; visible video and audible sound require TV verification.";
        if (ready) return "Provider reported ready/state; playback and sound remain unverified.";
        return "Awaiting provider signals; iframe load alone does not confirm playback.";
      }
      if (provider === "vidlink") {
        if (lastError) return "VidLink reports an error; picture and audio remain unverified.";
        if (play) return "VidLink sent play; picture and audio still require TV confirmation.";
        if (mediaDataCount > 0) return "VidLink sent progress data; picture and audio remain unverified.";
        return "Awaiting VidLink events; iframe load alone does not confirm playback.";
      }
      if (provider === "vidfast") {
        if (lastError === "status_500") return "VidFast reports stream status 500; autoplay cause is unestablished and playback remains unconfirmed.";
        if (lastError) return "Provider reports an error (" + lastError + "); cause is not identified.";
        if (play) return "VidFast sent play; picture and audio still require TV confirmation.";
        if (mediaDataCount > 0) return "VidFast reports sync heartbeat (" + mediaDataCount + "); video playback has not been confirmed.";
        if (ready) return "VidFast sent ready; decoded playback has not been confirmed.";
        return "Awaiting provider events; iframe internals remain unknown.";
      }
      if (provider !== "cinesrc") return "Select VidLink to observe its events.";
      if (lastError) {
        if (/decode|codec|format/i.test(lastError)) return "Provider reports a decoding or format error; verify on TV.";
        if (/network|fetch|load|http/i.test(lastError)) return "Provider reports a media or network loading error.";
        if (/autoplay|notallowed|permission|blocked/i.test(lastError)) return "Provider reports blocked playback.";
        return "Provider reports an error; cause is not identified.";
      }
      if (!mediaSource && hlsApple === "no" && hlsAlternate === "no") {
        return "Neither MSE nor native HLS is reported; unsupported stream path is plausible.";
      }
      if (mediaSource && mseAvc === "no" && mseMain === "no"
          && hlsApple === "no" && hlsAlternate === "no") {
        return "Tested H.264/AAC MSE types and native HLS are not reported; stream format incompatibility is plausible.";
      }
      if (sourceTransitions > 0 && !play) return "Sources changed without a play event; decode, loading, or autoplay cause remains unknown.";
      if (play) return "Provider sent play; picture and audio still require TV confirmation.";
      if (ready) return "Provider sent ready; decoded playback has not been confirmed.";
      return "Awaiting provider events; iframe internals remain unknown.";
    }
    function snapshot() {
      return {
        userAgent: userAgent,
        mediaSource: (mediaSource ? (host.MediaSource ? "present" : "prefixed") : "absent")
          + "; MSE fMP4 AVC/AAC " + mseAvc
          + "; MSE Main AVC/AAC " + mseMain
          + "; MSE TS AVC/AAC " + mseTs,
        nativeHls: "Apple HLS " + hlsApple + "; x-mpegURL " + hlsAlternate,
        html5: html5,
        permissions: permissions(),
        frameEvents: frameEvents.length ? frameEvents.join(" | ") : "none observed",
        events: events.length ? events.join(" | ") : "none received",
        messageChecks: provider === "vidrift"
          ? "Direct-frame: accepted " + riftAccepted + "; rejected " + riftRejected
            + (riftLastRejected ? "; last " + riftLastRejected
              + "; recent " + riftRecentRejections.join(" | ") : "")
          : "Direct-frame ignored: origin " + rejectedOrigin + "; envelope " + rejectedEnvelope
            + (rejectedEnvelopeType ? " (last: " + rejectedEnvelopeType + ")" : ""),
        sources: provider === "vidrift" ? (riftServerInfo || "no state received")
          : sourceCount ? sources.join(" → ") + (sourceCount > sources.length
          ? " (last " + sources.length + " of " + sourceCount + ")" : "") : "none reported",
        elapsed: (provider === "cinesrc" || provider === "vidfast" || provider === "vidlink"
          || provider === "vidrift" || provider === "vidbolt") ? Math.max(0, Math.floor((now() - startedAt) / 1000))
          + "s since iframe launch; confirmed video/audio cannot be observed by Horizon"
          + (provider === "vidrift" ? "; progress event "
            + (riftLastProgressAt === null ? "none" : Math.max(0, Math.floor((now() - riftLastProgressAt) / 1000)) + "s ago")
            + "; reported time increase " + (riftLastIncreaseAt === null ? "none"
              : Math.max(0, Math.floor((now() - riftLastIncreaseAt) / 1000)) + "s ago") : "")
          : "CineSrc not selected",
        assessment: assessment(),
      };
    }
    function recordCommand(command) {
      if ((provider !== "vidrift" && provider !== "vidbolt")
          || typeof command !== "string" || !/^[a-z-]{1,24}$/.test(command)) return;
      if (provider === "vidrift") riftLastSent = command;
      events.push("+" + Math.max(0, Math.floor((now() - startedAt) / 1000)) + "s sent " + command);
      if (events.length > (provider === "vidrift" ? 10 : 6)) events.shift();
    }
    return { reset: reset, record: record, recordFrame: recordFrame, recordCommand: recordCommand,
      recordRejected: recordRejected, snapshot: snapshot };
  }

  root.HorizonPlayerDiagnostics = { create: create };
})(typeof window !== "undefined" ? window : globalThis);
