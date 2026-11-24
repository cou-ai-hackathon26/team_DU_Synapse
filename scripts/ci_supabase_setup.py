"""Seed disposable Supabase accounts used only by the GitHub test job."""

import json
import os
import secrets
import shlex
import subprocess
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
local = ROOT / ".local"
local.mkdir(mode=0o700, exist_ok=True)
env_text = subprocess.check_output(
    ["npx", "--yes", "supabase@3.2.0", "status", "-o", "env"],
    cwd=ROOT,
    stderr=subprocess.DEVNULL,
    text=True,
)
values = dict(pair.split("=", 1) for pair in shlex.split(env_text) if "=" in pair)
keys = {
    "SUPABASE_URL": values["API_URL"],
    "SUPABASE_ANON_KEY": values["ANON_KEY"],
    "SUPABASE_SERVICE_ROLE_KEY": values["SERVICE_ROLE_KEY"],
}
env = ROOT / ".env"
with open(env, "a+", opener=lambda path, flags: os.open(path, flags, 0o600)) as f:
    f.seek(0)
    current = f.read()
    for key, value in keys.items():
        if not any(
            line.startswith(key + "=") and line.split("=", 1)[1].strip()
            for line in current.splitlines()
        ):
            f.write("\n" + key + "=" + value + "\n")

credentials = local / "accounts.json"
accounts = json.loads(credentials.read_text()) if credentials.exists() else {}
for role in ("reviewer", "viewer", "factory_manager"):
    accounts.setdefault(
        role,
        {
            "email": role.replace("_", "-") + "@safetyproof.test",
            "password": secrets.token_urlsafe(20),
        },
    )
with open(
    credentials, "w", opener=lambda path, flags: os.open(path, flags, 0o600)
) as f:
    json.dump(accounts, f, indent=2)

headers = {
    "apikey": keys["SUPABASE_SERVICE_ROLE_KEY"],
    "Authorization": "Bearer " + keys["SUPABASE_SERVICE_ROLE_KEY"],
}
base = keys["SUPABASE_URL"]
factory_response = httpx.get(
    base + "/rest/v1/factories",
    headers=headers,
    params={"name": "eq.Shaluk Threadworks Ltd."},
)
factory_response.raise_for_status()
factory_id = factory_response.json()[0]["id"]

for role in ("reviewer", "viewer", "factory_manager"):
    account = accounts[role]
    existing = httpx.get(
        base + "/rest/v1/account_profiles",
        headers=headers,
        params={"email": "eq." + account["email"]},
    )
    existing.raise_for_status()
    if existing.json():
        uid = existing.json()[0]["id"]
    else:
        profile = {
            "role": role,
            "status": "active",
            "full_name": role.replace("_", " ").title(),
        }
        if role == "factory_manager":
            profile["factory_id"] = factory_id
        auth = httpx.post(
            base + "/auth/v1/admin/users",
            headers=headers,
            json={"email": account["email"], "email_confirm": True},
        )
        auth.raise_for_status()
        uid = auth.json()["id"]
        registered = httpx.post(
            base + "/rest/v1/rpc/sp_register_profile",
            headers=headers,
            json={"uid": uid, "p": profile, "secret": account["password"]},
        )
        registered.raise_for_status()
    if role == "reviewer":
        assigned = httpx.post(
            base + "/rest/v1/reviewer_factories",
            headers={**headers, "Prefer": "resolution=ignore-duplicates"},
            json={"reviewer_id": uid, "factory_id": factory_id},
        )
        assigned.raise_for_status()

print("Ephemeral Supabase test accounts are ready.")
