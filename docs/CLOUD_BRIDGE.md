# Secure Cloudflare launch bridge (local prototype)

> This document describes the earlier Access-on-TV prototype. The active owner-mediated pairing design and current local test results are in [PAIRING_STAGING.md](PAIRING_STAGING.md). The Access-on-TV flow below was not usable with the Vizio remote and is not the current browser authorization plan.

## Architecture assessment

The repository previously had only `frontend/` and Pages deployment notes. It has no checked-in configuration for the existing production Worker, so its live routing, bindings, and Access policy cannot be inferred from this repository. `wrangler.jsonc` creates a **separate local preview configuration** named `horizon-cloud-bridge-preview` with `workers_dev: false`. It does not change the current `horizon-vizio.ali-al-anbari.workers.dev` deployment. Its static assets come directly from `frontend/`; `run_worker_first: ["/api/*"]` sends API routes to the Worker. The local Wrangler run returned 200 for `/` and `/horizon.js`, 404 for controller source, and denied unauthenticated API requests.

The trust boundary is:

```text
Horizon page ──same-origin HTTPS──> Worker API ──RPC──> one Durable Object
                                                      ↑
Mac or embedded controller ──outbound HTTPS polling───┘
          │
          └──authenticated SmartCast API on the TV LAN
```

The public page contains only five app identifiers. It never receives the SmartCast token or the controller credential. The Worker accepts a browser launch only after validating a Cloudflare Access JWT signature, issuer, audience, expiry, and the configured owner email. The browser API also checks the exact Origin, JSON request shape, and action header. CORS and the obscurity of the URL are not authorization. The Worker accepts controller claim and result calls only with a separate random bearer credential stored in a Worker secret and a mode-0600 file on the controller. The controller refuses commands outside its verified local allowlist. No endpoint accepts arbitrary URLs, SmartCast commands, or app IDs.

Cloudflare's static-assets router does not pass `ctx.access` to Worker code, so the API validates the `Cf-Access-Jwt-Assertion` header cryptographically with Cloudflare's rotating JWKS. The intended Access policy protects only `/api/apps/*` and permits only the owner account. The `/api/controller/*` routes use their own secret. If a future operator protects the entire Worker with Access instead, the controller would also need an Access service credential; this prototype does not silently bypass that policy. See [Cloudflare's Access JWT validation guide](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/), [Worker Access limitations](https://developers.cloudflare.com/workers/configuration/cloudflare-access/), and [Access application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/).

## Queue behavior

One SQLite-backed Durable Object instance is addressed by the fixed name `primary-tv`. Its storage contains one active command and at most eight recent results. Synchronous read and write operations in that one object claim a queued command once. Commands expire after 30 seconds if unclaimed or 35 seconds after a claim. Claimed commands are **never retried** after a controller failure, because the TV may have opened the app before the controller lost its response. Results remain readable for 120 seconds, then are pruned. A 12-second cooldown follows completion or expiry. Repeated requests for the same active app return the same command ID; requests for another app while active are rejected. Results require the matching one-time claim ID, and stale or repeated reports are rejected. An alarm prunes dormant results; API reads also enforce deadlines if an alarm is delayed. See [Cloudflare's SQLite Durable Object storage semantics](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) and [alarm timing](https://developers.cloudflare.com/durable-objects/api/alarms/).

The public command states are `queued`, `processing`, `verified`, `failed`, and `expired`. A TV launch is `verified` only when authenticated `GET /app/current` matches the observed state for the selected app. The controller sends `failed` for a TV rejection, connection failure, or an accepted request without the expected current app. The existing five launch and expected-state configurations in `controller/horizon-controller.py` are reused unchanged. The Live TV tile opens WatchFree+; the separate OTA tuner input remains untested.

The Mac polls for a command every two seconds by default. With a healthy controller, this adds about 0–2 seconds before a claim (about one second on average), followed by SmartCast launch/readback time and up to two seconds for the browser's result poll. This is an estimate, not a measurement on the physical TV. An offline controller leaves the request queued until the 30-second deadline. A claimed command can remain processing for up to 35 seconds. The same outbound HTTPS, small JSON command, and fixed allowlist can be implemented on a low-resource embedded device later; no inbound LAN port is needed for cloud mode.

## Authorization gate on Conjure

This design requires the Vizio Conjure webview to obtain and retain a Cloudflare Access session for the browser API. An isolated staging probe verified that Access sign-in and authenticated same-origin requests work on the Mac. On the TV, Conjure loaded the probe and its remote controls worked after a focus fix, but the physical remote could not operate Cloudflare's login page after redirect. No Access session or authenticated API request was verified on the TV. The public HTTPS launch flow remains unverified and should remain off production. An owner-mediated pairing/session design is the practical next investigation; a token in static assets or localStorage is not an acceptable shortcut.

An isolated, authentication-only staging test is prepared in [ACCESS_PROBE.md](ACCESS_PROBE.md). It does not have a command queue or TV launch capability.

## Local test plan (no production calls)

1. Run `npm ci`, then `npm run test:cloud`. The Node tests use generated signing keys, a mock Durable Object binding, and a mock clock. They cover JWT authorization, queue claim, duplicate and conflicting requests, expiry, replay rejection, and an API round trip.
2. Run `python3 -m unittest tests/cloud-controller-test.py tests/native-app-bridge-test.py`. The cloud controller tests mock SmartCast and Cloudflare calls; they verify that API success alone does not count as an opened app. The existing local LAN bridge tests check its fallback behavior. These tests never contact the TV.
3. Run `npm run dev:cloud -- --ip 127.0.0.1 --port 8787`. Confirm `GET /` and `GET /horizon.js` return 200. With no Access settings or controller secret configured, `POST /api/apps/launch` must return 503 and `POST /api/controller/claim` must return 403. This is a fail-closed routing check, not a successful launch test.
4. For a future isolated preview deployment, configure an owner-only Access application on `/api/apps/*`, set `TEAM_DOMAIN`, `ACCESS_AUD`, and `OWNER_EMAIL` in the Worker environment, and set `CONTROLLER_TOKEN` using a Cloudflare secret. Put the same independently generated credential in a mode-0600 file on the Mac. Test the Conjure login flow and `/api/apps/*` access before any TV launch. Do not use production credentials or the production Worker for the local tests above.

The controller command for an eventual isolated preview is:

```sh
python3 controller/horizon-controller.py cloud-poll \
  --tv TV_LAN_IP --auth-file /private/path/smartcast-auth.json \
  --cloud-url https://PREVIEW-WORKER-ORIGIN \
  --cloud-secret-file /private/path/controller-secret
```

`cloud-poll` does not alter power-on automation and accepts only HTTPS origins, except loopback HTTP for local tests. The LAN `serve` mode remains available. No production deployment, real cloud credential, or physical TV launch was part of this prototype.
