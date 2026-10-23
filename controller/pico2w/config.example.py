"""Copy to config.py on the Pico; keep that file private."""

WIFI_SSID = "YOUR_2_4_GHZ_SSID"
WIFI_PASSWORD = "YOUR_WPA2_PASSWORD"
TV_IP = "YOUR_TV_LAN_IP"
# The actual certificate name observed on the target TV, not its IP address.
TV_TLS_NAME = "MT5581.prod.vizio.com"
HORIZON_URL = "https://horizon-vizio.ali-al-anbari.workers.dev/"

# SHA-256 digest of the TV's *leaf* DER certificate, independently confirmed.
TV_CERT_SHA256 = "YOUR_TV_CERTIFICATE_SHA256_HEX"
NTP_HOST = "pool.ntp.org"
POLL_MS = 3000
SOCKET_TIMEOUT_S = 4
# Supervised read-only diagnostics run by default. Change only after tests pass.
AUTO_LAUNCH_ON_POWER = False
