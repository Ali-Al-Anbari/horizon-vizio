# Pico 2 W TLS certificate pin prototype

Status: the Pico 2 W is now running custom MicroPython v1.29.0 firmware with
this native pinning interface. The owner physically verified correct Vizio
pin acceptance, wrong-pin rejection, trusted and untrusted public HTTPS
behavior, and 10 alternating pin handshakes with about 438 KB free heap. The
verification-downgrade handshake test remains pending. The build attempt in
this workspace did not produce a UF2; do not use the output path described
below as an existing firmware image.

## Feasibility and trust boundary

The tested stock Pico firmware did not expose `getpeercert` or a usable Python
verification callback. The MicroPython v1.29.0 source does contain a generic
`SSLContext.verify_callback` attribute, but the tested physical build did not
make it available. `getpeercert` is compiled only when
`MBEDTLS_SSL_KEEP_PEER_CERTIFICATE` is enabled, which the RP2 configuration
does not enable. Loading this Vizio end-entity leaf as a CA failed on the
device. A genuine, independently obtained issuer CA might enable ordinary CA
verification, but that would not enforce this exact-certificate pin; it is not
available in the established setup.

The RP2 Pico 2 W firmware adds `ctx._context.set_pin_sha256(digest)`, where
`digest` is exactly 32 raw SHA-256 bytes read from device-local config. The
standard Python `ssl.SSLContext` wrapper does not expose this method.
It binds `mbedtls_ssl_set_verify` to each pinned TLS socket. The callback
hashes the *depth-zero leaf DER supplied in that socket's handshake*, compares
all 32 digest bytes without early exit, and aborts verification on a missing
or mismatching certificate. A second gate checks that depth zero was seen
before `wrap_socket()` can return. Pinned sockets require
`CERT_REQUIRED`, a hostname, and a blocking handshake. The application sends
its HTTP request and SmartCast `AUTH` header only after the native synchronous
`wrap_socket()` handshake returns. There is no certificate fetch on another connection and no trust in
the TV IP address alone.

For this **single pinned context**, the exact leaf is the trust anchor. The
callback clears CA-chain flags only after the depth-zero leaf matches; for
higher-depth certificates it clears flags pending the mandatory leaf check.
This authenticates possession of the key for that exact pinned certificate
through the TLS handshake, but deliberately does not add expiry or revocation
checking. It is not a general purpose CA replacement. Other SSL contexts use
MicroPython's original verification callback and `CERT_REQUIRED`, so the
Cloudflare CA path is unchanged. `CERT_NONE` and `CERT_OPTIONAL` are not used.

The fixed leaf fingerprint confirmed on Windows is:

`559309c19d655f6b4cf8b7e490421c2349e64aab2cae8efedde63dadd604886e`

It is a public certificate digest, not a credential. The firmware patch does
not contain it. Set it only in the device-local `config.py` after independent
confirmation. A changed certificate must fail until its new fingerprint is
confirmed out of band and deliberately installed. To rotate, stage a new
config value during a maintenance window, test the new certificate, and retain
the old value in a secure owner record for rollback. Never adopt a certificate
seen over an unverified connection automatically. An optional two-pin overlap
can be designed later if uninterrupted rotation becomes necessary; this
prototype intentionally supports one active pin.

## Build on Mac or Windows

Prerequisites: Git, Python 3, GNU Make, CMake, and a working `arm-none-eabi-gcc`
toolchain with newlib headers. On Windows, use WSL2 with these Linux tools; on
Mac, install the equivalent native tools. Verify `cmake --version` and
`arm-none-eabi-gcc --version` before starting. The previous Mac build attempt
stopped because its compiler lacked newlib headers; no size delta was measured.

From an **isolated build directory** outside the Horizon repository:

```sh
git clone --branch v1.29.0 --depth 1 https://github.com/micropython/micropython.git
cd micropython
git apply /absolute/path/to/vizio-home-prototype/controller/pico2w/firmware/micropython-v1.29.0-pico2w-cert-pin.patch
make -C mpy-cross
make -C ports/rp2 BOARD=RPI_PICO2_W submodules
make -C ports/rp2 BOARD=RPI_PICO2_W
```

Expected artifact:
`ports/rp2/build-RPI_PICO2_W/firmware.uf2`. Confirm the source tag is
`v1.29.0`, the board is `RPI_PICO2_W`, `git diff --check` is clean, and the
build reports no linker or flash overflow. Record UF2/ELF byte sizes and a
SHA-256 checksum before any installation. Compare with an unpatched v1.29.0
build from the same toolchain to measure actual firmware delta. The patch adds
33 bytes of fields plus possible alignment to each SSL context, one flag plus
possible alignment to each SSL socket, and uses the SHA-256 primitive already
enabled in RP2 mbedTLS; the exact code size and flash margin need a successful
build. Physical tests reported about 438 KB free heap.

For the host unit test (Mac with Clang):

```sh
python3 tests/pico-cert-pin-test.py
```

The test extracts the actual C callback from the patch and compiles it against
mock certificate/hash structures. It checks matching, mismatched, missing,
hash-error, changed-pin, and chain-only cases. It does not prove a real TLS
handshake or cryptographic SHA-256 implementation. Full firmware compilation,
TLS fixture testing, and Pico measurements are mandatory before provisioning.

## Physical validation plan — requires separate approval

1. Back up every Pico filesystem file, including private device-local config,
   to an offline private location. Record the currently installed stock UF2
   version and download the official Pico 2 W v1.29.0 UF2 for rollback.
2. For any future firmware replacement, inspect the custom UF2 first.
   Disconnect credentials/auto-start scripts during initial testing. With
   approval, use BOOTSEL to install the UF2; do **not** erase all flash.
   Confirm USB REPL, `sys.implementation`, free heap, free filesystem, and
   the native method on a fresh `SSLContext`'s `_context`.
3. Run a local TLS fixture with a known certificate and no SmartCast token.
   The matching pin must permit an HTTPS GET; a wrong pin, absent certificate,
   and replaced certificate must fail before the fixture records any HTTP
   bytes. Also verify that changing `verify_mode` to `CERT_NONE` after setting
   the pin fails before connection, and deferred handshakes are rejected.
4. Verify ordinary CA HTTPS still accepts a trusted Cloudflare certificate and
   rejects an untrusted public test certificate. Check NTP and Wi-Fi recovery.
5. After separate approval to provision the Pico, test a read-only
   `/app/current` SmartCast request with the independently confirmed Vizio pin.
   Prove that a wrong pin sends zero HTTP bytes using the local fixture first;
   do not send real credentials in a mismatch test. Measure peak heap/stack
   where possible and run repeated handshakes to check for leaks.

Do not install `main.py` for unattended operation until all gates pass. This
phase does not change the existing Mac controller or enable Pico automation.

## Rollback

Stop any test script. Hold BOOTSEL while connecting USB; the Pico 2 W appears
as an `RP2350` mass-storage device. Copy the official **Pico 2 W** v1.29.0
stock UF2 to that drive. It reboots to USB REPL. Restore the backed-up device
filesystem only after checking it; never copy private credentials into this
repository. If the filesystem is damaged, use the official recovery process
only after a separate, explicit erase approval. BOOTSEL is ROM-based and does
not depend on this TLS patch.

References: [MicroPython v1.29 SSL API](https://docs.micropython.org/en/v1.29.0/library/ssl.html),
[MicroPython RP2 build instructions](https://github.com/micropython/micropython/blob/v1.29.0/ports/rp2/README.md),
[Mbed TLS 3.6.6 per-connection verification callback](https://github.com/Mbed-TLS/mbedtls/blob/mbedtls-3.6.6/include/mbedtls/ssl.h),
[Mbed TLS X.509 callback semantics](https://github.com/Mbed-TLS/mbedtls/blob/mbedtls-3.6.6/include/mbedtls/x509_crt.h),
[Raspberry Pi BOOTSEL procedure](https://www.raspberrypi.com/documentation/microcontrollers/micropython.html).
