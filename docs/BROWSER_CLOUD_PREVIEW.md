# Horizon Cloud Browser preview

This is a separate, **undeployed** Browser Run experiment. Production Horizon,
its Durable Object, controller, credentials, and TV integrations are untouched.

## Architecture

```text
Vizio Conjure browser-cloud-lab.html
  ├─ local toolbar, cursor, TV keyboard, JPEG display
  └─ same-origin HTTPS, paired-device cookie
       → horizon-cloud-browser-preview Worker
       → BrowserCoordinator Durable Object (new namespace)
       → @cloudflare/playwright acquire/connect
       → Cloudflare Browser Run Chromium
       → JPEG screenshot back to Vizio
```

The worker has **no** production `LAUNCH_QUEUE`, SmartCast, or Pico bindings.
Pairing reuses the existing `DevicePairing` implementation in a new Durable
Object namespace. The owner approval routes need a **new owner-only Cloudflare
Access application** for `/owner`, `/owner.html`, and `/api/owner/*`, with new
`TEAM_DOMAIN`, `ACCESS_AUD`, and `OWNER_EMAIL` secret bindings for this Worker.
The team domain and authorized identity may be the same; the Access AUD must
belong to the new preview application. Never provision `CONTROLLER_TOKEN` here.
The public lab and pairing initiation are accessible;
browser operations require an approved, non-revoked, unexpired device cookie.
An owner can forcibly end the browser from an Access-authenticated `/owner`
page with a same-origin `POST /api/owner/browser/terminate` carrying
`X-Horizon-Action: browser-admin`; no controller or TV credential is involved.

One browser session exists at a time. It closes after 90 seconds idle, five
minutes total, explicit End Session, owner termination, or device revocation.
Browser Run's keep-alive is 120 seconds; if close fails, Cloudflare's inactivity
limit is the fallback. On a lost action response, the sequence is consumed and
the UI checks status; it never replays an ambiguous click or form submission.
If a command fails and Browser Run reports that the remote session is gone,
the coordinator clears its stale metadata and returns `session_expired`.

Browser input is restricted to the fixture, `example.com`, `www.wikipedia.org`,
and `www.google.com`. Browser Run hostname guardrails are set at acquisition,
and Playwright page requests are screened again. This fixed list prevents a
public visitor from turning the preview into an open proxy. It is **not** a
general URL policy for arbitrary untrusted domains or DNS rebinding; expanding
it requires separate SSRF review. Redirects outside the list are blocked. The
prototype rejects explicit ports, credentials in URLs, non-HTTPS schemes, and
private-IP destinations. Remote text insertion works only while a text/search
input or textarea in the top document is focused. Password fields, cross-frame
inputs, login flows, and persistence of website cookies after session close are
out of scope. Do not enter sensitive information during the test.

## Limits and measurement

The browser viewport is 1280×720. The TV converts coordinates from the
displayed, possibly letterboxed image into this viewport before sending a
click. Playwright's `page.mouse.click(x, y)` performs browser-level hit testing.
Each action returns a JPEG, capped at 1.5 MB. Up to 120 actions and 160 image
captures are allowed per session; actions are also capped at 30 per minute.
Explicit screenshot refreshes are capped at 20 per minute.
There is no continuous video or background screenshot loop.
The theoretical image-transfer ceiling is 240 MB per five-minute session;
actual JPEG sizes and network use require measurement. A decoded 1280×720
RGBA image is about 3.5 MiB, and the TV may briefly hold two images during a
swap. This is a memory risk to check on Conjure.

Use `?timing=1` for bounded diagnostics. The Worker reports action and JPEG
capture durations, plus Durable Object queue wait and handler duration; the TV reports response-header wait, image transfer, and
image-load callback durations. The Timing summary button reports p50/p95/max
for at most 40 local action-to-image-load samples. These clocks are **not**
subtracted across devices. Image `load` and animation-frame callbacks do not
prove that pixels were presented on the TV. Measure first visible change with
the physical remote separately. The target of <1 second click-to-update is a
target, not a measured result.

Cloudflare's published included usage is 10 browser minutes/day on Workers
Free, or 10 hours/month on Workers Paid, then $0.09/hour; concurrency charges
can apply to paid plans above included capacity. A full five-minute session
would consume roughly half a Free daily allowance. Free currently permits
three concurrent browsers and one new browser instance every 20 seconds; the
prototype itself permits only one. The account's actual plan
and remaining quota have **not** been checked. No Browser Run session was
started in local tests.
`npm audit --omit=dev` reports no runtime advisories. The full audit reports
three development-tool advisories in the existing Wrangler/Miniflare/Undici
chain; no package downgrade or speculative remediation was made in this phase.

## Local checks

From the repository root:

```sh
node --test tests/browser-cloud-preview.test.js
npm run test:cloud
node --check cloud/browser-preview-worker.js
node --check cloud/browser-preview-engine.js
node --check cloud/browser-preview-page.js
node --check frontend/browser-cloud-lab.js
XDG_CONFIG_HOME=/private/tmp npx wrangler deploy --config wrangler.browser-cloud-preview.jsonc --dry-run
git diff --check
```

To inspect only the static lab shell on a Mac, run
`python3 -m http.server 8788 --directory frontend` and open
`http://127.0.0.1:8788/browser-cloud-lab.html`. Its API is intentionally absent
in this static preview. The automated tests use a mock browser; they do not
consume Cloudflare browser minutes. `wrangler dev` with a live remote browser
binding is **not** part of the local procedure because it may consume account
quota.

## Later supervised staging setup (requires separate approval)

1. Check the account's Workers plan, Browser Run quota and billing settings.
2. Create a new owner-only Access application covering exactly `/owner`,
   `/owner.html`, and `/api/owner/*` on the **preview** hostname.
3. Confirm the Wrangler config names `horizon-cloud-browser-preview`, its new
   `BROWSER_COORDINATOR` migration `browser-preview-v1`, `BROWSER`, and `ASSETS`.
4. Only after approval, deploy the isolated Worker. Owner approval fails closed
   until its three preview secrets are set:

   ```sh
   npx wrangler deploy --config wrangler.browser-cloud-preview.jsonc
   ```

5. Enter the new preview values interactively; do not put them in shell history
   or source. Each `secret put` can publish a new isolated Worker version:

   ```sh
   npx wrangler secret put TEAM_DOMAIN --config wrangler.browser-cloud-preview.jsonc
   npx wrangler secret put ACCESS_AUD --config wrangler.browser-cloud-preview.jsonc
   npx wrangler secret put OWNER_EMAIL --config wrangler.browser-cloud-preview.jsonc
   ```

6. Pair a Mac browser first from the public lab, approving its code from the
   Access-protected owner page. Start the browser and check fixture screenshot,
   button click, text, scroll, page-two link, Back/Forward, and End Session.
   Confirm the button label changes in the **returned screenshot**, not merely
   that the API returns HTTP 200. Verify an unpaired browser receives 403 and
   a revoked device loses access. Check Browser Run usage afterward.

### Physical Vizio sequence (separate screen-change approval)

1. Use the existing authenticated Conjure launch path to open the preview's
   `/browser-cloud-lab.html`. This changes the TV screen and needs approval.
2. Pair the TV from a phone/Mac owner page; never share the code in logs.
3. Select **Start browser session**. Confirm the fixture image appears.
4. Select **Use cursor**, move over **Click me: 0**, press OK once. Confirm
   the returned image visibly reads **Click me: 1**.
5. Click the fixture text field, return to toolbar with Back, select **Type in
   page**, enter a harmless phrase, press keyboard Enter, then click **Show
   text**; confirm the returned screenshot shows that phrase.
6. Try Scroll mode, the page-two link, Back, Forward, Refresh, and End Session.
7. Only after the fixture succeeds, try `https://example.com`,
   `https://www.wikipedia.org`, and a Google search. Rendering, anti-bot
   responses, page controls, and media behavior are unverified on the Vizio.
8. Record action-to-image callback and first-visible-change times separately.
   Do not infer pixel presentation from the callback alone.

To recover if the lab loses TV input, use the existing authenticated SmartCast
Conjure launcher to reopen production Horizon. Do not expect Vizio Back to
restore the launcher after any accidental top-level navigation.

## Current proof boundary

Local mock tests verify protocol/state transitions and that commands call the
intended Playwright page methods. The Wrangler dry run verifies bundling and
bindings. They do **not** verify Browser Run acquisition, a genuine external
click, screenshot transfer over Cloudflare, Conjure image decoding, or physical
remote interaction. A deployed, approved staging test is the next gate.
