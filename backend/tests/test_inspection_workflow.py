"""A scheduled inspection exchanges evidence only between its assigned roles."""

import io
import json
from uuid import uuid4

import httpx
import pytest
from reportlab.pdfgen import canvas

from safetyproof import main
from safetyproof.config import ROOT
from safetyproof.platform import Platform
from safetyproof.worker import process


def make_pdf(line):
    output = io.BytesIO()
    pdf = canvas.Canvas(output)
    pdf.drawString(45, 750, "SafetyProof fictional inspection workflow test")
    pdf.drawString(45, 722, line)
    pdf.drawString(
        45, 694, "Packing corridor E-02 was clear at the start of the observed shift."
    )
    pdf.save()
    return output.getvalue()


@pytest.mark.asyncio
async def test_scheduled_report_and_factory_submission(monkeypatch, case_admin):
    account_file = ROOT / ".local/accounts.json"
    if not account_file.exists():
        pytest.skip("Configure the Supabase test project before running this test.")
    cfg = main.cfg.model_copy(update={"worker_enabled": False})
    monkeypatch.setattr(main, "cfg", cfg)
    credentials = json.loads(account_file.read_text())
    async with (
        main.lifespan(main.app),
        httpx.AsyncClient(timeout=30) as remote,
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=main.app), base_url="http://test"
        ) as api,
    ):
        db = Platform(cfg, remote)
        headers = {"admin": case_admin[1]}
        for role in ("reviewer", "factory_manager"):
            session = await db.call(
                "POST",
                "/auth/v1/token",
                params={"grant_type": "password"},
                data=credentials[role],
            )
            headers[role] = {"Authorization": "Bearer " + session["access_token"]}
            if role == "reviewer":
                reviewer_id = session["user"]["id"]

        async def call(method, path, role, status=200, body=None):
            response = await api.request(
                method, "/v1" + path, headers=headers[role], json=body
            )
            assert response.status_code == status, (
                path,
                response.status_code,
                response.text,
            )
            return response.json()

        factory = "Shaluk Threadworks Ltd."
        case = await call(
            "POST",
            "/admin/cases",
            "admin",
            201,
            {
                "title": "Inspection workflow test",
                "factory": factory,
                "reviewer_id": reviewer_id,
                "inspection_on": "2026-03-15",
            },
        )
        area = "/cases/" + case["id"]

        async def reserve(kind, role, when, status=200):
            return await call(
                "POST",
                area + "/uploads",
                role,
                status,
                {
                    "role": kind,
                    "request_key": str(uuid4()),
                    "title": kind,
                    "filename": kind + ".pdf",
                    "confirmed_factory": factory,
                    "issued_on": when,
                },
            )

        async def submit(kind, role, date, line):
            ticket = await reserve(kind, role, date)
            response = await remote.put(
                ticket["upload_url"],
                content=make_pdf(line),
                headers={"Content-Type": "application/pdf"},
            )
            response.raise_for_status()
            vid = ticket["version_id"]
            result = await call("POST", f"/document-versions/{vid}/finalize", role, 202)
            job = await db.rpc("claim_job", jid=result["job_id"])
            await process(db, None, cfg, job)
            return vid

        try:
            assert (
                case["period_start"] == "2026-03-01"
                and case["period_end"] == "2026-03-31"
            )
            notice = next(
                row
                for row in (await call("GET", "/manager/work", "factory_manager"))[
                    "inspections"
                ]
                if row["case_id"] == case["id"]
            )
            profile = await call("GET", "/me", "reviewer")
            assert (
                notice["inspection_on"],
                notice["organization"],
                notice["reviewer_name"],
            ) == (
                "2026-03-15",
                profile["organization"],
                profile["full_name"],
            )
            await reserve("cap", "factory_manager", "2026-03-20", 409)
            await reserve("inspection", "factory_manager", "2026-03-15", 403)
            await reserve("cap", "reviewer", "2026-03-20", 403)
            for wrong in (None, "2026-01-30", "2026-04-01", "2025-03-15"):
                await reserve("inspection", "reviewer", wrong, 422)
            await call("POST", area + "/samples", "reviewer", 403)
            invalid = await submit(
                "inspection", "reviewer", "2026-03-15", "Inspection date: 2026-04-01"
            )
            failed = await db.one("document_versions", invalid)
            assert failed["status"] == "failed" and "does not match" in failed["error"]
            assert (await call("GET", area, "factory_manager"))["versions"] == []
            report_id = await submit(
                "inspection", "reviewer", "2026-03-15", "Inspection date: 2026-03-15"
            )
            assert (await call("GET", area, "factory_manager"))["versions"][0][
                "id"
            ] == report_id
            await call(
                "GET", f"/document-versions/{report_id}/source", "factory_manager"
            )
            cap_id = await submit(
                "cap",
                "factory_manager",
                "2026-04-03",
                "Corrective action CA-01: Keep access to E-02 clear.",
            )
            cap = next(
                v
                for v in (await call("GET", area, "reviewer"))["versions"]
                if v["id"] == cap_id
            )
            assert cap["status"] == "ready" and cap["issuer"] == "factory"
        finally:
            await call("DELETE", "/admin" + area, "admin")
