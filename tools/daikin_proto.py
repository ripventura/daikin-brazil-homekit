"""Daikin "Smart AC - Brasil" (iotalabs firmware) local protocol.

Independent reimplementation of the protocol reverse-engineered in
github.com/crossworth/daikin. Local HTTP API on port 15914, bodies are:

    base64( IV[16] || AES-128/192/256-CFB(payload || "BZ") || CRC16[2, little-endian] )

The AES key is the per-device "secret key" (base64 from the cloud, decoded to raw
16/24/32 bytes). CRC16 is CRC-16/CCITT (poly 0x1021, init 0xFFFF) with a
final inversion; it is computed over IV||ciphertext and checked before decrypting.
"""
from __future__ import annotations
import base64
import os
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms
try:  # CFB moved to the "decrepit" module in cryptography 49+
    from cryptography.hazmat.decrepit.ciphers.modes import CFB
except ImportError:  # older cryptography
    from cryptography.hazmat.primitives.ciphers.modes import CFB

# Standard CRC-16/CCITT lookup table (polynomial 0x1021), as used by the firmware.
def _crc_table() -> list[int]:
    table = []
    for i in range(256):
        c = i << 8
        for _ in range(8):
            c = ((c << 1) ^ 0x1021) if c & 0x8000 else (c << 1)
        table.append(c & 0xFFFF)
    return table


_CRC = _crc_table()


def crc16(data: bytes) -> int:
    res = 0xFFFF
    for b in data:
        r = res & 0xFFFF
        res = ((r << 8) ^ _CRC[((r >> 8) ^ (b & 0xFF)) & 0xFF])
    return (~res) & 0xFFFF


def _cfb(key: bytes, iv: bytes):
    # Go's cipher.NewCFBEncrypter/Decrypter is full-block (128-bit segment) CFB.
    return Cipher(algorithms.AES(key), CFB(iv))


def encode(secret_key: bytes, plaintext: bytes) -> bytes:
    """Build an outgoing request body (raw bytes, before base64)."""
    iv = os.urandom(16)
    data = plaintext + b"BZ"
    enc = _cfb(secret_key, iv).encryptor()
    ct = enc.update(data) + enc.finalize()
    out = iv + ct
    c = crc16(out)
    out += bytes([c & 0xFF, (c >> 8) & 0xFF])  # little-endian
    return out


def decode(secret_key: bytes, data: bytes, path: str = "") -> bytes:
    """Verify CRC and decrypt a response body (raw bytes, after base64-decode)."""
    if len(data) < 18:
        raise ValueError("input too short")
    start = 16
    if path in ("acstatus", "get_scan", "status", "onboard"):
        start = 17  # these responses carry a 1-byte length prefix after the IV
    iv = data[:16]
    payload = data[start:len(data) - 2]
    crc_bytes = data[len(data) - 2:]
    got = (crc_bytes[1] << 8) | crc_bytes[0]
    want = crc16(data[:len(data) - 2])
    if got != want:
        raise ValueError(f"CRC mismatch (got {got:#06x}, want {want:#06x})")
    dec = _cfb(secret_key, iv).decryptor()
    return dec.update(payload) + dec.finalize()


def crc_ok(data: bytes) -> bool:
    """Check only the CRC framing (no key needed)."""
    if len(data) < 18:
        return False
    crc_bytes = data[-2:]
    got = (crc_bytes[1] << 8) | crc_bytes[0]
    return got == crc16(data[:-2])


def decode_key(b64_key: str) -> bytes:
    k = base64.b64decode(b64_key)
    if len(k) not in (16, 24, 32):
        raise ValueError(f"secret key must decode to 16/24/32 bytes, got {len(k)}")
    return k
