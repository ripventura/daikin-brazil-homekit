import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createCipheriv } from 'node:crypto';
import { crc16, decode, decodeKey, encode } from '../src/protocol.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools');
const PY = join(ROOT, '.venv', 'bin', 'python');
const KEY_B64 = Buffer.alloc(16, 7).toString('base64');
const KEY = decodeKey(KEY_B64);

function py(code: string, ...args: string[]): string {
  return execFileSync(PY, ['-c', code, ...args], { cwd: ROOT }).toString().trim();
}
const havePy = existsSync(PY);

test('encode/decode round-trip for 128/192/256-bit keys', () => {
  for (const len of [16, 24, 32]) {
    const key = Buffer.alloc(len, 3);
    const msg = Buffer.from('{"port1":{"power":1}}');
    assert.deepEqual(decode(key, encode(key, msg)), msg);
  }
});

test('crc16 is CRC-16/CCITT-FALSE with a final inversion', () => {
  // CCITT-FALSE("123456789") = 0x29B1; the firmware inverts it.
  assert.equal(crc16(Buffer.from('123456789')), ~0x29b1 & 0xffff);
});

test('decode rejects a bad CRC', () => {
  const body = encode(KEY, Buffer.from('{}'));
  body[20] ^= 0xff;
  assert.throws(() => decode(KEY, body), /CRC mismatch/);
});

test('decode handles the 1-byte length prefix on acstatus responses', () => {
  const iv = Buffer.alloc(16, 9);
  const msg = Buffer.from('{"port1":{"power":0}}');
  const c = createCipheriv('aes-128-cfb', KEY, iv);
  const ct = Buffer.concat([c.update(Buffer.concat([msg, Buffer.from('BZ')])), c.final()]);
  const body = Buffer.concat([iv, Buffer.from([ct.length]), ct]);
  const crc = crc16(body);
  const framed = Buffer.concat([body, Buffer.from([crc & 0xff, crc >> 8])]);
  assert.deepEqual(decode(KEY, framed, 'acstatus'), msg);
});

test('decodeKey rejects wrong key lengths', () => {
  assert.throws(() => decodeKey(Buffer.alloc(10).toString('base64')), /16\/24\/32/);
});

test('crc16 matches daikin_proto.py', { skip: !havePy && 'no tools/.venv' }, () => {
  for (const hex of ['', '00', '48656c6c6f', 'ff'.repeat(40), '0102030405060708090a0b0c0d0e0f10']) {
    const want = Number(py('import sys,daikin_proto as p;print(p.crc16(bytes.fromhex(sys.argv[1])))', hex));
    assert.equal(crc16(Buffer.from(hex, 'hex')), want, `crc16(${hex})`);
  }
});

test('Python-encoded body decodes in TS', { skip: !havePy && 'no tools/.venv' }, () => {
  const b64 = py(
    'import sys,base64,daikin_proto as p;' +
      'print(base64.b64encode(p.encode(p.decode_key(sys.argv[1]), b\'{"from":"python"}\')).decode())',
    KEY_B64,
  );
  assert.equal(decode(KEY, Buffer.from(b64, 'base64')).toString(), '{"from":"python"}');
});

test('TS-encoded body decodes in Python', { skip: !havePy && 'no tools/.venv' }, () => {
  const b64 = encode(KEY, Buffer.from('{"from":"ts"}')).toString('base64');
  const out = py(
    'import sys,base64,daikin_proto as p;' +
      'print(p.decode(p.decode_key(sys.argv[1]), base64.b64decode(sys.argv[2])).decode())',
    KEY_B64,
    b64,
  );
  assert.equal(out, '{"from":"ts"}BZ');
});
