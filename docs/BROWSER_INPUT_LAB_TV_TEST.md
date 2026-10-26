# Horizon Browser input lab — isolated feasibility test

Production Horizon and the Pico are unchanged. This lab is a separate static
page under the existing browser preview Worker. It logs only fixed navigation
key names, focus categories, action categories, and bounded relative times in
memory. It does not log typed text, URLs entered by a user, cookies, or tokens.

## Preview and recovery preparation

After reviewing local changes, deploy only the isolated static preview:

```sh
npx wrangler deploy --config wrangler.browser-preview.jsonc
```

Open the Wrangler URL with `/browser-input-lab.html` on a Mac first. The
controller's existing authenticated Conjure launcher is the recovery route if
the TV loses control. Prepare that command with the actual preview URL, but do
not run it until a separate TV-screen-change approval is given:

```sh
python3 controller/horizon-controller.py launch --url 'https://horizon-browser-lab-preview.ali-al-anbari.workers.dev/browser-input-lab.html'
```

The command uses the controller's existing private paired-token file. It does
not print the token. If the browser is on an external page and Back fails, use
TV Home or the verified iHeartRadio shortcut, then run the approved relaunch.

## Physical TV sequence

Stop at the first failed gate and report what is visible. Never enter account
credentials or private text into an external site during this experiment.

1. Open `/browser-input-lab.html` through the approved Conjure launch. Confirm
   the parent toolbar and a same-origin child page are both visible.
2. From **Focus toolbar**, press Left/Right and OK. Confirm parent key count
   increases and toolbar focus moves. The event list shows navigation keys only.
3. Select **Focus page**. Press Left, Right, Up, Down, and OK. Check whether
   **Child keys** increases and the child button count changes. Follow its
   local link, focus its input, and check visible focus. Do not type private text.
4. Press Back. The cooperating child should request parent toolbar focus.
   Confirm the parent toolbar is usable again. This is a same-origin capability
   check, not evidence about an external site.
5. Select **Local keyboard**. Confirm its overlay remains above the page and
   accepts a few test letters. Press Back. The keyboard should close and clear
   its test text. This proves only that the parent retains its own controls.
6. Select **example.com**. Inspect actual rendering, try scrolling, and test
   Back after **Focus page**. Then select **External links**, which points to
   `https://httpbin.org/links/5/0`. Try arrows, OK on a visible link, and Back.
   Record whether toolbar focus returns. Parent key count may stop while a
   frame owns focus; the lab cannot measure keys inside a foreign document.
7. Return or recover, then select **External form**. This currently points to
   `https://httpbin.org/forms/post`, whose HEAD response lacked frame-blocking
   headers during preparation. Actual GET, TV rendering, and input behavior
   are unverified. Try focusing a field, remote text input if offered, link
   activation, scrolling, and Back. Do not submit personal data.
8. Return or recover, then select **Google Search**. It advertised
   `X-Frame-Options: SAMEORIGIN` during preparation and is expected to refuse
   cross-origin framing. Record the visible result; an iframe load event is
   not success.

For every frame, record: visible rendering, focused control, arrow effect, OK
effect, text-field behavior, scrolling, Back behavior, and recovery needed.
Do not treat a silent parent event counter as proof that the TV did not deliver
events to the child frame.

## Interpretation

The local child cooperates through same-origin DOM access and checked
`postMessage`. External sites do not. The parent cannot inspect their DOM or
inject trusted input across origins. The external frame is sandboxed with
scripts and forms allowed; this may limit sites further. Direct top-level
Google navigation has already been physically observed to drop Horizon's
cursor, keyboard, and toolbar and to ignore the tested remote controls.

No publicly accessible official Conjure documentation reviewed so far
establishes a native multi-webview overlay, cross-origin input forwarding, or
application-level browser history API. Vizio's developer portal requires sign
in, so that absence is not proof such a partner API does not exist. The TV
experiment decides whether standard embedded pages are usable on this model.
