"""Account onboarding uses Supabase Auth and private Postgres profile records."""

import hashlib
import io
import re
import secrets
from calendar import monthrange
from datetime import UTC, date, datetime
from typing import Literal
from urllib.parse import urlencode
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse
from PIL import Image
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .models import CaseInput, CaseRecord
from .platform import PlatformError

EMAIL = re.compile(r"[^\s@]+@[^\s@]+\.[^\s@]+")
REVIEWER_USERNAME = re.compile(r"[a-zA-Z0-9._-]+")
ORGANIZATIONS = (
    {"name": "BGMEA", "email_domain": "bgmea-demo.test"},
    {"name": "BKMEA", "email_domain": "bkmea-demo.test"},
    {
        "name": "Department of Inspection for Factories and Establishments (DIFE)",
        "email_domain": "dife-demo.test",
    },
    {"name": "RMG Sustainability Council (RSC)", "email_domain": "rsc-demo.test"},
)
INVALID_INVITE = (
    "Invite invalid, expired or already used. Ask the admin for a new link."
)
CARD_LIMIT = 5 * 1024 * 1024
CARD_BUCKET = "manager-id-cards"
CARD_TYPES = {"PNG": "image/png", "JPEG": "image/jpeg"}
ROLE_TYPES = Literal[
    "Compliance Officer", "Independent Auditor", "Buyer Sustainability Team"
]
PROFILE_FIELDS = "id,email,full_name,role,status,organization,role_type,phone,job_title,requested_factory_id,factory_id,id_card_deleted_at,id_card_number,membership_number,consent_at,reject_reason,created_at"


class Identity(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email: str = Field(max_length=254)

    @field_validator("email")
    @classmethod
    def valid_email(cls, value):
        value = value.strip().lower()
        if not EMAIL.fullmatch(value):
            raise ValueError("Enter a valid email address.")
        return value


class Login(Identity):
    password: str = Field(min_length=1, max_length=72, repr=False)


class WorkspaceLogin(Login):
    workspace: Literal["factory_manager", "reviewer"] | None = None


class Reviewer(Identity):
    full_name: str = Field(min_length=1, max_length=160)
    organization: str | None = Field(default=None, max_length=160)
    role_type: ROLE_TYPES | None = None


class ReviewerRequest(Reviewer):
    website: str = Field(default="", max_length=200)


class AccountProfile(BaseModel):
    id: UUID
    full_name: str
    email: str
    role: str
    organization: str | None
    role_type: str | None
    phone: str | None = None
    job_title: str | None = None
    status: str
    created_at: datetime
    factory_id: UUID | None
    id_card_number: str | None = None
    membership_number: str | None = None
    consent_at: datetime | None = None


class Assignments(BaseModel):
    factory_ids: list[UUID] = Field(max_length=30)


class FactoryInput(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    address: str = Field(min_length=1, max_length=500)

    @field_validator("name", "address")
    @classmethod
    def nonblank(cls, value):
        value = value.strip()
        if not value:
            raise ValueError("This field is required.")
        return value


class AssignedCaseInput(CaseInput):
    reviewer_id: UUID
    inspection_on: date | None = None
    inspection_kind: Literal["initial", "follow_up"] = "initial"
    follow_up_of: UUID | None = None

    @model_validator(mode="after")
    def inspection_period(self):
        if self.inspection_on:
            day = self.inspection_on
            start = day.replace(day=1)
            end = day.replace(day=monthrange(day.year, day.month)[1])
            self.period_start = self.period_start or start
            self.period_end = self.period_end or end
            if not start <= self.period_start <= day <= self.period_end <= end:
                raise ValueError(
                    "The case period must be in the inspection month and include the visit date."
                )
        return self


class Manager(Login):
    full_name: str = Field(min_length=1, max_length=160)
    phone: str = Field(min_length=6, max_length=32)
    factory_id: UUID
    job_title: str = Field(default="Factory Manager", min_length=1, max_length=120)
    id_card_number: str | None = Field(default=None, max_length=120)
    membership_number: str | None = Field(default=None, max_length=120)
    consent: Literal[True]
    website: str = Field(default="", max_length=200)
    upload_key: str = Field(pattern=r"^[a-f0-9]{32}/[a-f0-9]{32}$")


class Token(BaseModel):
    model_config = ConfigDict(extra="forbid")
    token: str = Field(min_length=1, max_length=200, repr=False)


class SetPassword(Token):
    password: str = Field(min_length=8, max_length=72, repr=False)


class Decision(BaseModel):
    factory_id: UUID | None = None
    reason: str | None = Field(default=None, max_length=1500)


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def check_password(value):
    if len(value) < 8 or len(value.encode()) > 72 or "\x00" in value:
        raise HTTPException(
            422, "Use at least 8 characters and at most 72 UTF-8 bytes."
        )


async def rate(db, request, scope, limit, identity=""):
    # Vercel sets the client IP on ingress. Local requests use the socket peer.
    from os import environ

    ip = (
        request.headers.get("x-vercel-forwarded-for", "").split(",")[0].strip()
        if environ.get("VERCEL")
        else ""
    )
    ip = ip or (request.client.host if request.client else "unknown")
    if not await db.rpc(
        "account_rate", scope_name=scope, hashed_key=digest(ip), limit_count=limit
    ):
        raise HTTPException(429, "Too many attempts. Try again later.")
    if identity and not await db.rpc(
        "account_rate",
        scope_name=scope + "-identity",
        hashed_key=digest(identity),
        limit_count=10,
    ):
        raise HTTPException(429, "Too many attempts. Try again later.")


async def provision(db, email, profile, password=None):
    try:
        auth = await db.call(
            "POST",
            "/auth/v1/admin/users",
            admin=True,
            data={"email": email, "email_confirm": True},
        )
    except PlatformError as exc:
        if exc.status in (400, 409, 422):
            raise HTTPException(
                409, "An account or application already uses this email."
            ) from exc
        raise HTTPException(
            503, "Account provisioning is temporarily unavailable."
        ) from exc
    uid = auth["id"]
    try:
        await db.rpc("register_profile", uid=uid, p=profile, secret=password)
    except PlatformError as exc:
        # Do not delete an account if a timed-out transaction actually committed.
        existing = await db.rows(
            "account_profiles", fields="id", filters={"id": "eq." + uid}
        )
        if not existing:
            await db.call("DELETE", "/auth/v1/admin/users/" + uid, admin=True)
            raise HTTPException(
                503, "Account provisioning is temporarily unavailable."
            ) from exc
    return uid


async def factory(db, fid):
    return await db.one("factories", fid)


async def replace_assignments(db, uid, ids):
    await db.rpc(
        "reviewer_assign",
        uid=str(uid),
        factories=list(dict.fromkeys(str(i) for i in ids)),
    )


def require_name(value):
    if not value.strip():
        raise HTTPException(422, "Full name is required.")
    return value.strip()


def reviewer_profile(body: Reviewer, status: str):
    organization = (body.organization or "").strip()
    if not organization:
        raise HTTPException(422, "Select an organization or enter its name.")
    for entry in ORGANIZATIONS:
        if organization.casefold() == entry["name"].casefold():
            organization = entry["name"]
            username, _, domain = body.email.rpartition("@")
            if domain != entry["email_domain"]:
                raise HTTPException(
                    422, f"Use an email ending in @{entry['email_domain']}."
                )
            if not REVIEWER_USERNAME.fullmatch(username):
                raise HTTPException(
                    422,
                    "Use only letters, numbers, dots, hyphens or underscores before @.",
                )
            break
    return {
        "role": "reviewer",
        "status": status,
        "full_name": require_name(body.full_name),
        "organization": organization,
        "role_type": body.role_type,
    }


def card_type(data):
    if not data or len(data) > CARD_LIMIT:
        raise HTTPException(413, "Upload an office ID card up to 5 MB.")
    if data.startswith(b"%PDF-") and b"%%EOF" in data[-2048:]:
        import pypdfium2

        try:
            with pypdfium2.PdfDocument(data) as document:
                if not 1 <= len(document) <= 5:
                    raise ValueError()
            return "application/pdf"
        except Exception:
            raise HTTPException(
                422, "Upload a readable office ID PDF of up to five pages."
            ) from None
    if data.startswith((b"\x89PNG\r\n\x1a\n", b"\xff\xd8\xff")):
        try:
            with Image.open(io.BytesIO(data)) as image:
                kind = CARD_TYPES[image.format]
                if image.width * image.height > 20_000_000:
                    raise ValueError()
                image.verify()
            return kind
        except (
            ValueError,
            KeyError,
            OSError,
            SyntaxError,
            Image.DecompressionBombError,
        ):
            pass
    raise HTTPException(422, "Upload a valid JPG, PNG or PDF office ID card.")


def extract_card_number(text):
    label = re.compile(r"\b(?:ID|IDENTITY|NUMBER|NO\.?|#)\b", re.IGNORECASE)
    candidate = re.compile(
        r"(?<![A-Z0-9])([A-Z0-9]{2,}(?:[-/][A-Z0-9]{1,}){1,3})(?![A-Z0-9])",
        re.IGNORECASE,
    )
    lines = [" ".join(line.split()) for line in text.splitlines() if line.strip()]
    for index, line in enumerate(lines):
        found_label = label.search(line)
        if not found_label:
            continue
        same_line = candidate.search(line[found_label.end() :])
        if same_line:
            return same_line.group(1).upper()
        for following in lines[index + 1 : index + 3]:
            match = candidate.search(following)
            if match:
                return match.group(1).upper()
    matches = [
        value
        for value in candidate.findall(text.upper())
        if re.search(r"[A-Z]", value) and re.search(r"\d", value)
    ]
    return matches[0] if len(matches) == 1 else None


def read_card_text(data, kind, tessdata):
    if kind == "application/pdf":
        from .pdf import parse_pdf

        parsed = parse_pdf(data, str(uuid4()), tessdata, batch_size=1)
        text = parsed["pages"][0]["text"] if parsed["pages"] else ""
    else:
        import tesserocr
        from PIL import ImageOps

        with Image.open(io.BytesIO(data)) as source:
            image = ImageOps.exif_transpose(source).convert("L")
            image = ImageOps.autocontrast(image)
            if max(image.size) > 2400:
                image.thumbnail((2400, 2400))
            with tesserocr.PyTessBaseAPI(
                path=tessdata, lang="eng+ben", psm=tesserocr.PSM.AUTO
            ) as api:
                api.SetImage(image)
                text = api.GetUTF8Text()
            image.close()
    return text


def read_card_number(data, kind, tessdata):
    return extract_card_number(read_card_text(data, kind, tessdata))


def normalized_card_text(value):
    return " ".join(re.findall(r"[a-z0-9]+", value.casefold()))


async def manager_card_review(db, row, card_path):
    if row["status"] != "pending_approval":
        return None
    if not card_path:
        return {
            "card_status": "missing",
            "name_status": "not_checked",
            "number_status": "not_checked",
            "extracted_number": None,
        }
    try:
        data = await db.call(
            "GET",
            "/storage/v1/object/" + CARD_BUCKET + "/" + card_path,
            admin=True,
            raw=True,
        )
        from starlette.concurrency import run_in_threadpool

        text = await run_in_threadpool(
            read_card_text, data, row["id_card_type"], db.settings.tessdata_prefix
        )
    except Exception:
        return {
            "card_status": "unreadable",
            "name_status": "not_checked",
            "number_status": "not_checked",
            "extracted_number": None,
        }
    if not text.strip():
        return {
            "card_status": "unreadable",
            "name_status": "not_found",
            "number_status": "not_found",
            "extracted_number": None,
        }
    submitted_name = normalized_card_text(row["full_name"])
    recognized_text = normalized_card_text(text)
    name_status = "match" if submitted_name in recognized_text else "not_found"
    extracted_number = extract_card_number(text)
    submitted_number = row.get("id_card_number")
    if not extracted_number:
        number_status = "not_found" if submitted_number else "not_entered"
    elif not submitted_number:
        number_status = "not_entered"
    else:
        normalize_number = lambda value: re.sub(r"[^A-Z0-9]", "", value.upper())
        number_status = (
            "match"
            if normalize_number(extracted_number)
            == normalize_number(submitted_number)
            else "mismatch"
        )
    return {
        "card_status": "readable",
        "name_status": name_status,
        "number_status": number_status,
        "extracted_number": extracted_number,
    }


async def delete_card(db, key):
    await db.call(
        "DELETE",
        "/storage/v1/object/" + CARD_BUCKET,
        admin=True,
        data={"prefixes": [key]},
    )


async def finish_card_cleanup(db, uid, path):
    await delete_card(db, path)
    await db.call(
        "PATCH",
        "/rest/v1/account_profiles",
        admin=True,
        params={"id": "eq." + str(uid), "id_card_path": "eq." + path},
        data={
            "id_card_path": None,
            "id_card_type": None,
            "id_card_deleted_at": datetime.now(UTC).isoformat(),
        },
    )


def account_router(user, db_dep):
    router = APIRouter(prefix="/v1")

    async def admin(u=Depends(user)):
        if u.role != "admin":
            raise HTTPException(403, "Administrator access required.")
        return u

    def invite_response(db, raw):
        app_url = db.settings.app_url.rstrip("/")
        return {
            "invite_url": app_url + "/set-password#" + urlencode({"token": raw}),
            "expires_in_hours": 48,
        }

    async def invite(db, uid):
        raw = secrets.token_urlsafe(32)
        await db.rpc("invite_issue", uid=str(uid), digest=digest(raw))
        return invite_response(db, raw)

    @router.get("/me")
    async def me(u=Depends(user), db=Depends(db_dep)) -> AccountProfile:
        return await db.one(
            "account_profiles",
            u.id,
            fields=(
                "id,full_name,email,role,organization,role_type,phone,job_title,"
                "status,created_at,factory_id,id_card_number,membership_number,consent_at"
            ),
        )

    @router.post("/login")
    async def login(body: WorkspaceLogin, request: Request, db=Depends(db_dep)):
        await rate(db, request, "login", 60, body.email)
        failure = HTTPException(401, "Email or password is incorrect.")
        try:
            session = await db.call(
                "POST",
                "/auth/v1/token",
                params={"grant_type": "password"},
                data={"email": body.email, "password": body.password},
            )
        except PlatformError as exc:
            if exc.status not in (400, 401, 403, 422):
                raise HTTPException(
                    503, "Sign-in is temporarily unavailable."
                ) from None
            if len(body.password.encode()) > 72 or "\x00" in body.password:
                raise failure from None
            status = await db.rpc(
                "inactive_login", login_email=body.email, secret=body.password
            )
            if not status:
                raise failure from None
            messages = {
                "pending_approval": "Your application is waiting for admin approval.",
                "rejected": "Your application was rejected: "
                + (status["reason"] or ""),
                "deactivated": "Your account is deactivated.",
                "deleted": "This account has been deleted.",
            }
            raise HTTPException(
                403,
                messages.get(
                    status["status"], "Ask the admin for a password setup link."
                ),
            ) from None
        profiles = await db.rows(
            "account_profiles",
            fields="status,role",
            filters={"id": "eq." + session["user"]["id"]},
        )
        if not profiles or profiles[0]["status"] != "active":
            raise failure
        if body.workspace is not None:
            manager = profiles[0]["role"] == "factory_manager"
            if manager != (body.workspace == "factory_manager"):
                raise HTTPException(403, "Choose the sign-in option for your account.")
        return {key: session[key] for key in ("access_token", "refresh_token")}

    @router.get("/factories")
    async def factories(db=Depends(db_dep)):
        return await db.rows("factories", fields="id,name", order="name")

    @router.get("/factories/{fid}/address")
    async def address(fid: UUID, db=Depends(db_dep)):
        # Public demo address only; no operational or account data.
        row = await db.one("factories", fid, fields="address")
        return {"address": row["address"]}

    @router.get("/manager/work")
    async def manager_work(u=Depends(user), db=Depends(db_dep)):
        if u.role != "factory_manager":
            raise HTTPException(403, "Factory Manager access required.")
        bound = await factory(db, u.factory_id)
        tasks = await db.rows(
            "corrective_tasks",
            token=u.token,
            fields="id,case_id,title,due_on,status",
            order="due_on,id",
        )
        scheduled = await db.rows(
            "cases",
            token=u.token,
            fields="id,title,inspection_on,reviewer_id,manager_notified_at",
            filters={
                "inspection_on": "not.is.null",
                "archived": "eq.false",
                "deleting": "eq.false",
                "manager_notified_at": "not.is.null",
            },
            order="inspection_on,id",
        )
        reviewer_ids = {
            item["reviewer_id"] for item in scheduled if item["reviewer_id"]
        }
        reviewers = (
            await db.rows(
                "account_profiles",
                fields="id,full_name,organization",
                filters={"id": "in.(" + ",".join(sorted(reviewer_ids)) + ")"},
            )
            if reviewer_ids
            else []
        )
        profiles = {reviewer["id"]: reviewer for reviewer in reviewers}
        notices = [
            {
                "case_id": item["id"],
                "title": item["title"],
                "inspection_on": item["inspection_on"],
                "notified_at": item["manager_notified_at"],
                "reviewer_name": profiles.get(item["reviewer_id"], {}).get("full_name"),
                "organization": profiles.get(item["reviewer_id"], {}).get(
                    "organization"
                ),
            }
            for item in scheduled
        ]
        return {"factory": bound, "tasks": tasks, "inspections": notices}

    @router.get("/reviewer/factories")
    async def assigned_factories(u=Depends(user), db=Depends(db_dep)):
        if u.role != "reviewer":
            raise HTTPException(403, "Review access required.")
        return await db.rows(
            "reviewer_factories",
            fields="factories(id,name,address)",
            filters={"reviewer_id": "eq." + u.id},
        )

    @router.post("/signup/factory-manager/read-id-number")
    async def read_manager_id_number(
        request: Request, office_card: UploadFile = File(...), db=Depends(db_dep)
    ):
        await rate(db, request, "manager-card-ocr", 20)
        data = await office_card.read(CARD_LIMIT + 1)
        kind = card_type(data)
        from starlette.concurrency import run_in_threadpool

        try:
            number = await run_in_threadpool(
                read_card_number, data, kind, db.settings.tessdata_prefix
            )
        except Exception:
            number = None
        return {"number": number}

    @router.post("/signup/factory-manager/upload")
    async def reserve_card(request: Request, db=Depends(db_dep)):
        await rate(db, request, "card-reservation", 10)
        raw = secrets.token_hex(16)
        key = uuid4().hex + "/" + raw
        result = await db.call(
            "POST",
            "/storage/v1/object/upload/sign/" + CARD_BUCKET + "/" + key,
            admin=True,
            data={},
        )
        from time import time

        expires = str(int(time()) + 900)
        from hmac import digest as sign

        signature = sign(
            db.settings.supabase_service_role_key.encode(),
            (key + expires).encode(),
            "sha256",
        ).hex()
        return {
            "upload_key": key,
            "upload_url": db.base + "/storage/v1" + result["url"],
            "receipt": expires + "." + signature,
        }

    @router.post("/signup/factory-manager", status_code=201)
    async def signup(body: Manager, request: Request, db=Depends(db_dep)):
        await rate(db, request, "signup", 10, body.email)
        check_password(body.password)
        if body.website or not re.fullmatch(
            r"[+\d][\d ()+.-]{5,31}", body.phone.strip()
        ):
            raise HTTPException(422, "Check the application fields.")
        name = require_name(body.full_name)
        try:
            await factory(db, body.factory_id)
        except PlatformError as exc:
            if exc.status == 404:
                raise HTTPException(422, "Choose an existing factory.") from None
            raise
        from hmac import compare_digest, digest as sign
        from time import time

        receipt = request.headers.get("x-upload-receipt", "")
        expires, _, signature = receipt.partition(".")
        if (
            not expires.isdigit()
            or len(expires) > 12
            or int(expires) < time()
            or not compare_digest(
                signature,
                sign(
                    db.settings.supabase_service_role_key.encode(),
                    (body.upload_key + expires).encode(),
                    "sha256",
                ).hex(),
            )
        ):
            raise HTTPException(
                422, "The upload expired. Choose the office ID card again."
            )
        path = body.upload_key
        # Claim the staged upload once; a repeated request cannot delete an accepted card.
        if not await db.rpc("card_claim", card_path=path):
            raise HTTPException(
                409, "This upload was already used. Upload the ID card again."
            )
        stored_path = "verified/" + uuid4().hex
        try:
            data = await db.call(
                "GET",
                "/storage/v1/object/" + CARD_BUCKET + "/" + path,
                admin=True,
                raw=True,
            )
            kind = card_type(data)
            await db.call(
                "POST",
                "/storage/v1/object/" + CARD_BUCKET + "/" + stored_path,
                admin=True,
                body=data,
                headers={"Content-Type": kind},
            )
            await delete_card(db, path)
            await provision(
                db,
                body.email,
                {
                    "role": "factory_manager",
                    "status": "pending_approval",
                    "full_name": name,
                    "phone": body.phone.strip(),
                    "job_title": body.job_title.strip() or "Factory Manager",
                    "requested_factory_id": str(body.factory_id),
                    "id_card_path": stored_path,
                    "id_card_type": kind,
                    "id_card_number": body.id_card_number,
                    "membership_number": body.membership_number,
                    "consent_at": datetime.now(UTC).isoformat(),
                },
                body.password,
            )
        except (HTTPException, PlatformError):
            # Keep the file if provisioning may have succeeded before a network timeout.
            profiles = await db.rows(
                "account_profiles",
                fields="id",
                filters={"id_card_path": "eq." + stored_path},
            )
            if not profiles:
                await delete_card(db, stored_path)
            await delete_card(db, path)
            raise
        return {"status": "pending_approval"}

    @router.get("/reviewer-organizations")
    async def reviewer_organizations():
        return ORGANIZATIONS

    @router.post("/signup/reviewer", status_code=201)
    async def request_reviewer(
        body: ReviewerRequest, request: Request, db=Depends(db_dep)
    ):
        await rate(db, request, "reviewer-request", 20, body.email)
        if body.website:
            raise HTTPException(422, "Unable to submit the request.")
        profile = reviewer_profile(body, "pending_approval")
        await provision(db, body.email, profile)
        return {"status": "pending_approval"}

    @router.post("/invites/validate")
    async def validate(body: Token, request: Request, db=Depends(db_dep)):
        await rate(db, request, "invite-validate", 50)
        rows = await db.rows(
            "reviewer_invites",
            fields="account_profiles!inner(email)",
            filters={
                "token_hash": "eq." + digest(body.token),
                "used_at": "is.null",
                "expires_at": "gt." + datetime.now(UTC).isoformat(),
                "account_profiles.status": "eq.pending",
            },
        )
        if not rows:
            raise HTTPException(400, INVALID_INVITE)
        return {"valid": True, "email": rows[0]["account_profiles"]["email"]}

    @router.post("/invites/set-password")
    async def set_password(body: SetPassword, request: Request, db=Depends(db_dep)):
        await rate(db, request, "set-password", 20, digest(body.token))
        check_password(body.password)
        await db.rpc(
            "invite_accept", digest=digest(body.token), new_password=body.password
        )
        return {"status": "active"}

    @router.get("/admin/reviewers")
    async def reviewers(u=Depends(admin), db=Depends(db_dep)):
        return await db.rows(
            "account_profiles",
            fields="id,email,full_name,organization,role_type,status,created_at,reviewer_factories(factory_id)",
            filters={"role": "eq.reviewer"},
            order="created_at.desc",
        )

    @router.post("/admin/reviewers", status_code=201)
    async def add_reviewer(body: Reviewer, u=Depends(admin), db=Depends(db_dep)):
        uid = await provision(db, body.email, reviewer_profile(body, "pending"))
        return {"id": uid, **await invite(db, uid)}

    @router.post("/admin/reviewer-requests/{uid}/{choice}")
    async def decide_reviewer_request(
        uid: UUID,
        choice: Literal["approve", "reject"],
        u=Depends(admin),
        db=Depends(db_dep),
    ):
        raw = secrets.token_urlsafe(32) if choice == "approve" else None
        await db.rpc(
            "reviewer_request_decide",
            actor_id=u.id,
            uid=str(uid),
            choice=choice,
            token_hash=digest(raw) if raw else None,
        )
        return invite_response(db, raw) if raw else {"status": "rejected"}

    @router.post("/admin/reviewers/{uid}/resend-invite")
    async def resend(uid: UUID, request: Request, u=Depends(admin), db=Depends(db_dep)):
        await rate(db, request, "invite-resend", 40)
        return await invite(db, uid)

    @router.post("/admin/reviewers/{uid}/factories")
    async def assign(
        uid: UUID, body: Assignments, u=Depends(admin), db=Depends(db_dep)
    ):
        await replace_assignments(db, uid, body.factory_ids)
        return {"updated": True}

    @router.get("/admin/manager-applications")
    async def applications(u=Depends(admin), db=Depends(db_dep)):
        return await db.rows(
            "account_profiles",
            fields=PROFILE_FIELDS,
            filters={"role": "eq.factory_manager"},
            order="created_at.desc",
        )

    @router.get("/admin/manager-applications/unseen-count")
    async def unseen_manager_applications(u=Depends(admin), db=Depends(db_dep)):
        rows = await db.rows(
            "account_profiles",
            fields="id",
            filters={
                "role": "eq.factory_manager",
                "status": "eq.pending_approval",
                "manager_application_seen_at": "is.null",
            },
        )
        return {"count": len(rows)}

    @router.post("/admin/manager-applications/mark-seen")
    async def mark_manager_applications_seen(u=Depends(admin), db=Depends(db_dep)):
        rows = await db.call(
            "PATCH",
            "/rest/v1/account_profiles",
            admin=True,
            params={
                "role": "eq.factory_manager",
                "status": "eq.pending_approval",
                "manager_application_seen_at": "is.null",
            },
            data={"manager_application_seen_at": datetime.now(UTC).isoformat()},
            headers={"Prefer": "return=representation"},
        )
        return {"updated": len(rows or [])}

    async def application_row(db, uid):
        row = await db.one(
            "account_profiles",
            uid,
            fields=PROFILE_FIELDS + ",id_card_path,id_card_type",
        )
        if row["role"] != "factory_manager":
            raise HTTPException(404, "Application unavailable.")
        return row

    @router.get("/admin/manager-applications/{uid}")
    async def application(uid: UUID, u=Depends(admin), db=Depends(db_dep)):
        row = await application_row(db, uid)
        card_path = row.pop("id_card_path")
        card_present = bool(card_path)
        row["has_id_card"] = card_present and row["status"] == "pending_approval"
        row["card_cleanup_pending"] = (
            card_present and row["status"] != "pending_approval"
        )
        row["id_card_review"] = await manager_card_review(db, row, card_path)
        row["requested_factory"] = (
            await factory(db, row["requested_factory_id"])
            if row["requested_factory_id"]
            else None
        )
        row["active_manager_factory_ids"] = sorted(
            {
                p["factory_id"]
                for p in await db.rows(
                    "account_profiles",
                    fields="factory_id",
                    filters={"role": "eq.factory_manager", "status": "eq.active"},
                )
                if p["factory_id"]
            }
        )
        return row

    @router.get("/admin/manager-applications/{uid}/id-card")
    async def id_card(uid: UUID, u=Depends(admin), db=Depends(db_dep)):
        row = await application_row(db, uid)
        if not row["id_card_path"] or row["status"] != "pending_approval":
            raise HTTPException(404, "Office ID card is unavailable.")
        data = await db.call(
            "GET",
            "/storage/v1/object/" + CARD_BUCKET + "/" + row["id_card_path"],
            admin=True,
            raw=True,
        )
        return StreamingResponse(
            (data[offset : offset + 65536] for offset in range(0, len(data), 65536)),
            media_type=row["id_card_type"],
            headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
        )

    @router.post("/admin/accounts/{uid}/{choice}")
    async def decide(
        uid: UUID,
        choice: Literal["approve", "reject", "deactivate", "reactivate"],
        body: Decision,
        u=Depends(admin),
        db=Depends(db_dep),
    ):
        note = (body.reason or "").strip() or None
        if choice == "reject" and not note:
            raise HTTPException(422, "Enter a reason for rejection.")
        path = await db.rpc(
            "account_decide",
            actor_id=u.id,
            uid=str(uid),
            choice=choice,
            factory=str(body.factory_id) if body.factory_id else None,
            note=note,
        )
        if path:
            await finish_card_cleanup(db, uid, path)
        return {"updated": True}

    @router.delete("/admin/accounts/{uid}")
    async def delete_deactivated_account(
        uid: UUID, u=Depends(admin), db=Depends(db_dep)
    ):
        path = await db.rpc("account_delete", actor_id=u.id, uid=str(uid))
        card_cleanup_pending = False
        if path:
            try:
                await finish_card_cleanup(db, uid, path)
            except PlatformError:
                card_cleanup_pending = True
        return {"deleted": True, "card_cleanup_pending": card_cleanup_pending}

    @router.delete("/admin/manager-applications/{uid}/id-card")
    async def retry_cleanup(uid: UUID, u=Depends(admin), db=Depends(db_dep)):
        row = await application_row(db, uid)
        if row["status"] == "pending_approval":
            raise HTTPException(
                409, "Decide the application before deleting its office ID."
            )
        if row["id_card_path"]:
            await finish_card_cleanup(db, uid, row["id_card_path"])
        return {"updated": True}

    @router.post("/admin/cases", response_model=CaseRecord, status_code=201)
    async def create_assigned_case(
        body: AssignedCaseInput, u=Depends(admin), db=Depends(db_dep)
    ):
        if body.inspection_kind == "follow_up":
            if not body.follow_up_of:
                raise HTTPException(
                    422, "Choose the earlier inspection this follow-up continues."
                )
            previous = await db.one(
                "cases",
                body.follow_up_of,
                fields="factory,inspection_on",
            )
            if previous["factory"] != body.factory or not previous["inspection_on"]:
                raise HTTPException(
                    422,
                    "Choose an earlier scheduled inspection for the same factory.",
                )
            previous_date = date.fromisoformat(previous["inspection_on"])
            if body.inspection_on is None or body.inspection_on <= previous_date:
                raise HTTPException(
                    422,
                    "The follow-up inspection date must be after the previous inspection date.",
                )
        return await db.rpc(
            "create_case",
            actor_id=u.id,
            assignee_id=str(body.reviewer_id),
            data=body.model_dump(mode="json", exclude={"reviewer_id"}),
        )

    @router.get("/admin/cases/{cid}")
    async def admin_case(cid: UUID, u=Depends(admin), db=Depends(db_dep)):
        import asyncio

        case = await db.one(
            "cases",
            cid,
            fields="id,title,factory,period_start,period_end,archived,deleting,reviewer_id,inspection_on,inspection_kind,follow_up_of,follow_up_root_id,follow_up_number",
        )
        if case.pop("deleting"):
            raise HTTPException(404, "Case unavailable.")
        filters = {"case_id": "eq." + str(cid)}
        runs, tasks, documents = await asyncio.gather(
            db.rows(
                "verification_runs",
                fields="id,status,created_at",
                filters=filters,
                order="created_at.desc,id.desc",
            ),
            db.rows(
                "corrective_tasks",
                fields="id,title,assignee,due_on,status",
                filters=filters,
                order="due_on,id",
            ),
            db.rows(
                "documents", fields="id,title,role", filters=filters, order="title,id"
            ),
        )
        run = next(
            (item for item in runs if item["status"] in ("complete", "partial")), None
        )
        results = (
            await db.rows(
                "results",
                fields="id,claim,outcome,reason",
                filters={"run_id": "eq." + run["id"]},
            )
            if run
            else []
        )
        return {
            "case": case,
            "run": run,
            "results": results,
            "tasks": tasks,
            "documents": documents,
        }

    @router.get("/admin/factories")
    async def factory_overview(u=Depends(admin), db=Depends(db_dep)):
        return await db.rpc("factory_overview")

    @router.get("/admin/follow-up-support")
    async def follow_up_support(u=Depends(admin), db=Depends(db_dep)):
        try:
            await db.rows(
                "cases",
                fields="id,inspection_kind,follow_up_of,follow_up_root_id,follow_up_number",
                filters={"id": "eq.00000000-0000-0000-0000-000000000000"},
            )
        except PlatformError:
            return {"enabled": False}
        return {"enabled": True}

    @router.get("/admin/scheduled-inspections")
    async def scheduled_inspections(u=Depends(admin), db=Depends(db_dep)):
        filters = {
            "inspection_on": "not.is.null",
            "archived": "eq.false",
            "deleting": "eq.false",
        }
        try:
            cases = await db.rows(
                "cases",
                fields="id,title,factory,programme,inspection_on,reviewer_id,created_at,manager_notified_at,inspection_kind,follow_up_of,follow_up_root_id,follow_up_number",
                filters=filters,
                order="inspection_on,id",
            )
        except PlatformError:
            cases = await db.rows(
                "cases",
                fields="id,title,factory,programme,inspection_on,reviewer_id,created_at,manager_notified_at",
                filters=filters,
                order="inspection_on,id",
            )
            for case in cases:
                case.update(
                    inspection_kind="initial",
                    follow_up_of=None,
                    follow_up_root_id=case["id"],
                    follow_up_number=0,
                )
        if not cases:
            return []

        case_ids = ",".join(row["id"] for row in cases)
        documents = await db.rows(
            "documents",
            fields="id,case_id,title,role",
            filters={"case_id": "in.(" + case_ids + ")"},
        )
        inspection_docs = [row for row in documents if row["role"] == "inspection"]
        document_ids = ",".join(row["id"] for row in inspection_docs)
        versions = (
            await db.rows(
                "document_versions",
                fields="document_id,revision,status",
                filters={"document_id": "in.(" + document_ids + ")"},
                order="revision.desc",
            )
            if document_ids
            else []
        )
        latest_versions = {}
        for version in versions:
            previous = latest_versions.get(version["document_id"])
            if previous is None or version["revision"] > previous["revision"]:
                latest_versions[version["document_id"]] = version

        reviewer_ids = sorted(
            {row["reviewer_id"] for row in cases if row["reviewer_id"]}
        )
        reviewers = (
            await db.rows(
                "account_profiles",
                fields="id,full_name,organization",
                filters={"id": "in.(" + ",".join(reviewer_ids) + ")"},
            )
            if reviewer_ids
            else []
        )
        reviewer_by_id = {row["id"]: row for row in reviewers}
        documents_by_case = {}
        for document in inspection_docs:
            documents_by_case.setdefault(document["case_id"], []).append(document)

        result = []
        for case in cases:
            states = [
                latest_versions[doc["id"]]["status"]
                for doc in documents_by_case.get(case["id"], [])
                if doc["id"] in latest_versions
            ]
            if any(state in ("ready", "partial") for state in states):
                report_status = "complete"
            elif any(state in ("awaiting_upload", "queued") for state in states):
                report_status = "in_progress"
            elif "failed" in states:
                report_status = "needs_attention"
            else:
                report_status = "scheduled"
            reviewer = reviewer_by_id.get(case["reviewer_id"])
            result.append(
                {
                    **case,
                    "reviewer_name": reviewer["full_name"] if reviewer else None,
                    "reviewer_organization": reviewer["organization"]
                    if reviewer
                    else None,
                    "report_status": report_status,
                }
            )
        return result

    @router.post("/admin/factories", status_code=201)
    async def create_factory(body: FactoryInput, u=Depends(admin), db=Depends(db_dep)):
        try:
            created = await db.call(
                "POST",
                "/rest/v1/factories",
                admin=True,
                data={"name": body.name, "address": body.address},
                headers={"Prefer": "return=representation"},
            )
        except PlatformError as exc:
            if exc.status == 409:
                raise HTTPException(409, "A factory with this name already exists.") from exc
            raise
        return created[0]

    return router
