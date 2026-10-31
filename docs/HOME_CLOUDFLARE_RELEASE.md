# Horizon Home Workers release and rollback

`horizon-vizio` must retain the combined `bridge-worker.js` handler, `ASSETS`
with `/api/*` routed to the Worker, four encrypted bindings, and the original
`LAUNCH_QUEUE` namespace `3e81b6c93f6f45fb8595e8280201fd7a` (`v1`).
The `horizon-cloud-bridge-preview` Worker in `wrangler.jsonc` is separate.
Never upload Home with `wrangler.home-assets.jsonc`: it has no API handler.

Cloudflare's [script subdomain GET API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/subdomain/methods/get/)
returns `enabled`. The read-only guard uses this field. It never enables a
route. Cloudflare documents that a Wrangler deployment with `workers_dev:
false`, or an inferred false value when routes are configured, disables the
workers.dev route. The production-name Wrangler configuration explicitly sets
`workers_dev: true`. The cause of the prior 1042 outages has not been proven.

## Manual release

From the repository root, with existing Wrangler authentication:

1. Record the active version ID and run `node maintenance/check-home-release.mjs route`.
   Stop if it reports the route disabled. Review Cloudflare Domains & Routes;
   this workflow does not modify the setting.
2. Upload the intended combined source with
   `npx wrangler versions upload --config wrangler.production-repair.jsonc`.
   Record the printed UI version ID. Run the route check again.
3. Run `node maintenance/prepare-coordinated-release.mjs inspect home <UI_ID>`.
   Review its source, runtime, binding, and current asset manifest checks.
   Run `node maintenance/prepare-coordinated-release.mjs create-inactive home <UI_ID>`.
   Record the printed combined version ID. The beta Versions API explicitly
   inherits each encrypted binding from the verified historical version.
4. Run `node maintenance/check-home-release.mjs pre <COMBINED_ID>`. This checks
   the route and compares the candidate with the known combined handler,
   bindings, namespace, runtime, migration state, and `/api/*` asset routing.
   Stop on any failure. The Versions GET response does not expose exact asset
   contents, so the upload session and local manifest checks are also required.
5. Activate manually with
   `npx wrangler versions deploy '<COMBINED_ID>@100%' --config wrangler.production-repair.jsonc`.
   Do not run `wrangler triggers deploy` or an assets-only deploy as part of
   this procedure.
6. Immediately run `node maintenance/check-home-release.mjs post <COMBINED_ID>`.
   It checks the subdomain flag again, Home HTTP 200, and an unauthenticated
   controller claim HTTP 403. These probes do not pair a device or claim a
   command. If any check fails, stop further releases and inspect the route,
   deployment, and Worker logs.

The structural guard does not prove the live traffic allocation or every
asset byte. Record the version and asset manifest digest from the preparation
step and confirm the deployment in Cloudflare's version list.

## Rollback

Keep the last known working combined version ID from before activation.
For the documented recovery baseline, that ID is
`e6da0eff-01d6-4488-9b3c-7bee7777b308`.

1. Run `node maintenance/check-home-release.mjs pre <LAST_GOOD_ID>`.
2. Run `npx wrangler versions deploy '<LAST_GOOD_ID>@100%' --config wrangler.production-repair.jsonc`.
3. Run `node maintenance/check-home-release.mjs post <LAST_GOOD_ID>`.

If the workers.dev route is disabled, version rollback alone may still leave
the hostname unavailable. Inspect Domains & Routes and restore the route
manually through Cloudflare only after identifying the state change. The guard
does not change Cloudflare settings.
