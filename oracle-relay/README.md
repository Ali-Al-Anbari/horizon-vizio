# Akwam relay rollout

The [resolver](catalog.mjs) uses the existing verified catalog roots as a fast path. Other assets use Watch's existing public TMDB-backed title and season endpoints. The resolver uses the Arabic, original and English metadata labels and the season's title. It searches by section and year, then falls back to bounded section-only and unfiltered searches. TV still requires agreement on title, year and season. Movies rank normalized title and trusted TMDB release dates, with credits, runtime or a published IMDb ID as corroboration when available. Episode links must appear under that season and point to a watch link with their own source ID. Legacy short episode URLs also require agreement between the publisher's link label and the target episode heading. Positive root and page caches expire after five minutes, and known catalog misses expire after 45 seconds. Access errors and timeouts remain retryable. The normal path verifies Range semantics and an MP4 signature. A matched movie whose media server returns 200 instead of 206 can be tried only after the relay confirms an MP4 prefix. The relay rechecks that prefix when delivering byte zero and rejects HTML, malformed ranges, and mismatched movie tickets.

```sh
node oracle-relay/audit-catalog.mjs --find movie 'الجواهرجي' 'El Gawahergy'
CA_BUNDLE_PATH=/path/to/verified-ca-bundle.pem node oracle-relay/audit-catalog.mjs
CA_BUNDLE_PATH=/path/to/verified-ca-bundle.pem node oracle-relay/audit-catalog.mjs --expanded --probe-formats
CA_BUNDLE_PATH=/path/to/verified-ca-bundle.pem node oracle-relay/audit-catalog.mjs --unseen-movies
CA_BUNDLE_PATH=/path/to/verified-ca-bundle.pem node oracle-relay/audit-catalog.mjs --modern-egyptian --probe-formats
CA_BUNDLE_PATH=/path/to/verified-ca-bundle.pem node oracle-relay/audit-catalog.mjs \
  --discover-only --cold tv-122543-s4-e1 tv-122543-s4-e1
```

The audit reads public catalog and metadata responses and requests 12 media bytes per rendition. The optional `--probe-formats` gate requests up to 512 bytes for diagnostic identification of Matroska, WebM and HLS on candidates without an MP4 extension. The relay requires an MP4 signature for both Range-verified and best-effort movie sources. The audit prints identifiers, checks, mean and P95 lookup times, and peak process RSS. Playback, audio, and codecs require a player test.

## Provider adapter boundary

`getPlaybackSource(assetId, { force })` takes a canonical Watch movie or episode ID. An adapter verifies identity and media bytes, then returns that asset ID, its provider work ID, and MP4 sources with stable rendition keys. Akwam retains its existing TV descriptor with a null work ID. The shared boundary checks the descriptor shape, HTTPS host allowlist, unique sources, and the MP4 policy. The relay owns signed tickets, public DNS checks, TLS, Range semantics, and playback recovery.

Akwam is tried first at initial ticket issuance. A permitted MySeed descriptor can cover the same canonical ID if Akwam cannot resolve it. Existing sessions stay pinned to their signed provider and rendition so a seek never combines bytes from two representations. Legacy tickets resolve only through Akwam.

## MP4Plus fallback

With `MP4PLUS_ENABLED=true` and `MP4PLUS_PROXY_PERMITTED=true`, the relay tries the selected approved catalogs after Akwam misses. Set `MP4PLUS_CATALOGS=laroza,qfilm` or choose either catalog separately. The relay obtains the canonical identity from the existing Watch metadata, resolves exact catalog entries to stable MP4Plus embed IDs, and verifies the media before issuing a normal Watch ticket. Use a private persistent SQLite file set by `MP4PLUS_CACHE_PATH` and writable by the relay service user. The runtime must support `node:sqlite` (Node 22.13 or later).

SQLite stores verified canonical IDs, catalog names, stable file IDs, and runtime evidence for 12 hours. Definitive misses are cached for 60 seconds. Transient outages leave lookup retryable. The short-lived media URL stays in memory and is revalidated when refreshed. The relay confirms H.264/AAC sample entries, plausible duration and size, and consistent initial and nonzero byte ranges. Media requests stay on the scoped MP4Plus CDN. Source refresh preserves the signed provider, work, and rendition fingerprint. A session already issued by Akwam remains on Akwam.

Stage `catalog.mjs`, `playback-provider.mjs`, `myseed-provider.mjs`, `universal-catalog.mjs`, `mp4plus-provider.mjs`, and `relay-service.mjs` as one release. Verify staged checksums and entrypoint imports and save the active modules before replacement. Start with MP4Plus disabled. Smoke-test Akwam legacy and dynamic playback, seeking, and Resume before enabling any secondary catalog. After activation, test an Akwam control title and an MP4Plus fallback. On the LG, verify remote Play/Pause, arrow and progress-bar seeking, audio, subtitles, Resume after reopening Watch, and Back cancellation. Disable MP4Plus and restart to isolate a fallback failure. Restore the saved modules and restart for a relay regression. The Watch Worker and UI use the existing player contract.

## MySeed single-asset MP4 pilot

Keep `MYSEED_ENABLED` and `MYSEED_PROXY_PERMITTED` unset or false until the publisher authorizes relay delivery for the chosen asset, territory and Oracle egress. Confirm a seekable H.264/AAC MP4 and the exact approved HTTPS hostname. Record the media expiry and renewal rules when provided. Horizon assigns stable work and rendition IDs. The pilot accepts provider-approved media URLs with standard Range requests. Custom credentials, required Origin or Referer headers, or HLS require a separate provider-approved delivery contract and implementation.

The service reads one private JSON descriptor file configured with `MYSEED_DESCRIPTOR_FILE`. Give the service account read access and restrict other access. Set `MYSEED_MEDIA_HOSTS` to a comma-separated list of exact approved hostnames. A descriptor contains:

| Field | Pilot value |
|---|---|
| `assetId` | Exact canonical Watch ID, for example `movie-1316416` |
| `workId` | Stable Horizon identifier for the verified work and edition |
| `renditionId` | Stable Horizon identifier for that representation |
| `format` | `mp4` |
| `url` | Approved HTTPS media URL, supplied privately |
| `expiresAtMs` | Publisher expiry as Unix milliseconds, when published |

Rotate the descriptor using an atomic rename of a private regular file at the same path. Keep the asset, work, and rendition IDs unchanged for renewal. MySeed retries a 410 once on the same signed rendition and reloads expired descriptors before streaming. Watch Reload can recheck the file under the shared cooldown. A 403 or redirect fails closed. Keep tickets, descriptor contents and playback URLs out of command output and logs.

Stage `catalog.mjs`, `playback-provider.mjs`, `myseed-provider.mjs`, and `relay-service.mjs` together. Record live checksums and back up the active modules. Verify staged checksums, run `node --check` on each, and import the staged entrypoint with Node. Install with the entrypoint last and restart `horizon-relay-next` with MySeed disabled. Smoke-test a paired Akwam legacy episode, dynamic movie, late episode, Range seek and Resume. The Watch Worker contract is unchanged.

After authorization, first test the descriptor from the intended Oracle network. Enable both MySeed flags for the one descriptor only, then verify that an Akwam hit still plays and that the pilot fallback decodes audio and video, seeks, resumes and survives descriptor rotation. Verify playback on the physical LG before wider use. Disable MySeed and restart if the pilot fails. For a module regression, restore the backed-up modules with the prior entrypoint last and restart the existing unit. Leave the Watch Worker, existing issuer and signing keys, and CA configuration in place.

## Movie ranking and startup recovery rollout

Validate the Watch metadata and ticket changes on an inactive version with the existing pairing, secrets, and relay feature flag. The metadata enrichment is additive and the optional ticket source count defaults to one with the prior relay. After authorizing the change, activate and smoke-test Watch, then stage the Oracle modules together on Oracle. Compare the live entrypoint and module checksums to the preflight record, validate the staged files with Node, back up the active modules, then replace them and restart the existing `horizon-relay-next` unit once. Preserve the unit, its environment, and the trusted CA bundle.

Smoke-test a legacy episode, a newly matched movie with a one-year release discrepancy, a deliberately unavailable movie, and a marked recovery session. Watch waits for actual clock advancement, then preserves observed progress. A silent startup stall gets a refresh of the same source and, when the ticket lists another rendition of the same catalog work, one alternate attempt. Playback and seeking remain subject to the upstream's actual Range support. Use the previous Watch version and the backed-up Oracle modules for rollback. Repeat the existing physical LG checks before wider rollout.

## Discovery-only update on an existing dynamic relay

The release changes `catalog.mjs` on the VM. Confirm the active unit imports the existing dynamic catalog and record checksums for both active modules before staging. Use a fresh staging directory and a uniquely named backup of the active `catalog.mjs`. Confirm the active checksums still match your record, run `node --check` on the staged module, and verify the staged SHA-256 against your workstation. Install it to a temporary filename in `/opt/horizon-relay`, atomically rename it to `catalog.mjs`, then restart `horizon-relay-next`. Reuse the existing service configuration and environment.

Verify health, the original paired Watch playback of فخر الدلتا S01E01, the requested season of العتاولة, and one legacy short-link episode of الاختيار. Check Range 206, Arabic audio, and seek. Roll back by atomically restoring the backed-up `catalog.mjs` and restarting the same service. The sections below apply to discovery-only and initial dynamic-catalog rollouts.

## Oracle first

Proceed only after the deployment is authorized and the catalog scope is confirmed. The inspected unit is `horizon-relay-next` and the active entrypoint is `/opt/horizon-relay/relay-service.mjs`. The entrypoint hash matched the original audited package. Keep the existing environment, trusted CA bundle, Caddy configuration and resource limits. Run the focused tests on a staging copy before scheduling the restart.

On the workstation, upload the three Oracle source modules to a new staging directory on the server. Create the staging directory in the owner's home with restricted permissions.

```sh
ssh -i ~/.ssh/horizon-oracle.key ubuntu@129.213.139.127 'umask 077 && mkdir -p horizon-catalog-stage'
scp -i ~/.ssh/horizon-oracle.key oracle-relay/catalog.mjs oracle-relay/playback-provider.mjs oracle-relay/relay-service.mjs \
  ubuntu@129.213.139.127:horizon-catalog-stage/
```

On Oracle, run the following from the owner's shell. Stop if the checksum differs or the backup name exists.

```sh
set -e
cd /opt/horizon-relay
printf '%s  %s\n' 1f5a2bbcb496874d2aa381f25a510d4a11ed15141dae4eb6c71de1012ae03eb5 relay-service.mjs | sha256sum -c
sudo test ! -e relay-service.pre-catalog.mjs
sudo test ! -e catalog.pre-catalog.mjs
sudo test ! -e playback-provider.pre-catalog.mjs
node --check "$HOME/horizon-catalog-stage/catalog.mjs"
node --check "$HOME/horizon-catalog-stage/playback-provider.mjs"
node --check "$HOME/horizon-catalog-stage/relay-service.mjs"
sudo cp -p relay-service.mjs relay-service.pre-catalog.mjs
if sudo test -e catalog.mjs; then sudo cp -p catalog.mjs catalog.pre-catalog.mjs; fi
if sudo test -e playback-provider.mjs; then sudo cp -p playback-provider.mjs playback-provider.pre-catalog.mjs; fi
sudo install -m 0644 "$HOME/horizon-catalog-stage/catalog.mjs" catalog.mjs
sudo install -m 0644 "$HOME/horizon-catalog-stage/playback-provider.mjs" playback-provider.mjs
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
if sudo test -e playback-provider.pre-catalog.mjs; then
  sudo cp -p playback-provider.pre-catalog.mjs playback-provider.restore.mjs
  sudo mv -T playback-provider.restore.mjs playback-provider.mjs
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
