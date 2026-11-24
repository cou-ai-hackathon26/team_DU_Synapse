"""OCR based content checks for uploaded factory safety documents."""

import re

LEGAL_SUFFIXES = {
    "ltd",
    "limited",
    "llc",
    "plc",
    "inc",
    "incorporated",
    "company",
    "co",
    "corporation",
}


def _name_tokens(value):
    tokens = re.findall(r"[^\W_]+", value.casefold())
    while len(tokens) > 1 and tokens[-1].rstrip(".") in LEGAL_SUFFIXES:
        tokens.pop()
    return tokens


def factory_name_is_present(pages, factory):
    expected = _name_tokens(factory)
    actual = [
        token
        for page in pages
        for token in _name_tokens(page.get("text", ""))
    ]
    if not expected:
        return False
    size = len(expected)
    return any(actual[index : index + size] == expected for index in range(len(actual)))


def _pages_text(pages):
    return "\n\n".join(
        f"PAGE {page.get('page_no', index + 1)}\n{page['text'].strip()}"
        for index, page in enumerate(pages)
        if isinstance(page.get("text"), str) and page["text"].strip()
    )


def _has_any(text, patterns):
    return any(re.search(pattern, text, re.IGNORECASE) for pattern in patterns)


def _local_inspection_check(pages, factory):
    """Conservative, deterministic substitute for the upload-time AI screen.

    This checks document structure and OCR evidence only. It cannot establish
    authenticity or whether a reported safety claim is true.
    """
    text = _pages_text(pages)
    if not text.strip():
        return {
            "content_check": "unreadable",
            "content_reason": "No readable text was available for the local document check.",
            "content_indicators": [],
            "content_model": "local-ocr-rules-v1",
        }

    if not factory_name_is_present(pages, factory):
        return {
            "content_check": "invalid",
            "content_reason": f"The readable PDF does not identify {factory}.",
            "content_indicators": ["factory_name_missing_or_mismatched"],
            "content_model": "local-ocr-rules-v1",
        }

    normalized = text.casefold()
    inspection_cues = [
        r"\binspection\s+report\b",
        r"\bfollow[ -]?up\s+(?:inspection|visit)\b",
        r"\bsafety\s+inspection\b",
        r"\binspection\s+date\b",
        r"\binspected\s+(?:area|equipment|location|condition)\b",
    ]
    finding_cues = [
        r"\bfindings?\b",
        r"\bobservations?\b",
        r"\b(?:FI|finding)\s*[-#]?\s*\d+\b",
        r"\b(?:open|closed)\s*[-—]\s*(?:verified|not closed)\b",
        r"\bcorrective action\b",
    ]
    evidence_cues = [
        r"\b(?:area|location|asset|equipment)\s*:",
        r"\b(?:rechecked|observed|checked|reviewed|tested)\b",
        r"\b(?:result|evidence required|follow-up result)\b",
        r"\b(?:fire|emergency|electrical|machine|egress|worker|safety)\b",
    ]
    matched = []
    for label, patterns in (
        ("inspection_report_structure", inspection_cues),
        ("finding_or_observation", finding_cues),
        ("specific_inspection_evidence", evidence_cues),
    ):
        if _has_any(normalized, patterns):
            matched.append(label)

    inspection_structure = _has_any(normalized, inspection_cues)
    findings_present = _has_any(normalized, finding_cues)
    evidence_present = _has_any(normalized, evidence_cues)
    enough_text = len(re.findall(r"\b[\w-]+\b", normalized)) >= 120
    if inspection_structure and findings_present and evidence_present and enough_text:
        return {
            "content_check": "valid",
            "content_reason": "Local OCR checks found the factory name, inspection structure, findings, and specific follow-up evidence in the PDF. This does not verify whether the claims are true.",
            "content_indicators": matched,
            "content_model": "local-ocr-rules-v1",
        }

    clearly_other_record = _has_any(
        normalized,
        [
            r"\bincident\s+(?:register|log)\b",
            r"\bstandard operating procedure\b|\b\bSOP\b",
            r"\bcorrective action plan\b|\bCAP\b",
            r"\bmaintenance\s+(?:log|record)\b",
            r"\bdrill\s+(?:record|log|report)\b",
        ],
    )
    if clearly_other_record and not inspection_structure:
        status = "invalid"
        reason = "The OCR text identifies a different factory record type, not an inspection report."
    else:
        status = "uncertain"
        reason = "The local OCR checks could not find enough inspection findings and specific evidence to confirm this as an inspection report."
    return {
        "content_check": status,
        "content_reason": reason,
        "content_indicators": matched,
        "content_model": "local-ocr-rules-v1",
    }


ROLE_PATTERNS = {
    "cap": [r"\bcorrective action plan\b", r"\bCAP\b"],
    "incident": [r"\bincident (?:register|log|record)\b", r"\baccident register\b"],
    "sop": [r"\bstandard operating procedure\b", r"\bSOP\b", r"\bprocedure\b"],
    "drill": [r"\b(?:fire|emergency|evacuation) drill\b", r"\bdrill record\b"],
    "maintenance": [r"\bmaintenance (?:log|record|register)\b", r"\bwork order\b"],
    "other": [r"\bfollow[ -]?up evidence\b", r"\bsupporting record\b"],
}


def _local_factory_role_scores(text):
    scores = {role: 0 for role in ROLE_PATTERNS}
    for role, patterns in ROLE_PATTERNS.items():
        scores[role] = sum(bool(re.search(pattern, text, re.IGNORECASE)) for pattern in patterns)
    # Count meaningful record structure, not isolated safety vocabulary.
    if _has_any(text, [r"\bFI\s*[-#]?\s*\d+\b", r"\bfinding\s*[-#]?\s*\d+\b"]):
        scores["cap"] += 1
        scores["other"] += 1
    if _has_any(text, [r"\bCA\s*[-#]?\s*\d+\b", r"\baction (?:owner|deadline|target|status)\b"]):
        scores["cap"] += 1
    if _has_any(text, [r"\b(?:incident date|date of incident|incident details)\b", r"\bno incidents? (?:reported|recorded)\b"]):
        scores["incident"] += 1
    if _has_any(text, [r"\b(?:steps|responsibilities|scope|procedure)\b", r"\bshall\b"]):
        scores["sop"] += 1
    if _has_any(text, [r"\b(?:participants|attendees|attendance|debrief|roll call|exercise date)\b", r"\bdrill date\b"]):
        scores["drill"] += 1
    if _has_any(text, [r"\b(?:asset|equipment|work performed|service date|technician)\b", r"\b(?:repaired|tested|replaced)\b"]):
        scores["maintenance"] += 1
    if _has_any(text, [r"\b(?:evidence observed|verification result|closure check|photo reference)\b"]):
        scores["other"] += 1
    return scores


def _local_factory_record_check(pages, factory, expected_role):
    text = _pages_text(pages)
    if not text.strip():
        return {
            "content_check": "unreadable",
            "content_reason": "No readable text was available to identify this factory record.",
            "content_indicators": [],
            "content_model": "local-ocr-rules-v1",
        }
    if not factory_name_is_present(pages, factory):
        return {
            "content_check": "invalid",
            "content_reason": f"The readable PDF does not identify {factory}.",
            "content_indicators": ["factory_name_missing_or_mismatched"],
            "content_model": "local-ocr-rules-v1",
        }
    words = re.findall(r"\b[\w-]+\b", text)
    scores = _local_factory_role_scores(text)
    best = max(scores, key=scores.get)
    indicators = [role for role, score in scores.items() if score]
    if expected_role == "inspection":
        return _local_inspection_check(pages, factory)
    if expected_role in scores:
        score = scores[expected_role]
        if score >= 2 and len(words) >= 30 and best == expected_role:
            status = "valid"
            reason = f"Local OCR found the factory name and document structure expected for a {expected_role} record. This does not verify whether its claims are true."
        elif score >= 2 and len(words) >= 30 and scores[best] == score:
            status = "uncertain"
            reason = "The OCR text contains more than one possible record type; a reviewer should check the complete PDF."
        elif best != expected_role and scores[best] >= 2:
            status = "invalid"
            reason = f"The OCR structure looks like a {best} record, not the selected {expected_role} record."
        else:
            status = "uncertain"
            reason = f"The OCR text does not contain enough structured evidence to confirm a {expected_role} record."
    else:
        status = "uncertain"
        reason = "Choose a record type; the OCR text does not identify one confidently."
    return {
        "content_check": status,
        "content_reason": reason,
        "content_indicators": indicators[:5],
        "content_model": "local-ocr-rules-v1",
    }


async def check_inspection_content(
    pages, filename, factory, inspection_date, ai, factory_name_present=None
):
    """Check the entire OCR text locally; upload screening does not call Gemini."""
    return _local_inspection_check(pages, factory)


async def check_factory_record_content(
    pages,
    filename,
    factory,
    inspection_date,
    expected_role,
    ai,
    factory_name_present=None,
):
    """Check a factory record with deterministic rules over all OCR pages."""
    return _local_factory_record_check(pages, factory, expected_role)


async def classify_factory_record_content(
    pages, filename, factory, inspection_date, ai
):
    """Infer a likely record type locally; ambiguous PDFs require a manual choice."""
    text = _pages_text(pages)
    if not text.strip():
        return {
            "role": "other",
            "content_check": "unreadable",
            "content_reason": "No readable text was available to identify this factory record.",
            "content_indicators": [],
            "content_model": "local-ocr-rules-v1",
        }
    scores = _local_factory_role_scores(text)
    role = max(scores, key=scores.get)
    result = _local_factory_record_check(pages, factory, role)
    result["role"] = role
    return result
