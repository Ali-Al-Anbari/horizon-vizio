# Browser Lab Phase 2 — controlled TV checks

The changes are local until the isolated browser preview Worker is redeployed.
The production Horizon homepage, Pico, and app-launch backend are unchanged.

## Preview update

From the repository root, after approval to update the already isolated preview:

```sh
npx wrangler deploy --config wrangler.browser-preview.jsonc
```

Use the URL Wrangler prints and open `/browser-lab.html` on a Mac first. This
config has static frontend assets only; it has no controller secret, app-launch
route, or Durable Object binding. Do not use the production Wrangler config.

## TV sequence

Request separate approval before using the established Conjure app-17 launch
command to change the TV to the browser lab. Once the lab is visible:

1. Confirm **Back to Horizon**, Browser Back/Forward/Refresh/Home, address,
   Edit, Go, and Direct test controls are visible.
2. Select **Edit**. Type `google.com` with the TV keyboard, then choose its
   **Enter** key. Confirm the lab stays open and the address displays
   `https://google.com/`. Record what appears in the embedded viewport.
3. Select **Edit** again. Use the keyboard's **Clear** key, then enter a short plain-language
   query, such as `movies`. Choose the keyboard's **Enter** key. Confirm the
   lab stays open, the address is a Google `/search?q=` URL, and the Google
   embedding limitation message is visible.
4. With the address field selected, press the physical remote's OK once.
   Confirm it submits or refreshes the displayed address and does not return
   to Horizon. Use **Edit** whenever you want to change an existing address.
5. Press Browser **Back**, **Forward**, and **Refresh** one at a time. Check
   the address and controlled-history counter. Press **Browser Home** and then
   Browser **Back**. These controls cannot inspect links followed inside a
   third-party iframe.
6. On a non-Google page such as `example.com`, test cursor and **Focus frame**
   separately. Record visible rendering, arrow scrolling, OK activation,
   text input, and whether Back regains the toolbar.
7. Select **Direct test** for the current HTTPS page. Its confirmation dialog
   must open with **Cancel** selected. Press OK once to cancel and verify the
   lab remains visible. Do not choose **Open website directly** until a
   separate TV-screen-change test has been approved and a return path is
   prepared. Direct navigation removes the Horizon toolbar and script context.
8. Select **Back to Horizon** to confirm the explicit exit still works.

If a frame captures the remote, use the TV Home button or the verified
iHeartRadio return shortcut. A direct-navigation test may require relaunching
the lab through the existing authenticated Conjure mechanism. Do not enter
account credentials into the feasibility test.

## Interpretation

An iframe `load` event means only that the browser reported a navigation
event; it is not proof that the page rendered. Google Search's response header
observed during local testing was `X-Frame-Options: SAMEORIGIN`, so the lab
displays a limitation message instead of presenting a blank frame as success.
Mac Chrome results do not establish Vizio Conjure behavior. Report visible TV
content and remote behavior separately for each step.
