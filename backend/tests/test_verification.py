from uuid import uuid4

import pytest

from safetyproof.verify import checked_anchor, quoted_dates, scope_problem, verify_one


@pytest.fixture
def evidence():
    versions = {
        "inspection": {
            "id": "inspection",
            "title": "April inspection",
            "role": "inspection",
            "issuer": "external",
            "period_start": "2026-04-01",
            "period_end": "2026-04-30",
            "issued_on": "2026-04-30",
            "confirmed_factory": "Factory",
            "page_count": 1,
            "readable_pages": 1,
            "extraction_id": "extract-1",
            "revision": 1,
        },
        "register": {
            "id": "register",
            "title": "Incident register",
            "role": "incident",
            "issuer": "factory",
            "period_start": "2026-05-01",
            "period_end": "2026-05-31",
            "issued_on": "2026-05-31",
            "confirmed_factory": "Factory",
            "page_count": 1,
            "readable_pages": 1,
            "extraction_id": "extract-2",
            "revision": 1,
        },
    }
    source = "No injuries were recorded at machine M-05 during April 2026."
    ref = "১৫ মে ২০২৬ কাটিং মেশিন M-05 এ একজন শ্রমিক আহত হন।"
    pages = {}
    chunks = {}
    for page, role, quote in [
        ("page-a", "inspection", source),
        ("page-b", "register", ref),
    ]:
        key = str(uuid4())
        pages[page] = {
            "id": page,
            "page_no": 1,
            "quality": "readable",
            "text": quote,
            "method": "ocr" if role == "register" else "native",
            "blocks": [{"start": 0, "end": len(quote), "box": [0.1, 0.1, 0.6, 0.2]}],
        }
        chunks[role] = {
            "id": key,
            "page_id": page,
            "version_id": role,
            "page_no": 1,
            "text": quote,
            "start_at": 0,
            "end_at": len(quote),
        }

    def anchor(role):
        c = chunks[role]
        return checked_anchor(
            {"chunk_id": c["id"], "quote": c["text"]}, {c["id"]: c}, pages, versions
        )

    return versions, pages, chunks, anchor


def test_date_in_quoted_bangla_evidence_overrides_model_date(evidence):
    versions, _, _, anchor = evidence
    assert {d.isoformat() for d in quoted_dates(anchor("register")["quote"])} == {
        "2026-05-15"
    }
    target = {"kind": "claim", "asset": "M-05", "source": anchor("inspection")}
    model = {
        "compatible": True,
        "label": "contradicts",
        "evidence_start": "2026-04-15",
        "evidence_end": "2026-04-15",
    }
    assert "outside" in scope_problem(target, model, [anchor("register")], versions)


def test_changed_asset_is_never_a_contradiction(evidence):
    versions, _, _, anchor = evidence
    target = {"kind": "claim", "source": anchor("inspection")}
    cited = {**anchor("register"), "quote": "Machine M-50 injury on 15 April 2026."}
    verdict = {
        "compatible": True,
        "label": "contradicts",
        "evidence_start": "2026-04-15",
    }
    assert "subject or location" in scope_problem(target, verdict, [cited], versions)


@pytest.mark.asyncio
async def test_unreadable_pages_prevent_absence_claim(evidence):
    versions, pages, chunks, anchor = evidence

    class OnlyFirstPass:
        calls = 0

        async def __call__(self, prompt, data, schema):
            self.calls += 1
            assert self.calls == 1
            return {
                "label": "insufficient",
                "compatible": False,
                "evidence": [],
                "reason": "No evidence.",
            }

    call = OnlyFirstPass()
    result = await verify_one(
        {"kind": "claim", "source": anchor("inspection")},
        [chunks["register"]],
        [chunks["register"]],
        versions,
        pages,
        call,
        unreadable=1,
        retrieval_ids=[],
    )
    assert result["outcome"] == "not_assessed" and not result["coverage"]["full_search"]


def test_quote_must_exist_in_original_passage(evidence):
    versions, pages, chunks, _ = evidence
    c = chunks["register"]
    assert (
        checked_anchor(
            {"chunk_id": c["id"], "quote": "Invented source quotation"},
            {c["id"]: c},
            pages,
            versions,
        )
        is None
    )
