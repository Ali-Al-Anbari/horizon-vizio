# Horizon Browser Lab — physical Vizio test

This is a separate static page. It does not change the production Browser tile,
pairing, the Pico, or native-app launching. Host tests establish code behavior;
only the Vizio can establish Conjure rendering, remote focus, external iframe,
or video compatibility.

## Isolated preview

From the repository root, inspect `wrangler.browser-preview.jsonc`. It names
`horizon-browser-lab-preview`, serves `./frontend`, and has no Worker script,
secrets, API routes, or Durable Object binding. For a Mac-only local preview:

```sh
npx wrangler dev --local --config wrangler.browser-preview.jsonc
```

Open `http://localhost:8787/browser-lab.html` on the Mac. A public HTTPS TV
preview would require separate approval before running:

```sh
npx wrangler deploy --config wrangler.browser-preview.jsonc
```

Its expected page is `/browser-lab.html` on the new Worker’s `workers.dev`
origin. Check the actual URL printed by Wrangler before using it. Do not use
`wrangler.production-repair.jsonc` for this experiment.

## TV test sequence

Each numbered action is separate; stop at the first failed or unsafe step.

1. With the preview deployed and after approval to change the TV screen, use
   the established Conjure app-17 launcher to open the preview
   `/browser-lab.html` URL. Record whether the title, toolbar, local page, and
   highlighted **Back to Horizon** control render. Do not press an app tile.
2. Press Right across toolbar controls, Left back, Down into cursor mode, and
   Back to toolbar. Record lost or duplicate moves. Confirm Back to Horizon
   remains accessible. On the HTTPS preview, it opens the verified production
   Horizon URL; on localhost it returns to the local root.
3. Enter cursor mode. Move onto the local link and press OK once; check whether
   the lower section scrolls into view. Move onto the local button and press OK
   once; verify its count increases by exactly one.
4. Move onto the local text field and press OK. Type letters, a number,
   punctuation, Shift, Space, and Backspace using only remote arrows and OK.
   Press Enter, reopen, then Back. Check preview and field contents, and that
   focus remains usable.
5. Move onto the dropdown and press OK. It should cycle through local options;
   this intentionally does not open the TV's native select menu. Test Scroll
   Up/Down and cursor edge scrolling. Press OK on the video and record whether
   it visibly plays, errors, or stays black. Video is served by a public HTTPS
   source and may fail because of network, codec, or playback policy.
6. Only after the controlled page works, use the address keyboard to try
   `https://example.com/`, then `https://developer.mozilla.org/`, then
   `https://www.wikipedia.org/`, one at a time. For each, record visible
   rendering separately from the lab's iframe load status. A load event alone
   does not prove embedding succeeded.
7. On one visibly rendered external page, select **Focus frame**, then try
   arrows, OK, Back, scrolling, and a form field if present. Record exactly
   which remote event works. The Horizon cursor intentionally cannot click
   cross-origin elements. If the frame captures the remote and Back fails,
   use the TV's Home button or the already verified iHeartRadio return shortcut
   to escape, then relaunch the lab through Conjure if needed.
8. Direct top-level website navigation is a later, separately approved test.
   It may discard the Horizon toolbar and script context. Reopen the lab with
   the established Conjure launch mechanism afterward.

For each external site, record: rendered/blank/blocked; native remote focus,
link/button activation, text input, scroll, video, and whether Back returned.
Do not enter account credentials into this feasibility test.

## Mac Chrome baseline (not a Vizio result)

In local headless Chrome, the lab rendered at 1920×1080 and its simulated key
events opened the cursor, activated the local jump link, opened the keyboard,
typed a character, and closed the keyboard. At the smaller screenshot viewport,
`example.com` and `www.wikipedia.org` visibly rendered in the sandboxed iframe.
After focusing Wikipedia's frame, arrow keys visibly scrolled it. MDN showed a
blocked/error page; its final response advertised `X-Frame-Options: DENY`.
All three generated an iframe `load` event. These observations cannot establish
remote behavior, video playback, or website compatibility in Conjure.

## Expected platform boundaries

Same-origin controls are accessible to our script. The external frame is
sandboxed with scripts and forms, but has an opaque origin and cannot navigate
the top page. This may break sites that need their normal origin or cookies;
record it as a sandbox limitation, not proof that Conjure cannot load the site.
The frame's site can refuse embedding through CSP
`frame-ancestors` or `X-Frame-Options`; the parent cannot inspect its DOM
because of the same-origin policy. The iframe `load` event can also fire for a
blocked or error page. Browser restrictions and Conjure's remote dispatch must
be checked on the actual TV. The lab does not bypass DRM, CSP, CORS, or input
permissions.
