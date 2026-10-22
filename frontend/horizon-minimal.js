(() => {
  "use strict";
  const diagnostics = window.HorizonDiagnostics?.start();
  const keyDisplay = document.getElementById("minimal-key");
  const countDisplay = document.getElementById("minimal-count");
  const cells = [...document.querySelectorAll(".minimal-pad span")];
  let count = 0;
  let activeCell = null;

  function keyName(event) {
    if (event.key === "Enter" || event.key === "Select" || event.key === "OK") return "OK";
    if (event.key === "Escape" || event.key === "Backspace" || event.key === "BrowserBack" || event.key === "GoBack") return "Back";
    return event.key || "Unknown";
  }

  window.addEventListener("keydown", (event) => {
    const receivedAt = performance.now();
    const key = keyName(event);
    diagnostics?.received(key, event, receivedAt);
    if (key === "Back" || key === "OK" || key.startsWith("Arrow")) event.preventDefault();
    keyDisplay.textContent = key;
    countDisplay.textContent = `${++count} events`;
    if (activeCell) activeCell.classList.remove("is-active");
    activeCell = cells.find((cell) => cell.dataset.key === key) || null;
    if (activeCell) activeCell.classList.add("is-active");
    diagnostics?.handled(receivedAt, false);
  }, { passive: false });
})();
