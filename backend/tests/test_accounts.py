"""Exercise real local GoTrue, PostgREST and private Storage with synthetic IDs."""

import io
import os
import secrets
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

import httpx
import pytest
from PIL import Image

from safetyproof import main
from safetyproof.accounts import CARD_BUCKET, provision
from safetyproof.config import ROOT
from safetyproof.platform import Platform


@pytest.mark.asyncio
async def test_account_onboarding(monkeypatch):
    if not main.cfg.supabase_anon_key or urlsplit(
        main.cfg.supabase_url
    ).hostname not in {"localhost", "127.0.0.1"}:
        pytest.skip("Configure the local Supabase stack first.")
    monkeypatch.setattr(
        main, "cfg", main.cfg.model_copy(update={"worker_enabled": False})
    )
    created = []
    cases = []
    suffix = uuid4().hex[:12]
    secret = secrets.token_urlsafe(24)
    async with (
        httpx.AsyncClient(timeout=40) as remote,
        main.lifespan(main.app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=main.app), base_url="http://test"
        ) as api,
    ):
        db = Platform(main.cfg, remote)

        async def call(method, path, status=200, **kwargs):
            response = await api.request(method, "/v1" + path, **kwargs)
            assert response.status_code == status, (
                path,
                response.status_code,
                response.text[:450],
            )
            return response

        def headers(session):
            return {"Authorization": "Bearer " + session["access_token"]}

        async def login(email, password=secret, status=200):
            return (
                await call(
                    "POST",
                    "/login",
                    status,
                    json={"email": email, "password": password},
                )
            ).json()

        async def profile(email):
            return (
                await db.rows("account_profiles", filters={"email": "eq." + email})
            )[0]

        def token(response):
            return parse_qs(urlsplit(response.json()["invite_url"]).fragment)["token"][
                0
            ]

        async def decide(uid, verb, **body):
            return await call(
                "POST", f"/admin/accounts/{uid}/{verb}", headers=admin, json=body
            )

        async def signup(email, factory):
            ticket = (await call("POST", "/signup/factory-manager/upload")).json()
            image = io.BytesIO()
            Image.new("RGB", (32, 20), "navy").save(image, "PNG")
            upload = await remote.put(
                ticket["upload_url"],
                content=image.getvalue(),
                headers={"Content-Type": "image/png"},
            )
            assert upload.is_success, upload.status_code
            body = application(email, factory, ticket["upload_key"])
            await call(
                "POST",
                "/signup/factory-manager",
                201,
                headers={"X-Upload-Receipt": ticket["receipt"]},
                json=body,
            )
            row = await profile(email)
            created.append(row["id"])
            return row

        def application(email, factory, key="0" * 32 + "/" + "1" * 32):
            return {
                "full_name": "Fictional Manager",
                "email": email,
                "phone": "+8801700000000",
                "factory_id": factory,
                "consent": True,
                "password": secret,
                "upload_key": key,
            }

        async def direct_login(email):
            return await remote.post(
                main.cfg.supabase_url + "/auth/v1/token",
                params={"grant_type": "password"},
                headers={"apikey": main.cfg.supabase_anon_key},
                json={"email": email, "password": secret},
            )

        try:
            admin_email = f"admin-{suffix}@safetyproof.test"
            # Run the documented seed twice against a fresh email.
            env = {
                **os.environ,
                "ADMIN_EMAIL": admin_email,
                "ADMIN_PASSWORD": secret,
                "PYTHONPATH": "backend",
            }
            import asyncio, sys

            for _ in range(2):
                proc = await asyncio.create_subprocess_exec(
                    sys.executable, "scripts/seed_accounts.py", env=env
                )
                assert await proc.wait() == 0
            admin_id = (await profile(admin_email))["id"]
            created.append(admin_id)
            admin = headers(await login(admin_email))
            factories = (await call("GET", "/factories")).json()
            assert len(factories) >= 8 and len(
                {item["name"] for item in factories}
            ) == len(factories)
            assert all(set(item) == {"id", "name"} for item in factories)
            first, second = [item["id"] for item in factories[:2]]
            await call("GET", "/admin/reviewers", 401)
            await call("GET", "/samples", 401)
            await call(
                "POST",
                "/signup/factory-manager",
                422,
                json=application(f"missing-{suffix}@safetyproof.test", str(uuid4())),
            )
            reviewer_email = f"reviewer-{suffix}@safetyproof.test"
            created_response = await call(
                "POST",
                "/admin/reviewers",
                201,
                headers=admin,
                json={
                    "email": reviewer_email,
                    "full_name": "Fictional Reviewer",
                    "organization": "Fictional Dhaka Auditors",
                    "role_type": "Independent Auditor",
                },
            )
            uid = created_response.json()["id"]
            created.append(uid)
            assert (await profile(reviewer_email))["status"] == "pending"
            assert (await profile(reviewer_email))[
                "organization"
            ] == "Fictional Dhaka Auditors"
            assert (
                await db.rows(
                    "reviewer_factories", filters={"reviewer_id": "eq." + uid}
                )
                == []
            )
            await call(
                "POST",
                f"/admin/reviewers/{uid}/factories",
                headers=admin,
                json={"factory_ids": [first, second]},
            )

            await login(reviewer_email, status=401)
            old_token = token(created_response)
            await db.call(
                "PATCH",
                "/rest/v1/reviewer_invites",
                admin=True,
                params={"reviewer_id": "eq." + uid},
                data={"expires_at": "2000-01-01T00:00:00Z"},
            )
            await call("POST", "/invites/validate", 400, json={"token": old_token})
            await call(
                "POST",
                "/invites/set-password",
                400,
                json={"token": old_token, "password": secret},
            )
            current_token = token(
                await call(
                    "POST", f"/admin/reviewers/{uid}/resend-invite", headers=admin
                )
            )
            validated_invite = await call(
                "POST", "/invites/validate", json={"token": current_token}
            )
            assert validated_invite.json() == {"valid": True, "email": reviewer_email}
            first_response, second_response = await asyncio.gather(
                *[
                    api.post(
                        "/v1/invites/set-password",
                        json={"token": current_token, "password": secret},
                    )
                    for _ in range(2)
                ]
            )
            assert sorted(
                [first_response.status_code, second_response.status_code]
            ) == [200, 400]
            reviewer = headers(await login(reviewer_email))
            own_profile = (await call("GET", "/me", headers=reviewer)).json()
            assert own_profile.pop("created_at")
            assert own_profile == {
                "id": uid,
                "email": reviewer_email,
                "full_name": "Fictional Reviewer",
                "organization": "Fictional Dhaka Auditors",
                "role_type": "Independent Auditor",
                "role": "reviewer",
                "status": "active",
                "factory_id": None,
                "phone": None,
                "job_title": None,
                "id_card_number": None,
                "membership_number": None,
                "consent_at": None,
            }
            await call("GET", "/admin/reviewers", 403, headers=reviewer)
            organizations = (await call("GET", "/reviewer-organizations")).json()
            assert all(
                entry["email_domain"].endswith(".test") for entry in organizations
            )
            organization = organizations[0]
            request_body = {
                "email": f"request_{suffix}@{organization['email_domain']}",
                "full_name": "Fictional Applicant",
                "organization": organization["name"],
            }
            invalid_domain = {**request_body, "email": f"request-{suffix}@other.test"}
            for path in ("/admin/reviewers", "/signup/reviewer"):
                mismatch = await call(
                    "POST", path, 422, headers=admin, json=invalid_domain
                )
                assert organization["email_domain"] in mismatch.json()["detail"]
            await call(
                "POST",
                "/signup/reviewer",
                422,
                json={
                    **request_body,
                    "email": request_body["email"].replace("_", "+", 1),
                },
            )
            await call("POST", "/signup/reviewer", 201, json=request_body)
            requested = await profile(request_body["email"])
            created.append(requested["id"])
            assert requested["status"] == "pending_approval"
            await call("POST", "/signup/reviewer", 409, json=request_body)
            await login(request_body["email"], status=401)
            approval_path = f"/admin/reviewer-requests/{requested['id']}/approve"
            await call("POST", approval_path, 403, headers=reviewer)
            approval = await call("POST", approval_path, headers=admin)
            await call("POST", approval_path, 409, headers=admin)
            setup = {"token": token(approval), "password": secret}
            identity = await call(
                "POST", "/invites/validate", json={"token": setup["token"]}
            )
            assert identity.json()["email"] == request_body["email"]
            await call(
                "POST",
                "/invites/set-password",
                422,
                json={**setup, "email": reviewer_email},
            )
            await call("POST", "/invites/set-password", json=setup)
            await login(request_body["email"])

            rejected_email = f"denied-{suffix}@other.test"
            await call(
                "POST",
                "/signup/reviewer",
                201,
                json={
                    **request_body,
                    "organization": "Fictional Inspection Group",
                    "email": rejected_email,
                },
            )
            rejected = await profile(rejected_email)
            created.append(rejected["id"])
            await call(
                "POST",
                f"/admin/reviewer-requests/{rejected['id']}/reject",
                headers=admin,
            )
            assert (await profile(rejected_email))["status"] == "rejected"
            await login(rejected_email, status=401)
            await call(
                "POST",
                "/login",
                403,
                json={
                    "email": reviewer_email,
                    "password": secret,
                    "workspace": "factory_manager",
                },
            )
            colleague_email = f"colleague-{suffix}@safetyproof.test"
            colleague_id = await provision(
                db,
                colleague_email,
                {
                    "full_name": "Fictional Colleague",
                    "role": "reviewer",
                    "status": "active",
                },
                secret,
            )
            created.append(colleague_id)
            colleague = headers(await login(colleague_email))
            await call(
                "POST",
                f"/admin/reviewers/{colleague_id}/factories",
                headers=admin,
                json={"factory_ids": [first]},
            )
            payload = {
                "factory": factories[1]["name"],
                "title": "Unassigned case",
                "reviewer_id": colleague_id,
            }
            await call("POST", "/cases", 403, headers=reviewer, json=payload)
            await call("POST", "/admin/cases", 403, headers=reviewer, json=payload)
            await call("POST", "/admin/cases", 422, headers=admin, json=payload)
            for item in factories[:2]:
                case = (
                    await call(
                        "POST",
                        "/admin/cases",
                        201,
                        headers=admin,
                        json={
                            "factory": item["name"],
                            "title": "Account test",
                            "reviewer_id": uid,
                            "inspection_on": (
                                "2030-08-01" if item == factories[0] else "2030-08-02"
                            ),
                        },
                    )
                ).json()
                assert case["created_by"] == admin_id and case["reviewer_id"] == uid
                cases.append(case["id"])
                assert (
                    await call("GET", f"/cases/{case['id']}", headers=reviewer)
                ).json()["role"] == "reviewer"
            await call("GET", f"/cases/{cases[0]}", 404, headers=colleague)
            await call(
                "POST",
                f"/admin/reviewers/{colleague_id}/factories",
                headers=admin,
                json={"factory_ids": [first, second]},
            )
            assert (await call("GET", "/cases", headers=colleague)).json() == []
            await call("GET", f"/cases/{cases[1]}", 404, headers=colleague)
            for factory_ids, expected in [([second], 404), ([first, second], 200)]:
                await call(
                    "POST",
                    f"/admin/reviewers/{uid}/factories",
                    headers=admin,
                    json={"factory_ids": factory_ids},
                )
                await call("GET", f"/cases/{cases[0]}", expected, headers=reviewer)
            await call(
                "POST",
                f"/cases/{cases[0]}/runs",
                403,
                headers=admin,
                json={
                    "version_ids": [str(uuid4()), str(uuid4())],
                    "request_key": str(uuid4()),
                },
            )

            rejected_email = f"rejected-{suffix}@safetyproof.test"
            rejected = await signup(rejected_email, first)
            result = await login(rejected_email, status=403)
            assert "waiting for admin approval" in result["detail"]
            assert not (await direct_login(rejected_email)).is_success
            path = f"/admin/manager-applications/{rejected['id']}/id-card"
            await call("GET", path, 403, headers=reviewer)
            await call("GET", path, headers=admin)
            await decide(rejected["id"], "reject", reason="Office ID did not match.")
            assert (await profile(rejected_email))["id_card_deleted_at"]
            await call("GET", path, 404, headers=admin)
            result = await login(rejected_email, status=403)
            assert (
                result["detail"]
                == "Your application was rejected: Office ID did not match."
            )
            assert (await login(rejected_email, "wrong-password", 401))["detail"] == (
                await login(f"unknown-{suffix}@safetyproof.test", status=401)
            )["detail"]

            manager_email = f"manager-{suffix}@safetyproof.test"
            manager_row = await signup(manager_email, first)
            await decide(manager_row["id"], "approve", factory_id=second)
            bound = await profile(manager_email)
            assert bound["id_card_deleted_at"] and bound["factory_id"] == second
            from safetyproof.platform import PlatformError

            for row in (rejected, manager_row):
                with pytest.raises(PlatformError) as error:
                    await db.call(
                        "GET",
                        "/storage/v1/object/" + CARD_BUCKET + "/" + row["id_card_path"],
                        admin=True,
                        raw=True,
                    )
                assert error.value.status in (400, 404)
            manager_session = await login(manager_email)
            manager = headers(manager_session)
            await call("GET", f"/cases/{cases[0]}", 404, headers=manager)
            await call("GET", f"/cases/{cases[1]}", headers=manager)
            await call(
                "POST",
                f"/cases/{cases[1]}/corrective-work",
                403,
                headers=manager,
                json={
                    "title": "No permission",
                    "assignee": "Team",
                    "due_on": "2026-11-30",
                },
            )
            await decide(manager_row["id"], "deactivate")
            await login(manager_email, status=403)
            await call("GET", "/me", 401, headers=manager)
            await decide(uid, "deactivate")
            await login(reviewer_email, status=403)
            await call("GET", "/me", 401, headers=reviewer)
            access = await db.rows(
                "cases",
                token=manager_session["access_token"],
                filters={"id": "eq." + cases[1]},
            )
            assert access == []
            audit = await db.rows("account_audit", filters={"actor": "eq." + admin_id})
            assert {row["action"] for row in audit} == {
                "approve",
                "reject",
                "deactivate",
            }
            source = ROOT / "frontend/components/onboarding.tsx"
            assert "national id" not in source.read_text().lower()
        finally:
            for cid in cases:
                await db.call(
                    "DELETE", "/rest/v1/cases", admin=True, params={"id": "eq." + cid}
                )
            for uid in reversed(created):
                await db.call("DELETE", "/auth/v1/admin/users/" + uid, admin=True)
