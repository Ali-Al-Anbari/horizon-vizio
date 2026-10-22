# Cloudflare Pages deployment settings

Horizon is static HTML, CSS, and JavaScript. It has no package installation or compilation step.

For GitHub integration in Cloudflare Pages, configure:

| Setting | Value |
| --- | --- |
| Framework preset | None |
| Production branch | `main` |
| Root directory | Repository root (leave blank or `.`) |
| Build command | `exit 0` |
| Build output directory | `frontend` |

`frontend/index.html` is the production homepage. It references `horizon.css`, `horizon-config.js`, `horizon-diagnostics.js`, and `horizon.js` with relative paths. Pages publishes files under `frontend/` at the site root, so the homepage is served at `https://PROJECT.pages.dev/` and its assets resolve from the same origin. `horizon.html` is an equivalent explicit page path.

The output directory contains only the web interface and its static A/B diagnostic page; Python controller code, pairing data, and local settings live elsewhere in the repository. The frontend Content Security Policy sets `connect-src 'none'` and contains no SmartCast API calls or credentials.

No Pages deployment is performed as part of local validation. After the first deployment, confirm that the pages.dev homepage loads and that `horizon.css`, `horizon-config.js`, `horizon-diagnostics.js`, and `horizon.js` return successfully. The Conjure TV launch remains an external controller operation; static hosting does not enable startup automation by itself.
