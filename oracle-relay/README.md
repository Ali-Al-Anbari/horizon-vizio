# Akwam relay rollout

The [resolver](catalog.mjs) uses the existing verified catalog roots as a fast path. Other assets use Watch's existing public TMDB-backed title and season endpoints. The resolver uses the Arabic, original and English metadata labels and the season's title. It searches by section and year, then falls back to bounded section-only and unfiltered searches. TV still requires agreement on title, year and season. Movies rank normalized title and trusted TMDB release dates, with credits, runtime or a published IMDb ID as corroboration when available. Episode links must appear under that season and point to a watch link with their own source ID. Legacy short episode URLs also require agreement between the publisher's link label and the target episode heading. Positive root and page caches expire after five minutes, and known catalog misses expire after 45 seconds. Access errors and timeouts remain retryable. The normal path verifies Range semantics and an MP4 signature. A matched movie whose media server returns 200 instead of 206 can be tried only after the relay confirms an MP4 prefix. The relay rechecks that prefix when delivering byte zero and rejects HTML, malformed ranges, and mismatched movie tickets.

```sh
node oracle-relay/audit-catalog.mjs --find movie 'الجواهرجي' 'El Gawahergy'
CA_BUNDLE_PATH=/path/to/verified-ca-bundle.pem node oracle-relay/audit-catalog.mjs
CA_BUNDLE_PATH=/path/to/verified-ca-bundle.pem node oracle-relay/audit-catalog.mjs --expanded --probe-formats
CA_BUNDLE_PATH=/path/to/verified-ca-bundle.pem node oracle-relay/audit-catalog.mjs --unseen-movies
CA_BUNDLE_PATH=/path/to/verified-ca-bundle.pem node oracle-relay/audit-catalog.mjs \
  --discover-only --cold tv-122543-s4-e1 tv-122543-s4-e1
```

The audit reads public catalog and metadata responses and requests 12 media bytes per rendition. The optional `--probe-formats` gate requests up to 512 bytes for diagnostic identification of Matroska, WebM and HLS on candidates without an MP4 extension. The relay requires an MP4 signature for both Range-verified and best-effort movie sources. The audit prints identifiers, checks, mean and P95 lookup times, and peak process RSS. Playback, audio, and codecs require a player test.

## Movie ranking and startup recovery rollout

Validate the Watch metadata and ticket changes on an inactive version with the existing pairing, secrets, and relay feature flag. The metadata enrichment is additive and the optional ticket source count defaults to one with the prior relay. After authorizing the change, activate and smoke-test Watch, then stage the new `catalog.mjs` and `relay-service.mjs` together on Oracle. Compare the live entrypoint and module checksums to the preflight record, validate both staged files with Node, back up both active modules, then replace both and restart the existing `horizon-relay-next` unit once. Preserve the unit, its environment, and the trusted CA bundle.

Smoke-test a legacy episode, a newly matched movie with a one-year release discrepancy, a deliberately unavailable movie, and a marked recovery session. Watch waits for actual clock advancement, then preserves observed progress. A silent startup stall gets a refresh of the same source and, when the ticket lists another rendition of the same catalog work, one alternate attempt. Playback and seeking remain subject to the upstream's actual Range support. Use the previous Watch version and both backed-up Oracle files for rollback. Repeat the existing physical LG checks before wider rollout.

## Discovery-only update on an existing dynamic relay

The release changes `catalog.mjs` on the VM. Confirm the active unit imports the existing dynamic catalog and record checksums for both active modules before staging. Use a fresh staging directory and a uniquely named backup of the active `catalog.mjs`. Confirm the active checksums still match your record, run `node --check` on the staged module, and verify the staged SHA-256 against your workstation. Install it to a temporary filename in `/opt/horizon-relay`, atomically rename it to `catalog.mjs`, then restart `horizon-relay-next`. Reuse the existing service configuration and environment.

Verify health, the original paired Watch playback of فخر الدلتا S01E01, the requested season of العتاولة, and one legacy short-link episode of الاختيار. Check Range 206, Arabic audio, and seek. Roll back by atomically restoring the backed-up `catalog.mjs` and restarting the same service. The sections below apply to discovery-only and initial dynamic-catalog rollouts.

## Oracle first

Proceed only after the deployment is authorized and the catalog scope is confirmed. The inspected unit is `horizon-relay-next` and the active entrypoint is `/opt/horizon-relay/relay-service.mjs`. The entrypoint hash matched the original audited package. Keep the existing environment, trusted CA bundle, Caddy configuration and resource limits. Run the focused tests on a staging copy before scheduling the restart.

On the workstation, upload only the two public source files to a new staging directory on the server. Create the staging directory in the owner's home with restricted permissions.

```sh
ssh -i ~/.ssh/horizon-oracle.key ubuntu@129.213.139.127 'umask 077 && mkdir -p horizon-catalog-stage'
scp -i ~/.ssh/horizon-oracle.key oracle-relay/catalog.mjs oracle-relay/relay-service.mjs \
  ubuntu@129.213.139.127:horizon-catalog-stage/
```

On Oracle, run the following from the owner's shell. Stop if the checksum differs or the backup name exists.

```sh
set -e
cd /opt/horizon-relay
printf '%s  %s\n' 1f5a2bbcb496874d2aa381f25a510d4a11ed15141dae4eb6c71de1012ae03eb5 relay-service.mjs | sha256sum -c
sudo test ! -e relay-service.pre-catalog.mjs
sudo test ! -e catalog.pre-catalog.mjs
node --check "$HOME/horizon-catalog-stage/catalog.mjs"
node --check "$HOME/horizon-catalog-stage/relay-service.mjs"
sudo cp -p relay-service.mjs relay-service.pre-catalog.mjs
if sudo test -e catalog.mjs; then sudo cp -p catalog.mjs catalog.pre-catalog.mjs; fi
sudo install -m 0644 "$HOME/horizon-catalog-stage/catalog.mjs" catalog.mjs
sudo install -m 0644 "$HOME/horizon-catalog-stage/relay-service.mjs" relay-service.catalog-new.mjs
sudo mv -T relay-service.catalog-new.mjs relay-service.mjs
sudo systemctl restart horizon-relay-next
curl -fsS https://horizon.129-213-139-127.sslip.io/health
```

From a paired Watch tab, verify the existing فخر الدلتا S01E01 plays, seeks and resumes. Also verify through an authenticated issuer probe that `GET /catalog?id=tv-122543-s4-e1` returns a boolean and the matching asset ID and that season six episode 30 stays unavailable. Pass authorization privately and avoid printing tickets, headers, or playback URLs.

## Watch second

The automatic discovery change requires no Watch upload on a Worker that already routes `/api/arabic/relay-catalog` and accepts canonical relay asset IDs. If this earlier integration is still pending, deploy that Watch version only after Oracle smoke checks pass.

Record the current active Watch version as `WATCH_PRIOR_VERSION`. Confirm the configured Watch Durable Object migration is already applied. From the repository root:

```sh
WATCH_CONFIG=wrangler.universal-search-preview.jsonc
./node_modules/.bin/wrangler deployments list --config "$WATCH_CONFIG"
./node_modules/.bin/wrangler versions upload --config "$WATCH_CONFIG" \
  --var AKWAM_RELAY_ENABLED:true
```

Set `WATCH_VERSION` to the returned inactive version. Verify the flag and the existing Watch bindings, including `ISSUER_SECRET`, `TMDB_TOKEN`, Access settings, `LAUNCH_QUEUE`, `ASSETS`, and `AI`. Preserve the canonical workers.dev route and keep version URLs disabled.

```sh
./node_modules/.bin/wrangler versions view "$WATCH_VERSION" --config "$WATCH_CONFIG"
./node_modules/.bin/wrangler versions deploy "${WATCH_VERSION}@100%" --config "$WATCH_CONFIG"
```

In paired Chrome, verify a mapped movie, a late episode, a different season, an unavailable selection, and the legacy episode. Verify actual playback and Arabic audio, seeking, Reload, Resume, Next and Back. Inspect response status and range headers without copying or logging request URLs.

## Rollback

Roll Watch back to `WATCH_PRIOR_VERSION` first. Leave the Watch pairing namespace and credentials in place.

```sh
./node_modules/.bin/wrangler rollback "$WATCH_PRIOR_VERSION" \
  --config wrangler.universal-search-preview.jsonc
```

If the Oracle change broke playback, restore the backed-up entrypoint and any prior catalog module on Oracle and restart. If this was an Oracle-only release, leave Watch's active version in place.

```sh
cd /opt/horizon-relay
if sudo test -e catalog.pre-catalog.mjs; then
  sudo cp -p catalog.pre-catalog.mjs catalog.restore.mjs
  sudo mv -T catalog.restore.mjs catalog.mjs
fi
sudo cp -p relay-service.pre-catalog.mjs relay-service.restore.mjs
sudo mv -T relay-service.restore.mjs relay-service.mjs
sudo systemctl restart horizon-relay-next
curl -fsS https://horizon.129-213-139-127.sslip.io/health
```

Confirm legacy playback on Watch after rollback.

## Physical LG NANO90 validation

- Pair on the TV. Play a legacy episode, a mapped movie and a late episode for at least 60 seconds. Confirm stable video and Arabic audio. Verify the actual renditions use supported H.264 and AAC profiles before widening rollout.
- Play and pause with the remote. Seek forward and backward and confirm playback resumes from the new position. Check that Oracle's Range responses are 206.
- Reload during play and pause, then verify position and state. Exercise one expired-source recovery under controlled conditions.
- Press Back during catalog lookup, ticket issuance and active playback. Check that late callbacks leave the player closed, media requests stop and focus returns.
- Verify episode and season transitions, movie and episode Resume, Continue Watching, Watch History, subtitles where available, and unaffected providers. Repeat after reloading Watch and after suspending and resuming the TV.
