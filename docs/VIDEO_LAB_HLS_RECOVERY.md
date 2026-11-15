# Video Lab HLS recovery experiment

The existing `/video-lab/index.html` page retains its original video element,
source picker, D-pad controls, and diagnostics. HLS remains an experimental,
manually selected **Apple Bip Bop test**. Watch playback, VidBolt, YapGrid,
progress, and subtitles are not routed through this page.

The original HLS button assigned an `.m3u8` URL directly to `<video>`. The
earlier physical Vizio probe reported no native HLS hint, although it reported
MediaSource and tested H.264/AAC MSE types. A direct media-element source is
therefore insufficient on that TV. This does not prove MSE decoding works.

The HLS button now prefers MSE with a pinned, lazy-loaded hls.js 1.5.20 light
build when a tested H.264/AAC MP4 SourceBuffer type is reported. It falls back
to native HLS when MSE is unavailable but the browser reports native support.
If neither path exists, it shows an unsupported message. Loading never calls
`play()`; Play is a direct user action. Source changes destroy the adapter and
invalidate pending work. The sample's subtitle tracks are disabled by default.
The page's CSP permits only the public Apple CDN for HLS fetches and the local
adapter; MSE requires `blob:` media URLs. The library's internal empty WebVTT
media URL also requires `data:` in `media-src`.

`?diagnostics=1` shows capability hints, media events, and sanitized HLS
stage/type/detail/HTTP code. A status-0 network error can indicate CORS or
transport failure and is not identified as one or the other without a network
trace. Fatal failures never switch providers; select HLS again to retry.

## Physical Vizio checklist

1. Open the isolated Video Lab page with `?diagnostics=1`. Photograph the
   capability hints and select **HLS · Apple Bip Bop** with the remote.
2. Confirm manifest and metadata events, a real moving picture, and audible
   sound. A `canplay` or `playing` event alone is insufficient.
3. Press Play with OK after media is ready. Record any `play()` rejection and
   whether the same action works after a fresh page load.
4. Pause, resume, seek forward and backward, and verify the displayed time
   follows the picture. Confirm subtitles remain Off.
5. Switch to the known MP4 sample and back to HLS. Confirm the old stream stops
   and that HLS can recover by selecting it again after a failure.
6. Leave Video Lab and confirm playback stops. Check that Watch and Video Lab's
   normal VidBolt/YapGrid flows remain unaffected.

The first successful desktop Chrome run used the public Apple test stream:
metadata loaded, the video clock advanced, and pause/seek/resume worked.
Audio output and SmartCast compatibility require the physical TV checks above.

PandaFlix's public README describes LookMovie as an IMDb-keyed provider using
its own API and a desktop `mpv`/VLC/IINA playback flow. It does not establish
authorized browser HLS access, CORS, stable media URLs, or SmartCast support.
No LookMovie resolver, credentials, or stream extraction are included here.
