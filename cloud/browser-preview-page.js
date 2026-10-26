// Browser-level commands, kept separate from the Browser Run binding for mock tests.
export async function executePageCommand(page, command, navigationTimeoutMs = 15_000) {
  if (command.type === "navigate") {
    const response = await page.goto(command.url, { waitUntil: "domcontentloaded", timeout: navigationTimeoutMs });
    if (!response || response.status() >= 400) throw new Error("navigation_failed");
  } else if (command.type === "click") {
    await page.mouse.click(command.x, command.y);
  } else if (command.type === "scroll") {
    await page.mouse.wheel(0, command.deltaY);
  } else if (command.type === "text") {
    const editable = await page.evaluate(() => {
      const element = document.activeElement;
      if (!element) return false;
      if (element.tagName === "TEXTAREA") return true;
      return element.tagName === "INPUT" && ["text", "search"].includes(element.type);
    });
    if (!editable) throw new Error("text_target_unavailable");
    await page.keyboard.insertText(command.text);
  } else if (command.type === "key") {
    await page.keyboard.press(command.key);
  } else if (command.type === "back") {
    await page.goBack({ waitUntil: "domcontentloaded", timeout: navigationTimeoutMs });
  } else if (command.type === "forward") {
    await page.goForward({ waitUntil: "domcontentloaded", timeout: navigationTimeoutMs });
  } else if (command.type === "refresh") {
    await page.reload({ waitUntil: "domcontentloaded", timeout: navigationTimeoutMs });
  } else throw new Error("unsupported_command");
}

export async function capturePageFrame(page, actionMs = 0, now = () => performance.now()) {
  const start = now();
  const frame = await page.screenshot({ type: "jpeg", quality: 65, timeout: 7_000,
    animations: "disabled" });
  return { frame, url: page.url(), timings: {
    actionMs, captureMs: Math.max(0, Math.round(now() - start)), bytes: frame.byteLength,
  } };
}
