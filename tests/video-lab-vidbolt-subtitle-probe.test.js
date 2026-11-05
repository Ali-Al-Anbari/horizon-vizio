import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const script = readFileSync(new URL("../video-lab/vidbolt-subtitle-probe.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../video-lab/vidbolt-subtitle-probe.html", import.meta.url), "utf8");
const root = {};
runInNewContext(script, { window: root });
const probe = root.HorizonVidBoltSubtitleProbe;

test("probe uses documented mobileSheets URL only for valid movie or exact episode", () => {
  assert.equal(probe.embedUrl("movie", "550"),
    "https://vidbolt.xyz/movie/550?autoPlay=true&mobileSheets=true");
  assert.equal(probe.embedUrl("tv", "1396", "1", "2"),
    "https://vidbolt.xyz/tv/1396/1/2?autoPlay=true&mobileSheets=true");
  for (const id of ["0", "-1", "1/2", "1?x=y", "001"]) assert.equal(probe.embedUrl("movie", id), null);
  assert.equal(probe.embedUrl("tv", "1396", "0", "2"), null);
  assert.match(html, /id="probe-width"[^>]*>[\s\S]*value="mobile"[\s\S]*value="full"/);
});

test("probe accepts only active VidBolt mobile-panel rows and retains exact provider values", () => {
  const source = {};
  const active = { generation: 3, frame: { contentWindow: source } };
  const event = { origin: "https://vidbolt.xyz", source, data: { type: "mobile-panel", options: [
    { option: "subtitles", value: "7", label: "English", group: "Subtitles", selected: false },
    { option: "subtitles", value: -1, label: "Off", group: "Subtitles", selected: true },
    { option: "audio", value: "en", label: "English", group: "Audio", selected: false },
  ] } };
  const panel = probe.acceptMobilePanel(event, active);
  assert.equal(panel.generation, 3);
  assert.deepEqual(Array.from(panel.rows, row => `${row.label}:${row.value}:${row.selected}`),
    ["English:7:false", "Off:-1:true"]);
  assert.equal(probe.acceptMobilePanel({ ...event, origin: "https://other.test" }, active), null);
  assert.equal(probe.acceptMobilePanel({ ...event, source: {} }, active), null);
  assert.equal(probe.acceptMobilePanel({ ...event, data: { type: "play", options: event.data.options } }, active), null);
  assert.equal(probe.acceptMobilePanel({ ...event, data: { type: "mobile-panel", options: {} } }, active), null);
  assert.equal(probe.acceptMobilePanel({ ...event, data: { type: "mobile-panel", options: Array(101).fill(null) } }, active), null);
});

test("probe sends only a deliberately selected current English or Off row", () => {
  const sent = [];
  const frame = { contentWindow: { postMessage(data, origin) { sent.push({ data, origin }); } } };
  const english = { option: "subtitles", value: "7", label: "English", selected: false };
  const off = { option: "subtitles", value: "-1", label: "Off", selected: true };
  const active = { generation: 4, frame, rows: [english, off] };
  assert.equal(probe.sendSelected(active, 3, english), false);
  assert.equal(probe.sendSelected(active, 4, { ...english }), false);
  assert.equal(probe.sendSelected(active, 4, english), true);
  assert.equal(probe.sendSelected(active, 4, off), true);
  assert.deepEqual(sent.map(item => JSON.stringify(item)), [
    '{"data":{"type":"mobile-option","option":"subtitles","value":"7"},"origin":"https://vidbolt.xyz"}',
    '{"data":{"type":"mobile-option","option":"subtitles","value":"-1"},"origin":"https://vidbolt.xyz"}',
  ]);
  active.generation += 1;
  active.rows = [];
  assert.equal(probe.sendSelected(active, 4, english), false);
  assert.equal(sent.length, 2);
});
