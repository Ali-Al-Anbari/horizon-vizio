const rows = [
  [...document.querySelectorAll('[data-row="0"]')],
  [...document.querySelectorAll('[data-row="1"]')],
  [...document.querySelectorAll('[data-row="2"]')],
];

const address = document.querySelector("#address");
const notice = document.querySelector(".notice");
let noticeTimer;

function announce(message) {
  notice.textContent = message;
  notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.hidden = true; }, 3600);
}

function focusAt(row, column) {
  rows[row]?.[Math.min(column, rows[row].length - 1)]?.focus();
}

function toUrl(text) {
  const value = text.trim();
  if (!value) return null;
  const candidate = /^(https?:\/\/)/i.test(value)
    ? value
    : /^(?:localhost|[^\s]+\.[^\s]+)(?:\/.*)?$/i.test(value)
      ? `https://${value}`
      : `https://duckduckgo.com/?q=${encodeURIComponent(value)}`;
  try {
    const url = new URL(candidate);
    return ["https:", "http:"].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

function openWebsite(value) {
  const url = toUrl(value);
  if (!url) return announce("Enter a website address or search term.");
  // A separate tab preserves this local launcher. Embedded sites may reject iframes.
  window.open(url, "_blank", "noopener,noreferrer");
  announce("Opened on this Mac. TV webview behavior is not yet verified.");
}

document.querySelectorAll(".app-tile").forEach((tile) => {
  tile.addEventListener("click", () => {
    if (tile.dataset.app === "Browser") address.focus();
    else announce(`${tile.dataset.app} launch needs a future paired TV controller.`);
  });
});

document.querySelector("#address-form").addEventListener("submit", (event) => {
  event.preventDefault();
  openWebsite(address.value);
});

document.querySelectorAll(".bookmark").forEach((bookmark) => {
  bookmark.addEventListener("click", () => openWebsite(bookmark.dataset.url));
});

document.addEventListener("focusin", (event) => {
  document.querySelectorAll(".app-tile").forEach((tile) => tile.classList.remove("is-selected"));
  if (event.target.matches(".app-tile")) event.target.classList.add("is-selected");
});

window.addEventListener("keydown", (event) => {
  const active = document.activeElement;
  const row = Number(active?.dataset.row);
  const column = Number(active?.dataset.column);
  const inAddress = active === address;

  if (event.key === "Escape" || (event.key === "Backspace" && !inAddress)) {
    event.preventDefault();
    focusAt(0, 2);
    return;
  }
  if (event.key === "Enter" && active instanceof HTMLButtonElement) {
    event.preventDefault();
    active.click();
    return;
  }
  if (!Number.isInteger(row) || !Number.isInteger(column)) return;
  if (inAddress && (event.key === "ArrowLeft" || event.key === "ArrowRight")) return;

  const next = {
    ArrowLeft: [row, Math.max(0, column - 1)],
    ArrowRight: [row, Math.min(rows[row].length - 1, column + 1)],
    ArrowUp: [Math.max(0, row - 1), column],
    ArrowDown: [Math.min(rows.length - 1, row + 1), column],
  }[event.key];
  if (next) {
    event.preventDefault();
    focusAt(...next);
  }
});

focusAt(0, 2);
