# Pico 2 W feasibility draft

This is an **unproven, fail-closed** MicroPython v1.29.0 port of the Horizon
power watcher. It has not been copied to a Pico or used to contact the TV.
The Mac controller remains the working implementation.

The TV at port 7345 presented one Vizio-issued certificate with no SAN. The
leaf is **not self-signed**. The TV did not send its issuer certificate, and
macOS did not accept the leaf alone as a trusted anchor. The draft therefore
pins the exact leaf SHA-256 digest through MicroPython's v1.29.0 mbedTLS
`SSLContext.verify_callback`. This attribute exists in the official source
but is not described in the public API documentation, so board testing is
required. The token is sent only if the callback observed a matching leaf.
Certificate rotation or replacement intentionally stops the launcher until
the pin is checked and updated over a trusted channel. Pinning authenticates
the exact certificate but does not enforce its expiry or revocation.

`config.example.py` and `secrets.example.py` show the required device-local
files. Copy them to `config.py` and `secrets.py` **on the board only**; keep
the paired token out of the frontend and Git. The Wi-Fi password and
`secrets.py` are readable by someone with physical/USB access to a stock
MicroPython board. File permissions do not provide meaningful isolation there.
For protection against physical access, a secure element or a custom secured
firmware design would be needed; this draft does not provide that.

`main.py` starts after power is applied. It stores only the last confirmed TV
power state in `state.json`, writes only on transitions, and launches after a
confirmed off-to-on edge. It consumes that edge before sending the launch,
so a reset or lost launch response at the exact launch moment can **miss** a
launch but will not automatically replay it. Network failures preserve the
last confirmed state.
Home and app changes do not create another power edge.

The HTTP parser intentionally accepts only small non-chunked JSON responses.
Actual TV responses, TLS chain validation, memory headroom, and behavior after
extended outages still need tests on physical Pico hardware. Do not install
this file as `main.py` until those checks pass with placeholder credentials
and a test server. This draft contains no pairing flow or local web server.
