#!/usr/bin/env python3
"""Extract the per-device local "secret key" for a Daikin "Smart AC - Brasil" unit.

You run this yourself after setting the AC up once in the official app. It prompts
for your Daikin app email + password (never passed on the command line), does the
AWS Cognito SRP login the app uses, then asks iotalabs' managething endpoint for
your registered devices and prints each device's thing_id, name and secret key.

It talks ONLY to AWS Cognito (us-east-1) and https://dmb.iotalabs.co.in — the same
servers the official app uses. Nothing is sent anywhere else. Your password is used
only for the SRP handshake and is not stored.

Run:  tools/.venv/bin/python tools/extract_key.py
"""
import getpass
import sys

import boto3
import requests
from botocore import UNSIGNED
from botocore.config import Config
from pycognito.aws_srp import AWSSRP

# Public constants embedded in the official app (also documented in crossworth/daikin).
REGION = "us-east-1"
POOL_ID = "us-east-1_s6T1EfUgP"
CLIENT_ID = "2ut21oh12e4gb6t5f8g87ls0t3"
CLIENT_SECRET = "dtof6slltmbet3gic9o1cgirur7ietd4mqtklt9r0ld5h902la2"
MANAGETHING = "https://dmb.iotalabs.co.in/devices/thinginfo/managething"
USER_AGENT = "okhttp/5.0.0-alpha.2"


def main() -> int:
    email = input("Daikin app email: ").strip()
    password = getpass.getpass("Daikin app password: ")
    if not email or not password:
        print("email and password are required", file=sys.stderr)
        return 2

    client = boto3.client(
        "cognito-idp", region_name=REGION, config=Config(signature_version=UNSIGNED)
    )
    srp = AWSSRP(
        username=email,
        password=password,
        pool_id=POOL_ID,
        client_id=CLIENT_ID,
        client_secret=CLIENT_SECRET,
        client=client,
    )
    try:
        tokens = srp.authenticate_user()
    except Exception as e:  # noqa: BLE001 - surface auth failures plainly
        print(f"Cognito login failed: {e}", file=sys.stderr)
        return 1

    auth = tokens["AuthenticationResult"]
    id_token = auth["IdToken"]
    access_token = auth["AccessToken"]

    # The username managething expects is Cognito's canonical username.
    user = client.get_user(AccessToken=access_token)
    username = user["Username"]

    body = (
        '{"request_type":"GET_THING_INFO","json_request":{},'
        f'"user_name":"{username}","access_token":"{access_token}"}}'
    )
    resp = requests.post(
        MANAGETHING,
        data=body,
        headers={
            "User-Agent": USER_AGENT,
            "Authorization": id_token,  # app sends the ID token here, not Bearer
            "Content-Type": "application/json; charset=utf-8",
        },
        timeout=30,
    )
    if resp.status_code != 200:
        print(f"managething HTTP {resp.status_code}: {resp.text[:500]}", file=sys.stderr)
        return 1

    data = resp.json()
    things = data.get("json_response", {}).get("things", [])
    if not things:
        print("No devices found on this account. Did you finish setup in the app?",
              file=sys.stderr)
        print("Raw response:", resp.text[:800], file=sys.stderr)
        return 1

    print(f"\nFound {len(things)} device(s):\n")
    for t in things:
        meta = t.get("thing_metadata", {})
        name = meta.get("thing_name", "?")
        key = (meta.get("thing_secret_key") or "").strip()
        print(f"  name:       {name}")
        print(f"  thing_id:   {t.get('thing_id', '?')}")
        print(f"  secret_key: {key}")
        print()
    print("Keep the secret_key private; it grants full local control of the unit.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
