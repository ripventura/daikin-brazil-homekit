/**
 * Daikin "Smart AC - Brasil" (iotalabs firmware) local protocol.
 *
 * TypeScript port of tools/daikin_proto.py (protocol reverse-engineered in github.com/crossworth/daikin).
 * Bodies on the wire are:
 *
 *     base64( IV[16] || AES-CFB(payload || "BZ") || CRC16[2, little-endian] )
 *
 * The AES key is the per-device secret key (base64 → 16/24/32 raw bytes). CRC16 uses
 * the firmware's own table with a final inversion, computed over IV||ciphertext and
 * checked before decrypting.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Standard CRC-16/CCITT lookup table (polynomial 0x1021), as used by the firmware.
const CRC = Array.from({ length: 256 }, (_, i) => {
  let c = i << 8;
  for (let b = 0; b < 8; b++) {
    c = c & 0x8000 ? (c << 1) ^ 0x1021 : c << 1;
  }
  return c & 0xffff;
});

// Responses for these paths carry a 1-byte length prefix after the IV.
const LENGTH_PREFIXED = new Set(['acstatus', 'get_scan', 'status', 'onboard']);
const TRAILER = Buffer.from('BZ');

export function crc16(data: Uint8Array): number {
  let res = 0xffff;
  for (const b of data) {
    const r = res & 0xffff;
    res = (r << 8) ^ CRC[((r >> 8) ^ b) & 0xff];
  }
  return ~res & 0xffff;
}

function cipherName(key: Buffer): string {
  // Node's aes-*-cfb is full-block (128-bit segment) CFB, matching Go's NewCFBEncrypter.
  return `aes-${key.length * 8}-cfb`;
}

/** Build an outgoing request body (raw bytes, before base64). */
export function encode(key: Buffer, plaintext: Buffer, iv: Buffer = randomBytes(16)): Buffer {
  const enc = createCipheriv(cipherName(key), key, iv);
  const ct = Buffer.concat([enc.update(Buffer.concat([plaintext, TRAILER])), enc.final()]);
  const body = Buffer.concat([iv, ct]);
  const c = crc16(body);
  return Buffer.concat([body, Buffer.from([c & 0xff, (c >> 8) & 0xff])]);
}

/** Verify CRC and decrypt a response body (raw bytes, after base64-decode). Strips the "BZ" trailer. */
export function decode(key: Buffer, data: Buffer, path = ''): Buffer {
  if (data.length < 18) {
    throw new Error('input too short');
  }
  const got = data[data.length - 2] | (data[data.length - 1] << 8);
  const want = crc16(data.subarray(0, data.length - 2));
  if (got !== want) {
    throw new Error(`CRC mismatch (got 0x${got.toString(16)}, want 0x${want.toString(16)})`);
  }
  const start = LENGTH_PREFIXED.has(path) ? 17 : 16;
  const iv = data.subarray(0, 16);
  const dec = createDecipheriv(cipherName(key), key, iv);
  let out = Buffer.concat([dec.update(data.subarray(start, data.length - 2)), dec.final()]);
  if (out.subarray(-2).equals(TRAILER)) {
    out = out.subarray(0, -2);
  }
  return out;
}

export function decodeKey(b64Key: string): Buffer {
  const k = Buffer.from(b64Key.trim(), 'base64');
  if (![16, 24, 32].includes(k.length)) {
    throw new Error(`secret key must decode to 16/24/32 bytes, got ${k.length}`);
  }
  return k;
}
