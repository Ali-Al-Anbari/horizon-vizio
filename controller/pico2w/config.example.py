"""Copy to config.py on the Pico; keep that file private."""

WIFI_SSID = "YOUR_2_4_GHZ_SSID"
WIFI_PASSWORD = "YOUR_WPA2_PASSWORD"
TV_IP = "YOUR_TV_LAN_IP"
# The actual certificate name observed on the target TV, not its IP address.
TV_TLS_NAME = "MT5581.prod.vizio.com"
HORIZON_URL = "https://horizon-vizio.ali-al-anbari.workers.dev/"
CLOUD_CA_FILE = "cloud-root-isrg-x1.pem"
CLOUD_SOCKET_TIMEOUT_S = 8
# Experimental CA-verified single-socket HTTP/1.1 reuse. Keep disabled until
# the Pico heap and stale-socket recovery are checked on the physical board.
CLOUD_KEEPALIVE = False
# Safe starting cadence. A supervised 1500 ms trial doubles idle claim traffic
# from 20 to 40 requests/minute; measure the actual Pico before keeping it.
CLOUD_POLL_MS = 3000
# Optional supervised optimization: reuse only a confirmed TV-on reading less
# than one second old. Keep False until measured on the actual TV.
CLOUD_REUSE_RECENT_POWER = False
# Bounds the native app-state verification loop; does not delay a successful
# launch. Allowed range in the controller: 10000–20000 ms.
CLOUD_CONFIRM_MS = 15000
# Opt-in stage, DNS, TCP, TLS, and GC timings. Keep off in normal operation.
# Leave off in normal operation; no polling interval changes are required.
PERF_TIMING = False
# Live claiming can consume and execute a queued TV command. Keep disabled
# until the connectivity probe and a supervised physical launch have passed.
CLOUD_LIVE_CLAIMING = False
# Isolated Video Lab outbound player bridge. Keep disabled until supervised
# preview pairing, authentication, TLS and physical command tests pass.
PLAYER_BRIDGE_ENABLED = False

# SHA-256 digest of the TV's *leaf* DER certificate, independently confirmed.
TV_CERT_SHA256 = "YOUR_TV_CERTIFICATE_SHA256_HEX"
NTP_HOST = "pool.ntp.org"
POLL_MS = 3000
SOCKET_TIMEOUT_S = 4
# Supervised read-only diagnostics run by default. Change only after tests pass.
AUTO_LAUNCH_ON_POWER = False
# Optional local iHeartRadio-button return shortcut. Enable only after a
# supervised test; reads /app/current every 2 seconds while TV is on.
# A supervised 1000 ms trial raises reads from 30 to 60 per minute.
IHEART_RETURNS_TO_HORIZON = False
IHEART_POLL_MS = 2000
# Once Horizon appears, defer a due cloud claim by at most this long to take
# the second confirmation sample first. Set 0 to restore cloud-first ordering.
IHEART_CONFIRM_PRIORITY_MS = 1000
# Safe app-state categories and relative timings only; no tokens or URLs.
IHEART_DIAGNOSTICS = False
