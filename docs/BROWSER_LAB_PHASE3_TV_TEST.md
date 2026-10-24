# Browser Lab Phase 3 — supervised Vizio test

These source changes are local. The production Horizon launcher and Pico are
unchanged. After reviewing the local changes, update only the isolated preview:

```sh
npx wrangler deploy --config wrangler.browser-preview.jsonc
```

The preview URL ends in `/browser-lab.html`. Request separate approval before
using the established Conjure launch mechanism to replace the TV's screen.

## Gate 1: complete remote path

Perform each step in order. Stop and report the first failure before testing
external sites.

1. Open the preview Browser Lab in Conjure. Confirm **Toolbar mode** appears.
2. Press Down once. Confirm **Cursor mode**, the pointer, and **↑ Toolbar · Search** appear.
3. Move the pointer a few single presses. Confirm each press moves a small,
   predictable distance. Hold a direction and compare its repeat movement.
4. Press the TV Back button once. Confirm **Toolbar mode** and visible focus on
   **Edit**. It must not navigate to Horizon. If Back is not delivered, move
   the cursor onto **↑ Toolbar · Search** and press OK; report which route worked.
5. Press OK on **Edit**. Confirm the TV keyboard opens. Enter a short query such
   as `movies`, then choose the keyboard's **Enter** key.
6. Confirm the keyboard closes, Browser Lab remains visible, the address shows
   `https://www.google.com/search?q=movies`, and focus returns to the address.
   A warning about Google iframe embedding is expected; do not interpret it as
   a Vizio rendering result until you inspect the viewport.
7. Press Down to reenter cursor mode, then Back to return to toolbar. Repeat
   twice. Confirm neither focus nor cursor position jumps unexpectedly.

## Gate 2: controlled page and dropdown

1. Select **Browser Home**, then **Use cursor** or press Down from toolbar.
2. Move onto the Dropdown control and press OK. Confirm all three choices are
   visibly presented.
3. Press Down, then Back. Confirm it closes and still says **Movies**.
4. Reopen it, choose **Live TV** with Up/Down and OK, and confirm the selection.
5. Return to toolbar. Test Browser Back, Forward, Refresh, and Home. Remote Back
   on the first history entry must stay in Browser Lab. Only **Back to Horizon**
   should exit it.

## Gate 3: external pages, only after Gate 1 works

Try these addresses one at a time in embedded mode:

1. `https://example.com`
2. `https://www.wikipedia.org`
3. `https://www.google.com/search?q=interstellar`

For each page, record visible content or blank/blocked result, whether frame
focus receives remote arrows, whether links and text fields respond, and whether
Back restores toolbar control. An iframe load event alone proves none of these.
The Horizon cursor cannot access cross-origin page elements. Do not enter
account credentials in this feasibility test.

**Direct test is separate.** First open its confirmation dialog and choose
Cancel. Only test **Open website directly** after separate approval and with the
existing authenticated Conjure relaunch path ready. Top-level navigation drops
the toolbar, cursor, keyboard, and controlled history. If the remote becomes
trapped in a frame or on a direct page, use the TV Home button or the verified
iHeartRadio return shortcut, then relaunch the lab through Conjure.
