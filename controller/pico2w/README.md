# Pico 2 W controller

The Pico 2 W now runs custom MicroPython v1.29.0 firmware with native Vizio
certificate pinning. Physical tests accepted the correct Vizio pin, rejected a
wrong pin, accepted a trusted public HTTPS certificate, rejected an untrusted
one, and passed 10 alternating Vizio pin handshakes. Heap stayed near 438 KB.
The final verification-downgrade handshake check is still pending.

The firmware method is on the native context:
`ctx._context.set_pin_sha256(bytes.fromhex(PIN_HEX))`. The standard
`ssl.SSLContext` wrapper does not expose this method. The controller checks
that the method exists and keeps `CERT_REQUIRED`; it stops if the interface is
missing. Its SmartCast requests are sent only after the synchronous pinned TLS
handshake succeeds.

## Supervised mode

`config.example.py` sets `AUTO_LAUNCH_ON_POWER = False`. In this default mode,
running `main.py` checks Wi-Fi, synchronizes NTP, verifies a pinned TLS
handshake, and, when a private SmartCast token is configured, reads TV power
and `/app/current`. It makes no launch request and exits. It prints no token,
Wi-Fi password, or pin.

The unattended watcher can be enabled only by setting the literal boolean
`AUTO_LAUNCH_ON_POWER = True` in the Pico's device-local `config.py`. It uses
the first successful power reading as a baseline and launches only after a
confirmed off-to-on edge. Home and native app changes do not alter TV power
state, so they cannot trigger another launch. Before each retry it checks
`/app/current`; a launch is considered complete only when app ID 17 is
observed. It never retries on an unknown power reading. Wi-Fi and NTP use
bounded retries with increasing delays. A TLS pin mismatch fails before HTTP
or the SmartCast token is sent. The power edge is saved before launching; a
reset in that interval can miss a launch, but will not replay it at boot.

`config.example.py` and `secrets.example.py` are templates, not credential
stores. The actual `config.py` and `secrets.py` must remain on the device and
are ignored by Git. Physical access to a Pico can expose its filesystem; this
controller does not provide protection against possession of the board.

## Transfer files from Mac to Windows with Thonny

On the Mac, copy these files from
`/Users/alialanbari/vizio-home-prototype/controller/pico2w/` to a private USB
drive: `main.py`, `config.example.py`, and `secrets.example.py`. They contain
no real credentials. On Windows:

1. Install and open Thonny. Connect the Pico by USB; do not hold BOOTSEL.
2. In **Tools → Options → Interpreter**, select **MicroPython (Raspberry Pi
   Pico)** and the Pico's serial port. Confirm the REPL reports MicroPython
   v1.29.0. Do not select an installer or firmware update action.
3. Open `main.py` from the USB drive. In Thonny's Files pane, use the device
   pane and **Save as** to copy it to the Pico as `/main.py`.
4. Copy `config.example.py` to the Pico as `/config.py` and
   `secrets.example.py` as `/secrets.py`. Do not enter or copy real credentials
   during this installation step. Leave `AUTO_LAUNCH_ON_POWER = False`.
5. With template placeholders still present, pressing **F5 (Run current
   script)** should stop with a clear missing-config message and make no
   network request. After you separately enter credentials directly into the
   device files, the same supervised run checks Wi-Fi, NTP, pinned Vizio TLS,
   and read-only SmartCast state. It never changes the TV's current app.
6. Press **Stop/Restart backend** to return to the REPL. Leave automatic
   launching disabled until the supervised checks, including the pending
   downgrade test, are complete and separately approved.

Do not enable automatic launch as part of initial installation. No native app
launch, production deployment, or firmware rebuild is needed for supervised
mode.
