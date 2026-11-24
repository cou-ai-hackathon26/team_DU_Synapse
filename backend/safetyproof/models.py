from datetime import date
from typing import Literal
from uuid import UUID
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

Role = Literal["inspection", "sop", "incident", "drill", "maintenance", "cap", "other"]
Outcome = Literal[
    "contradicted",
    "unsupported",
    "unresolved",
    "supported",
    "needs_review",
    "not_assessed",
]


class Period(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")
    period_start: date | None = None
    period_end: date | None = None

    @model_validator(mode="after")
    def ordered(self):
        if (
            self.period_start
            and self.period_end
            and self.period_start > self.period_end
        ):
            raise ValueError("The reporting period ends before it starts")
        return self


class CaseInput(Period):
    factory: str = Field(min_length=1, max_length=160)
    title: str = Field(min_length=1, max_length=160)
    programme: str | None = Field(default=None, max_length=120)


class UploadInput(Period):
    request_key: UUID
    document_id: UUID | None = None
    filename: str = Field(min_length=1, max_length=200)
    title: str = Field(min_length=1, max_length=160)
    role: Role
    issued_on: date | None = None
    issuer: Literal["factory", "external", "unknown"] = "unknown"
    confirmed_factory: str = Field(min_length=1, max_length=160)

    @field_validator("filename")
    @classmethod
    def pdf_name(cls, v):
        if not v.lower().endswith(".pdf") or any(
            ord(ch) < 32 or ch in "/\\" for ch in v
        ):
            raise ValueError("Choose a PDF with a valid filename")
        return v


class RunInput(BaseModel):
    request_key: UUID
    version_ids: list[UUID] = Field(min_length=2, max_length=10)


class ReviewInput(BaseModel):
    action: Literal["accept", "dismiss", "request_evidence", "comment"]
    comment: str = Field(default="", max_length=3000)

    @model_validator(mode="after")
    def required_note(self):
        self.comment = self.comment.strip()
        if self.action in ("comment", "request_evidence") and not self.comment:
            raise ValueError("Enter a review note")
        return self


class EvidenceRef(BaseModel):
    version_id: str
    extraction_id: str
    page_id: str
    page: int
    chunk_id: str
    start: int
    end: int
    quote: str
    boxes: list[list[float]]
    document: str
    revision: int
    method: str


class Target(BaseModel):
    chunk_id: str
    quote: str
    kind: Literal["claim", "finding"]
    facility: str | None = None
    location: str | None = None
    asset: str | None = None
    finding_id: str | None = None
    start_date: str | None = None
    end_date: str | None = None
    severity: Literal["high", "medium", "low", "unknown"] = "unknown"


class TargetList(BaseModel):
    items: list[Target]


class QuoteChoice(BaseModel):
    chunk_id: str
    quote: str


class CapAction(QuoteChoice):
    action_ref: str | None = None
    finding_refs: list[str] = Field(default_factory=list)
    asset: str | None = None
    location: str | None = None
    deadline: str | None = None
    reported_status: str | None = None


class CapActionList(BaseModel):
    items: list[CapAction]


class CapReviewInput(BaseModel):
    finding_id: UUID
    action_id: UUID
    decision: Literal["confirm", "dismiss"]
    comment: str = Field(default="", max_length=3000)


class Verdict(BaseModel):
    label: Literal["supports", "contradicts", "insufficient", "ambiguous"]
    evidence: list[QuoteChoice]
    reason: str = Field(max_length=650)
    compatible: bool
    subject: str | None = None
    evidence_start: str | None = None
    evidence_end: str | None = None


class SecondOpinion(BaseModel):
    relation: Literal["entails", "contradicts", "insufficient"]


class Assessment(BaseModel):
    id: str
    outcome: Outcome
    claim: dict
    evidence: list[EvidenceRef]
    reason: str
    coverage: dict
    checks: dict


class CaseRecord(CaseInput):
    id: UUID
    created_by: UUID | None
    reviewer_id: UUID | None = None
    inspection_on: date | None = None
    inspection_kind: Literal["initial", "follow_up"] = "initial"
    follow_up_of: UUID | None = None
    follow_up_root_id: UUID | None = None
    follow_up_number: int = 0
    manager_notified_at: str | None = None
    created_at: str
    archived: bool
    deleting: bool
    model_config = ConfigDict(extra="ignore")


class UploadTicket(BaseModel):
    version_id: UUID
    upload_url: str | None
    status: str


class RunTicket(BaseModel):
    run_id: UUID
    job_id: UUID


class ReviewEvent(BaseModel):
    id: UUID
    result_id: UUID
    actor: UUID | None
    action: str
    comment: str
    created_at: str


class PublishedResult(Assessment):
    run_id: UUID
    reviews: list[ReviewEvent] = Field(default_factory=list)
