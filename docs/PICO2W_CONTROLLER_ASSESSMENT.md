# Pico 2 W controller feasibility and gates

The owner identified the new hardware as a **Raspberry Pi Pico 2 W** and later reported that it runs MicroPython v1.29.0 and has connected to home Wi-Fi and Cloudflare over HTTPS. This session has not independently measured free heap, reconnect behavior, certificate verification, or physical credential storage. Nothing was flashed or copied to it during the cloud-launch phase.

## Hardware and runtime

Pico 2 W is an RP2350 microcontroller, not a Linux Raspberry Pi. Raspberry Pi specifies **520 KB SRAM**, **4 MB flash**, and **2.4 GHz 802.11n Wi-Fi**. The ordinary CPython Mac controller and systemd plan cannot run unchanged. MicroPython has an official Pico 2 W build; v1.29.0 is the current stable release as of 2026-10-23. See [Raspberry Pi's product specification](https://www.raspberrypi.com/products/raspberry-pi-pico-2/) and [MicroPython's board download](https://micropython.org/download/RPI_PICO2_W/).

`controller/pico2w/main.py` is only an untested power watcher. It does **not** poll Cloudflare, claim queue commands, verify native app states, or provide pairing. Its Wi-Fi loop bounds connection attempts, but actual reconnect behavior and free heap after TLS handshakes need board tests. Its flash writes are limited to observed power transitions, which is appropriate for flash endurance; the eventual cloud poller should write nothing during routine polling. The board needs a compatible 2.4 GHz home Wi-Fi network.

## TLS security gate

MicroPython v1.29.0 documents that, on mbedTLS ports, `CERT_NONE` **and `CERT_OPTIONAL` do not perform certificate validation**; `CERT_REQUIRED` does. It also requires a plausible clock and `server_hostname` for normal certificate verification. `SSLContext.load_verify_locations(cadata=...)` can supply a CA certificate. See the [MicroPython v1.29.0 TLS documentation](https://docs.micropython.org/en/v1.29.0/library/ssl.html).

For Cloudflare HTTPS, require CA validation with `CERT_REQUIRED`, SNI/hostname matching, a plausible clock, and tests that reject a wrong CA, hostname, and expired certificate. A successful HTTP status without those tests is insufficient. Certificate-chain size and TLS heap use must be measured on the actual Pico 2 W.

The TV's SmartCast service at port 7345 previously presented a Vizio-issued leaf without a SAN and without the issuer in the served chain. Normal CA validation may therefore fail. The existing Pico draft uses `CERT_OPTIONAL` plus an undocumented `verify_callback` and post-handshake leaf-hash check. That callback has **not** been verified on the board, so the draft must not receive the SmartCast token or be run as the controller. A supported, fail-closed trust-anchor or certificate-pinning method must be demonstrated on the hardware, including rejection of a mismatched certificate, before provisioning. The Mac controller currently calls `ssl._create_unverified_context()` for SmartCast; its networking code must not be copied to the Pico as a security baseline.

## Hardware validation before provisioning

1. With owner approval, connect the board read-only to identify its installed firmware and inspect `gc.mem_free()` and filesystem capacity. Do not flash or erase it yet.
2. With placeholder credentials and a test endpoint, confirm 2.4 GHz Wi-Fi join, disconnect/reconnect, DNS, and behavior after a power interruption. Measure free heap before and after repeated TLS handshakes.
3. Validate Cloudflare HTTPS as above using a public staging test endpoint. Reject wrong hostname/CA/time cases. Do not send the controller credential.
4. Validate the TV TLS identity with no SmartCast token. Reject a changed certificate before any HTTP `AUTH` header is sent. If this cannot be done with the stock MicroPython build, Pico deployment is blocked pending a separately reviewed runtime or hardware choice.
5. Only after those gates, implement the fixed five-app queue poller, mock-test it, and provision separate Cloudflare controller and SmartCast credentials with owner approval. Test offline recovery, no duplicate claims, result readback, watchdog recovery, and flash-write rate.

Stock MicroPython files on the Pico are accessible to someone with physical/USB access; Unix-style mode `0600` does not protect them. Physical tamper resistance would need a separately designed secure element or secured firmware/boot configuration. The Mac remains the verified controller until Pico security and reliability are established. Automatic Horizon startup and return behavior remain separate opt-in features.
