# Python tools

Command-line helpers for Daikin *Smart AC - Brasil* units (iotalabs firmware). The full
protocol notes are in [`docs/PROTOCOL.md`](../docs/PROTOCOL.md).

| File | Purpose |
|------|---------|
| `extract_key.py`  | **One-time:** logs in the way the official app does and prints each unit's secret key. |
| `daikin_local.py` | LAN control: `--discover`, `status`, `get`, `set`. |
| `daikin`          | Wrapper that runs `daikin_local.py` with `tools/.venv`. |
| `daikin_proto.py` | AES-CFB + CRC16 codec and framing. |

## Setup

```sh
cd tools
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

## Get your unit's secret key (once)

Set the AC up in the official *Daikin Smart AC - Brasil* app first; that is what creates
the key. Then:

```sh
.venv/bin/python extract_key.py
```

It prompts for your app email and password and sends them only to AWS Cognito and
`dmb.iotalabs.co.in`, the same servers the app uses. The password is not stored. Copy the
`secret_key` it prints and keep it private.

## Local control

```sh
./daikin --discover                                    # find units via mDNS
./daikin --key <BASE64_KEY> --ip <AC_IP> status        # link/cloud/auth status
./daikin --key <BASE64_KEY> --ip <AC_IP> get           # full AC state
./daikin --key <BASE64_KEY> --ip <AC_IP> set '{"power":1,"temperature":25,"mode":3}'
```

Settable fields: `power` (0/1), `mode` (0 auto, 2 dry, 3 cool, 4 heat, 6 fan),
`temperature` (°C), `fan` (3 low … 7 high, 17 auto, 18 quiet), `v_swing` (0/1),
`coanda`, `econo`, `powerchill` (0/1).
