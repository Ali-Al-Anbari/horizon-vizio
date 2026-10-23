"""Copy to config.py on the Pico; keep that file private."""

WIFI_SSID = "YOUR_2_4_GHZ_SSID"
WIFI_PASSWORD = "YOUR_WPA2_PASSWORD"
TV_IP = "YOUR_TV_LAN_IP"
# The actual certificate name observed on the target TV, not its IP address.
TV_TLS_NAME = "YOUR_TV_CERTIFICATE_NAME"
HORIZON_URL = "https://YOUR_HOSTED_HORIZON_URL/"

# SHA-256 digest of the TV's *leaf* DER certificate, obtained on a trusted LAN.
TV_CERT_SHA256 = "YOUR_TV_CERTIFICATE_SHA256_HEX"
POLL_MS = 3000
SOCKET_TIMEOUT_S = 4
