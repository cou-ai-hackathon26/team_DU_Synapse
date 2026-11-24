import secrets
from urllib.parse import urlsplit
from uuid import uuid4

import httpx
import pytest
import pytest_asyncio

from safetyproof import main
from safetyproof.accounts import provision
from safetyproof.platform import Platform


@pytest_asyncio.fixture
async def case_admin():
    cfg = main.cfg
    if not cfg.supabase_service_role_key or urlsplit(cfg.supabase_url).hostname not in {
        "localhost",
        "127.0.0.1",
    }:
        pytest.skip("Configure the local Supabase stack first.")
    email = f"case-admin-{uuid4().hex[:12]}@safetyproof.test"
    password = secrets.token_urlsafe(24)
    async with httpx.AsyncClient() as client:
        db = Platform(cfg, client)
        uid = await provision(
            db,
            email,
            {
                "role": "admin",
                "status": "active",
                "full_name": "Case Test Administrator",
            },
            password,
        )
        try:
            session = await db.call(
                "POST",
                "/auth/v1/token",
                params={"grant_type": "password"},
                data={"email": email, "password": password},
            )
            yield uid, {"Authorization": "Bearer " + session["access_token"]}
        finally:
            await db.call("DELETE", f"/auth/v1/admin/users/{uid}", admin=True)
