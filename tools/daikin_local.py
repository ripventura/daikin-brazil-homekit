#!/usr/bin/env python3
"""Local control for a Daikin "Smart AC - Brasil" (iotalabs firmware) unit.

Talks straight to the AC's on-device HTTP API (port 15914) over your LAN using the
per-device secret key from extract_key.py. No cloud, no app.

Examples:
  python daikin_local.py --discover
  python daikin_local.py --key <BASE64> --ip 192.168.1.50 get
  python daikin_local.py --key <BASE64> --ip 192.168.1.50 status
  python daikin_local.py --key <BASE64> --ip 192.168.1.50 set '{"power":1,"temperature":25,"mode":3}'

Settable fields (see docs/PROTOCOL.md): power(0/1), mode(0 auto,2 dry,3 cool,4 heat,6 fan),
temperature(float), fan(3 low..7 high, 17 auto, 18 quiet), v_swing(0/1),
coanda/comfort(0/1), econo(0/1), powerchill/powerful(0/1).
"""
from __future__ import annotations
import argparse
import base64
import json
import socket
import struct
import sys
import time

import daikin_proto as proto

PORT = 15914


# ---------------------------------------------------------------------------
# Tolerant HTTP/1.1 client: the adapter sends non-compliant responses (tab-
# indented headers, "Connection: Closed"), so we parse them by hand.
# ---------------------------------------------------------------------------
def http_request(ip: str, method: str, path: str, body: bytes = b"", timeout: float = 15.0) -> bytes:
    s = socket.socket()
    s.settimeout(timeout)
    s.connect((ip, PORT))
    req = (
        f"{method} {path} HTTP/1.1\r\n"
        f"Host: {ip}:{PORT}\r\n"
        f"Content-Length: {len(body)}\r\n"
        f"Connection: close\r\n\r\n"
    ).encode() + body
    s.sendall(req)
    data = b""
    try:
        while True:
            chunk = s.recv(4096)
            if not chunk:
                break
            data += chunk
    except socket.timeout:
        pass
    finally:
        s.close()
    if b"\r\n\r\n" not in data:
        raise IOError(f"no HTTP body from {ip}{path} (got {len(data)} bytes)")
    head, payload = data.split(b"\r\n\r\n", 1)
    status_line = head.split(b"\r\n", 1)[0].decode(errors="replace")
    if " 200 " not in status_line and not status_line.endswith(" 200 OK"):
        raise IOError(f"{method} {path} -> {status_line.strip()}")
    return payload.strip()


def api_get(ip: str, key: bytes, path: str, decode_path: str) -> dict:
    raw = base64.b64decode(http_request(ip, "GET", path))
    return json.loads(proto.decode(key, raw, decode_path))


def api_set(ip: str, key: bytes, desired: dict) -> dict:
    payload = json.dumps({"port1": desired}, separators=(",", ":")).encode()
    body = base64.b64encode(proto.encode(key, payload))
    raw = base64.b64decode(http_request(ip, "POST", "/acstatus", body))
    return json.loads(proto.decode(key, raw, "acstatus"))


# ---------------------------------------------------------------------------
# Minimal multicast mDNS discovery for _iota._tcp (the Daikin service type).
# ---------------------------------------------------------------------------
def _read_name(buf: bytes, off: int):
    labels = []
    jumped = False
    end = off
    while True:
        length = buf[off]
        if length & 0xC0 == 0xC0:  # compression pointer
            ptr = ((length & 0x3F) << 8) | buf[off + 1]
            if not jumped:
                end = off + 2
            off = ptr
            jumped = True
            continue
        if length == 0:
            off += 1
            if not jumped:
                end = off
            break
        labels.append(buf[off + 1:off + 1 + length].decode(errors="replace"))
        off += 1 + length
    return ".".join(labels), end


def discover(timeout: float = 4.0) -> list[dict]:
    service = b"\x05_iota\x04_tcp\x05local\x00"
    query = struct.pack(">HHHHHH", 0, 0, 1, 0, 0, 0) + service + struct.pack(">HH", 12, 1)
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
    s.settimeout(timeout)
    s.sendto(query, ("224.0.0.251", 5353))
    found: dict[str, dict] = {}
    srv_port: dict[str, int] = {}
    txt: dict[str, str] = {}
    a_rec: dict[str, str] = {}
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            pkt, _ = s.recvfrom(9000)
        except socket.timeout:
            break
        try:
            _parse_mdns(pkt, found, srv_port, txt, a_rec)
        except Exception:
            continue
    s.close()
    out = []
    for inst, host in found.items():
        apn = txt.get(inst, "")
        ip = a_rec.get(host, "")
        out.append({"instance": inst, "host": host, "ip": ip,
                    "port": srv_port.get(inst, PORT), "apn": apn})
    return out


def _parse_mdns(pkt, found, srv_port, txt, a_rec):
    qd, an, ns, ar = struct.unpack(">HHHH", pkt[4:12])
    off = 12
    for _ in range(qd):
        _, off = _read_name(pkt, off)
        off += 4
    for _ in range(an + ns + ar):
        name, off = _read_name(pkt, off)
        rtype, _rclass, _ttl, rdlen = struct.unpack(">HHIH", pkt[off:off + 10])
        off += 10
        rdata = pkt[off:off + rdlen]
        if rtype == 12 and name.startswith("_iota._tcp"):      # PTR -> instance
            inst, _ = _read_name(pkt, off)
            found[inst] = found.get(inst, "")
        elif rtype == 33:                                       # SRV
            _prio, _wt, port = struct.unpack(">HHH", rdata[:6])
            target, _ = _read_name(pkt, off + 6)
            found[name] = target
            srv_port[name] = port
        elif rtype == 16:                                       # TXT
            i = 0
            while i < len(rdata):
                l = rdata[i]
                chunk = rdata[i + 1:i + 1 + l].decode(errors="replace")
                if chunk.startswith("apn="):
                    txt[name] = chunk[4:]
                i += 1 + l
        elif rtype == 1 and rdlen == 4:                         # A
            a_rec[name] = ".".join(str(b) for b in rdata)
        off += rdlen


def main() -> int:
    ap = argparse.ArgumentParser(description="Local control for Daikin Smart AC (Brasil).")
    ap.add_argument("--discover", action="store_true", help="find units on the LAN via mDNS and exit")
    ap.add_argument("--key", help="base64 secret key from extract_key.py")
    ap.add_argument("--ip", help="AC IP address")
    ap.add_argument("cmd", nargs="?", choices=["get", "status", "set"], help="action")
    ap.add_argument("state", nargs="?", help="JSON for 'set'")
    args = ap.parse_args()

    if args.discover:
        devs = discover()
        if not devs:
            print("No Daikin units found on this network.")
            return 1
        for d in devs:
            print(f"{d['instance']}  ip={d['ip']}  port={d['port']}  apn={d['apn']}  host={d['host']}")
        return 0

    if not args.cmd:
        ap.error("give a command (get/status/set) or --discover")
    if not args.key or not args.ip:
        ap.error("--key and --ip are required for get/status/set")

    key = proto.decode_key(args.key)
    if args.cmd == "status":
        print(json.dumps(api_get(args.ip, key, "/status", "status"), indent=2))
    elif args.cmd == "get":
        print(json.dumps(api_get(args.ip, key, "/acstatus", "acstatus"), indent=2))
    elif args.cmd == "set":
        if not args.state:
            ap.error("set needs a JSON state argument")
        desired = json.loads(args.state)
        print(json.dumps(api_set(args.ip, key, desired), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
