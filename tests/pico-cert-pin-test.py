"""Host-side tests of the C pin decision path in the MicroPython patch.

The SHA-256 primitive is mocked; a full RP2 build and physical TLS handshake
are separate release gates. No TV, credentials, or network are involved.
"""

from pathlib import Path
import re
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[1]
PATCH = ROOT / "controller/pico2w/firmware/micropython-v1.29.0-pico2w-cert-pin.patch"
lines = PATCH.read_text().splitlines()
added = "\n".join(line[1:] for line in lines if line.startswith("+") and not line.startswith("+++"))
match = re.search(
    r"static int ssl_sock_cert_pin_verify\(.*?\n}\n",
    added,
    flags=re.DOTALL,
)
assert match, "native pin callback missing from patch"
assert "mbedtls_ssl_set_verify(&o->ssl, ssl_sock_cert_pin_verify, o);" in added
assert "if (ssl_context->pin_enabled && !o->pin_seen)" in added
assert "self->authmode != MBEDTLS_SSL_VERIFY_REQUIRED" in added

source = r'''
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#define MBEDTLS_ERR_X509_FATAL_ERROR (-0x3000)
typedef struct { unsigned char *p; size_t len; } raw_t;
typedef struct { raw_t raw; } mbedtls_x509_crt;
typedef struct { unsigned char pin_sha256[32]; } mp_obj_ssl_context_t;
typedef struct { mp_obj_ssl_context_t *ssl_context; bool pin_seen; } mp_obj_ssl_socket_t;
static unsigned char trusted_digest[32];
static int mbedtls_sha256(const unsigned char *p, size_t len, unsigned char *out, int is224) {
    if (is224 != 0 || len == 0 || p[0] == '!') return -1;
    memcpy(out, trusted_digest, 32);
    if (p[0] == 'x') out[31] ^= 1;
    return 0;
}
'''
source += match.group(0)
source += r'''
#include <assert.h>
int main(void) {
    mp_obj_ssl_context_t ctx = {0};
    mp_obj_ssl_socket_t sock = {.ssl_context = &ctx, .pin_seen = false};
    unsigned char good[] = "trusted";
    unsigned char changed[] = "xchanged";
    unsigned char hash_error[] = "!error";
    for (int i = 0; i < 32; ++i) trusted_digest[i] = (unsigned char)i;
    memcpy(ctx.pin_sha256, trusted_digest, 32);
    mbedtls_x509_crt cert = {.raw = {good, sizeof(good)}};
    uint32_t flags = 0xffffffff;
    assert(ssl_sock_cert_pin_verify(&sock, &cert, 0, &flags) == 0);
    assert(sock.pin_seen && flags == 0);

    sock.pin_seen = false;
    cert.raw.p = changed;
    cert.raw.len = sizeof(changed);
    flags = 0xffffffff;
    assert(ssl_sock_cert_pin_verify(&sock, &cert, 0, &flags) == MBEDTLS_ERR_X509_FATAL_ERROR);
    assert(!sock.pin_seen);

    assert(ssl_sock_cert_pin_verify(&sock, NULL, 0, &flags) == MBEDTLS_ERR_X509_FATAL_ERROR);
    cert.raw.p = NULL;
    assert(ssl_sock_cert_pin_verify(&sock, &cert, 0, &flags) == MBEDTLS_ERR_X509_FATAL_ERROR);
    cert.raw.p = good;
    cert.raw.len = 0;
    assert(ssl_sock_cert_pin_verify(&sock, &cert, 0, &flags) == MBEDTLS_ERR_X509_FATAL_ERROR);

    cert.raw.p = hash_error;
    cert.raw.len = sizeof(hash_error);
    assert(ssl_sock_cert_pin_verify(&sock, &cert, 0, &flags) == MBEDTLS_ERR_X509_FATAL_ERROR);

    cert.raw.p = good;
    cert.raw.len = sizeof(good);
    ctx.pin_sha256[0] ^= 1;
    assert(ssl_sock_cert_pin_verify(&sock, &cert, 0, &flags) == MBEDTLS_ERR_X509_FATAL_ERROR);

    // A chain certificate cannot satisfy the mandatory depth-zero leaf check.
    ctx.pin_sha256[0] ^= 1;
    sock.pin_seen = false;
    flags = 0xffffffff;
    assert(ssl_sock_cert_pin_verify(&sock, &cert, 1, &flags) == 0);
    assert(!sock.pin_seen);
    return 0;
}
'''

with tempfile.TemporaryDirectory() as directory:
    c_file = Path(directory) / "pin_test.c"
    binary = Path(directory) / "pin_test"
    c_file.write_text(source)
    subprocess.run(["clang", "-std=c11", "-Wall", "-Wextra", "-Werror", str(c_file), "-o", str(binary)], check=True)
    subprocess.run([str(binary)], check=True)

print("pin callback host tests: matching, mismatched, missing, hash error, changed pin, and chain-only passed")
