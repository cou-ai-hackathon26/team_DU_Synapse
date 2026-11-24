"""Large originals keep page identity and progress across ingestion leases."""

import io
import json
from uuid import uuid4

import httpx
import pytest
from reportlab.pdfgen import canvas

from safetyproof import main
from safetyproof.config import ROOT
from safetyproof.platform import Platform
from safetyproof.worker import isolated_pdf, process


def long_pdf(title):
    buffer = io.BytesIO()
    pdf = canvas.Canvas(buffer)
    for page in range(1, 58):
        pdf.drawString(
            72, 700, f"{title}: recorded inspection observation on page {page}"
        )
        pdf.showPage()
    pdf.save()
    return buffer.getvalue()


@pytest.mark.asyncio
async def test_large_pdf_checkpoints_and_case_can_exceed_one_hundred_pages(
    monkeypatch, case_admin
):
    accounts = ROOT / ".local/accounts.json"
    if not accounts.exists() or "127.0.0.1" not in main.cfg.supabase_url:
        pytest.skip("Configure local Supabase and demo accounts first.")
    cfg = main.cfg.model_copy(update={"worker_enabled": False})
    monkeypatch.setattr(main, "cfg", cfg)
    async with (
        main.lifespan(main.app),
        httpx.AsyncClient(timeout=30) as remote,
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=main.app), base_url="http://test"
        ) as api,
    ):
        db = Platform(cfg, remote)
        login = await remote.post(
            cfg.supabase_url + "/auth/v1/token",
            params={"grant_type": "password"},
            headers={"apikey": cfg.supabase_anon_key},
            json=json.loads(accounts.read_text())["reviewer"],
        )
        login.raise_for_status()
        session = login.json()
        headers = {"Authorization": "Bearer " + session["access_token"]}
        factory = "Shaluk Threadworks Ltd."
        case = await api.post(
            "/v1/admin/cases",
            headers=case_admin[1],
            json={
                "factory": factory,
                "title": "Large PDF integration",
                "reviewer_id": session["user"]["id"],
                "inspection_on": "2030-11-14",
            },
        )
        case.raise_for_status()
        cid = case.json()["id"]
        try:
            for title in ("Structural inspection", "Fire inspection"):
                response = await api.post(
                    f"/v1/cases/{cid}/uploads",
                    headers=headers,
                    json={
                        "request_key": str(uuid4()),
                        "filename": "report.pdf",
                        "title": title,
                        "role": "inspection",
                        "issued_on": "2030-11-14",
                        "confirmed_factory": factory,
                    },
                )
                response.raise_for_status()
                ticket = response.json()
                vid = ticket["version_id"]
                data = long_pdf(title)
                upload = await remote.put(
                    ticket["upload_url"],
                    content=data,
                    headers={"Content-Type": "application/pdf"},
                )
                upload.raise_for_status()
                finalize = await api.post(
                    f"/v1/document-versions/{vid}/finalize", headers=headers
                )
                finalize.raise_for_status()
                jid = finalize.json()["job_id"]
                job = await db.rpc("claim_job", jid=jid)
                batch = await isolated_pdf(data, vid, cfg.tessdata_prefix, 0, 8)
                await db.rpc("ingest_batch", jid=jid, ticket=job["lease"], batch=batch)
                await db.rpc("yield_job", jid=jid, ticket=job["lease"])
                resumed = await db.rpc("claim_job", jid=jid)
                assert resumed["completed"] == 8 and resumed["total"] == 57
                await process(db, None, cfg, resumed)
                version = await db.one("document_versions", vid)
                assert version["status"] == "ready", version["error"]
                assert version["page_count"] == version["readable_pages"] == 57
                pages = await api.get(
                    f"/v1/document-versions/{vid}/pages", headers=headers
                )
                pages.raise_for_status()
                assert [row["page_no"] for row in pages.json()] == list(range(1, 58))
                last = await api.get(
                    f"/v1/document-versions/{vid}/pages?offset=56&limit=8",
                    headers=headers,
                )
                last.raise_for_status()
                assert [row["page_no"] for row in last.json()] == [57]
            dossier = await api.get(f"/v1/cases/{cid}", headers=headers)
            dossier.raise_for_status()
            assert sum(v["page_count"] for v in dossier.json()["versions"]) == 114
        finally:
            result = await api.delete(f"/v1/admin/cases/{cid}", headers=case_admin[1])
            result.raise_for_status()
