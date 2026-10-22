# SmartCast integration boundary

`frontend/horizon-config.js` contains display metadata for launcher tiles. The page itself makes no SmartCast API calls and does not contain a pairing token. Its Content Security Policy blocks network connections.

The local companion controller performs authenticated power reads and Conjure launches through SmartCast. App ID 17 and namespace 4 opened Horizon on the tested retail TV. App ID 17 is an experimental launch route for this project; this does not give Horizon the ability to replace Vizio Home or launch at TV boot.

Streaming-app tiles currently show a configured/coming-soon notice. A future app-launch feature should send only a tile ID to a narrowly scoped local controller, which would map the ID to an allowed SmartCast app and use the token locally. Do not expose a general authenticated API proxy or put the token in frontend configuration. Launching another app replaces the Conjure page.

The internet tile is also a placeholder. Conjure can display web content, but a useful browser needs site navigation, text entry, cookies, history, and DRM compatibility; these are not established by the current launcher.

The page can be hosted at a static HTTPS address. Hosting does not replace the always-on controller for automatic power-on detection. See [AUTOSTART.md](AUTOSTART.md).
