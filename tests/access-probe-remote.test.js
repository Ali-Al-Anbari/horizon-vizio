import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

test("remote arrows focus probe actions and OK activates the focused action", () => {
  let active;
  let checks = 0;
  const signIn = {
    href: "https://staging.example/api/auth/start",
    addEventListener() {},
    focus() { active = this; },
  };
  const check = {
    disabled: false,
    addEventListener() {},
    focus() { active = this; },
    click() { checks++; },
  };
  const handlers = {};
  const window = {
    location: { href: "https://staging.example/", search: "" },
    addEventListener(name, handler) { handlers[name] = handler; },
  };
  const document = {
    getElementById(id) { return { "sign-in": signIn, check, status: { textContent: "" } }[id]; },
  };
  runInNewContext(readFileSync(new URL("../access-probe/probe.js", import.meta.url), "utf8"), { window, document });

  function press(key) {
    let prevented = false;
    handlers.keydown({ key, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
  }

  assert.equal(active, signIn);
  press("ArrowRight");
  assert.equal(active, check);
  press("OK");
  assert.equal(checks, 1);
  press("ArrowLeft");
  assert.equal(active, signIn);
  press("Enter");
  assert.equal(window.location.href, signIn.href);
});
