"""Short-lived upload receipts bind a storage object to its manager and task."""

import base64
import hashlib
import hmac
import json
import time


def issue(secret: str, payload: dict) -> str:
    body = base64.urlsafe_b64encode(
        json.dumps(
            {**payload, "expires": int(time.time()) + 3600}, separators=(",", ":")
        ).encode()
    ).decode()
    signature = hmac.new(secret.encode(), body.encode(), hashlib.sha256).hexdigest()
    return body + "." + signature


def verify(secret: str, token: str) -> dict:
    try:
        body, signature = token.split(".")
        expected = hmac.new(secret.encode(), body.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected):
            raise ValueError("Invalid upload receipt")
        payload = json.loads(base64.urlsafe_b64decode(body))
        if payload["expires"] < time.time():
            raise ValueError("Upload receipt expired")
        return payload
    except (ValueError, KeyError, TypeError) as exc:
        raise ValueError(
            "Upload receipt is invalid or expired. Start the upload again."
        ) from exc
