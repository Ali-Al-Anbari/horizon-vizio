(function (root) {
  "use strict";
  var ORIGIN = "https://vidbolt.xyz";

  function positiveId(value) { return /^[1-9][0-9]{0,14}$/.test(String(value)); }
  function embedUrl(type, id, season, episode) {
    if (!positiveId(id)) return null;
    if (type === "movie") return ORIGIN + "/movie/" + id + "?autoPlay=true&mobileSheets=true";
    if (type === "tv" && positiveId(season) && positiveId(episode))
      return ORIGIN + "/tv/" + id + "/" + season + "/" + episode
        + "?autoPlay=true&mobileSheets=true";
    return null;
  }
  function acceptMobilePanel(event, active) {
    if (!active || !active.frame || !active.frame.contentWindow || !event
        || event.origin !== ORIGIN || event.source !== active.frame.contentWindow) return null;
    var data = event.data;
    if (!data || typeof data !== "object" || Array.isArray(data)
        || data.type !== "mobile-panel" || !Array.isArray(data.options)
        || data.options.length > 100) return null;
    var rows = [];
    for (var i = 0; i < data.options.length; i += 1) {
      var item = data.options[i];
      if (!item || typeof item !== "object" || Array.isArray(item)
          || item.option !== "subtitles" || item.group !== "Subtitles") continue;
      if (typeof item.label !== "string" || !item.label || item.label.length > 100
          || typeof item.selected !== "boolean"
          || !(typeof item.value === "string" && item.value.length <= 80
            || typeof item.value === "number" && isFinite(item.value))) continue;
      rows.push({ option: item.option, value: item.value, label: item.label,
        group: item.group, selected: item.selected });
    }
    return { generation: active.generation, rows: rows };
  }
  function selectable(row) { return /\benglish\b/i.test(row.label) || /^off$/i.test(row.label.trim()); }
  function sendSelected(active, generation, row) {
    if (!active || active.generation !== generation || !active.frame
        || !active.rows || active.rows.indexOf(row) < 0 || !selectable(row)
        || row.option !== "subtitles" || !active.frame.contentWindow) return false;
    try {
      active.frame.contentWindow.postMessage({ type: "mobile-option", option: row.option,
        value: row.value }, ORIGIN);
      return true;
    } catch (_error) { return false; }
  }
  function createProbe(doc, win) {
    var get = function (id) { return doc.getElementById(id); };
    var active = null;
    var generation = 0;
    var host = get("frame-host");
    function status(message) { get("probe-status").textContent = message; }
    function clearRows() {
      get("subtitle-rows").replaceChildren();
      get("english-status").textContent = "English track: unknown until a valid mobile-panel arrives.";
    }
    function unload() {
      if (active && active.frame) {
        active.frame.src = "about:blank";
        host.replaceChildren();
      }
      active = null;
      generation += 1;
      clearRows();
      status("Iframe unloaded. No subtitle choice is retained.");
    }
    function load() {
      var url = embedUrl(get("media-type").value, get("media-id").value,
        get("season").value, get("episode").value);
      if (!url) { status("Enter valid TMDB ID, season, and episode values."); return; }
      unload();
      var frame = doc.createElement("iframe");
      var current = { frame: frame, generation: generation, rows: [] };
      active = current;
      frame.title = "VidBolt subtitle diagnostic player";
      frame.setAttribute("allow", "autoplay; encrypted-media; picture-in-picture; fullscreen");
      frame.setAttribute("allowfullscreen", "");
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.addEventListener("load", function () {
        if (active === current) get("probe-events").textContent =
          "Generation " + current.generation + ": iframe load. Media and subtitles unverified.";
      });
      frame.addEventListener("error", function () {
        if (active === current) get("probe-events").textContent =
          "Generation " + current.generation + ": iframe error.";
      });
      host.className = "frame-host " + (get("probe-width").value === "full" ? "full" : "mobile");
      host.replaceChildren(frame);
      frame.src = url;
      status("Generation " + current.generation + " loaded at "
        + (get("probe-width").value === "full" ? "full TV width" : "520px")
        + ". Open VidBolt's CC control inside the iframe. No subtitle command sent.");
    }
    function renderPanel(panel) {
      var rows = get("subtitle-rows");
      rows.replaceChildren();
      active.rows = panel.rows;
      var english = false;
      panel.rows.forEach(function (row) {
        if (/\benglish\b/i.test(row.label)) english = true;
        var line = doc.createElement("div");
        line.className = "subtitle-row";
        var detail = doc.createElement("span");
        detail.textContent = row.label + " · " + (row.selected ? "selected" : "not selected")
          + " · option=" + row.option + " · value=" + String(row.value);
        line.appendChild(detail);
        if (selectable(row)) {
          var button = doc.createElement("button");
          button.type = "button";
          button.textContent = "Test " + row.label;
          var selectedGeneration = panel.generation;
          button.addEventListener("click", function () {
            status(sendSelected(active, selectedGeneration, row)
              ? "Selection requested: " + row.label + ". Confirm captions visibly changed inside VidBolt."
              : "Selection rejected: stale or invalid provider option.");
          });
          line.appendChild(button);
        }
        rows.appendChild(line);
      });
      get("english-status").textContent = "English track: " + (english ? "present in current provider options" : "not present in current provider options");
      status("Validated mobile-panel for generation " + panel.generation + ". Inspect tracks before selecting.");
    }
    get("probe-form").addEventListener("submit", function (event) { event.preventDefault(); load(); });
    get("unload").addEventListener("click", unload);
    win.addEventListener("message", function (event) {
      var panel = acceptMobilePanel(event, active);
      if (panel && active && panel.generation === active.generation) renderPanel(panel);
    });
    return { load: load, unload: unload };
  }
  root.HorizonVidBoltSubtitleProbe = { embedUrl: embedUrl, acceptMobilePanel: acceptMobilePanel,
    sendSelected: sendSelected, createProbe: createProbe };
  if (typeof document !== "undefined") createProbe(document, root);
})(typeof window !== "undefined" ? window : globalThis);
