import { Socket } from 'node:net';
import { decode, decodeKey, encode } from './protocol.js';

export const PORT = 15914;

/** The `port1` object from /acstatus. Only the fields we use are typed. */
export interface AcState {
  power?: number;
  mode?: number;
  temperature?: number;
  fan?: number;
  v_swing?: number;
  sensors?: { room_temp?: number; out_temp?: number };
  fw_ver?: string;
  [k: string]: unknown;
}

/**
 * Tolerant HTTP/1.1 request: the adapter sends non-compliant responses (tab-indented
 * headers, "Connection: Closed"), so we speak it over a raw socket like daikin_local.py.
 */
export function httpRequest(ip: string, method: string, path: string, body = Buffer.alloc(0), timeoutMs = 10_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const sock = new Socket();
    const chunks: Buffer[] = [];
    let settled = false;

    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      sock.destroy();
      const data = Buffer.concat(chunks);
      const sep = data.indexOf('\r\n\r\n');
      if (sep < 0) {
        reject(new Error(`no HTTP body from ${ip}${path} (got ${data.length} bytes)`));
        return;
      }
      const statusLine = data.subarray(0, data.indexOf('\r\n')).toString();
      if (!/ 200( |$)/.test(statusLine)) {
        reject(new Error(`${method} ${path} -> ${statusLine.trim()}`));
        return;
      }
      resolve(Buffer.from(data.subarray(sep + 4).toString().trim()));
    };

    sock.setTimeout(timeoutMs, finish);
    sock.on('data', (c) => chunks.push(c));
    sock.on('end', finish);
    sock.on('close', finish);
    sock.on('error', (err) => {
      if (!settled) {
        settled = true;
        sock.destroy();
        reject(err);
      }
    });
    sock.connect(PORT, ip, () => {
      const head =
        `${method} ${path} HTTP/1.1\r\n` +
        `Host: ${ip}:${PORT}\r\n` +
        `Content-Length: ${body.length}\r\n` +
        'Connection: close\r\n\r\n';
      sock.write(Buffer.concat([Buffer.from(head), body]));
    });
  });
}

export class DaikinClient {
  private readonly key: Buffer;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(public readonly ip: string, b64Key: string) {
    this.key = decodeKey(b64Key);
  }

  /** Run requests one at a time; the ESP adapter does not cope well with concurrency. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async get(path: string): Promise<Record<string, unknown>> {
    const raw = Buffer.from((await httpRequest(this.ip, 'GET', `/${path}`)).toString(), 'base64');
    return JSON.parse(decode(this.key, raw, path).toString());
  }

  getStatus(): Promise<Record<string, unknown>> {
    return this.serial(() => this.get('status'));
  }

  getState(): Promise<AcState> {
    return this.serial(async () => (await this.get('acstatus')).port1 as AcState);
  }

  setState(desired: Partial<AcState>): Promise<AcState> {
    return this.serial(async () => {
      const payload = Buffer.from(JSON.stringify({ port1: desired }));
      const body = Buffer.from(encode(this.key, payload).toString('base64'));
      const res = await httpRequest(this.ip, 'POST', '/acstatus', body);
      const json = JSON.parse(decode(this.key, Buffer.from(res.toString(), 'base64'), 'acstatus').toString());
      return json.port1 as AcState;
    });
  }
}
