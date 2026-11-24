"""Use actual local Supabase and synthetic PDFs with a scripted test-only inference boundary."""

import asyncio
import json
import secrets
from pathlib import Path
from uuid import uuid4

import httpx
import pytest
import pytest_asyncio
from safetyproof import main
from safetyproof.accounts import provision
from safetyproof.platform import Platform
from safetyproof.models import CapActionList, SecondOpinion, TargetList, Verdict

ROOT = Path(__file__).resolve().parents[2]


class ScriptedInference:
    client = None

    def __init__(self, cfg):
        pass

    async def embed(self, texts, task):
        return [[1.0] + [0.0] * 767 for _ in texts], {}

    async def structured(self, instruction, data, schema):
        if schema is TargetList:
            items = []
            for passage in data["passages"]:
                for line in passage["text"].splitlines():
                    if (
                        "No workplace injuries" in line
                        or "Exit E-02 was obstructed" in line
                        or "One emergency drill" in line
                    ):
                        is_finding = "Exit E-02" in line
                        items.append(
                            {
                                "chunk_id": passage["id"],
                                "quote": line,
                                "start_date": "2026-03-06"
                                if is_finding
                                else "2026-04-01",
                                "end_date": "2026-03-06"
                                if is_finding
                                else "2026-04-30",
                                "kind": "finding" if is_finding else "claim",
                                "severity": "high" if is_finding else "unknown",
                            }
                        )
            return {"items": items}, {}
        if schema is Verdict:
            if "No workplace injuries" in data["target"]["statement"]:
                for s in data["sources"]:
                    for line in s["text"].splitlines():
                        if "শ্রমিক আহত হন" in line:
                            return {
                                "label": "contradicts",
                                "compatible": True,
                                "evidence": [{"chunk_id": s["id"], "quote": line}],
                                "reason": "The incident register records an injury in April.",
                                "evidence_start": "2026-04-15",
                            }, {}
            return {
                "label": "insufficient",
                "compatible": False,
                "evidence": [],
                "reason": "No matching corroboration.",
            }, {}
        if schema is CapActionList:
            items = []
            for passage in data["passages"]:
                lines = passage["text"].splitlines()
                for i, line in enumerate(lines):
                    if line.startswith(
                        ("CA-01 for finding", "CA-02 for finding", "CA-03:")
                    ):
                        ref = line[:5]
                        quote = line
                        if i + 1 < len(lines) and lines[i + 1].startswith(
                            ref + " target"
                        ):
                            quote += "\n" + lines[i + 1]
                        items.append(
                            {
                                "chunk_id": passage["id"],
                                "quote": quote,
                                "action_ref": ref,
                                "finding_refs": ["FI-16"] if "FI-16" in quote else [],
                                "asset": "E-02" if "E-02" in quote else None,
                            }
                        )
            return {"items": items}, {}
        if schema is SecondOpinion:
            contradicted = "No workplace injuries" in data["hypothesis"][
                "statement"
            ] and any("শ্রমিক আহত হন" in p["text"] for p in data["premises"])
            return {"relation": "contradicts" if contradicted else "insufficient"}, {}
        raise AssertionError(schema)


@pytest_asyncio.fixture
async def test_viewer():
    if not main.cfg.supabase_anon_key or "127.0.0.1" not in main.cfg.supabase_url:
        pytest.skip("Configure the local Supabase stack first.")
    email = f"test-viewer-{uuid4().hex[:12]}@safetyproof.test"
    password = secrets.token_urlsafe(18)
    async with httpx.AsyncClient(timeout=30) as remote:
        db = Platform(main.cfg, remote)
        uid = await provision(
            db,
            email,
            {"role": "viewer", "status": "active", "full_name": "Test Viewer"},
            password,
        )
        try:
            yield {"email": email, "password": password}
        finally:
            await db.call("DELETE", "/auth/v1/admin/users/" + uid, admin=True)


@pytest.mark.asyncio
async def test_case_review_and_permissions(monkeypatch, test_viewer, case_admin):
    credentials = ROOT / ".local/accounts.json"
    if not credentials.exists() or not main.cfg.supabase_anon_key:
        pytest.skip("Configure the Supabase test project before running this test")
    monkeypatch.setattr(
        main,
        "cfg",
        main.cfg.model_copy(update={"gemini_api_key": "test-only-provider-stub"}),
    )
    monkeypatch.setattr(main, "Gemini", ScriptedInference)
    accounts = {**json.loads(credentials.read_text()), "viewer": test_viewer}
    async with (
        main.lifespan(main.app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=main.app), base_url="http://test"
        ) as api,
        httpx.AsyncClient() as remote,
    ):
        headers = {"admin": case_admin[1]}
        users = {}
        for role, creds in accounts.items():
            response = await remote.post(
                main.cfg.supabase_url + "/auth/v1/token",
                params={"grant_type": "password"},
                headers={"apikey": main.cfg.supabase_anon_key},
                json=creds,
            )
            response.raise_for_status()
            info = response.json()
            headers[role] = {"Authorization": "Bearer " + info["access_token"]}
            users[role] = info["user"]["id"]

        async def call(method, path, role="reviewer", body=None, status=200):
            response = await api.request(
                method, "/v1" + path, headers=headers[role], json=body
            )
            assert response.status_code == status, (
                method,
                path,
                response.status_code,
                response.text[:300],
            )
            return response.json()

        async def eventually(path, done):
            for _ in range(140):
                item = await call("GET", path)
                if done(item):
                    return item
                await asyncio.sleep(0.1)
            pytest.fail(f"Processing never reached expected state: {item}")

        case = await call(
            "POST",
            "/admin/cases",
            role="admin",
            body={
                "factory": "Shaluk Threadworks Ltd.",
                "title": "Integration smoke",
                "reviewer_id": users["reviewer"],
                "inspection_on": "2030-09-15",
            },
            status=201,
        )
        # This integration case uses the older sample-document workflow. Preserve
        # its date-less legacy shape after creation, since newly assigned cases
        # now require dates and cannot accept samples.
        await main.app.state.db.call(
            "PATCH",
            "/rest/v1/cases",
            admin=True,
            params={"id": "eq." + case["id"]},
            data={"inspection_on": None},
        )
        path = "/cases/" + case["id"]
        try:
            await call("GET", path, role="viewer", status=404)
            await call("POST", path + "/samples", status=202)
            current = await eventually(
                path,
                lambda d: (
                    len(d["versions"]) == 5
                    and all(
                        v["status"] not in ["queued", "awaiting_upload"]
                        for v in d["versions"]
                    )
                ),
            )
            assert all(v["status"] == "ready" for v in current["versions"])
            scan = next(
                v
                for v in current["versions"]
                if v["filename"] == "incident-register.pdf"
            )
            await call(
                "GET",
                "/document-versions/" + scan["id"] + "/source",
                role="viewer",
                status=404,
            )
            original = await call("GET", "/document-versions/" + scan["id"] + "/source")
            assert (await remote.get(original["url"])).content.startswith(b"%PDF-")

            await main.app.state.db.call(
                "POST",
                "/rest/v1/case_members",
                admin=True,
                data={
                    "case_id": case["id"],
                    "user_id": users["viewer"],
                    "role": "viewer",
                },
            )
            assert (await call("GET", path, role="viewer"))["role"] == "viewer"
            await call("POST", path + "/samples", role="viewer", status=403)

            run_payload = {
                "version_ids": [v["id"] for v in current["versions"]],
                "request_key": str(uuid4()),
            }
            run = await call("POST", path + "/runs", body=run_payload, status=202)
            assert run == await call(
                "POST", path + "/runs", body=run_payload, status=202
            )
            run_path = "/runs/" + run["run_id"]
            finished = await eventually(
                run_path, lambda r: r["status"] not in ("queued", "running")
            )
            assert finished["status"] == "complete"
            results = await call("GET", run_path + "/results")
            assert {r["outcome"] for r in results} == {
                "contradicted",
                "unsupported",
                "unresolved",
            }
            result = next(r for r in results if r["outcome"] == "contradicted")
            assert (
                result["evidence"][0]["page"] == 1
                and result["evidence"][0]["version_id"] == scan["id"]
            )
            assert result["evidence"][0]["boxes"]
            review_path = "/results/" + result["id"] + "/reviews"
            decision = {"action": "accept", "comment": "Checked both cited pages."}
            await call("POST", review_path, role="viewer", body=decision, status=403)
            await call("POST", review_path, body=decision, status=201)
            reports = await call("GET", run_path + "/report", role="viewer")
            assert any(
                e["comment"] == decision["comment"]
                for row in reports["results"]
                for e in row["reviews"]
            )
            cap = await call("GET", run_path + "/cap", role="viewer")
            assert len(cap["analysis"]["actions"]) == 3
            assert len(cap["analysis"]["suggestions"]) == 2
            pair = cap["analysis"]["suggestions"][0]
            link = {
                "finding_id": pair["finding_id"],
                "action_id": pair["action_id"],
                "decision": "confirm",
                "comment": "Checked the CAP page.",
            }
            await call(
                "POST", run_path + "/cap/reviews", role="viewer", body=link, status=403
            )
            await call(
                "POST",
                run_path + "/cap/reviews",
                body={**link, "action_id": str(uuid4())},
                status=409,
            )
            await call("POST", run_path + "/cap/reviews", body=link, status=201)
            assert (await call("GET", run_path + "/cap", role="viewer"))["reviews"][0][
                "comment"
            ] == link["comment"]
            request = {
                "action": "request_evidence",
                "comment": "Provide a signed clinic extract.",
            }
            await call("POST", review_path, body=request, status=201)
            second = await call(
                "POST",
                path + "/runs",
                body={**run_payload, "request_key": str(uuid4())},
                status=202,
            )
            later = await eventually(
                "/runs/" + second["run_id"],
                lambda r: r["status"] not in ("queued", "running"),
            )
            assert later["status"] == "complete"
            assert all(
                not r["reviews"]
                for r in await call("GET", "/runs/" + second["run_id"] + "/results")
            )
            assert any(r["reviews"] for r in await call("GET", run_path + "/results"))
            followups = await call("GET", path + "/followups")
            assert [item["event"]["comment"] for item in followups] == [
                request["comment"]
            ]
            assert followups[0]["run_id"] == run["run_id"]
            await call("POST", review_path, body=decision, status=201)
            assert await call("GET", path + "/followups") == []
            factory_user = "factory_manager"
            await call(
                "POST",
                "/cases",
                role=factory_user,
                body={"factory": "Test", "title": "Private audit"},
                status=403,
            )
            await call(
                "POST",
                path + "/share-manager",
                body={"email": accounts[factory_user]["email"]},
                status=201,
            )
            manager_case = await call("GET", path, role=factory_user)
            assert (
                manager_case["role"] == "manager"
                and manager_case["runs"] == manager_case["documents"] == []
            )
            await call("GET", run_path + "/results", role=factory_user, status=404)
            await call(
                "GET",
                "/document-versions/" + scan["id"] + "/source",
                role=factory_user,
                status=404,
            )
            await call("GET", path + "/corrective-work", role="viewer", status=404)
            await call(
                "POST",
                path + "/corrective-work",
                role=factory_user,
                status=403,
                body={
                    "title": "No permission",
                    "assignee": "Team",
                    "due_on": "2026-11-28",
                },
            )
            task = await call(
                "POST",
                path + "/corrective-work",
                status=201,
                body={
                    "title": "Demonstrate aisle clearance",
                    "assignee": "Maintenance",
                    "due_on": "2026-11-28",
                    "detail": "Provide the exit follow-up PDF.",
                },
            )
            task_path = "/corrective-tasks/" + task["id"]
            await call(
                "POST",
                task_path + "/events",
                role=factory_user,
                body={"action": "comment", "note": "Maintenance scheduled the work."},
            )
            board = await call("GET", path + "/corrective-work", role=factory_user)
            assert board["tasks"][0]["status"] == "assigned"
            assert board["events"][-1]["action"] == "comment"
            await call(
                "POST",
                task_path + "/events",
                role=factory_user,
                body={"action": "started"},
            )
            await call(
                "POST",
                task_path + "/events",
                role=factory_user,
                body={"action": "accept"},
                status=403,
            )

            async def submit(filename, raw):
                ticket = await call(
                    "POST",
                    task_path + "/uploads",
                    role=factory_user,
                    body={"filename": filename},
                    status=201,
                )
                uploaded = await remote.put(
                    ticket["upload_url"],
                    content=raw,
                    headers={"Content-Type": "application/pdf"},
                )
                assert uploaded.is_success, uploaded.text
                body = {"receipt": ticket["receipt"]}
                await call(
                    "POST",
                    task_path + "/uploads/finalize",
                    role="reviewer",
                    body=body,
                    status=403,
                )
                await call(
                    "POST",
                    task_path + "/uploads/finalize",
                    role=factory_user,
                    body={"receipt": ticket["receipt"] + "x"},
                    status=422,
                )
                result = await call(
                    "POST",
                    task_path + "/uploads/finalize",
                    role=factory_user,
                    body=body,
                    status=201,
                )
                assert result == await call(
                    "POST",
                    task_path + "/uploads/finalize",
                    role=factory_user,
                    body=body,
                    status=201,
                )
                return result

            await submit(
                "first-pass.pdf",
                (ROOT / "fixtures/demo/march-inspection.pdf").read_bytes(),
            )
            await call(
                "POST",
                task_path + "/events",
                body={"action": "return", "note": "Provide the external follow-up."},
            )
            board = await call("GET", path + "/corrective-work", role=factory_user)
            assert board["tasks"][0]["status"] == "needs_revision"
            assert board["events"][-1]["note"] == "Provide the external follow-up."
            evidence = await submit(
                "follow-up.pdf",
                (ROOT / "fixtures/live/exit-follow-up.pdf").read_bytes(),
            )
            source_path = "/corrective-evidence/" + evidence["id"]
            await call("GET", source_path + "/source", role="viewer", status=404)
            signed = await call("GET", source_path + "/source", role=factory_user)
            assert (await remote.get(signed["url"])).content.startswith(b"%PDF-")
            await call("POST", source_path + "/import", role=factory_user, status=403)
            job = await call("POST", source_path + "/import", status=202)
            assert job == await call("POST", source_path + "/import", status=202)
            assert (
                await eventually(
                    "/jobs/" + job["job_id"],
                    lambda item: item["state"] in ("done", "failed"),
                )
            )["state"] == "done"
            await call(
                "POST",
                task_path + "/events",
                body={"action": "accept", "note": "Reviewed the submitted PDF."},
            )
            board = await call("GET", path + "/corrective-work", role=factory_user)
            assert (
                board["tasks"][0]["status"] == "reviewed"
                and len(board["evidence"]) == 2
            )

        finally:
            await call("DELETE", "/admin" + path, role="admin")


@pytest.mark.asyncio
async def test_interrupted_job_reclaims_lease(monkeypatch, case_admin):
    credentials = ROOT / ".local/accounts.json"
    if not credentials.exists() or not main.cfg.supabase_anon_key:
        pytest.skip("Configure the Supabase test project before running this test")
    monkeypatch.setattr(
        main, "cfg", main.cfg.model_copy(update={"worker_enabled": False})
    )
    async with main.lifespan(main.app), httpx.AsyncClient() as remote:
        reviewer = json.loads(credentials.read_text())["reviewer"]
        response = await remote.post(
            main.cfg.supabase_url + "/auth/v1/token",
            params={"grant_type": "password"},
            headers={"apikey": main.cfg.supabase_anon_key},
            json=reviewer,
        )
        response.raise_for_status()
        actor = response.json()["user"]["id"]
        db = main.app.state.db
        case = await db.rpc(
            "create_case",
            actor_id=case_admin[0],
            assignee_id=actor,
            data={
                "factory": "Shaluk Threadworks Ltd.",
                "title": "Lease test",
                "inspection_on": "2030-10-16",
            },
        )
        cid = case["id"]
        try:
            v = await db.rpc(
                "reserve",
                cid=cid,
                actor_id=actor,
                data={
                    "request_key": str(uuid4()),
                    "confirmed_factory": "Shaluk Threadworks Ltd.",
                    "filename": "test.pdf",
                    "title": "Inspection",
                    "role": "inspection",
                    "issued_on": "2030-10-16",
                    "issuer": "external",
                },
            )
            jid = await db.rpc("ingest", cid=cid, actor_id=actor, vid=v["id"])
            original = await db.rpc("claim")
            assert original["id"] == jid and await db.rpc("claim") is None
            await db.call(
                "PATCH",
                "/rest/v1/jobs",
                admin=True,
                params={"id": "eq." + jid},
                data={"lease_until": "2000-01-01T00:00:00Z"},
            )
            resumed = await db.rpc("claim_job", jid=jid)
            assert resumed["id"] == jid and resumed["lease"] != original["lease"]
            from safetyproof.platform import PlatformError

            with pytest.raises(PlatformError, match="Job lease expired"):
                await db.rpc(
                    "step", jid=jid, ticket=original["lease"], op="progress", payload={}
                )
            await db.rpc(
                "step",
                jid=jid,
                ticket=resumed["lease"],
                op="progress",
                payload={"completed": 1},
            )
            await db.rpc("yield_job", jid=jid, ticket=resumed["lease"])
            yielded = await db.one("jobs", jid)
            assert (
                yielded["state"] == "queued"
                and yielded["attempts"] == resumed["attempts"] - 1
            )
            with pytest.raises(PlatformError, match="Job lease expired"):
                await db.rpc("yield_job", jid=jid, ticket=resumed["lease"])
            reclaimed = await db.rpc("claim_job", jid=jid)
            assert (
                reclaimed["lease"] != resumed["lease"] and reclaimed["completed"] == 1
            )

        finally:
            await db.call(
                "DELETE", "/rest/v1/cases", admin=True, params={"id": "eq." + cid}
            )
