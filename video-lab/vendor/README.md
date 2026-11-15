# Experimental HLS adapter

`hls.light.1.5.20.min.js` is the pinned hls.js 1.5.20 UMD light build from
`https://cdn.jsdelivr.net/npm/hls.js@1.5.20/dist/hls.light.min.js`.
Its license is in `HLS-LICENSE.txt` (Apache-2.0 and notices).

The library loads only when the existing Video Lab HLS sample is selected.
Version 1.5.20 played Apple's public Bip Bop stream in local Chrome with the
existing `<video>` element. Locally tested 1.6.15 and 1.7.4 light builds emitted
repeated media attachment / fragment parsing errors in the same test. None of
these desktop observations establish physical Vizio playback support.
