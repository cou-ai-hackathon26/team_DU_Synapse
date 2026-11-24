import pytest

from safetyproof.cap import complete_action_metadata, linkage, suggest_links
from safetyproof.verify import checked_anchor


def metadata_evidence(text, quote, ref):
    chunks = {
        "chunk": {
            "id": "chunk",
            "page_id": "page",
            "version_id": "cap",
            "start_at": 0,
            "text": text,
        }
    }
    pages = {
        "page": {
            "id": "page",
            "page_no": 1,
            "quality": "readable",
            "text": text,
            "method": "native",
            "blocks": [{"start": 0, "end": len(text), "box": [0.1, 0.1, 0.9, 0.8]}],
        }
    }
    versions = {
        "cap": {
            "id": "cap",
            "title": "Corrective action plan",
            "revision": 1,
            "extraction_id": "extraction",
        }
    }
    source = checked_anchor(
        {"chunk_id": "chunk", "quote": quote}, chunks, pages, versions
    )
    assert source is not None
    return (
        {
            "id": "original-action-id",
            "action_ref": ref,
            "source": source,
            "deadline": None,
            "reported_status": None,
        },
        chunks,
        pages,
        versions,
    )


def test_adjacent_same_action_metadata_recovers_quoted_status_and_deadline():
    quote = "CA-02 for finding FI-16: Mark the aisle at Exit E-02 with floor paint."
    text = (
        quote
        + "\nCA-02 target: 25 March 2026. Reported status: in progress.\nCA-03: Replace signs."
    )
    args = metadata_evidence(text, quote, "CA-02")
    completed = complete_action_metadata(*args)
    assert completed["id"] == "original-action-id"
    assert completed["reported_status"] == "in progress"
    assert completed["deadline"] == "2026-03-25"
    assert "Reported status: in progress." in completed["source"]["quote"]
    assert "CA-03" not in completed["source"]["quote"]


def test_metadata_is_never_borrowed_from_another_action():
    quote = "CA-03: Replace two faded signs."
    text = quote + "\nCA-02 target: 25 March 2026. Reported status: in progress."
    args = metadata_evidence(text, quote, "CA-03")
    assert complete_action_metadata(*args) == args[0]


def test_previously_enriched_action_is_not_changed_on_repeated_repairs():
    quote = "CA-01 for finding FI-16: Clear Exit E-02."
    text = quote + "\nCA-01 target: 20 March 2026. Reported status: planned."
    args = metadata_evidence(text, quote, "CA-01")
    completed = complete_action_metadata(*args)
    assert complete_action_metadata(completed, *args[1:]) == completed


def finding(
    quote="Finding FI-16. Exit E-02 was obstructed by cartons.", asset="Exit E-02"
):
    return {
        "kind": "finding",
        "finding_id": "FI-16",
        "asset": asset,
        "source": {"quote": quote},
    }


def action(quote, asset, refs=None):
    return {
        "id": "action-1",
        "asset": asset,
        "finding_refs": refs if refs is not None else ["fi-16"],
        "source": {"quote": quote},
    }


@pytest.mark.parametrize(
    "quote,asset",
    [
        ("CA-01 for finding FI-16: Remove cartons and clear Exit E-02.", "cartons"),
        (
            "CA-02 for finding FI-16: Mark the aisle at Exit E-02 with floor paint.",
            "aisle",
        ),
        ("CA-01 for finding FI-16: Remove the cartons.", "cartons"),
    ],
)
def test_explicit_finding_id_survives_different_extracted_nouns(quote, asset):
    assert linkage(finding(), action(quote, asset))[0] == "explicit_reference"


def test_explicit_reference_is_recovered_from_source_when_model_omits_it():
    cap = action(
        "CA-01 for finding FI-16: Remove cartons and clear Exit E-02.", "cartons", []
    )
    assert linkage(finding(), cap)[0] == "explicit_reference"


@pytest.mark.parametrize(
    "quote,asset",
    [
        ("CA-01 for finding FI-16: Remove cartons from Exit E-03.", "cartons"),
        ("CA-01 for finding FI-16: Clear Exit E-02 in Building B.", "Exit E-02"),
        ("CA-01 for finding FI-16: Clear Exit E-02 on floor 2.", "Exit E-02"),
    ],
)
def test_explicit_finding_link_surfaces_asset_building_or_floor_conflict(quote, asset):
    f = finding("Finding FI-16. Exit E-02 was obstructed in Building A on floor 1.")
    basis, reason = linkage(f, action(quote, asset))
    assert basis == "explicit_reference_conflict"
    assert "conflicts" in reason


def test_different_explicit_finding_id_does_not_link():
    f = finding("Finding FI-16. Exit E-02 was obstructed in Building A on floor 1.")
    assert linkage(f, action("CA-01 for finding FI-17: Clear Exit E-02.", "Exit E-02")) is None


def test_unverified_model_reference_cannot_override_source_reference():
    cap = action("CA-01 for finding FI-17: Clear Exit E-02.", "Exit E-02", ["FI-16"])
    assert linkage(finding(), cap) is None


def test_shared_asset_without_finding_id_remains_a_possible_match():
    cap = action("CA-01: Clear Exit E-02.", "Exit E-02", [])
    assert linkage(finding(), cap)[0] == "same_asset"


def test_suggestions_link_both_fi16_actions_and_leave_unrelated_signage_unlinked():
    actions = [
        action(
            "CA-01 for finding FI-16: Remove cartons and clear Exit E-02.", "cartons"
        ),
        {
            **action("CA-02 for finding FI-16: Mark the aisle at Exit E-02.", "aisle"),
            "id": "action-2",
        },
        {
            **action(
                "CA-03: Replace directional signs in Building B.",
                "directional signs",
                [],
            ),
            "id": "action-3",
        },
    ]
    links = suggest_links(
        {"result-1": finding(), "claim-1": {"kind": "claim"}}, actions
    )
    assert [(link["finding_id"], link["action_id"]) for link in links] == [
        ("result-1", "action-1"),
        ("result-1", "action-2"),
    ]
    assert all(link["basis"] == "explicit_reference" for link in links)
