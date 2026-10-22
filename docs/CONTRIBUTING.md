# Contributing

Thanks for helping improve Horizon. Keep changes small and testable; this project targets a constrained TV webview as well as desktop browsers.

## Before opening a change

- Do not commit SmartCast tokens, auth JSON, `.env`, private TV/LAN addresses, logs, or controller state.
- Keep pairing credentials in the local Python controller. Never add them to `frontend/` or a static-hosted file.
- Preserve the frontend Content Security Policy. Any companion-controller feature should expose only the specific action needed, not an unrestricted authenticated proxy.
- Keep remote navigation responsive: avoid blocking network requests and long synchronous work in key handlers.
- Do not add exploits, firmware modifications, or persistent TV configuration changes.

## Local checks

```sh
python3 -m py_compile controller/horizon-controller.py tests/*.py
node --check frontend/horizon.js
node --check frontend/horizon-config.js
node --check frontend/horizon-diagnostics.js
```

You can inspect the UI on a desktop with `python3 -m http.server 8765 --directory frontend`. A real TV launch is optional and must be done deliberately with the guarded test helper and owner approval.

## Pull requests

Describe the TV/runtime tested, the input sequence used, and any measured change in focus/paint latency. Do not include private network details or screenshots that expose personal information. Update the relevant docs when setup, supported behavior, or safety boundaries change.
