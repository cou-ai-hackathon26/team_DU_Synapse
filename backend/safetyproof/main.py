import asyncio
import hashlib
import json
import logging
from contextlib import asynccontextmanager, suppress
from datetime import date, datetime
from typing import Literal
from uuid import UUID, uuid4, uuid5
from zoneinfo import ZoneInfo

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict, Field

from .accounts import account_router
from .ai import Gemini
from .config import JOB_FIELDS, settings
from .document_metadata import extract_cap_submission_deadline, extract_metadata
from .document_duplicates import content_fingerprint, duplicate_candidate
from .document_validation import (
    classify_factory_record_content,
    check_factory_record_content,
    check_inspection_content,
)
from .models import (
    CapReviewInput,
    CaseRecord,
    PublishedResult,
    ReviewInput,
    RunInput,
    RunTicket,
    UploadInput,
    UploadTicket,
)
from .platform import Platform, PlatformError
from .worker import isolated_pdf, loop

cfg = settings()
logger = logging.getLogger(__name__)
bearer = HTTPBearer(auto_error=False)


async def parse_all_pdf_pages(data, version_id, parsed, tessdata):
    """OCR every page, keeping the parser's bounded batch size."""
    pages = list(parsed["pages"])
    total_pages = parsed["total_pages"]
    for offset in range(len(pages), total_pages, 8):
        batch = await isolated_pdf(data, version_id, tessdata, offset, 8)
        pages.extend(batch["pages"])
    return pages


@asynccontextmanager
async def lifespan(app):
    async with httpx.AsyncClient(timeout=35) as client:
        app.state.db = Platform(cfg, client)
        app.state.ai = Gemini(cfg)
        app.state.wake = asyncio.Event()
        task = (
            asyncio.create_task(loop(app.state.db, app.state.ai, cfg, app.state.wake))
            if cfg.worker_enabled
            and not cfg.queue_enabled
            and cfg.supabase_service_role_key
            else None
        )
        try:
            yield
        finally:
            if task:
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task
            await app.state.ai.aclose()


app = FastAPI(title="SafetyProof AI", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[s.strip() for s in cfg.cors_origins.split(",")],
    allow_methods=["GET", "POST", "PATCH", "DELETE"],
    allow_headers=["Authorization", "Content-Type", "X-Upload-Receipt"],
    allow_private_network=True,
)


@app.middleware("http")
async def protect_authenticated_responses(request: Request, call_next):
    response = await call_next(request)
    if request.headers.get("authorization") or request.url.path.startswith(
        ("/v1/login", "/v1/invites", "/v1/signup")
    ):
        response.headers["Cache-Control"] = "private, no-store"
    return response


@app.exception_handler(PlatformError)
async def platform_error(_, error):
    return JSONResponse(
        {"detail": str(error)},
        status_code=error.status if 400 <= error.status < 600 else 502,
    )


@app.exception_handler(RequestValidationError)
async def validation_error(_, error):
    # Validation errors must not reflect passwords, token values or uploaded data.
    return JSONResponse(
        {
            "detail": [
                {"loc": item["loc"], "msg": item["msg"], "type": item["type"]}
                for item in error.errors()
            ]
        },
        status_code=422,
    )


class User(BaseModel):
    id: str
    token: str
    role: str
    factory_id: UUID | None = None

    @property
    def factory_manager(self):
        return self.role == "factory_manager"


async def user(
    request: Request, auth: HTTPAuthorizationCredentials | None = Depends(bearer)
):
    if not auth:
        raise HTTPException(401, "Sign in to open this workspace.")
    db = request.app.state.db
    try:
        identity = await db.call("GET", "/auth/v1/user", token=auth.credentials)
    except PlatformError as e:
        if e.status in (400, 401, 403):
            raise HTTPException(401, "Your sign-in has expired.") from e
        raise
    profile = await db.rows(
        "account_profiles",
        fields="role,status,factory_id",
        filters={"id": "eq." + identity["id"]},
    )
    if not profile or profile[0]["status"] != "active":
        raise HTTPException(401, "Your session is no longer active.")
    role = profile[0]["role"]
    path = request.url.path
    if role == "admin" and path != "/v1/me" and not path.startswith("/v1/admin/"):
        raise HTTPException(
            403, "Administrator accounts use the read-only factory overview."
        )
    if role in ("viewer", "factory_manager") and request.method != "GET":
        manager_write = path.startswith("/v1/corrective-tasks/") or (
            request.method == "POST"
            and (
                path.startswith("/v1/cases/")
                and path.endswith(("/uploads", "/inspect-upload"))
                or path.startswith("/v1/document-versions/")
                and path.endswith("/finalize")
            )
        ) or (
            request.method == "DELETE"
            and path.startswith("/v1/cases/")
            and "/documents/" in path
        )
        if role != "factory_manager" or not manager_write:
            raise HTTPException(403, "Review access required.")
    return User(
        id=identity["id"],
        token=auth.credentials,
        role=role,
        factory_id=profile[0]["factory_id"],
    )


def db(request: Request):
    return request.app.state.db


app.include_router(account_router(user, db))


async def schedule_work(request: Request):
    if cfg.queue_enabled:
        from .queue import publish

        pending = await request.app.state.db.rows(
            "jobs", fields="id,available_at", filters={"state": "in.(queued,running)"}
        )
        for entry in pending:
            await publish(entry["id"], entry["available_at"])
    else:
        request.app.state.wake.set()


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/v1/config")
def public_config():
    return {
        "supabase_url": cfg.supabase_url,
        "publishable_key": cfg.supabase_anon_key,
        "ai_configured": bool(cfg.gemini_keys()),
        "models": cfg.provenance(),
        "limits": {"case_documents": 10},
    }


def samples():
    return json.loads((cfg.sample_dir / "manifest.json").read_text())


@app.get("/v1/samples")
def sample_list(u: User = Depends(user)):
    return samples()


@app.get("/v1/samples/{filename}")
def sample_pdf(filename: str, u: User = Depends(user)):
    if filename not in {d["filename"] for d in samples()["documents"]}:
        raise HTTPException(404, "Unknown sample.")
    return FileResponse(
        cfg.sample_dir / filename,
        media_type="application/pdf",
        filename=filename,
        content_disposition_type="inline",
    )


@app.get("/v1/cases", response_model=list[CaseRecord])
async def list_cases(u: User = Depends(user), d=Depends(db)):
    return await d.rows("cases", token=u.token, order="created_at.desc")


@app.get("/v1/notifications")
async def reviewer_notifications(u: User = Depends(user), d=Depends(db)):
    if u.role != "reviewer":
        raise HTTPException(403, "Reviewer notifications are available to reviewers.")
    return await d.rows(
        "reviewer_notifications",
        token=u.token,
        fields="id,case_id,document_id,title,body,created_at,read_at",
        filters={"user_id": "eq." + u.id},
        order="created_at.desc",
    )


@app.post("/v1/notifications/{notification_id}/read")
async def mark_reviewer_notification_read(
    notification_id: UUID, u: User = Depends(user), d=Depends(db)
):
    if u.role != "reviewer":
        raise HTTPException(403, "Reviewer notifications are available to reviewers.")
    rows = await d.rows(
        "reviewer_notifications",
        token=u.token,
        fields="id,read_at",
        filters={"id": "eq." + str(notification_id), "user_id": "eq." + u.id},
    )
    if not rows:
        raise HTTPException(404, "This notification is unavailable.")
    if not rows[0]["read_at"]:
        await d.call(
            "PATCH",
            "/rest/v1/reviewer_notifications",
            admin=True,
            params={"id": "eq." + str(notification_id), "user_id": "eq." + u.id},
            data={"read_at": datetime.now().astimezone().isoformat()},
        )
    return {"read": True}


@app.post("/v1/cases", status_code=403)
async def create_case(u: User = Depends(user)):
    raise HTTPException(403, "Only an administrator can create and assign a case.")


@app.get("/v1/cases/{cid}")
async def get_case(cid: UUID, u: User = Depends(user), d=Depends(db)):
    c = await d.one("cases", cid, token=u.token)
    f = {"case_id": "eq." + str(cid)}
    members, docs, all_versions, runs, jobs = await asyncio.gather(
        d.rows("case_members", token=u.token, filters=f),
        d.rows(
            "documents",
            token=u.token,
            filters={**f, "deleted_at": "is.null"},
        ),
        d.rows("document_versions", token=u.token, filters=f, order="created_at"),
        d.rows(
            "verification_runs",
            token=u.token,
            fields="id,created_at,status,manifest,config,usage",
            filters=f,
            order="created_at.desc,id.desc",
        ),
        d.rows(
            "jobs", token=u.token, fields=JOB_FIELDS, filters=f, order="created_at.desc"
        ),
    )
    prior_case_ids = []
    prior_case_titles = {}
    if c.get("inspection_kind") == "follow_up" and c.get("follow_up_root_id"):
        prior_cases = await d.rows(
            "cases",
            token=u.token,
            fields="id,title,inspection_on,follow_up_number",
            filters={
                "follow_up_root_id": "eq." + c["follow_up_root_id"],
                "inspection_on": "lt." + c["inspection_on"],
                "deleting": "eq.false",
            },
            order="inspection_on.asc,follow_up_number.asc",
        )
        prior_case_ids = [row["id"] for row in prior_cases]
        prior_case_titles = {row["id"]: row["title"] for row in prior_cases}
        if prior_case_ids:
            prior_filter = "in.(" + ",".join(prior_case_ids) + ")"
            prior_docs, prior_versions = await asyncio.gather(
                d.rows(
                    "documents",
                    token=u.token,
                    filters={"case_id": prior_filter, "deleted_at": "is.null"},
                ),
                d.rows(
                    "document_versions",
                    token=u.token,
                    filters={"case_id": prior_filter},
                    order="created_at",
                ),
            )
            docs.extend(
                {**row, "source_case_title": prior_case_titles.get(row["case_id"])}
                for row in prior_docs
            )
            all_versions.extend(prior_versions)
    active_document_ids = {row["id"] for row in docs}
    versions = [
        row for row in all_versions if row["document_id"] in active_document_ids
    ]
    return {
        "case": c,
        "role": members[0]["role"],
        "documents": docs,
        "versions": versions,
        "prior_case_ids": prior_case_ids,
        "runs": runs,
        "jobs": jobs,
    }


@app.get("/v1/cases/{cid}/followups")
async def evidence_followups(cid: UUID, u: User = Depends(user), d=Depends(db)):
    await d.one("cases", cid, token=u.token)
    case_filter = {"case_id": "eq." + str(cid)}
    events = await d.rows(
        "review_events",
        token=u.token,
        filters={**case_filter, "action": "neq.comment"},
        order="created_at.desc,id.desc",
    )
    decisions = {}
    for event in events:
        decisions.setdefault(event["result_id"], event)
    pending = {
        rid: event
        for rid, event in decisions.items()
        if event["action"] == "request_evidence"
    }
    if not pending:
        return []
    records = await d.rows(
        "results", token=u.token, fields="id,run_id,claim", filters=case_filter
    )
    findings = {result["id"]: result for result in records if result["id"] in pending}
    return [
        {
            "id": rid,
            "run_id": findings[rid]["run_id"],
            "source": findings[rid]["claim"]["source"],
            "event": event,
        }
        for rid, event in pending.items()
        if rid in findings
    ]


class Archive(BaseModel):
    archived: bool


async def case_to_manage(cid, request, u, d):
    if request.url.path.startswith("/v1/admin/"):
        if u.role != "admin":
            raise HTTPException(403, "Administrator access required.")
        return await d.one("cases", cid)
    case = await d.one("cases", cid, token=u.token)
    if case["created_by"] != u.id:
        raise HTTPException(403, "Only the case owner can manage this case.")
    return case


@app.patch("/v1/cases/{cid}")
@app.patch("/v1/admin/cases/{cid}")
async def archive_case(
    cid: UUID, body: Archive, request: Request, u: User = Depends(user), d=Depends(db)
):
    await case_to_manage(cid, request, u, d)
    await d.call(
        "PATCH",
        "/rest/v1/cases",
        admin=True,
        params={"id": "eq." + str(cid)},
        data={"archived": body.archived},
    )
    return {"archived": body.archived}


@app.delete("/v1/cases/{cid}", status_code=200)
@app.delete("/v1/admin/cases/{cid}", status_code=200)
async def delete_case(
    cid: UUID, request: Request, u: User = Depends(user), d=Depends(db)
):
    c = await case_to_manage(cid, request, u, d)
    linked_followups = await d.rows(
        "cases",
        fields="id,title",
        filters={"follow_up_of": "eq." + str(cid), "deleting": "eq.false"},
    )
    if linked_followups:
        raise HTTPException(
            409,
            "Delete later follow-up inspections first; this case provides their related files.",
        )
    # The tombstone prevents new jobs and reservations while cleanup is retried.
    await d.call(
        "PATCH",
        "/rest/v1/cases",
        admin=True,
        params={"id": "eq." + str(cid)},
        data={"deleting": True, "archived": True},
    )
    versions = await d.rows(
        "document_versions", fields="object_key", filters={"case_id": "eq." + str(cid)}
    )
    submissions = await d.rows(
        "corrective_evidence",
        fields="object_key",
        filters={"case_id": "eq." + str(cid)},
    )
    await d.remove(sorted({row["object_key"] for row in versions + submissions}))
    await d.call(
        "DELETE",
        "/rest/v1/cases",
        admin=True,
        params={"id": "eq." + str(cid), "created_by": "eq." + c["created_by"]},
    )
    return {"deleted": True}


@app.delete("/v1/cases/{cid}/documents/{did}")
async def remove_factory_document(
    cid: UUID, did: UUID, u: User = Depends(user), d=Depends(db)
):
    if u.role != "factory_manager":
        raise HTTPException(403, "Only the factory manager can remove factory documents.")
    case = await d.one("cases", cid, token=u.token)
    if case["archived"] or case["deleting"]:
        raise HTTPException(409, "This case is closed to document changes.")
    membership = await d.rows(
        "case_members",
        token=u.token,
        fields="role",
        filters={"case_id": "eq." + str(cid), "user_id": "eq." + u.id},
    )
    if not membership or membership[0]["role"] != "manager":
        raise HTTPException(403, "Factory manager access is required for this case.")

    document = await d.one("documents", did)
    if document["case_id"] != str(cid) or document.get("deleted_at"):
        raise HTTPException(404, "This document is unavailable.")
    versions = await d.rows(
        "document_versions",
        fields="id,issuer,status",
        filters={"case_id": "eq." + str(cid), "document_id": "eq." + str(did)},
    )
    if not versions:
        raise HTTPException(404, "This document has no uploaded versions.")
    if any(version["status"] in ("awaiting_upload", "queued") for version in versions):
        raise HTTPException(409, "Wait for document processing to finish before removing it.")

    await d.call(
        "PATCH",
        "/rest/v1/documents",
        admin=True,
        params={"id": "eq." + str(did), "case_id": "eq." + str(cid)},
        data={"deleted_at": datetime.now().astimezone().isoformat(), "deleted_by": u.id},
    )
    await d.call(
        "PATCH",
        "/rest/v1/document_versions",
        admin=True,
        params={"case_id": "eq." + str(cid), "document_id": "eq." + str(did)},
        data={"content_fingerprint": None, "duplicate_warning": None},
    )
    return {"deleted": True}


@app.post("/v1/cases/{cid}/uploads", response_model=UploadTicket)
async def reserve_upload(
    cid: UUID, body: UploadInput, u: User = Depends(user), d=Depends(db)
):
    case = await d.one("cases", cid, token=u.token)
    if case.get("inspection_on"):
        if u.role == "reviewer" and body.role != "inspection":
            raise HTTPException(
                403, "Reviewers can upload inspection reports only for this case."
            )
        if u.role == "factory_manager" and body.role == "inspection":
            raise HTTPException(
                403, "Factory managers cannot upload reviewer inspection reports."
            )
        if u.role == "factory_manager" and not body.issued_on:
            raise HTTPException(422, "Enter the factory document's issue date.")
    if u.role == "factory_manager" and body.role == "cap":
        existing_caps = await d.rows(
            "documents",
            token=u.token,
            fields="id",
            filters={
                "case_id": "eq." + str(cid),
                "role": "eq.cap",
                "deleted_at": "is.null",
            },
        )
        existing_cap_ids = {str(row["id"]) for row in existing_caps}
        requested_document_id = str(body.document_id) if body.document_id else None
        if requested_document_id and requested_document_id not in existing_cap_ids:
            raise HTTPException(
                422,
                "A CAP revision must use the existing CAP record for this case.",
            )
        if existing_caps and requested_document_id not in existing_cap_ids:
            raise HTTPException(
                409,
                "This case already has a CAP. Choose its existing record to upload a revision.",
            )
    version = await d.rpc(
        "reserve", cid=str(cid), actor_id=u.id, data=body.model_dump(mode="json")
    )
    url = (
        await d.signed(version["object_key"], upload=True)
        if version["status"] == "awaiting_upload"
        else None
    )
    return {"version_id": version["id"], "upload_url": url, "status": version["status"]}


@app.post("/v1/cases/{cid}/inspect-upload")
async def inspect_upload(
    cid: UUID, request: Request, u: User = Depends(user), d=Depends(db)
):
    case = await d.one("cases", cid, token=u.token)
    if case["archived"] or case["deleting"]:
        raise HTTPException(409, "This case is closed to document uploads.")
    form = await request.form()
    file = form.get("file")
    if file is None or not hasattr(file, "read"):
        raise HTTPException(422, "Choose a PDF to read its fields.")
    expected_role = str(form.get("role") or "")
    factory_record_roles = {
        "cap",
        "incident",
        "sop",
        "drill",
        "maintenance",
        "other",
    }
    if (
        u.role == "factory_manager"
        and expected_role
        and expected_role not in factory_record_roles
    ):
        raise HTTPException(
            422, "Choose a valid factory record type before checking this PDF."
        )
    data = await file.read()
    version_id = str(uuid4())
    try:
        parsed = await isolated_pdf(data, version_id, cfg.tessdata_prefix, 0, 8)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    fields = extract_metadata(
        parsed["pages"],
        getattr(file, "filename", "document.pdf") or "document.pdf",
        case.get("inspection_on") if u.role == "reviewer" else None,
    )
    content_pages = await parse_all_pdf_pages(
        data, version_id, parsed, cfg.tessdata_prefix
    )
    fields["content_fingerprint"] = content_fingerprint(content_pages, data)
    existing = await case_document_text(d, cid)
    fields["duplicate_of"] = await find_exact_duplicate(
        d,
        cid,
        fields["content_fingerprint"],
        hashlib.sha256(data).hexdigest(),
        existing,
    )
    fields["duplicate_warning"] = await find_duplicate_warning(
        d, cid, content_pages, fields, existing
    )
    if u.role == "reviewer" and case.get("inspection_on"):
        fields["pages_checked"] = len(content_pages)
        fields["readable_pages"] = sum(
            page.get("quality") == "readable" for page in content_pages
        )
        fields.update(
            await check_inspection_content(
                content_pages,
                getattr(file, "filename", "document.pdf") or "document.pdf",
                case["factory"],
                case["inspection_on"],
                request.app.state.ai,
            )
        )
    elif u.role == "factory_manager":
        fields["pages_checked"] = len(content_pages)
        fields["readable_pages"] = sum(
            page.get("quality") == "readable" for page in content_pages
        )
        filename = getattr(file, "filename", "factory-record.pdf") or "factory-record.pdf"
        if expected_role:
            fields["role"] = expected_role
            fields.update(
                await check_factory_record_content(
                    content_pages,
                    filename,
                    case["factory"],
                    case.get("inspection_on"),
                    expected_role,
                    request.app.state.ai,
                )
            )
        else:
            fields.update(
                await classify_factory_record_content(
                    content_pages,
                    filename,
                    case["factory"],
                    case.get("inspection_on"),
                    request.app.state.ai,
                )
            )
        factory_role = fields["role"]
        if factory_role == "cap":
            deadline = await case_cap_submission_deadline(d, cid, u.token)
            fields["cap_submission_deadline"] = deadline
            issue_date = fields.get("issued_on")
            fields["cap_deadline_warning"] = (
                cap_deadline_warning(issue_date, deadline) if deadline else None
            )
    else:
        fields.update(
            {
                "content_check": "not_applicable",
                "content_reason": None,
                "content_indicators": [],
                "content_model": None,
            }
        )
    return fields


async def case_document_text(d, cid):
    docs = await d.rows(
        "documents",
        fields="id,role",
        filters={"case_id": "eq." + str(cid), "deleted_at": "is.null"},
    )
    if not docs:
        return []
    roles_by_id = {row["id"]: row["role"] for row in docs}
    # Use only columns present in the base schema. The optional migration adds
    # fingerprint persistence, but OCR comparison also works from page text
    # and the existing PDF hash before that migration is installed.
    versions = await d.rows(
        "document_versions",
        fields="id,document_id,issued_on,period_start,period_end,status,sha256",
        filters={
            "case_id": "eq." + str(cid),
            "document_id": "in.({})".format(",".join(roles_by_id)),
            "status": "in.(queued,ready,partial)",
        },
    )
    records = []
    for version in versions:
        pages = await d.rows(
            "pages",
            fields="page_no,text",
            filters={"version_id": "eq." + version["id"]},
            order="page_no",
        )
        records.append(
            {
                **version,
                "role": roles_by_id.get(version["document_id"]),
                "pages": pages,
            }
        )
    return records


async def find_exact_duplicate(d, cid, fingerprint, raw_sha256=None, existing=None):
    if not fingerprint and not raw_sha256:
        return None
    records = existing if existing is not None else await case_document_text(d, cid)
    for record in records:
        if raw_sha256 and record.get("sha256") == raw_sha256:
            return record["id"]
        if content_fingerprint(record.get("pages", [])) == fingerprint:
            return record["id"]
    return None


async def find_duplicate_warning(d, cid, pages, metadata, existing=None):
    records = existing if existing is not None else await case_document_text(d, cid)
    return duplicate_candidate(pages, metadata, records)


async def case_cap_submission_deadline(d, cid, token):
    documents = await d.rows(
        "documents",
        token=token,
        fields="id",
        filters={"case_id": "eq." + str(cid), "role": "eq.inspection"},
    )
    document_ids = {row["id"] for row in documents}
    if not document_ids:
        return None
    versions = await d.rows(
        "document_versions",
        token=token,
        fields="id,document_id,status",
        filters={"case_id": "eq." + str(cid)},
        order="created_at.desc",
    )
    report = next(
        (
            version
            for version in versions
            if version["document_id"] in document_ids
            and version["status"] in ("ready", "partial")
        ),
        None,
    )
    if not report:
        return None
    pages = await d.rows(
        "pages",
        token=token,
        fields="page_no,text",
        filters={"version_id": "eq." + report["id"]},
        order="page_no",
    )
    return extract_cap_submission_deadline(pages)


def cap_deadline_warning(issue_date, deadline):
    if issue_date and deadline and issue_date > deadline:
        return (
            f"CAP issued on {issue_date}, after the inspection report's CAP "
            f"submission deadline ({deadline}). Reviewer review required."
        )
    return None


@app.post("/v1/document-versions/{vid}/finalize", status_code=202)
async def finalize(vid: UUID, request: Request, u: User = Depends(user), d=Depends(db)):
    v = await d.one("document_versions", vid, token=u.token)
    data = parsed = content_pages = None
    if u.role == "reviewer":
        case = await d.one("cases", v["case_id"], token=u.token)
        if case.get("inspection_on"):
            document = await d.one(
                "documents", v["document_id"], token=u.token, fields="role"
            )
            if document["role"] == "inspection":
                data = await d.download(v["object_key"])
                try:
                    parsed = await isolated_pdf(
                        data, str(vid), cfg.tessdata_prefix, 0, 8
                    )
                except ValueError as exc:
                    raise HTTPException(422, str(exc)) from exc
                content_pages = await parse_all_pdf_pages(
                    data, str(vid), parsed, cfg.tessdata_prefix
                )
                metadata = extract_metadata(
                    parsed["pages"],
                    v.get("filename") or "inspection.pdf",
                    case["inspection_on"],
                )
                if (
                    metadata["inspection_date"]
                    and metadata["inspection_date"] != case["inspection_on"]
                ):
                    raise HTTPException(
                        422,
                        "The PDF inspection date must match the date scheduled by the admin.",
                    )
                if (
                    not metadata["inspection_date"]
                    and v.get("issued_on") != case["inspection_on"]
                ):
                    raise HTTPException(
                        422,
                        "Enter the admin-scheduled inspection date when OCR cannot read it from the PDF.",
                    )
                content_check = await check_inspection_content(
                    content_pages,
                    v.get("filename") or "inspection.pdf",
                    case["factory"],
                    case["inspection_on"],
                    request.app.state.ai,
                )
                if content_check["content_check"] not in (
                    "valid",
                    "not_configured",
                ):
                    raise HTTPException(
                        422,
                        content_check["content_reason"]
                        or "This PDF could not be confirmed as an inspection report.",
                    )
                if (
                    content_check["content_check"] == "not_configured"
                    and metadata["readable_pages"] > 0
                    and metadata["role"] != "inspection"
                ):
                    raise HTTPException(
                        422,
                        "Reviewers can upload inspection reports only for this case.",
                    )
    elif u.role == "factory_manager":
        case = await d.one("cases", v["case_id"], token=u.token)
        if case.get("inspection_on"):
            document = await d.one(
                "documents", v["document_id"], token=u.token, fields="role"
            )
            if document["role"] == "inspection":
                raise HTTPException(
                    403, "Factory managers cannot submit reviewer inspection reports."
                )
            data = await d.download(v["object_key"])
            try:
                parsed = await isolated_pdf(data, str(vid), cfg.tessdata_prefix, 0, 8)
            except ValueError as exc:
                raise HTTPException(422, str(exc)) from exc
            content_pages = await parse_all_pdf_pages(
                data, str(vid), parsed, cfg.tessdata_prefix
            )
            metadata = extract_metadata(
                parsed["pages"],
                v.get("filename") or "factory-record.pdf",
                case["inspection_on"],
            )
            content_check = await check_factory_record_content(
                content_pages,
                v.get("filename") or "factory-record.pdf",
                case["factory"],
                case["inspection_on"],
                document["role"],
                request.app.state.ai,
            )
            valid_without_ai = (
                content_check["content_check"] == "not_configured"
                and metadata["readable_pages"] > 0
                and metadata["role"] == document["role"]
            )
            if content_check["content_check"] != "valid" and not valid_without_ai:
                raise HTTPException(
                    422,
                    content_check["content_reason"]
                    or "This PDF could not be confirmed as the selected factory record type.",
                )
            if document["role"] == "cap":
                deadline = await case_cap_submission_deadline(d, v["case_id"], u.token)
                warning = cap_deadline_warning(v.get("issued_on"), deadline)
                try:
                    await d.call(
                        "PATCH",
                        "/rest/v1/document_versions",
                        admin=True,
                        params={"id": "eq." + str(vid)},
                        data={"cap_deadline_warning": warning},
                    )
                except PlatformError:
                    # CAP upload remains usable before the optional warning
                    # column migration is applied.
                    pass
    # Repeat duplicate detection on the server after the private upload. The
    # database RPC serializes fingerprint registration per case, so parallel
    # uploads cannot bypass this check.
    if data is None:
        data = await d.download(v["object_key"])
    if parsed is None:
        try:
            parsed = await isolated_pdf(data, str(vid), cfg.tessdata_prefix, 0, 8)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
    if content_pages is None:
        content_pages = await parse_all_pdf_pages(
            data, str(vid), parsed, cfg.tessdata_prefix
        )
    metadata = extract_metadata(
        parsed["pages"], v.get("filename") or "document.pdf", None
    )
    fingerprint = content_fingerprint(content_pages, data)
    existing = await case_document_text(d, v["case_id"])
    known_duplicate = await find_exact_duplicate(
        d, v["case_id"], fingerprint, hashlib.sha256(data).hexdigest(), existing
    )
    warning = await find_duplicate_warning(
        d, v["case_id"], content_pages, metadata, existing
    )
    if known_duplicate:
        duplicate_id = known_duplicate
        await d.call(
            "PATCH",
            "/rest/v1/document_versions",
            admin=True,
            params={"id": "eq." + str(vid)},
            data={
                "status": "duplicate",
                "duplicate_of": known_duplicate,
                "error": "This PDF repeats readable document text already uploaded in this case.",
            },
        )
    else:
        try:
            duplicate_id = await d.rpc(
                "register_document_fingerprint",
                cid=v["case_id"],
                actor_id=u.id,
                vid=str(vid),
                fingerprint=fingerprint,
                warning=warning,
                existing_duplicate=None,
            )
        except PlatformError:
            # Before migration, exact duplicates are still caught above. The
            # optional database-persisted warning and race-safe index wait for
            # the SQL migration, but normal uploads must continue to work.
            duplicate_id = None
    if duplicate_id:
        await d.remove([v["object_key"]])
        raise HTTPException(
            409,
            "This PDF contains the same readable document text as an existing upload in this case. It was blocked as a duplicate.",
        )
    jid = await d.rpc("ingest", cid=v["case_id"], actor_id=u.id, vid=str(vid))
    await schedule_work(request)
    if u.role == "factory_manager":
        try:
            case = await d.one("cases", v["case_id"], token=u.token)
            if case.get("reviewer_id"):
                document = await d.one(
                    "documents", v["document_id"], token=u.token, fields="title"
                )
                await d.call(
                    "POST",
                    "/rest/v1/reviewer_notifications",
                    admin=True,
                    data={
                        "user_id": case["reviewer_id"],
                        "case_id": v["case_id"],
                        "document_id": v["document_id"],
                        "version_id": str(vid),
                        "title": "Factory evidence uploaded",
                        "body": f'{document["title"]} was uploaded for {case["factory"]}.',
                    },
                    headers={"Prefer": "resolution=ignore-duplicates,return=minimal"},
                )
        except PlatformError as exc:
            # The accepted upload should remain successful if notification
            # persistence is temporarily unavailable.
            logger.warning(
                "Could not create reviewer upload notification (Supabase status %s).",
                exc.status,
            )
    return {"job_id": jid}


@app.get("/v1/document-versions/{vid}/pages")
async def pages(
    vid: UUID,
    offset: int = Query(default=0, ge=0),
    limit: int | None = Query(default=None, ge=1, le=20),
    u: User = Depends(user),
    d=Depends(db),
):
    await d.one("document_versions", vid, token=u.token)
    if u.role == "factory_manager":
        return await d.rows(
            "pages",
            fields="id,page_no,method,quality,text",
            filters={"version_id": "eq." + str(vid), "page_no": "gt." + str(offset)},
            order="page_no",
        )
    if limit is not None:
        return await d.call(
            "GET",
            "/rest/v1/pages",
            token=u.token,
            params={
                "version_id": "eq." + str(vid),
                "select": "id,page_no,method,quality,text",
                "order": "page_no",
                "offset": offset,
                "limit": limit,
            },
        )
    return await d.rows(
        "pages",
        token=u.token,
        filters={"version_id": "eq." + str(vid), "page_no": "gt." + str(offset)},
        order="page_no",
    )


@app.get("/v1/document-versions/{vid}/source")
async def source(vid: UUID, u: User = Depends(user), d=Depends(db)):
    v = await d.one("document_versions", vid, token=u.token)
    if v["status"] not in ("ready", "partial"):
        raise HTTPException(409, "This document is not ready for preview.")
    return {"url": await d.signed(v["object_key"]), "expires_in": 300}


@app.post("/v1/cases/{cid}/samples", status_code=202)
async def add_samples(
    cid: UUID, request: Request, u: User = Depends(user), d=Depends(db)
):
    c = await d.one("cases", cid, token=u.token)
    catalog = samples()
    if c["inspection_on"]:
        raise HTTPException(
            403,
            "Scheduled cases use reports uploaded by the assigned reviewer and records from the factory manager.",
        )
    if c["factory"] != catalog["factory"]:
        raise HTTPException(
            409,
            "These sample documents belong to the factory listed in the document library.",
        )
    for meta in catalog["documents"]:
        v = await d.rpc(
            "reserve",
            cid=str(cid),
            actor_id=u.id,
            data={
                **meta,
                "request_key": str(uuid5(cid, meta["filename"])),
                "confirmed_factory": c["factory"],
            },
        )
        if v["status"] == "awaiting_upload":
            try:
                await d.put(
                    v["object_key"], (cfg.sample_dir / meta["filename"]).read_bytes()
                )
            except PlatformError as exc:
                if (
                    "already exists" not in str(exc).lower()
                    and "duplicate" not in str(exc).lower()
                ):
                    raise
        await d.rpc("ingest", cid=str(cid), actor_id=u.id, vid=v["id"])
    await schedule_work(request)
    return {"documents": len(catalog["documents"])}


@app.post("/v1/cases/{cid}/runs", response_model=RunTicket, status_code=202)
async def new_run(
    cid: UUID, body: RunInput, request: Request, u: User = Depends(user), d=Depends(db)
):
    await d.one("cases", cid, token=u.token)
    if not cfg.gemini_keys():
        raise HTTPException(
            503, "The service needs a Gemini API key to run verification."
        )
    ticket = await d.rpc(
        "run",
        cid=str(cid),
        actor_id=u.id,
        vids=[str(v) for v in body.version_ids],
        request_id=str(body.request_key),
        configuration=cfg.provenance(),
    )
    await schedule_work(request)
    return ticket


@app.get("/v1/jobs/{jid}")
async def job(jid: UUID, u: User = Depends(user), d=Depends(db)):
    record = await d.one("jobs", jid, fields=JOB_FIELDS, token=u.token)
    if cfg.queue_enabled and record["state"] == "queued":
        from .queue import publish

        await publish(str(jid), record["available_at"])
    return record


@app.post("/v1/jobs/{jid}/retry", status_code=202)
async def retry(jid: UUID, request: Request, u: User = Depends(user), d=Depends(db)):
    j = await d.one("jobs", jid, fields=JOB_FIELDS, token=u.token)
    await d.rpc("retry", cid=j["case_id"], actor_id=u.id, jid=str(jid))
    await schedule_work(request)
    return {"job_id": str(jid)}


@app.get("/v1/runs/{rid}")
async def get_run(rid: UUID, u: User = Depends(user), d=Depends(db)):
    return await d.one("verification_runs", rid, token=u.token)


async def ranked_results(run, u, d):
    rows = await d.rows("results", token=u.token, filters={"run_id": "eq." + run["id"]})
    notes = await d.rows(
        "review_events",
        token=u.token,
        filters={"case_id": "eq." + run["case_id"]},
        order="created_at,id",
    )
    by_result = {}
    for note in notes:
        by_result.setdefault(note["result_id"], []).append(note)
    for row in rows:
        row["reviews"] = by_result.get(row["id"], [])
    severity = {"high": 0, "medium": 1, "low": 2, "unknown": 3}
    outcome_order = {
        "contradicted": 0,
        "unresolved": 1,
        "unsupported": 2,
        "needs_review": 3,
        "not_assessed": 4,
        "supported": 5,
    }
    return sorted(
        rows,
        key=lambda r: (
            severity.get(r["claim"].get("severity"), 3),
            outcome_order[r["outcome"]],
            r["claim"]["source"]["page"],
            r["id"],
        ),
    )


@app.get("/v1/runs/{rid}/results", response_model=list[PublishedResult])
async def results(rid: UUID, u: User = Depends(user), d=Depends(db)):
    return await ranked_results(
        await d.one("verification_runs", rid, token=u.token), u, d
    )


@app.post("/v1/results/{rid}/reviews", status_code=201)
async def review(rid: UUID, body: ReviewInput, u: User = Depends(user), d=Depends(db)):
    result = await d.one("results", rid, token=u.token)
    eid = await d.rpc(
        "review",
        cid=result["case_id"],
        actor_id=u.id,
        rid=str(rid),
        data=body.model_dump(),
    )
    return {"event_id": eid}


@app.get("/v1/runs/{rid}/report")
async def report(rid: UUID, u: User = Depends(user), d=Depends(db)):
    run = await d.one("verification_runs", rid, token=u.token)
    if run["status"] not in ("complete", "partial"):
        raise HTTPException(409, "This analysis is still incomplete.")
    return {
        "case": await d.one("cases", run["case_id"], token=u.token),
        "run": run,
        "results": await ranked_results(run, u, d),
        "cap_reviews": await cap_events(run["id"], u, d)
        if run["cap_analysis"] is not None
        else [],
    }


async def cap_events(rid, u, d):
    return await d.rows(
        "cap_review_events",
        token=u.token,
        filters={"run_id": "eq." + str(rid)},
        order="created_at,id",
    )


@app.get("/v1/runs/{rid}/cap")
async def cap_report(rid: UUID, u: User = Depends(user), d=Depends(db)):
    run = await d.one("verification_runs", rid, token=u.token)
    if run["status"] not in ("complete", "partial"):
        raise HTTPException(409, "This analysis is still incomplete.")
    return {"analysis": run["cap_analysis"], "reviews": await cap_events(rid, u, d)}


@app.post("/v1/runs/{rid}/cap/reviews", status_code=201)
async def review_cap(
    rid: UUID, body: CapReviewInput, u: User = Depends(user), d=Depends(db)
):
    await d.one("verification_runs", rid, token=u.token)
    event = await d.rpc(
        "cap_review",
        rid=str(rid),
        actor_id=u.id,
        finding=str(body.finding_id),
        cap_action=str(body.action_id),
        choice=body.decision,
        note=body.comment.strip(),
    )
    return {"event_id": event}


@app.get("/v1/runs/{rid}/retrieval")
async def retrieval(rid: UUID, u: User = Depends(user), d=Depends(db)):
    """Expose ranked source passages for evaluation and inspection within the same case."""
    run = await d.one("verification_runs", rid, token=u.token)
    records = await d.rows(
        "results",
        token=u.token,
        fields="id,coverage",
        filters={"run_id": "eq." + run["id"]},
    )
    ids = {key for row in records for key in row["coverage"]["retrieved"]}
    by_id = {}
    ordered = sorted(ids)
    for i in range(0, len(ordered), 60):
        chunk_ids = ordered[i : i + 60]
        batch = await d.rows(
            "chunks",
            token=u.token,
            fields="id,version_id,page_no,text",
            filters={
                "case_id": "eq." + run["case_id"],
                "id": "in.(" + ",".join(chunk_ids) + ")",
            },
        )
        by_id.update({c["id"]: c for c in batch})
    return {
        r["id"]: [by_id[key] for key in r["coverage"]["retrieved"] if key in by_id]
        for r in records
    }


class ManagerShare(BaseModel):
    email: str = Field(min_length=3, max_length=254)


class TaskInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    title: str = Field(min_length=1, max_length=160)
    detail: str = Field(default="", max_length=3000)
    assignee: str = Field(min_length=1, max_length=120)
    due_on: date


class TaskDecision(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    action: Literal["started", "return", "accept", "comment"]
    note: str = Field(default="", max_length=3000)


async def corrective_role(d, u, cid):
    membership = await d.rows(
        "case_members",
        token=u.token,
        fields="role",
        filters={"case_id": "eq." + str(cid)},
    )
    if not membership or membership[0]["role"] not in ("reviewer", "manager"):
        raise HTTPException(404, "Corrective work is unavailable.")
    return membership[0]["role"]


def corrective_deadline_passed(task):
    deadline = date.fromisoformat(task["due_on"])
    today = datetime.now(ZoneInfo("Asia/Dhaka")).date()
    return today > deadline


@app.post("/v1/cases/{cid}/share-manager", status_code=201)
async def share_manager(
    cid: UUID, body: ManagerShare, u: User = Depends(user), d=Depends(db)
):
    if await corrective_role(d, u, cid) != "reviewer":
        raise HTTPException(403, "Review access required.")
    await d.rpc(
        "share_manager", cid=str(cid), actor_id=u.id, manager_email=body.email.strip()
    )
    return {"shared": True}


@app.get("/v1/cases/{cid}/corrective-work")
async def corrective_work(cid: UUID, u: User = Depends(user), d=Depends(db)):
    role = await corrective_role(d, u, cid)
    filters = {"case_id": "eq." + str(cid)}
    tasks, evidence, events = await asyncio.gather(
        d.rows("corrective_tasks", token=u.token, filters=filters, order="due_on,id"),
        d.rows(
            "corrective_evidence",
            token=u.token,
            fields="id,task_id,filename,imported_version,created_at",
            filters=filters,
            order="created_at,id",
        ),
        d.rows(
            "corrective_events", token=u.token, filters=filters, order="created_at,id"
        ),
    )
    return {"role": role, "tasks": tasks, "evidence": evidence, "events": events}


@app.post("/v1/cases/{cid}/corrective-work", status_code=201)
async def create_task(
    cid: UUID, body: TaskInput, u: User = Depends(user), d=Depends(db)
):
    if await corrective_role(d, u, cid) != "reviewer":
        raise HTTPException(403, "Only reviewers assign corrective tasks.")
    tid = await d.rpc(
        "corrective_task",
        cid=str(cid),
        actor_id=u.id,
        payload=body.model_dump(mode="json"),
    )
    return {"id": tid}


@app.post("/v1/corrective-tasks/{tid}/events")
async def task_event(
    tid: UUID, body: TaskDecision, u: User = Depends(user), d=Depends(db)
):
    task = await d.one("corrective_tasks", tid, token=u.token)
    expected_role = "manager" if body.action in ("started", "comment") else "reviewer"
    if await corrective_role(d, u, task["case_id"]) != expected_role:
        raise HTTPException(403, "This action requires the other workspace role.")
    if body.action == "comment" and not body.note:
        raise HTTPException(422, "Enter a comment.")
    if body.action == "return" and not body.note:
        raise HTTPException(422, "Explain what needs to be revised.")
    await d.rpc(
        "corrective_event",
        tid=str(tid),
        actor_id=u.id,
        event_name=body.action,
        note=body.note,
    )
    return {"updated": True}


@app.post("/v1/corrective-tasks/{tid}/evidence", status_code=201)
async def submit_task_evidence(
    tid: UUID,
    request: Request,
    filename: str,
    u: User = Depends(user),
    d=Depends(db),
    content_type: str = Header(default=""),
):

    task = await d.one("corrective_tasks", tid, token=u.token)
    if await corrective_role(d, u, task["case_id"]) != "manager":
        raise HTTPException(403, "Factory Manager access required.")
    if corrective_deadline_passed(task):
        raise HTTPException(
            409, "This task deadline has passed. Evidence can no longer be submitted."
        )
    if task["status"] not in {"assigned", "in_progress", "needs_revision"}:
        raise HTTPException(409, "This task is not accepting evidence.")
    filename = filename.strip()
    if (
        not filename.lower().endswith(".pdf")
        or len(filename) > 200
        or any(ord(c) < 32 or c in "/\\" for c in filename)
    ):
        raise HTTPException(422, "Choose a PDF with a valid filename.")
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
    if content_type.split(";")[0] != "application/pdf" or b"%PDF-" not in data[:1024]:
        raise HTTPException(422, "Choose a PDF file.")
    evidence_id = str(uuid4())
    key = f"{task['case_id']}/corrective/{evidence_id}.pdf"
    await d.put(key, bytes(data))
    try:
        await d.rpc(
            "corrective_event",
            tid=str(tid),
            actor_id=u.id,
            event_name="submitted",
            note="",
            evidence_id=evidence_id,
            original_filename=filename,
        )
    except PlatformError as exc:
        if exc.status < 500:
            await d.remove([key])
        raise
    return {"id": evidence_id}


class CorrectiveUpload(BaseModel):
    filename: str = Field(min_length=1, max_length=200)


class CorrectiveFinalize(BaseModel):
    receipt: str = Field(min_length=1, max_length=2000)


@app.post("/v1/corrective-tasks/{tid}/uploads", status_code=201)
async def reserve_corrective_upload(
    tid: UUID, body: CorrectiveUpload, u: User = Depends(user), d=Depends(db)
):
    from .upload_tokens import issue

    task = await d.one("corrective_tasks", tid, token=u.token)
    if await corrective_role(d, u, task["case_id"]) != "manager":
        raise HTTPException(403, "Factory Manager access required.")
    if corrective_deadline_passed(task):
        raise HTTPException(
            409, "This task deadline has passed. Evidence can no longer be submitted."
        )
    if task["status"] not in {"assigned", "in_progress", "needs_revision"}:
        raise HTTPException(409, "This task is not accepting evidence.")
    try:
        filename = UploadInput.pdf_name(body.filename.strip())
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    evidence_id = str(uuid4())
    key = f"{task['case_id']}/corrective/{evidence_id}.pdf"
    return {
        "upload_url": await d.signed(key, upload=True),
        "receipt": issue(
            cfg.supabase_service_role_key,
            {
                "task": str(tid),
                "actor": u.id,
                "id": evidence_id,
                "filename": filename,
            },
        ),
    }


@app.post("/v1/corrective-tasks/{tid}/uploads/finalize", status_code=201)
async def finalize_corrective_upload(
    tid: UUID, body: CorrectiveFinalize, u: User = Depends(user), d=Depends(db)
):
    from .upload_tokens import verify

    try:
        receipt = verify(cfg.supabase_service_role_key, body.receipt)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    if receipt["task"] != str(tid) or receipt["actor"] != u.id:
        raise HTTPException(403, "This upload belongs to another task or account.")
    task = await d.one("corrective_tasks", tid, token=u.token)
    if await corrective_role(d, u, task["case_id"]) != "manager":
        raise HTTPException(403, "Factory Manager access required.")
    existing = await d.rows(
        "corrective_evidence", token=u.token, filters={"id": "eq." + receipt["id"]}
    )
    if existing:
        return {"id": receipt["id"]}
    if corrective_deadline_passed(task):
        key = f"{task['case_id']}/corrective/{receipt['id']}.pdf"
        try:
            await d.remove([key])
        except PlatformError:
            pass
        raise HTTPException(
            409, "This task deadline has passed. Evidence can no longer be submitted."
        )
    if task["status"] not in {"assigned", "in_progress", "needs_revision"}:
        raise HTTPException(409, "This task is not accepting evidence.")
    key = f"{task['case_id']}/corrective/{receipt['id']}.pdf"
    data = await d.download(key)
    if b"%PDF-" not in data[:1024]:
        await d.remove([key])
        raise HTTPException(422, "Choose a valid PDF.")
    await d.rpc(
        "corrective_event",
        tid=str(tid),
        actor_id=u.id,
        event_name="submitted",
        note="",
        evidence_id=receipt["id"],
        original_filename=receipt["filename"],
    )
    return {"id": receipt["id"]}


@app.get("/v1/corrective-evidence/{eid}/source")
async def corrective_source(eid: UUID, u: User = Depends(user), d=Depends(db)):
    evidence = await d.one("corrective_evidence", eid, token=u.token)
    return {"url": await d.signed(evidence["object_key"])}


@app.post("/v1/corrective-evidence/{eid}/import", status_code=202)
async def import_corrective_evidence(
    eid: UUID, request: Request, u: User = Depends(user), d=Depends(db)
):
    evidence = await d.one("corrective_evidence", eid, token=u.token)
    if await corrective_role(d, u, evidence["case_id"]) != "reviewer":
        raise HTTPException(403, "Review access required.")
    job_id = await d.rpc("corrective_import", eid=str(eid), actor_id=u.id)
    await schedule_work(request)
    return {"job_id": job_id}
