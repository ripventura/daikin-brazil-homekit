# Daikin Smart AC (Brazil) — local protocol & tools

How a Daikin **FTHP09** air conditioner was brought under full **local, cloud-free**
control, what the protocol looks like, and how to use the small Python toolkit in
[`tools/`](../tools). The Homebridge plugin at the root of this repo is a TypeScript
port of the same protocol.

---

## 1. Overview

**Goal.** Control the AC over the local network without leaving it tied to Daikin's
cloud (the official *Daikin Smart AC - Brasil* app keeps the unit internet-connected).

**Outcome.** The unit's Wi-Fi adapter exposes an **encrypted HTTP API on TCP port
15914**. We reimplemented the wire format in Python and can now read state and send
commands entirely over the LAN. The only unavoidable cloud touch is a **one-time**
setup in the official app, which generates the per-device **secret key** (the AES key
for the local API). After that, no cloud is needed for control.

The unit runs the **iotalabs** firmware (app package `in.co.iotalabs.dmb.smartac`),
not Daikin's international "DSIOT"/BRP platform — a distinction that matters when
comparing against other Daikin integrations online.

---

## 2. Setup at a glance

Before setup, the adapter is its **own** open Wi-Fi access point (`DAIKINxxxxxx`,
`192.168.4.1`). **After** setup it joins your home Wi-Fi and becomes an ordinary LAN
device. To control it, the machine running the tools (or Homebridge) only needs to
reach it on the LAN.

---

## 3. How we got here

1. The adapter boots an **open setup AP** `DAIKINxxxxxx` and hands out DHCP from
   `192.168.4.1`. Its MAC (`94:3c:c6:…`) is an **Espressif** (ESP32-class) chip.
2. **Port 80 refused**, and a full TCP port scan of the adapter found *nothing* open
   — so it is not the classic Daikin BRP web adapter.
3. **mDNS gave it away.** The adapter advertises a service `_iota._tcp`, instance
   name **"Daikin Smart AC"**, with a TXT record `apn=DAIKIN:XXXXXXXXXXXX`.
4. The real control API is on **TCP 15914**, and every response body is
   **AES-encrypted**.
5. This matched an existing reverse-engineering project,
   [`crossworth/daikin`](https://github.com/crossworth/daikin), which lists the
   **FTHP09** as confirmed working. The AES key is a **per-device secret issued by the
   app/cloud at setup** — not readable from the device — so a one-time setup in the
   official iOS app was required to mint it.
6. With the key, local read **and** write were confirmed against the live unit.

> **Gotcha seen during probing:** while in setup-AP mode the adapter constantly
> deauthenticated clients (802.11 reason code 6) and sometimes stopped broadcasting
> altogether. That is only a factor during initial setup; once the unit is on your
> home Wi-Fi it is a stable normal client.

---

## 4. Protocol reference

### Discovery
- mDNS / DNS-SD service type **`_iota._tcp.local`**, instance **"Daikin Smart AC"**.
- TXT record carries **`apn=DAIKIN:<id>`** (the device/APN identifier).
- ⚠️ The SRV record advertises **port 80**, but that port is closed — **control is on
  15914**. Use the SRV only to find the host/IP, not the port.

### Transport
- Plain **HTTP/1.1 over TCP 15914**.
- The on-device server is **slightly non-compliant** (tab-indented headers,
  `Connection: Closed`). Standard clients like `curl` / `requests` reject it, so a
  tolerant / hand-rolled HTTP reader is required (see `daikin_local.py:http_request`).

### Message framing
Each HTTP body (request and response) is **base64** of:

```
IV[16] || AES-CFB( payload || "BZ" ) || CRC16[2, little-endian]
```

- **Key** = the per-device secret key, given as base64, decoded to raw bytes and used
  **directly** as the AES key. Its length selects AES-128/192/256 (16/24/32 bytes).
- **Cipher** = AES in **CFB** mode (full-block / 128-bit feedback, matching Go's
  `cipher.NewCFBEncrypter`).
- **`"BZ"`** is appended to the plaintext before encryption (and present after
  decryption); purpose unknown, but required.
- **CRC16** uses the firmware's own lookup table with a final bitwise inversion,
  computed over `IV || ciphertext`, stored **little-endian**, and **checked before
  decrypting**. This means you can validate framing without the key.
- **Length-prefixed responses:** for `status`, `get_scan`, `acstatus`, and `onboard`,
  there is a **1-byte length after the IV**, so the payload starts at **offset 17**
  (plain 16 otherwise).

### Endpoints
| Method | Path | Purpose |
|--------|------|---------|
| GET  | `/status`   | module/link/cloud/auth status |
| GET  | `/get_scan` | Wi-Fi scan results (setup) |
| GET  | `/acstatus` | full AC state |
| POST | `/acstatus` | set desired AC state |

### `/acstatus` state fields (`port1`)
| Field | Meaning |
|-------|---------|
| `power` | `0` off / `1` on |
| `mode` | `0` auto · `2` dry · `3` cool · `4` heat · `6` fan |
| `temperature` | setpoint °C (float, e.g. `25.0`) |
| `fan` | `3` low · `4` med-low · `5` med · `6` med-high · `7` high · `17` auto · `18` quiet |
| `v_swing` | `0`/`1` vertical swing |
| `coanda` | `0`/`1` comfort (Coandă) |
| `econo` | `0`/`1` economy |
| `powerchill` | `0`/`1` powerful |
| `good_sleep`, `streamer`, `out_quite`, `*_timer_*` | extra features / timers |
| `sensors.room_temp` | measured room temp °C |
| `sensors.out_temp` | outdoor temp °C (**`255` = no reading**, e.g. while off) |
| `fw_ver` | adapter firmware (e.g. `p1.0.3.33`) |

**Setting** uses the same fields; include only what you want to change. Example body
(before encryption): `{"port1":{"power":1,"temperature":25,"mode":3}}`.

### `/status` fields
| Field | Meaning |
|-------|---------|
| `ac` | `1` = adapter is communicating with the indoor unit |
| `sta` | `1` = adapter is connected to your Wi-Fi (station mode) |
| `cloud` | `1` = adapter currently holds a cloud (AWS IoT) connection |
| `auth` | `1` = a local lock PIN is set (sent as `Authorization: Basic <PIN>`) |

### Key extraction path (one-time, cloud)
1. **AWS Cognito SRP** login (region `us-east-1`, pool/client/secret embedded in the
   app) using your app email + password → `IdToken` + `AccessToken`.
2. **POST** to `https://dmb.iotalabs.co.in/devices/thinginfo/managething` with the
   tokens → returns your registered devices, each with `thing_id` and
   `thing_metadata.thing_secret_key`.

This path touches only **AWS Cognito** and **`dmb.iotalabs.co.in`** — the same
servers the official app uses.

---

## 5. The tools

All live in [`tools/`](../tools) and run against a self-contained virtualenv (`tools/.venv/`).

| File | What it is |
|------|------------|
| `daikin_proto.py` | The AES-CFB + CRC16 codec and framing. Validated against the reference test vector **and** against the real CRC of ciphertext captured from the unit. |
| `extract_key.py` | **One-time** key grabber: prompts for your app email/password, does the Cognito login, calls `managething`, prints each device's `thing_id` + `secret_key`. **You** run it; credentials are never passed on the command line or shared. |
| `daikin_local.py` | LAN control: `--discover`, `status`, `get`, `set`. |
| `daikin` | Wrapper that runs `daikin_local.py` with the project venv. |
| `requirements.txt` | `pycognito`, `requests`, `cryptography`. |

### First-time environment

```sh
cd tools
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

### One-time: get the secret key

Set the AC up once in the official app (this creates the key), then:

```sh
.venv/bin/python extract_key.py
# enter your Daikin app email + password when prompted
# copy the printed secret_key (base64) for your unit
```

### Daily use (fully local)

```sh
./daikin --discover                                  # find the AC's IP on your LAN
./daikin --key <KEY> --ip <AC_IP> status             # link / cloud / auth status
./daikin --key <KEY> --ip <AC_IP> get                # full AC state
./daikin --key <KEY> --ip <AC_IP> set '{"power":1,"temperature":25,"mode":3}'
```

`--discover` prints a line like:

```
Daikin Smart AC._iota._tcp.local  ip=192.168.1.50  port=80  apn=DAIKIN:XXXXXXXXXXXX  host=DAIKINxxxxxx.local
```

(The `port=80` there is the mDNS advertisement; control still uses 15914.)

### Interpreting the output

A real `get` from this unit (idle):

```json
{
  "port1": { "power": 0, "mode": 0, "temperature": 24.0, "fan": 18,
             "v_swing": 1, "sensors": { "room_temp": 24.0, "out_temp": 255.0 },
             "fw_ver": "p1.0.3.33" },
  "idu": 1
}
```

Read as: unit **off**, mode **auto**, setpoint **24 °C**, fan **quiet**, vertical
swing **on**, room **24 °C**, outdoor **255** = no reading (expected while off),
firmware `p1.0.3.33`. A matching `status` showed `ac:1, sta:1, cloud:1, auth:0` — i.e.
connected to the indoor unit and your Wi-Fi, still talking to the cloud, no lock PIN.

---

## 6. Keeping it off the cloud

`status.cloud:1` means the adapter is holding an outbound **AWS IoT (MQTT)**
connection. Local control does **not** need it, so to close that off while keeping LAN
control:

1. **Pin the IP** — give the adapter a **static DHCP reservation** (by its MAC) so it
   stays put.
2. **Deny WAN, allow LAN** — add a router firewall / parental-control rule blocking
   that MAC/IP from the internet while leaving LAN traffic open. On a VLAN-capable
   setup, a no-internet IoT VLAN achieves the same.

**Trade-off:** cutting the cloud **disables the official app's remote control** by
design (and any Alexa/Google integration). Everything local — these tools, the Homebridge plugin,
Home Assistant on your LAN, etc. — keeps working.

---

## 7. Security notes

- The **secret key grants full local control** of the unit. Treat it like a password:
  keep it out of git and out of shell history (prefer prompting or an env var over a
  literal `--key` in a saved script).
- `.venv/` is gitignored. **Do not commit the secret key or your Daikin
  credentials.**
- The local API currently has **no PIN** (`auth:0`); anyone on your LAN who learns the
  key can control the unit. Factor that into your network segmentation.

---

## 8. References

- [`crossworth/daikin`](https://github.com/crossworth/daikin) — the reverse-engineering
  this protocol work is based on (Go; iotalabs firmware; lists FTHP09).
- [`gpdl49/ha-daikin-india`](https://github.com/gpdl49/ha-daikin-india) — a **different**
  Daikin firmware family (DSIOT `/dsiot/multireq`); useful for contrast, not this unit.
- [ESP32-Faikin](https://github.com/bartjanisse/ESP32-Faikin) — open-source **hardware
  replacement** Wi-Fi module (wires to the indoor unit's S21 connector) for fully
  offline control if you ever want to drop the stock adapter entirely.
