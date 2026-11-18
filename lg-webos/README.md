# Horizon Watch — LG webOS 6.x Hosted Application

HTTPS-hosted LG webOS 6.x application (`com.horizon.watch.lg`) that launches the shared **Horizon Watch** frontend at:

```text
https://horizon-universal-search-preview.ali-al-anbari.workers.dev/?lg=1
```

This avoids maintaining a separate broken HTML/CSS copy and loads live TMDB discovery rows, posters, details, episodes, history, and settings directly from Horizon's preview Worker, while activating LG compatibility & Arabic modules cleanly when `?lg=1` or webOS is detected.

## Package Layout (`lg-webos/`)

```text
lg-webos/
  appinfo.json                  # Hosted webOS manifest (main -> preview Worker ?lg=1, 1920x1080, disableBackHistoryAPI)
  icon.png                      # 80x80 launcher icon
  largeIcon.png                 # 130x130 launcher icon
  scripts/build-ipk.mjs         # Validates & builds official .ipk via @webos-tools/cli ares-package
  scripts/verify-lg-playwright.mjs  # 1920x1080 Playwright verification + Chromium 79 replaceChildren emulation
```

## Shared Frontend LG Modules (`universal-search/`)

- `universal-search/lg-compat.js` — Chromium 79 polyfill (`Element/Document/DocumentFragment.prototype.replaceChildren`), flexbox `gap` feature detection (`lg-no-flex-gap`), and `?lg=1` / `webOS` mode detection.
- `universal-search/lg-webos-compat.css` — Chromium 79 fallbacks (`inset:`, `aspect-ratio:`, flexbox `gap:`) plus Horizon-matched `#arabic-view`, RTL details, availability pills, EN/AR keyboard toggle, and `#lg-player-overlay`.
- `universal-search/arabic-catalog.js` — Verified Arabic-original catalog (`originalLanguage: "ar"`) with Arabic script normalization and official YouTube video IDs.
- `universal-search/lg-webos-adapter.js` — Opt-in LG adapter (`__HORIZON_LG_MODE__` only): injects `#arabic-toggle`, `#arabic-view`, Arabic EN/AR search keyboard, RTL details/availability decoration, LG Back `461` & media key handling, YouTube player overlay, and Luna app launch (`youtube.leanback.v4` / `netflix`).

> **Important Deployment Note:** The `.ipk` loads `https://horizon-universal-search-preview.ali-al-anbari.workers.dev/?lg=1`. Until you deploy the updated `./universal-search` assets via `wrangler.universal-search-preview.jsonc` (`npx wrangler deploy --config wrangler.universal-search-preview.jsonc`), the live preview URL still serves the prior frontend without Chromium 79 compatibility, LG key `461`, or the Arabic section.

## LG NANO90 (webOS 6.x) Developer Mode Setup

1. Install **Developer Mode** from the LG Content Store on the TV and sign in with your LG Developer account.
2. Turn **Dev Mode Status: ON** and **Key Server: ON**.
3. Note the TV IP address and 6-character **Passphrase** *(remember Developer Mode session expires after 1000 hours unless extended in the app)*.

## Mac CLI Setup (`@webos-tools/cli`) & Package Commands

```bash
# Install official LG webOS CLI
npm install -g @webos-tools/cli

# Register TV (name: lg-nano90, port: 9922, ssh user: prisoner) and fetch key
ares-setup-device
ares-novacom --device lg-nano90 --getkey
ares-device-info -d lg-nano90

# Build & validate hosted .ipk
node lg-webos/scripts/build-ipk.mjs
ares-package -I lg-webos/dist/com.horizon.watch.lg_0.2.0_all.ipk

# Install, launch, inspect logs, uninstall
ares-install -d lg-nano90 lg-webos/dist/com.horizon.watch.lg_0.2.0_all.ipk
ares-launch -d lg-nano90 com.horizon.watch.lg
ares-inspect -d lg-nano90 -a com.horizon.watch.lg --open
ares-log -d lg-nano90
ares-install -d lg-nano90 -r com.horizon.watch.lg
```
