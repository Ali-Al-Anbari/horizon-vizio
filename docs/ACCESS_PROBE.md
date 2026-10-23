# Isolated Conjure / Cloudflare Access test

## What was inspected

The public production URL is `https://horizon-vizio.ali-al-anbari.workers.dev/`. On 2026-10-23, read-only requests returned the Horizon page and `horizon.js` with HTTP 200, while `/api/auth/probe` returned 404. The public JavaScript digest differed from this checkout, so the current checkout must not be treated as an exact copy of the deployed version. `docs/CLOUDFLARE_PAGES.md` describes an alternative Pages setup, but the active URL is a `workers.dev` hostname. There is no checked-in production Wrangler configuration. After the owner signed in to Wrangler, read-only current-version metadata showed `horizon-vizio` was deployed with Wrangler, serves static assets directly from `/` (`serve_directly: true`, `raw_run_worker_first: false`), and has zero bindings; `wrangler secret list` returned no secret names. The latest production version remained `b3763658-1472-4355-8cb5-8e7cca1bc74c` after staging deployment. Wrangler's OAuth token cannot read Access applications (Cloudflare API returned 403), so matching hostname, Worker, or account-level Access policies remain unverified.

In Workers & Pages, use the Access tab and Zero Trust dashboard to inspect any matching hostname/path, Worker-level, or account-level Access rules. Do not copy secret values. The local bridge configuration in `wrangler.jsonc` is a separate, undeployed prototype named `horizon-cloud-bridge-preview` and has a Durable Object; it is not this authentication probe.

## Staging configuration

The separate `wrangler.access-probe.jsonc` deployed `horizon-access-probe-staging` at `https://horizon-access-probe-staging.ali-al-anbari.workers.dev/` on 2026-10-23. It had no prior deployment. Its asset directory is `access-probe/`, its entrypoint is `cloud/access-probe-worker.js`, and it has **no Durable Object, controller binding, launch route, or SmartCast credential**. It serves only the public test page and two read-only GET routes. The deployed page returned 200 and `/api/apps/launch` returned 404. The owner created a path-scoped Access application for `/api/auth/*`; unauthenticated requests to both auth routes then returned a 302 Access redirect. `TEAM_DOMAIN`, `ACCESS_AUD`, and `OWNER_EMAIL` were stored as staging Worker secrets, with names verified and values not logged. Do not attach production routes or custom domains. Do not reuse production Access audience or application.

Staging setup completed after the approved deployment:

1. In the Zero Trust dashboard, check whether an account-level Access rule already covers all Workers; a more specific hostname/path rule may take priority.
2. Create a **new self-hosted Cloudflare Access application** scoped to this staging hostname and path `/api/auth/*` with an allow policy for the owner's **exact email address**. Keep the test page at `/` public so navigation can be distinguished from login. Do not use a wildcard that covers production. Choose a short session duration (for example, one hour). Record the new application's audience tag, but never put its JWT or a cookie in a file, issue, log, or URL.
3. The staging Worker is already deployed. Its endpoints reject requests without a valid owner JWT. The full bridge configuration was not deployed.
4. In the **staging Worker only**, set server-side `TEAM_DOMAIN` to `https://<team>.cloudflareaccess.com`, `ACCESS_AUD` to the staging Access application's audience tag, and `OWNER_EMAIL` to the exact policy email. Keep them out of `access-probe/` and `frontend/`. No controller credential is needed. Do not copy production variables, secrets, Durable Object bindings, or queues. The staging Wrangler file sets `keep_vars: true` so later deploys retain these dashboard-managed variables.
5. The owner completed the desktop-browser login on the Mac and reported “Owner verified. Same-origin API request carried a usable Access session” after checking and reloading. An unapproved identity has not been tested with a separate account. The Worker independently checks the exact owner email in the validated JWT. Do not record browser cookies or JWTs. The staging Worker has no `/api/apps/*` or `/api/controller/*` route.

Cloudflare documents that hostname/path Access apps can protect `workers.dev` URLs, while Worker-level and account-level Access rules may also apply. A path rule is selected here to leave the page public and protect only the two API routes. The Worker independently validates the `Cf-Access-Jwt-Assertion` signature, issuer, audience, expiry, and owner email because `ctx.access` is not passed to a Worker behind the Static Assets router. This is defense in depth; an Access policy alone is not the Worker authorization check.

## Conjure test after separate screen-change approval

Use the **existing authenticated Conjure launch mechanism** to navigate the TV to the staging page. This changes the TV screen, so obtain owner approval first. Do not point the TV at production or the bridge prototype for this test. No SmartCast app-launch command is issued by the probe.

The existing paired credential file is present and owner-only; its contents were not displayed. After separate approval, use the existing controller command from this repository:

```sh
python3 controller/horizon-controller.py launch \
  --tv 192.168.12.196 \
  --auth-file /Users/alialanbari/.config/vizio-smartcast/auth-192.168.12.196.json \
  --url https://horizon-access-probe-staging.ali-al-anbari.workers.dev/
```

This sends one authenticated Conjure namespace-4/app-17 launch and replaces the TV's current screen. It does not launch a streaming app or run the cloud command queue.

1. Confirm the public test page loads. Failure here is navigation, TLS, or general webview compatibility, before Access is involved.
2. Press OK on “Start sign-in” to do a **top-level** navigation to `/api/auth/start`. Observe whether the Access login page loads, accepts the owner's login, and returns to the public page. A login redirect initiated by `fetch()` is not a reliable interactive test.
3. On return, the page checks `/api/auth/probe` using same-origin `fetch` with credentials. “Owner verified” means the request reached the Worker with a valid assertion for the staging audience and owner. Press “Check session” again, then reload the page and check once more to test session retention. This does not itself prove that a native app can be launched through the cloud bridge.
4. Record only the stage reached, final status text, and visible behavior. Do not capture devtools network bodies, `Set-Cookie`, `CF_Authorization`, or JWTs. Do not enable request-header logging.

### TV result on 2026-10-23

With explicit owner approval, the paired controller sent a Conjure namespace-4/app-17 launch for the staging URL. The TV reported namespace 4, app ID 17, and the owner visually confirmed that the public test page loaded. The first probe version lacked physical-remote focus handling. A staging-only update added initial focus and arrow/OK handling; the owner then confirmed the test button worked with the remote, but did not retain its response text. Pressing OK on “Start sign-in” navigated to Cloudflare Access, but the remote did not operate the **Cloudflare login page itself**. The owner did not complete an Access login on the TV. Therefore no authenticated same-origin API request, fetch outcome, or Access cookie retention was verified in Conjure. This is an interactive-login compatibility failure, not evidence of a failure in the staging Worker's JWT check. The Mac login and authenticated request remain verified.

Cloudflare's documented Access login-page customization permits branding changes (name, logo, header/footer, and background), not remote-key handlers. “Instant authentication” can skip identity-provider selection when a single provider is configured, but it does not establish that the remaining sign-in UI works with this TV remote. Neither setting was changed for this test. See [Access login page customization](https://developers.cloudflare.com/cloudflare-one/reusable-components/custom-pages/access-login-page/) and [instant authentication](https://developers.cloudflare.com/learning-paths/clientless-access/customize-ux/login-page/).

If the public page loads but the Access page cannot load, investigate top-level navigation or the identity provider. If login completes but the page does not return, investigate redirect and cookie handling. If return works but the page reports no assertion, check the Access path rule, Access session cookie, and possible account/Worker-level policy precedence. If it reports authorization rejected, check the staging audience, team issuer, and owner policy. If same-origin `fetch` fails or receives HTML, investigate the webview's fetch/redirect/cookie behavior. If `fetch` is unavailable, the existing cloud frontend transport requires adaptation. The UI intentionally displays only coarse status codes; it never displays a token, cookie, or email.

## If interactive Access fails

Do not substitute a public unauthenticated launch route or a permanent secret in JavaScript. A practical next design is an owner-mediated device flow modeled on [RFC 8628](https://www.rfc-editor.org/rfc/rfc8628/):

1. The TV requests a short-lived pairing challenge from the staging Worker. The Worker generates a random display code and an independent high-entropy device secret, retained only in server state and an `HttpOnly`, `Secure`, `SameSite` cookie on the TV. The unauthenticated pairing route cannot queue or launch a TV command. Challenges expire within minutes, are single-use, and are rate-limited.
2. The owner opens an Access-protected approval page **on the Mac or phone**, enters the code visible on the TV, and explicitly approves that pending request. The approval endpoint validates the owner's Access JWT. Showing the code on the TV prevents approving an unseen device; the owner must still check it carefully to avoid code-phishing.
3. The TV polls using its original device cookie. Once approved, the Worker rotates it into a scoped, short-lived, revocable device session cookie. No permanent secret is embedded in Horizon JavaScript, placed in `localStorage`, or passed in a URL. A launch endpoint would require this session, same-origin request checks, the five-app allowlist, and the existing separate controller credential. Sessions expire and can be revoked from the owner's Access-protected page.
4. Before implementing this, run a **separate read-only cookie probe** in Conjure to verify that first-party `Secure`/`HttpOnly` cookies survive same-origin requests and reopening the page. A successful Mac Access test does not establish TV cookie behavior. If Conjure cannot retain first-party cookies, the design needs another owner-approved device credential mechanism and review; IP address or URL secrecy cannot authenticate the TV.

This is an architecture proposal only. No pairing endpoint, device cookie, or launch route was added to staging or production.

## Verification status

`npm run test:access-probe` covers denial without configuration, JWT signature/owner/audience checks, safe redirect, absence of launch routes, and remote arrow/OK behavior. `npm run test:cloud` checks that the existing mock bridge still passes. `npm run dev:access-probe -- --ip 127.0.0.1 --port 8788` served `/` and `/probe.js` with 200, returned 503 for unconfigured `/api/auth/probe`, 404 for `/api/controller/claim`, and did not expose a launch route. The deployed staging Worker passed public routing and fail-closed checks. The owner confirmed a real Access login and authenticated same-origin API request on the Mac, including after reload. Conjure loaded the page and handled the probe controls after the focus fix, but its Cloudflare Access login page could not be operated with the physical remote. Conjure's authenticated API and cookie behavior remain unverified.
