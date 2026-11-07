(function (root) {
  "use strict";
  var MAX_CUES = 12000;
  var MAX_TEXT = 750000;
  var memory = new Map();
  function remember(key, value) {
    memory.delete(key);
    if (memory.size >= 8) memory.delete(memory.keys().next().value);
    memory.set(key, value);
  }

  function timestamp(value) {
    var match = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[,.](\d{2,3})$/.exec(value.trim());
    if (!match) return null;
    var hours = Number(match[1] || 0), minutes = Number(match[2]), seconds = Number(match[3]);
    var millis = Number(match[4].padEnd(3, "0"));
    if (minutes > 59 || seconds > 59) return null;
    return hours * 3600 + minutes * 60 + seconds + millis / 1000;
  }

  function cleanText(value) {
    // Subtitle markup is data. Strip tags, retain line breaks, then render via textContent.
    return value.replace(/\{\\[^}]*\}/g, "").replace(/<[^>]*>/g, "")
      .replace(/\r/g, "").trim().slice(0, 500);
  }

  function parse(text) {
    if (typeof text !== "string" || text.length > MAX_TEXT) return [];
    var blocks = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split(/\n\s*\n/);
    var cues = [];
    blocks.forEach(function (block) {
      if (cues.length >= MAX_CUES) return;
      var lines = block.split("\n");
      if (/^WEBVTT/.test(lines[0])) lines.shift();
      var index = lines.findIndex(function (line) { return line.indexOf("-->") !== -1; });
      if (index < 0) return;
      var parts = lines[index].split("-->");
      var start = timestamp(parts[0]);
      var end = timestamp((parts[1] || "").trim().split(/\s+/)[0]);
      var value = cleanText(lines.slice(index + 1).join("\n"));
      if (start === null || end === null || end <= start || end - start > 30 || !value) return;
      cues.push({ start: start, end: end, text: value });
    });
    cues.sort(function (a, b) { return a.start - b.start || a.end - b.end; });
    return cues;
  }

  // Binary search plus a bounded backward check for overlapping cues.
  function cueAt(cues, time) {
    if (!Array.isArray(cues) || !Number.isFinite(time) || time < 0) return null;
    var low = 0, high = cues.length;
    while (low < high) {
      var mid = (low + high) >> 1;
      if (cues[mid].start <= time) low = mid + 1; else high = mid;
    }
    for (var i = low - 1, checked = 0; i >= 0 && checked < 8; i--, checked++) {
      if (cues[i].start <= time && time < cues[i].end) return cues[i];
    }
    return null;
  }

  function cacheKey(target) {
    return target.type + ":" + target.id + (target.type === "tv"
      ? ":" + target.season + ":" + target.episode : "");
  }

  function create(options) {
    var fetcher = options.fetch || root.fetch.bind(root);
    var pairFetcher = options.pairFetch;
    var caption = options.caption;
    var status = options.status;
    var target = null, generation = 0, enabled = false, offset = 0;
    var cues = [], lastText = "", lastTime = null, lastReliable = false, loading = false, available = false;
    var error = null, release = "";

    function render(text) {
      if (text === lastText) return;
      lastText = text;
      caption.textContent = text;
      caption.hidden = !text;
    }
    function clear() { render(""); lastTime = null; lastReliable = false; }
    function state() { return { enabled: enabled, offset: offset, loading: loading,
      available: available, error: error, release: release, count: cues.length }; }
    function announce() { if (status) status(state()); }
    function setTarget(next, preserve) {
      generation += 1;
      target = next;
      cues = []; loading = false; available = false; error = null; release = "";
      if (!preserve) enabled = false;
      offset = 0;
      clear(); announce();
    }
    function setEnabled(value) {
      enabled = !!value && available;
      if (!enabled) render("");
      else if (lastTime !== null) {
        var match = cueAt(cues, lastTime - offset);
        render(match ? match.text : "");
      }
      announce();
      return enabled;
    }
    function adjust(direction) {
      if (direction === 0) {
        offset = 0;
      } else {
        var step = Number.isFinite(direction) ? (direction > 0 ? 0.5 : -0.5) : 0;
        offset = Math.max(-10, Math.min(10, Math.round((offset + step) * 2) / 2));
      }
      if (lastTime !== null && enabled && available) {
        var match = cueAt(cues, lastTime - offset);
        render(match ? match.text : "");
      } else if (!enabled || !available) {
        render("");
      }
      announce(); return offset;
    }
    function resetOffset() {
      return adjust(0);
    }
    function restore(value) {
      if (!value) return;
      offset = Math.max(-10, Math.min(10, Math.round((Number(value.offset) || 0) * 2) / 2));
      enabled = value.enabled === true;
      if (lastTime !== null && enabled && available) {
        var match = cueAt(cues, lastTime - offset);
        render(match ? match.text : "");
      }
      announce();
    }
    function update(time, reliable) {
      if (!Number.isFinite(time) || time < 0) { clear(); return; }
      lastTime = time;
      lastReliable = !!reliable;
      if (!enabled || !available || !reliable) { render(""); return; }
      var match = cueAt(cues, time - offset);
      render(match ? match.text : "");
    }
    function load() {
      if (!target || loading || available) return Promise.resolve(state());
      var key = cacheKey(target), cached = memory.get(key), myGeneration = generation;
      if (cached && cached.expires > Date.now()) {
        cues = cached.cues; release = cached.release; available = cues.length > 0;
        error = available ? null : cached.error || "subtitle_unavailable";
        announce(); return Promise.resolve(state());
      }
      loading = true; error = null; announce();
      var params = new URLSearchParams({ type: target.type, tmdb_id: String(target.id) });
      if (target.type === "tv") { params.set("season", String(target.season)); params.set("episode", String(target.episode)); }
      return fetcher("/api/subtitles?" + params, { credentials: "same-origin" }).then(function (response) {
        if (response.ok) return response.json();
        if (response.status !== 403 && root.location && /^(localhost|127\.0\.0\.1)$/.test(root.location.hostname)
            && target.type === "tv" && target.id === 2190 && target.season === 15 && target.episode === 7)
          return fetcher("/tests/fixtures/south-park-s15e7-demo.srt").then(function (fixture) {
            if (!fixture.ok) throw Error("subtitle_unavailable");
            return fixture.text().then(function (text) { return { text: text, release: "Local demonstration fixture" }; });
          });
        return response.json().then(function (body) {
          throw Error(typeof body.code === "string" ? body.code : "worker_unavailable");
        }, function () { throw Error("worker_unavailable"); });
      }).then(function (data) {
        if (myGeneration !== generation) return state();
        cues = parse(data.text); release = String(data.release || "").slice(0, 120);
        available = cues.length > 0; error = available ? null : "unsupported_subtitle";
        if (available) remember(key, { cues: cues, release: release, expires: Date.now() + 3600000 });
        loading = false;
        if (lastTime !== null && enabled && available) {
          var match = cueAt(cues, lastTime - offset);
          render(match ? match.text : "");
        }
        announce(); return state();
      }).catch(function (failure) {
        if (myGeneration !== generation) return state();
        loading = false; available = false; cues = []; error = failure.message || "subtitle_unavailable";
        if (error === "subtitle_unavailable" || error === "subdl_unconfigured")
          remember(key, { cues: [], release: "", error: error, expires: Date.now() + 300000 });
        enabled = false; clear(); announce(); return state();
      });
    }
    function refreshPairing() {
      if (typeof pairFetcher !== "function") return Promise.resolve();
      return pairFetcher("/api/pair/session", { credentials: "same-origin", cache: "no-store" })
        .then(function (response) { return response.ok ? response.json() : null; })
        .then(function (session) {
          if (!session || session.state !== "paired" || session.rotationDue !== true) return;
          return pairFetcher("/api/pair/rotate", { method: "POST", credentials: "same-origin",
            cache: "no-store", headers: { "X-Horizon-Action": "pair" } });
        }).catch(function () { /* Renewal is best effort and never blocks playback. */ });
    }
    return { setTarget: setTarget, setEnabled: setEnabled, adjust: adjust, resetOffset: resetOffset, restore: restore,
      update: update, load: load, refreshPairing: refreshPairing, clear: clear, state: state };
  }

  root.HorizonIndependentSubtitles = { parse: parse, cueAt: cueAt, create: create };
})(typeof window !== "undefined" ? window : globalThis);
