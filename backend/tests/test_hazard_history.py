from uuid import uuid4

import pytest
import pytest_asyncio

from safetyproof.config import ROOT, settings
from safetyproof.document_validation import check_factory_record_content, check_inspection_content
from safetyproof.hazard_history import hazard_histories
from safetyproof.pdf import parse_pdf
from safetyproof.verify import (
    checked_anchor,
    explicit_closure_anchor,
    explicit_open_observations,
    is_closure_statement,
    verify_one,
)


@pytest_asyncio.fixture(scope="module", loop_scope="module")
async def sample_series():
    directory = ROOT / "output" / "pdf" / "hazard-history"
    versions, pages, passages, anchors = {}, {}, {}, {}
    for name, date, role, phrase in (
        ("march", "2026-03-09", "inspection", "Finding FI-26."),
        ("bangla", "2026-03-12", "cap", "কারখানার দাবি:"),
        ("april", "2026-04-13", "inspection", "Finding FI-26."),
        ("may", "2026-05-11", "inspection", "independently verified"),
        ("june", "2026-06-08", "inspection", "Finding FI-26."),
    ):
        path = next(directory.glob(f"*-{name}-*.pdf"))
        parsed = parse_pdf(path.read_bytes(), str(uuid4()), settings().tessdata_prefix)
        factory = "Kadam Weaving Works"
        if role == "inspection":
            check = await check_inspection_content(parsed["pages"], path.name, factory, date, None)
        else:
            check = await check_factory_record_content(parsed["pages"], path.name, factory, date, role, None)
        assert check["content_check"] == "valid", check
        versions[name] = {
            "id": name,
            "title": path.stem,
            "role": role,
            "issuer": "factory" if role == "cap" else "external",
            "issued_on": date,
            "period_start": None,
            "period_end": None,
            "confirmed_factory": factory,
            "page_count": parsed["total_pages"],
            "readable_pages": parsed["readable_pages"],
            "revision": 1,
            "extraction_id": name,
        }
        pages.update({page["id"]: page for page in parsed["pages"]})
        passage = next(chunk for chunk in parsed["chunks"] if phrase in chunk["text"])
        passage["version_id"] = name
        passages[name] = passage
        anchors[name] = checked_anchor(
            {"chunk_id": passage["id"], "quote": passage["text"]},
            {passage["id"]: passage}, pages, versions,
        )
        assert anchors[name] is not None
    return versions, pages, passages, anchors


@pytest.mark.asyncio
async def test_bangla_factory_claim_cannot_close_english_finding(sample_series):
    versions, pages, passages, anchors = sample_series
    assert anchors["bangla"]["method"] == "ocr"
    assert "হয়েছে" in anchors["bangla"]["quote"]

    async def ask(*args):
        pytest.fail("Factory-only evidence should never reach the closure model")

    result = await verify_one(
        {"kind": "finding", "source": anchors["march"]},
        [passages["bangla"]], [passages["bangla"]],
        {name: versions[name] for name in ("march", "bangla")}, pages, ask,
        unreadable=0, retrieval_ids=[passages["bangla"]["id"]],
    )
    assert result["outcome"] == "unresolved"
    assert not result["evidence"]


@pytest.mark.asyncio
async def test_hazard_is_open_carried_closed_then_reopened(sample_series):
    versions, pages, passages, anchors = sample_series

    async def ask(*args):
        pytest.fail("The exact independent closure citation should be verified directly")

    verified = await verify_one(
        {"kind": "finding", "source": anchors["april"]},
        [passages["bangla"], passages["may"]], [passages["bangla"], passages["may"]],
        {name: versions[name] for name in ("april", "bangla", "may")}, pages, ask,
        unreadable=0, retrieval_ids=[passages["may"]["id"]],
    )
    assert verified["outcome"] == "supported"
    assert verified["checks"]["closure"] == "explicit_independent_inspection"
    assert [
        name for name in ("march", "april", "may", "june")
        if list(explicit_open_observations(passages[name], versions[name]["issued_on"]))
    ] == ["march", "april", "june"]
    assert is_closure_statement(anchors["may"]["quote"])
    assert not is_closure_statement("Finding FI-26 was resolved in May, but the exit is blocked again.")
    rows = [
        {"run_id": "run", **verified},
        {"run_id": "run", "claim": {"kind": "finding", "source": anchors["june"]},
         "outcome": "unresolved", "evidence": [], "checks": {}},
        {"run_id": "run", "claim": {"kind": "finding", "source": anchors["may"]},
         "outcome": "unresolved", "evidence": [], "checks": {}},
        # Even a legacy result that trusted the factory claim cannot close the history.
        {"run_id": "run", "claim": {"kind": "finding", "source": anchors["march"]},
         "outcome": "supported", "evidence": [anchors["bangla"]],
         "checks": {"secondary": "entails"}},
    ]
    runs = [{"id": "run", "manifest": list(versions.values())}]
    [hazard] = hazard_histories(runs, rows, set(versions))
    assert hazard["finding_id"] == "FI-26"
    assert [(event["date"], event["status"], event["source"]["version_id"]) for event in hazard["events"]] == [
        ("2026-03-09", "opened", "march"),
        ("2026-04-13", "carried_forward", "april"),
        ("2026-05-11", "closed", "may"),
        ("2026-06-08", "reopened", "june"),
    ]
    [restricted] = hazard_histories(runs, rows, set(versions) - {"may"})
    assert [event["status"] for event in restricted["events"]] == [
        "opened", "carried_forward", "carried_forward",
    ]


def test_older_closure_and_different_exit_cannot_close_reopened_hazard(sample_series):
    versions, pages, passages, anchors = sample_series
    target = {"kind": "finding", "source": anchors["june"]}
    assert explicit_closure_anchor(target, [passages["may"]], pages, versions) is None

    other_exit = {"kind": "finding", "source": {
        **anchors["april"], "quote": anchors["april"]["quote"].replace("E-07", "E-08"),
    }}
    assert explicit_closure_anchor(other_exit, [passages["may"]], pages, versions) is None
