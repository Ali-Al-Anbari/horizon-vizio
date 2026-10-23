# Conjure first-party cookie and HTTPS probe

The isolated staging page is `https://horizon-access-probe-staging.ali-al-anbari.workers.dev/cookie`. The staging Worker provides only a cookie transport diagnostic at `/api/cookie/*`; it has no SmartCast token, controller credential, app-launch endpoint, or command queue. The cookie is a random **non-authorizing** marker with `__Host-`, `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`, and a one-day maximum age. The page receives only a boolean indicating whether the marker was sent; no cookie value appears in JavaScript, status text, or application logs. Its POST routes require the exact same-origin `Origin` and a fixed action header. The staging Access application still protects only `/api/auth/*`.

## Results on 2026-10-23

| Test | Result | Evidence |
| --- | --- | --- |
| Local Worker route | Passed | A loopback request changed the check response from `cookieSeen: false` to `true` when the test cookie was returned. |
| Mac browser creation | Passed | Owner saw “Test cookie present in same-origin HTTPS request” after creation. |
| Mac browser reload | Passed | Owner saw the same present message after reload. |
| Vizio Conjure creation | Passed | Owner reported that the cookie was created through the physical-remote controls. |
| Vizio Conjure reload | Passed | Owner reported that the cookie remained present after the page's reload action. |
| Leave Conjure for stock Vizio Home, then relaunch | Passed | After a separately approved Conjure app-17 relaunch, the owner reported “test cookie is present” on the page's automatic check. |
| Reported full TV restart, then Conjure relaunch | Passed by owner report | After the approved relaunch, the owner reported the cookie was “present.” The reboot method was not independently verified. |

The TV outcomes confirm that this Conjure webview can send a first-party cookie on a same-origin HTTPS `fetch` request and retain it across page reload and an ordinary exit/relaunch. The owner also reported it present after a restart sequence; the exact reboot method was not independently verified. These outcomes do **not** authenticate the TV or prove that a future pairing session is secure. The test cookie is deliberately useless for app launching. Cloudflare Access login in Conjure remains blocked by the remote-unfriendly Access login page.

The only SmartCast call in the TV setup was the existing, owner-approved Conjure namespace-4/app-17 navigation to the staging page. The diagnostic route itself never contacted the TV's SmartCast API. Production Horizon and the full cloud bridge were not deployed or modified.
