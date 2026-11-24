"""Define ground truth from six synthetic document families and two variants each."""

import json
from pathlib import Path

OUTPUT = Path(__file__).with_name("labels.json")
CATEGORIES = ("contradicted", "unsupported", "unresolved", "supported", "needs_review")
MONTHS = ("February", "March", "April", "May", "June", "July")
BN_MONTHS = ("ফেব্রুয়ারি", "মার্চ", "এপ্রিল", "মে", "জুন", "জুলাই")
TOPICS = ("lighting", "exits", "lifting", "guarding", "ventilation", "housekeeping")
BENGALI_DIGITS = str.maketrans("0123456789", "০১২৩৪৫৬৭৮৯")


def document(role, title, period, line, *, scan=False, external=False):
    start, end = period
    return {
        "role": role,
        "title": title,
        "filename": title.lower().replace(" ", "-") + ".pdf",
        "issued_on": end,
        "period_start": start,
        "period_end": end,
        "issuer": "external" if external else "factory",
        "lines": [line],
        "scan": scan,
    }


def bundle(family, variant, category):
    month, bn_month, topic = MONTHS[family], BN_MONTHS[family], TOPICS[family]
    label = f"{family + 1:02}-{variant + 1}"
    date = 12 + variant
    mm = family + 2
    period = (f"2026-{mm:02}-01", f"2026-{mm:02}-28")
    place = f"Building {'A' if variant == 0 else 'B'}"
    asset = f"EX-{family + 12:02}"
    citation = None
    supporting_period = period
    scan = False
    if category == "contradicted":
        claim = f"No workplace injuries occurred from 1 to 28 {month} 2026."
        evidence = (
            f"{str(date).translate(BENGALI_DIGITS)} {bn_month} ২০২৬ একজন শ্রমিক আহত হন।"
        )
        role, scan, citation = "incident", True, evidence
    elif category == "unsupported":
        claim = (
            f"An evacuation drill was completed every week from 1 to 28 {month} 2026."
        )
        evidence = f"Procedure: schedule a drill every week and keep records for the {topic} review."
        role = "sop"
    elif category == "unresolved":
        claim = f"Exit {asset} was blocked in {place} on {date} {month} 2026."
        if variant == 0:
            evidence = f"Factory maintenance reported clearing {asset}. Follow-up inspection is pending."
        else:
            evidence = f"Factory issued a plan to clear {asset} in {place}. Correction was not verified."
        role = "maintenance"
    elif category == "supported":
        claim = f"Emergency alarms in {place} were tested on {date} {month} 2026."
        evidence = f"{date} {month} 2026: alarm test completed in {place}. Operator signed the test register."
        if variant == 0:
            evidence = f"{str(date).translate(BENGALI_DIGITS)} {bn_month} ২০২৬: ভবন এ-তে জরুরি সংকেত পরীক্ষা সম্পন্ন হয়।"
            scan = True
        role, citation = "maintenance", evidence
    else:
        claim = f"No injuries in {place} were reported from 1 to 28 {month} 2026."
        evidence = f"An injury was logged on {date} {month} 2026. Allocation to building and unit is unknown."
        role = "incident"
    expected_citations = (
        []
        if citation is None
        else [{"filename": "evidence-record.pdf", "page": 1, "quote": citation}]
    )
    docs = [
        document("inspection", "Inspection review", period, claim, external=True),
        document(role, "Evidence record", supporting_period, evidence, scan=scan),
    ]
    if variant == 0 and category in {"contradicted", "supported"}:
        prior_period = (f"2026-{mm - 1:02}-01", f"2026-{mm - 1:02}-28")
        misleading = (
            "The previous month's injury total was zero."
            if category == "contradicted"
            else "The alarm test failed in Building B during the previous reporting period."
        )
        docs.append(document(role, "Prior period extract", prior_period, misleading))
    return {
        "id": f"{label}-{category}",
        "family": topic,
        "split": "development" if family < 3 else "held_out",
        "factory": f"SafetyProof Fictional Site {family + 1:02}",
        "category": category,
        "expected": category,
        "target": {"filename": "inspection-review.pdf", "page": 1, "quote": claim},
        "acceptable": ["needs_review", "not_assessed"]
        if category == "needs_review"
        else [],
        "citations": expected_citations,
        "docs": docs,
    }


def main():
    cases = [
        bundle(family, variant, category)
        for family in range(6)
        for variant in range(2)
        for category in CATEGORIES
    ]
    OUTPUT.write_text(json.dumps(cases, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
