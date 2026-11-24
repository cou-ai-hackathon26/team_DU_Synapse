"""Case-scoped duplicate checks for uploaded safety records."""

import hashlib
import re
import unicodedata


def normalized_text(pages):
    text = "\n".join(
        page.get("text", "") for page in pages if isinstance(page.get("text"), str)
    )
    text = unicodedata.normalize("NFKC", text).casefold()
    return " ".join(re.findall(r"[\w]+", text, flags=re.UNICODE))


def content_fingerprint(pages, fallback_bytes=None):
    text = normalized_text(pages)
    if text:
        return hashlib.sha256(text.encode("utf-8")).hexdigest()
    return hashlib.sha256(fallback_bytes).hexdigest() if fallback_bytes else None


def _shingles(text):
    words = text.split()[:30_000]
    if len(words) < 5:
        return set(words)
    return {" ".join(words[index : index + 5]) for index in range(len(words) - 4)}


def _similarity(left, right):
    a, b = _shingles(left), _shingles(right)
    return len(a & b) / len(a | b) if a and b else 0


def _record_ids(text):
    return set(
        re.findall(
            r"\b(?:FI|CA|INC|DR|WO|EL|EX|EQ|ASSET)[-\s]?[A-Z0-9]{1,12}\b",
            text.upper(),
        )
    )


def duplicate_candidate(pages, metadata, existing):
    """Return a warning only for a strong same-record signal; never auto-block it."""
    candidate_text = normalized_text(pages)
    role = metadata.get("role")
    if not candidate_text or not role:
        return None
    for record in existing:
        if record.get("role") != role:
            continue
        prior_text = normalized_text(record.get("pages", []))
        if not prior_text:
            continue
        ratio = _similarity(candidate_text, prior_text)
        same_issue_date = bool(
            metadata.get("issued_on")
            and metadata.get("issued_on") == record.get("issued_on")
        )
        same_period = bool(
            metadata.get("period_start")
            and metadata.get("period_start") == record.get("period_start")
            and metadata.get("period_end") == record.get("period_end")
        )
        shares_record_id = bool(_record_ids(candidate_text) & _record_ids(prior_text))
        if (
            ratio >= 0.8
            or ((same_issue_date or same_period) and ratio >= 0.35)
            or (shares_record_id and ratio >= 0.12)
        ):
            return (
                "This may describe a record already in this case. Check whether it "
                "is the same event or reporting period; upload it as a revision "
                "only when it updates that existing record."
            )
    return None
