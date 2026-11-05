(function (root) {
  "use strict";

  var CINESRC_ORIGIN = "https://cinesrc.st";
  var VIDFAST_ORIGIN = "https://vidfast.vc";
  var VIDLINK_ORIGIN = "https://vidlink.pro";
  var VIDRIFT_ORIGIN = "https://embed.vidrift.net";
  var VIDBOLT_ORIGIN = "https://vidbolt.xyz";
  var VIDFAST_MIRRORS = [
    "https://vidfast.vc",
    "https://vidfast.pro",
    "https://vidfast.in",
    "https://vidfast.io",
    "https://vidfast.me",
    "https://vidfast.net",
    "https://vidfast.pm",
    "https://vidfast.bz"
  ];
  var YAPGRID = "yapgrid";
  var VIDFAST = "vidfast";
  var VIDLINK = "vidlink";
  var VIDRIFT = "vidrift";
  var VIDBOLT = "vidbolt";
  var CINESRC = "cinesrc"; // Preserved for reference; excluded during VidFast testing.
  var PRIMARY = YAPGRID;
  var FALLBACK = YAPGRID;
  var VISIBLE = [YAPGRID, VIDBOLT];
  var BASELINE = "baseline";

  function positive(value) {
    return typeof value === "number" && isFinite(value) && value > 0
      && value % 1 === 0 && value <= 9007199254740991;
  }
  function finiteNonnegative(value) {
    return typeof value === "number" && isFinite(value) && value >= 0;
  }
  // Older experiments remain available as reference code, not as active selections.
  function select(value) {
    return value === VIDLINK || value === VIDFAST || value === VIDRIFT || value === VIDBOLT ? value : PRIMARY;
  }
  function next(value) {
    var index = VISIBLE.indexOf(value);
    return VISIBLE[(index + 1) % VISIBLE.length];
  }
  function label(value) {
    var s = select(value);
    if (s === VIDFAST) return "VidFast";
    if (s === VIDLINK) return "VidLink";
    if (s === VIDRIFT) return "VidRift";
    if (s === VIDBOLT) return "VidBolt";
    if (value === CINESRC) return "CineSrc";
    return "YapGrid";
  }
  function compatibilityMode(value) {
    return value === "quality480" || value === "autoplayOff" ? value : BASELINE;
  }
  function vidFastMode(value) { return value === "autoPlayTrue" ? value : BASELINE; }
  function vidLinkMode(value) {
    return value === "defaultOn" || value === "jwOn" ? value : "defaultOff";
  }

  function embedUrl(target, provider, subtitle, pageOrigin, catalog, testMode, startAt) {
    if (!target || !catalog) return null;
    // Preserved CineSrc embed generation for reference only:
    if (provider === CINESRC) {
      var cinesrc = null;
      if (positive(target.movieId)) cinesrc = CINESRC_ORIGIN + "/embed/movie/" + target.movieId;
      else if (positive(target.showId) && positive(target.season) && positive(target.episode)) {
        cinesrc = CINESRC_ORIGIN + "/embed/tv/" + target.showId + "?s=" + target.season
          + "&e=" + target.episode + "&autonext=false";
      }
      if (!cinesrc) return null;
      var mode = compatibilityMode(testMode);
      if (mode === "quality480") return cinesrc + (cinesrc.indexOf("?") < 0 ? "?" : "&") + "quality=480";
      if (mode === "autoplayOff") return cinesrc + (cinesrc.indexOf("?") < 0 ? "?" : "&") + "autoplay=false";
      return cinesrc;
    }

    // Keep the old VidFast URL generator for reference, though it is not selectable.
    var chosen = provider === VIDFAST ? VIDFAST : select(provider);
    if (chosen === YAPGRID) {
      var yapgrid = catalog.embedUrl(target);
      if (!yapgrid) return null;
      if (positive(target.movieId)) return yapgrid;
      if (subtitle === "on") return yapgrid + "?lang=en";
      var origin = pageOrigin && pageOrigin !== "null" ? pageOrigin
        : "https://horizon-video-lab-preview.ali-al-anbari.workers.dev";
      return yapgrid + "?sub_url=" + encodeURIComponent(origin + "/empty.vtt")
        + "&sub_lang=en&sub_label=Off";
    }
    if (chosen === VIDFAST) {
      if (positive(target.movieId)) {
        return VIDFAST_ORIGIN + "/movie/" + target.movieId
          + (vidFastMode(testMode) === "autoPlayTrue" ? "?autoPlay=true" : "");
      }
      if (positive(target.showId) && positive(target.season) && positive(target.episode)) {
        return VIDFAST_ORIGIN + "/tv/" + target.showId + "/" + target.season + "/" + target.episode
          + (vidFastMode(testMode) === "autoPlayTrue" ? "?autoPlay=true" : "");
      }
      return null;
    }
    if (chosen === VIDLINK) {
      var vidlink = null;
      if (positive(target.movieId)) vidlink = VIDLINK_ORIGIN + "/movie/" + target.movieId;
      else if (positive(target.showId) && positive(target.season) && positive(target.episode)) {
        vidlink = VIDLINK_ORIGIN + "/tv/" + target.showId + "/" + target.season + "/" + target.episode;
      }
      if (!vidlink) return null;
      var linkMode = vidLinkMode(testMode);
      return vidlink + (linkMode === "jwOn" ? "?player=jw&autoplay=true"
        : "?player=default&autoplay=" + (linkMode === "defaultOn" ? "true" : "false"));
    }
    if (chosen === VIDRIFT || chosen === VIDBOLT) {
      var base = chosen === VIDRIFT ? VIDRIFT_ORIGIN + "/embed" : VIDBOLT_ORIGIN;
      if (positive(target.movieId)) base += "/movie/" + target.movieId;
      else if (positive(target.showId) && positive(target.season) && positive(target.episode)) {
        base += "/tv/" + target.showId + "/" + target.season + "/" + target.episode;
      } else return null;
      if (chosen === VIDBOLT) {
        var params = testMode === "autoPlayOff" ? "" : "?autoPlay=true";
        if (finiteNonnegative(startAt)) params += (params ? "&" : "?") + "startAt=" + startAt;
        return base + params;
      }
      return base;
    }
    return null;
  }

  function safeSourceId(value) {
    if (typeof value === "number" && positive(value)) value = String(value);
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(value)
        || /token|signature|secret|credential|bearer|cookie|authorization/i.test(value))
      return "(redacted)";
    return value;
  }
  function safeError(value) {
    if (typeof value !== "string" || !value) return "unknown";
    if (/https?:|[\/?=&@]|token|signature|secret|credential|bearer|cookie|authorization/i.test(value))
      return "redacted";
    if (/decode|codec|format/i.test(value)) return "decode_error";
    if (/network|fetch|load|http/i.test(value)) return "network_error";
    if (/autoplay|notallowed|permission|blocked/i.test(value)) return "playback_blocked";
    return "provider_error";
  }

  function isVidFastOrigin(origin) {
    return origin === VIDFAST_ORIGIN || VIDFAST_MIRRORS.indexOf(origin) >= 0;
  }

  function riftInteger(value) {
    if (typeof value === "number") return isFinite(value) && Math.floor(value) === value && value > 0 ? value : null;
    return typeof value === "string" && /^[1-9][0-9]*$/.test(value) ? Number(value) : null;
  }

  function riftIdentityIssue(data, target, allowMissing) {
    if (!target) return null;
    var expectedId = positive(target.movieId) ? target.movieId : target.showId;
    var expectedType = positive(target.movieId) ? "movie" : "tv";
    if (data.tmdbId == null) { if (!allowMissing) return "missing-tmdbId"; }
    else if (riftInteger(data.tmdbId) !== expectedId) return "mismatch-tmdbId";
    if (data.mediaType == null) { if (!allowMissing) return "missing-mediaType"; }
    else if (data.mediaType !== expectedType) return "mismatch-mediaType";
    if (expectedType === "tv") {
      if (data.season == null) { if (!allowMissing) return "missing-season"; }
      else if (riftInteger(data.season) !== target.season) return "mismatch-season";
      if (data.episode == null) { if (!allowMissing) return "missing-episode"; }
      else if (riftInteger(data.episode) !== target.episode) return "mismatch-episode";
    }
    return null;
  }

  function safeRiftValue(value) {
    if (typeof value === "number" && isFinite(value) && Math.floor(value) === value) value = String(value);
    return typeof value === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(value) ? value : null;
  }

  function acceptEvent(event, frame, provider, target) {
    try {
      var chosen = provider === VIDFAST ? VIDFAST : select(provider);
      if (!event || !frame || !frame.contentWindow || event.source !== frame.contentWindow) return null;

      if (chosen === VIDRIFT) {
        if (event.origin !== VIDRIFT_ORIGIN) return null;
        var r = event.data;
        if (!r || typeof r !== "object" || Array.isArray(r) || typeof r.type !== "string") return null;
        if (riftIdentityIssue(r, target, r.type === "vidrift:command-error")) return null;
        if (r.type === "vidrift:state") {
          if (typeof r.paused !== "boolean" || !finiteNonnegative(r.currentTime)
              || !finiteNonnegative(r.duration) || !finiteNonnegative(r.volume)
              || r.volume > 1 || typeof r.muted !== "boolean") return null;
          var servers = [];
          if (Array.isArray(r.servers)) {
            for (var ri = 0; ri < r.servers.length && ri < 8; ri += 1) {
              var server = r.servers[ri];
              if (server && typeof server === "object" && safeRiftValue(server.value))
                servers.push({ value: safeRiftValue(server.value),
                  state: server.state === "ready" || server.state === "failed" ? server.state : "unknown" });
            }
          }
          return { type: r.type, paused: r.paused, currentTime: r.currentTime,
            duration: r.duration, volume: r.volume, muted: r.muted,
            server: safeRiftValue(r.server), source: safeRiftValue(r.source), servers: servers,
            audioCount: Array.isArray(r.audios) ? Math.min(99, r.audios.length) : 0,
            subtitleCount: Array.isArray(r.subtitles) ? Math.min(99, r.subtitles.length) : 0,
            serverCount: Array.isArray(r.servers) ? Math.min(99, r.servers.length) : 0,
            qualityCount: Array.isArray(r.qualities) ? Math.min(99, r.qualities.length) : 0 };
        }
        if (r.type === "vidrift:progress" || r.type === "vidrift:paused" || r.type === "vidrift:unpaused") {
          if (!finiteNonnegative(r.currentTime)
              || (r.type === "vidrift:progress" && !finiteNonnegative(r.duration))) return null;
          return { type: r.type, currentTime: r.currentTime,
            duration: finiteNonnegative(r.duration) ? r.duration : null };
        }
        if (r.type === "vidrift:command-error") {
          var reason = ["click-required", "not-ready", "invalid", "unavailable"].indexOf(r.reason) >= 0
            ? r.reason : "other";
          var command = typeof r.command === "string" && /^(?:vidrift:)?[a-z-]{1,24}$/.test(r.command)
            ? r.command : "unknown";
          var field = typeof r.field === "string" && /^[a-zA-Z]{1,24}$/.test(r.field) ? r.field : null;
          return { type: r.type, reason: reason, command: command, field: field };
        }
        if (r.type === "vidrift:ended") return { type: r.type };
        return null;
      }
      if (chosen === VIDBOLT) {
        if (event.origin !== VIDBOLT_ORIGIN) return null;
        var b = event.data;
        if (!b || typeof b !== "object" || Array.isArray(b) || typeof b.type !== "string") return null;
        if (["ready", "play", "pause", "ended"].indexOf(b.type) >= 0)
          return { type: "vidbolt:" + b.type };
        if (b.type === "timeupdate" && finiteNonnegative(b.time))
          return { type: "vidbolt:timeupdate", currentTime: b.time,
            duration: finiteNonnegative(b.duration) ? b.duration : null };
        if (b.type === "durationchange" && finiteNonnegative(b.duration))
          return { type: "vidbolt:durationchange", duration: b.duration };
        // Passive diagnostics only. The documented mobile-panel API is limited to
        // mobile iframe layouts; never reply with mobile-option on the TV.
        if (b.type === "mobile-panel" && Array.isArray(b.options)) {
          var subtitleOptions = 0;
          var englishOptions = 0;
          var offOptions = 0;
          for (var bi = 0; bi < b.options.length && bi < 99; bi += 1) {
            if (b.options[bi] && typeof b.options[bi] === "object"
                && b.options[bi].option === "subtitles" && b.options[bi].group === "Subtitles") {
              subtitleOptions += 1;
              if (typeof b.options[bi].label === "string" && /\benglish\b/i.test(b.options[bi].label))
                englishOptions += 1;
              if (typeof b.options[bi].label === "string" && /^off$/i.test(b.options[bi].label.trim()))
                offOptions += 1;
            }
          }
          return { type: "vidbolt:mobile-panel", optionCount: Math.min(99, b.options.length),
            subtitleOptionCount: subtitleOptions, englishOptionCount: englishOptions,
            offOptionCount: offOptions };
        }
        return null;
      }

      if (chosen === VIDLINK) {
        if (event.origin !== VIDLINK_ORIGIN) return null;
        var linkData = event.data;
        if (!linkData || typeof linkData !== "object" || Array.isArray(linkData)
            || !linkData.data || typeof linkData.data !== "object" || Array.isArray(linkData.data)) return null;
        if (linkData.type === "MEDIA_DATA") {
          var linkCount = 0;
          for (var item in linkData.data) {
            if (Object.prototype.hasOwnProperty.call(linkData.data, item)) linkCount += 1;
            if (linkCount >= 9999) break;
          }
          return { type: "vidlink:media_data", event: "media_data",
            itemCount: linkCount };
        }
        if (linkData.type !== "PLAYER_EVENT") return null;
        var linkPayload = linkData.data;
        var linkEvent = linkPayload.event;
        if (["play", "pause", "seeked", "ended", "timeupdate", "error"].indexOf(linkEvent) < 0) return null;
        if ((linkPayload.currentTime !== undefined && !finiteNonnegative(linkPayload.currentTime))
            || (linkPayload.duration !== undefined && !finiteNonnegative(linkPayload.duration))) return null;
        return { type: "vidlink:" + linkEvent, event: linkEvent,
          currentTime: finiteNonnegative(linkPayload.currentTime) ? linkPayload.currentTime : null,
          duration: finiteNonnegative(linkPayload.duration) ? linkPayload.duration : null,
          error: linkEvent === "error" ? safeError(linkPayload.error) : null };
      }

      if (chosen === VIDFAST) {
        if (!isVidFastOrigin(event.origin)) return null;
        var data = event.data;
        if (typeof data === "string") {
          try { data = JSON.parse(data); } catch (_e) { return null; }
        }
        if (!data || typeof data !== "object" || Array.isArray(data)) return null;

        // 1. Standard player transport events: { type: "PLAYER_EVENT", data: { event, ... } }
        if (data.type === "PLAYER_EVENT" && data.data && typeof data.data === "object" && !Array.isArray(data.data)) {
          var payload = data.data;
          var ev = payload.event;
          if (typeof ev !== "string" || ["play", "pause", "seeked", "ended", "timeupdate", "playerstatus"].indexOf(ev) < 0) return null;
          var currentTime = finiteNonnegative(payload.currentTime) ? payload.currentTime : 0;
          var duration = finiteNonnegative(payload.duration) ? payload.duration : 0;
          var playing = typeof payload.playing === "boolean" ? payload.playing
            : (ev === "play" ? true : ev === "pause" ? false : false);
          var tmdbId = positive(payload.tmdbId) ? payload.tmdbId : null;
          return {
            type: "vidfast:" + ev,
            event: ev,
            currentTime: currentTime,
            duration: duration,
            playing: playing,
            tmdbId: tmdbId
          };
        }

        // 2. VidFast progress synchronization: { type: "MEDIA_DATA", data: { ... } }
        // Documented 5s interval progress sync emitted by VidFast client.
        if (data.type === "MEDIA_DATA" && data.data && typeof data.data === "object" && !Array.isArray(data.data)) {
          return {
            type: "vidfast:media_data",
            event: "media_data",
            itemCount: Object.keys(data.data).length
          };
        }

        // 3. VidFast stream status: { event: "status", data: statusCode } or { type: "status", data: statusCode }
        if ((data.event === "status" || data.type === "status") && typeof data.data === "number" && positive(data.data)) {
          return {
            type: "vidfast:status",
            event: "status",
            statusCode: data.data
          };
        }

        // 4. Next episode notifications: { type: "NEXT_EPISODE_AVAILABLE", data: { season, episode } }
        if (data.type === "NEXT_EPISODE_AVAILABLE" && data.data && typeof data.data === "object" && !Array.isArray(data.data)) {
          return {
            type: "vidfast:nextepisode",
            event: "nextepisode",
            season: positive(data.data.season) ? data.data.season : null,
            episode: positive(data.data.episode) ? data.data.episode : null
          };
        }

        return null;
      }

      // Preserved CineSrc event handling for reference only:
      if (provider === CINESRC && event.origin === CINESRC_ORIGIN) {
        var cData = event.data;
        if (!cData || typeof cData !== "object" || Array.isArray(cData)
            || typeof cData.type !== "string") return null;
        var type = cData.type;
        if (type === "cinesrc:ready" || type === "cinesrc:play" || type === "cinesrc:pause"
            || type === "cinesrc:ended" || type === "cinesrc:close") return { type: type };
        if (type === "cinesrc:timeupdate" || type === "cinesrc:seeking" || type === "cinesrc:seeked") {
          return finiteNonnegative(cData.currentTime) && finiteNonnegative(cData.duration)
            ? { type: type, currentTime: cData.currentTime, duration: cData.duration } : null;
        }
        if (type === "cinesrc:loadedmetadata") {
          return finiteNonnegative(cData.duration) ? { type: type, duration: cData.duration } : null;
        }
        if (type === "cinesrc:nextepisode") {
          return positive(cData.season) && positive(cData.episode)
            ? { type: type, season: cData.season, episode: cData.episode } : null;
        }
        if (type === "cinesrc:sourceused") {
          return cData.sourceId === undefined || cData.sourceId === null ? null
            : { type: type, sourceId: safeSourceId(cData.sourceId) };
        }
        if (type === "cinesrc:error") return { type: type, error: safeError(cData.error) };
        if (type === "cinesrc:response") {
          return (cData.command === "getCurrentTime" || cData.command === "getDuration")
            && finiteNonnegative(cData.result)
            ? { type: type, command: cData.command, result: cData.result } : null;
        }
      }
      return null;
    } catch (_error) { return null; }
  }

  function diagnosticRejection(event, frame, provider, target) {
    try {
      var chosen = provider === VIDFAST ? VIDFAST : select(provider);
      if (!event || !frame || !frame.contentWindow) return null;
      if (chosen === VIDRIFT) {
        if (event.source !== frame.contentWindow)
          return event.origin === VIDRIFT_ORIGIN ? "source" : null;
        if (event.origin !== VIDRIFT_ORIGIN) return "origin";
        var r = event.data;
        if (!r || typeof r !== "object" || Array.isArray(r) || typeof r.type !== "string") return "shape";
        var identityIssue = riftIdentityIssue(r, target, r.type === "vidrift:command-error");
        if (identityIssue) return "identity:" + identityIssue;
        if (["vidrift:state", "vidrift:progress", "vidrift:paused", "vidrift:unpaused",
          "vidrift:command-error", "vidrift:ended"].indexOf(r.type) < 0) return "unsupported-type";
        return "shape";
      }
      if (event.source !== frame.contentWindow) return null;
      if (chosen === VIDBOLT) return event.origin === VIDBOLT_ORIGIN ? "envelope" : "origin";
      if (chosen === VIDLINK) return event.origin === VIDLINK_ORIGIN ? "envelope" : "origin";
      if (chosen === VIDFAST) {
        return isVidFastOrigin(event.origin) ? "envelope" : "origin";
      }
      if (provider === CINESRC) {
        return event.origin === CINESRC_ORIGIN ? "envelope" : "origin";
      }
      return null;
    } catch (_error) { return null; }
  }

  function sendCommand(frame, command, args, provider) {
    if (!frame || !frame.contentWindow || typeof frame.contentWindow.postMessage !== "function") return false;
    var chosen = provider === VIDFAST ? VIDFAST : select(provider);

    if (chosen === VIDRIFT || chosen === VIDBOLT) {
      var payload = null;
      var targetOrigin = chosen === VIDRIFT ? VIDRIFT_ORIGIN : VIDBOLT_ORIGIN;
      if (chosen === VIDRIFT) {
        if (command === "play" || command === "pause" || command === "get-state")
          payload = { type: "vidrift:" + command };
        else if (command === "seek-backward" || command === "seek-forward")
          payload = { type: "vidrift:skip", seconds: command === "seek-forward" ? 10 : -10 };
        else if (command === "volume50") payload = { type: "vidrift:set", volume: 0.5 };
        else if (command === "unmute") payload = { type: "vidrift:set", muted: false };
        else if (command === "resume" && Array.isArray(args) && args.length === 1
            && finiteNonnegative(args[0])) payload = { type: "vidrift:resume", currentTime: args[0] };
      } else {
        if (command === "play" || command === "pause") payload = { type: command };
        else if (command === "seek" && Array.isArray(args) && args.length === 1
            && finiteNonnegative(args[0])) payload = { type: "seek", time: args[0] };
        else if (command === "volume50") payload = { type: "volume", volume: 0.5 };
        else if (command === "volume100") payload = { type: "volume", volume: 1 };
      }
      if (!payload) return false;
      try { frame.contentWindow.postMessage(payload, targetOrigin); return true; }
      catch (_error) { return false; }
    }

    if (chosen === VIDFAST) {
      if (command === "play") {
        frame.contentWindow.postMessage({ command: "play" }, VIDFAST_ORIGIN);
        return true;
      }
      if (command === "pause") {
        frame.contentWindow.postMessage({ command: "pause" }, VIDFAST_ORIGIN);
        return true;
      }
      if (command === "seek") {
        args = args || [];
        if (!Array.isArray(args) || args.length !== 1 || !finiteNonnegative(args[0])) return false;
        frame.contentWindow.postMessage({ command: "seek", time: args[0] }, VIDFAST_ORIGIN);
        return true;
      }
      if (command === "getStatus") {
        frame.contentWindow.postMessage({ command: "getStatus" }, VIDFAST_ORIGIN);
        return true;
      }
      return false;
    }

    // Preserved CineSrc command sending for reference only:
    if (provider === CINESRC) {
      if (command !== "getCurrentTime" && command !== "getDuration"
          && command !== "play" && command !== "pause" && command !== "seek") return false;
      args = args || [];
      if (!Array.isArray(args) || (command === "seek"
          ? args.length !== 1 || !finiteNonnegative(args[0]) : args.length !== 0)) return false;
      frame.contentWindow.postMessage({ type: "cinesrc:command", command: command, args: args }, CINESRC_ORIGIN);
      return true;
    }
    return false;
  }

  root.HorizonPlaybackProviders = {
    YAPGRID: YAPGRID,
    VIDFAST: VIDFAST,
    VIDLINK: VIDLINK,
    VIDRIFT: VIDRIFT,
    VIDBOLT: VIDBOLT,
    CINESRC: CINESRC,
    PRIMARY: PRIMARY,
    FALLBACK: FALLBACK,
    BASELINE: BASELINE,
    VIDFAST_ORIGIN: VIDFAST_ORIGIN,
    VIDLINK_ORIGIN: VIDLINK_ORIGIN,
    VIDRIFT_ORIGIN: VIDRIFT_ORIGIN,
    VIDBOLT_ORIGIN: VIDBOLT_ORIGIN,
    select: select,
    next: next,
    label: label,
    compatibilityMode: compatibilityMode,
    vidFastMode: vidFastMode,
    vidLinkMode: vidLinkMode,
    embedUrl: embedUrl,
    acceptEvent: acceptEvent,
    diagnosticRejection: diagnosticRejection,
    sendCommand: sendCommand
  };
})(typeof window !== "undefined" ? window : globalThis);
