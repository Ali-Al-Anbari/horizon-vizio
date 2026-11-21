# Akwam relay rollout

The [resolver](catalog.mjs) uses the existing verified catalog roots as a fast path. Other assets use Watch's existing public TMDB-backed title and season endpoints. The resolver searches Akwam using the trusted original and localized names, applies the publisher's section and year filters, and requires a unique exact title, year and season. Each episode must appear under that season and have a watch link for its own source ID and episode number. An ambiguous or missing match stays unavailable. An available result still requires a strict Range and MP4 signature check.

```sh
node oracle-relay/audit-catalog.mjs --find movie 'الجواهرجي' 'El Gawahergy'
CA_BUNDLE_PATH=/path/to/verified-ca-bundle.pem node oracle-relay/audit-catalog.mjs
CA_BUNDLE_PATH=/path/to/verified-ca-bundle.pem node oracle-relay/audit-catalog.mjs --expanded
CA_BUNDLE_PATH=/path/to/verified-ca-bundle.pem node oracle-relay/audit-catalog.mjs \
  --discover-only --cold tv-122543-s4-e1 tv-122543-s4-e1
```

The audit reads public catalog and metadata responses and at most 12 media bytes per rendition. Its MKV probe records the container signature for diagnosis. MKV remains unavailable for the MP4 relay. The audit prints identifiers, checks, timings, and peak process RSS. It never prints media URLs. Playback, audio, and codecs require a player test.

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
