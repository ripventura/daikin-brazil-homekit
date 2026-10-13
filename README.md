# homebridge-daikin-brazil-homekit

[![npm](https://img.shields.io/npm/v/homebridge-daikin-brazil-homekit)](https://www.npmjs.com/package/homebridge-daikin-brazil-homekit)
[![license](https://img.shields.io/github/license/ripventura/daikin-brazil-homekit)](LICENSE)

Control Daikin air conditioners sold in Brazil with the **Daikin Smart AC - Brasil** app
from Apple **HomeKit**, through [Homebridge](https://homebridge.io), **locally and
without the cloud**.

These units ship with a Wi-Fi adapter running iotalabs firmware, which officially only
works through Daikin's cloud app. The adapter also has an encrypted HTTP API on your
LAN (TCP 15914). This plugin talks to it directly, so the AC keeps working in HomeKit
even if you block its internet access.

- Tested with the **FTHP09** (EcoSwing). Other units that use the same app and adapter
  should work; please open an issue with your model either way.
- This is **not** for Daikin's international BRP/"DSIOT" adapters. For those, see
  [homebridge-daikin-local](https://github.com/cbrandlehner/homebridge-daikin-local).

## What you get in HomeKit

| HomeKit | AC |
|---------|----|
| Heater/Cooler: on/off | power |
| Heater/Cooler: Auto / Heat / Cool | mode |
| Heater/Cooler: target temperature | setpoint, 16–30 °C in 0.5° steps (configurable) |
| Heater/Cooler: current temperature | room sensor |
| Heater/Cooler: fan speed slider | low → high in 5 steps |
| Heater/Cooler: oscillate | vertical swing |
| Temperature sensor "… Outdoor" | outdoor unit sensor (shows *not active* while there is no reading) |

HomeKit's Heater/Cooler has no slot for dry mode, fan-only mode, or auto/quiet fan. If
the AC is in one of those (set from the remote, say), HomeKit shows *Auto* and the lowest
fan step. Changing mode or speed from HomeKit replaces them.

## Requirements

- Homebridge 1.8+ or 2.x, Node.js 20+.
- The AC on the same network as Homebridge, ideally with a **fixed IP** (a DHCP
  reservation on your router).
- The unit's **secret key**, which you get once (see below).

## 1. Get the secret key (one time)

The local API is encrypted with a per-unit key that Daikin's cloud issues when you first
set the AC up. You can't read it from the device, so you fetch it once from the cloud:

1. Install the **Daikin Smart AC - Brasil** app, create an account, and add the AC. This
   connects the AC to your Wi-Fi and creates its key.
2. Run the key extractor from this repo (Python 3):
   ```sh
   git clone https://github.com/ripventura/daikin-brazil-homekit.git
   cd daikin-brazil-homekit/tools
   python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
   .venv/bin/python extract_key.py
   ```
   It prompts for your app email and password and sends them only to AWS Cognito and
   `dmb.iotalabs.co.in`, the same servers the official app uses. It prints a
   `secret_key` (base64) for each unit.
3. Find the AC's IP in your router, or run `./daikin --discover` in the same folder.

**Treat the key like a password.** Anyone on your network who has it can control the AC.

## 2. Install the plugin

In the Homebridge UI, search for **`homebridge-daikin-brazil-homekit`** under *Plugins*
and install it. Or from a shell:

```sh
sudo hb-service add homebridge-daikin-brazil-homekit
```

## 3. Configure

Use the plugin's settings form in the Homebridge UI, or add this to `config.json`:

```json
{
  "platform": "DaikinLocal",
  "pollInterval": 30,
  "devices": [
    { "name": "Living Room AC", "ip": "192.168.1.50", "key": "<base64 secret key>" }
  ]
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `devices[].name` | `Daikin AC` | Name shown in HomeKit. |
| `devices[].ip` | — | The AC's IP address. **Required.** |
| `devices[].key` | — | The base64 secret key from step 1. **Required.** |
| `devices[].minTemp` / `maxTemp` | `16` / `30` | Setpoint range in °C. |
| `devices[].outdoorSensor` | `true` | Expose the outdoor temperature sensor. |
| `pollInterval` | `30` | Seconds between state refreshes (minimum 5). |

Running the plugin as a **child bridge** (in its Bridge Settings in the Homebridge UI)
is recommended, so a misbehaving AC can't affect your other accessories.

## Keeping the AC off the cloud (optional)

Once the plugin works, you can block the AC's internet access in your router, or put it
on a no-internet IoT VLAN, while keeping LAN access. HomeKit control keeps working. The
official app's remote control and any Alexa/Google integration stop working.

## Troubleshooting

- **`poll failed: connect ECONNREFUSED/ETIMEDOUT`**: Homebridge can't reach `<ip>:15914`.
  Check the IP and that both are on the same network/VLAN.
- **`CRC mismatch` or JSON errors**: usually a wrong or truncated key. Run
  `extract_key.py` again and paste the whole value.
- **Check outside Homebridge**: from a clone of this repo,
  `npm install && DAIKIN_KEY=<key> npm run cli -- <ip> get` prints the raw state.

## How it works

Every request and response body is `base64(IV ‖ AES-CFB(json ‖ "BZ") ‖ CRC16)`, sent as
slightly non-standard HTTP on port 15914. The plugin polls `GET /acstatus`, and merges the
separate changes HomeKit sends for one action into a single `POST /acstatus`. Full notes
are in [`docs/PROTOCOL.md`](docs/PROTOCOL.md).

## Development

```sh
npm install
npm test        # protocol tests, including a cross-check against tools/daikin_proto.py
npm run build
DAIKIN_KEY=<key> npm run cli -- <ip> get|status|set '<json>'
```

## Credits

The protocol was reverse-engineered by [crossworth/daikin](https://github.com/crossworth/daikin).
This project is an independent implementation. It is not affiliated with or endorsed by
Daikin or iotalabs.

## License

[MIT](LICENSE)
