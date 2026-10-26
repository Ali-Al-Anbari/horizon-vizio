# Horizon pointer ownership lab

This is a static, isolated experiment. It changes neither production Horizon nor
the Pico. Its event list holds at most 12 fixed diagnostic labels and relative
times in memory. It records no URLs entered by a user, text, cookies or keys
beyond a count of navigation events.

## What the three indicators mean

- **A Cursor visible**: Horizon painted its own cursor above the iframe.
- **B Parent remote keys**: Horizon's top-level document received an arrow,
  OK or Back event. The count may stop while a child frame owns focus.
- **C External activation**: A real third-party action must be observed on the
  TV. The page cannot infer one from A, B, iframe `load`, or a same-origin
  synthetic click. It never sends a synthetic click into a third-party frame.

The same-origin fixture is a positive control. Its button and link can be
activated using the same-origin child DOM, but this is a synthetic action and
does not establish trusted pointer input on an external website.

## Capability matrix before this TV test

| Capability | Current evidence |
| --- | --- |
| Parent receives remote arrows and OK while Horizon owns focus | Confirmed on Vizio in Browser Lab; this page is unverified on Vizio |
| Cursor paints and moves above an iframe while parent owns focus | Confirmed in local Mac Chrome; unverified on Vizio |
| External iframe receives native arrows after `focus()` | Unverified on Vizio; parent key ownership may be lost |
| External iframe responds to native OK | Unverified on Vizio |
| Parent injects genuine coordinate pointer clicks into external iframe | Unsupported by documented ordinary web APIs |
| External text field accepts remote text | Unverified on Vizio |
| Back restores parent after native iframe focus | Unverified on Vizio |
| Direct top-level Google navigation keeps Horizon's controls | Confirmed false on Vizio by the earlier physical test |

The first two Mac rows validate this implementation only in desktop Chrome.
They do not establish Conjure behavior.

## Preview and recovery

Review the files and manually deploy only the existing static preview Worker:

```sh
npx wrangler deploy --config wrangler.browser-preview.jsonc
```

Open the resulting URL at `/browser-pointer-lab.html` in a Mac browser first.
Before a separate approved TV navigation, prepare the existing authenticated
Conjure launcher with the actual preview URL. Do not put credentials in the URL:

```sh
python3 controller/horizon-controller.py launch --url 'https://horizon-browser-lab-preview.ali-al-anbari.workers.dev/browser-pointer-lab.html'
```

The `Back to Browser Lab` link remains in the parent toolbar. If native frame
focus traps the remote, use TV Home or the already verified iHeartRadio return
shortcut. An approved Conjure relaunch can then reopen this page. Do not rely
on the physical Back key after direct top-level navigation.

## Physical Vizio test, in order

Stop at the first failed gate and report what is visible. No private text or
account sign-in is needed.

1. Open the isolated pointer lab through an approved Conjure navigation. Verify
   that the same-origin child page, top toolbar and white cursor are visible.
2. Select **Overlay cursor**. Press Left, Right, Up and Down. Check that A says
   yes, B increases, and the cursor visibly moves above the child page. Press
   Back and verify that the toolbar regains focus. Repeat once.
3. Select **Overlay cursor** again. Position the cursor on the child button and
   press OK. Check for a visible count change inside the child. This is only a
   same-origin synthetic positive control.
4. Select **External links**. First verify that the page itself visibly renders.
   Select **Overlay cursor**. Move the cursor across a visible external link and
   press OK. Record A, B, C and whether the external page actually changes.
   The expected code path reports that no external click was sent. Press Back
   and verify parent toolbar recovery.
5. Select **Native frame focus** on the same external page. Try arrows, OK on
   a link, scrolling and Back. Record whether a link visibly opens, whether
   the parent B count stops, and whether Back returns. If it traps the remote,
   use the recovery method above. Do not interpret B stopping as proof that
   the external frame received no events.
6. If recovery works, select **External form**. Compare overlay mode with native
   frame focus for field focus and text input. Do not enter private data or
   submit the form. A Horizon keyboard remains usable for Horizon-owned fields
   in Browser Lab; it has no access to this foreign input field.
7. Last, select **Google framing check**. It is expected to refuse embedding.
   Treat any iframe load signal as indeterminate; inspect visible output.

For each website record rendering, arrows, OK/link result, field focus, text,
scrolling, Back and recovery separately. A genuine external click must produce
an externally visible action on the TV. This lab does not claim one in advance.

## Interpretation and next decision

The browser's same-origin policy prevents parent JavaScript from reading or
clicking the cross-origin frame's internal DOM. An overlay can remain visible
and keep parent key ownership, but ordinary web APIs provide no authenticated
browser-level coordinate injection into a foreign iframe. Native frame focus
may allow that page's own keyboard interactions; its behavior is a physical TV
question. Google and other sites may block framing entirely.

TV Labs SmartCast WebDriver sends remote keys through SmartCast and uses an
external ChromeDriver attached to a debugger port for page automation. CDP
`Input.dispatchMouseEvent`, `Input.insertText` and scroll gestures are debugger
commands, not hosted-page Web APIs. The Android TV Arrowz Browser controls its
own native WebView and uses a native overlay. Norigin's spatial navigation
controls app-owned focusable elements. None of these establishes an authorized
browser-input bridge for an ordinary hosted Conjure page.

If native iframe focus cannot activate an external link and form field on the
TV, the next useful step is to request from Vizio a documented Conjure API for
**application-owned overlay plus trusted pointer/key/text forwarding into the
active web surface**, including cross-origin frames, scroll and Back/history.
The request must clarify whether the API is available on retail VQD50R-1007
firmware to ordinary hosted applications. Do not probe private debug ports.

Sources:

- https://docs.tvlabs.ai/platform/integrations/appium/smartcast-webdriver
- https://docs.tvlabs.ai/platform/platforms/smartcast
- https://chromedevtools.github.io/devtools-protocol/tot/Input/
- https://github.com/NoMercyLabs/Arrowz-Browser
- https://github.com/NoriginMedia/Norigin-Spatial-Navigation
- https://github.com/exiva/Vizio_SmartCast_API
- https://github.com/socialvibe/truex-ctv-web-reference-app/blob/develop/platforms/Vizio/README.md
- https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy
