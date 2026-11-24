from collections import defaultdict
from uuid import uuid4

import pytest
from fastapi import HTTPException

from safetyproof.document_metadata import extract_metadata
from safetyproof.document_validation import check_inspection_content
from safetyproof.documentary_report import carried_entries, is_document_review, original_statement
from safetyproof.hazard_history import hazard_histories
from safetyproof.main import User, follow_up_report_entries
from safetyproof.pdf import chunks_for
from safetyproof.verify import checked_anchor, later_independent_inspection


@pytest.mark.asyncio
async def test_follow_up_preserves_prior_flags_and_requires_previous_event_sources():
    user = User(id="reviewer", token="reviewer-token", role="reviewer")
    case = {"follow_up_of": "first", "reviewer_id": user.id, "inspection_on": "2026-04-13",
            "archived": False, "deleting": False}
    run = {"manifest": [
        {"id": "first-report", "role": "inspection", "period_start": "2026-03-01", "period_end": "2026-03-31"},
        {"id": "first-cap", "role": "cap"},
    ]}
    rows = [
        {"outcome": "unresolved", "claim": {"kind": "finding", "source": {
            "version_id": "first-report", "quote": "Finding FI-26. Exit E-07 was blocked.",
        }}},
        {"outcome": "unsupported", "claim": {"kind": "claim", "source": {
            "version_id": "first-report", "quote": "No injuries occurred.",
        }}},
        {"outcome": "supported", "claim": {"kind": "finding"}},
    ]

    class PreviousEvent:
        async def rows(self, table, *, token, fields, filters):
            assert table == "document_versions" and token == user.token
            assert filters["case_id"] == "eq.first"
            return [{"id": "first-report"}, {"id": "first-cap"}]

    entries = await follow_up_report_entries(case, run, rows, user, PreviousEvent())
    assert [entry["finding_id"] for entry in entries] == ["FI-26", None]
    assert entries[1]["period"] == "2026-03-01 to 2026-03-31"
    with pytest.raises(HTTPException) as mismatch:
        await follow_up_report_entries(case, {"manifest": [*run["manifest"], {"id": "new-cap"}]}, rows, user, PreviousEvent())
    assert mismatch.value.status_code == 409


@pytest.mark.asyncio
async def test_saved_report_reenters_the_next_inspection_as_documentary_evidence():
    lines = [
        "Documentary follow-up inspection report",
        "Review method: documentary review only",
        "Inspection date: 2026-04-13",
        "Factory: Kadam Weaving Works",
        "Carry-forward register",
        "Carry-forward finding FI-26: Exit E-07 was blocked. [End review entry]",
        "Carry-forward claim: [Period 2026-03-01 to 2026-03-31] No injuries occurred. [End review entry]",
        "End of carry-forward register",
        "Sources reviewed",
        "মার্চের রিপোর্ট এবং কারখানার সংশোধনী পরিকল্পনা।",
        "Carry-forward finding FI-99: A quoted example in a note. [End review entry]",
    ]
    lines.insert(5, "A long preceding line. " * 39)
    blocks, offset = [], 0
    for line in lines:
        blocks.append({"start": offset, "end": offset + len(line), "box": [0.1, 0.1, 0.9, 0.8]})
        offset += len(line) + 1
    page = {"id": "page", "page_no": 1, "text": "\n".join(lines), "quality": "readable", "method": "native", "blocks": blocks}
    assert is_document_review(page)
    meta = extract_metadata([page], "follow-up.pdf", "2026-04-13")
    assert meta["role"] == "inspection"
    assert meta["issued_on"] == meta["period_start"] == meta["period_end"] == "2026-04-13"
    check = await check_inspection_content([page], "follow-up.pdf", "Kadam Weaving Works", "2026-04-13", None)
    assert check["content_check"] == "valid"
    version_id = str(uuid4())
    chunks = chunks_for(page, version_id)
    for chunk in chunks:
        chunk["version_id"] = version_id
    entries = list(carried_entries([page], defaultdict(list, {"page": chunks})))
    assert [entry["finding_id"] for entry, _ in entries] == ["FI-26", None]
    assert entries[1][0]["start_date"] == "2026-03-01"
    version = {"id": version_id, "title": "Follow-up report", "revision": 1, "extraction_id": str(uuid4()),
               "role": "inspection", "issuer": "external", "issued_on": "2026-04-13",
               "confirmed_factory": "Kadam Weaving Works", "document_review": True}
    item, chunk = entries[0]
    anchor = checked_anchor(item, {chunk["id"]: chunk}, {"page": page}, {version_id: version})
    assert anchor and original_statement(anchor["quote"]) == "Exit E-07 was blocked."
    assert not later_independent_inspection({**version, "issued_on": "2026-03-09"}, version, item)
    [history] = hazard_histories(
        [{"id": "run", "manifest": [version]}],
        [{"run_id": "run", "claim": {**item, "source": anchor}, "outcome": "unresolved", "checks": {}}],
        {version_id},
    )
    assert [event["status"] for event in history["events"]] == ["carried_forward"]
