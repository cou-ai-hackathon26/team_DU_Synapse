"""Best-effort metadata extraction from the first OCR-readable PDF pages."""

import re
from datetime import datetime


DATE_TOKEN = re.compile(
    r"\d{4}[-/.]\d{1,2}[-/.]\d{1,2}"
    r"|\d{1,2}[-/.]\d{1,2}[-/.]\d{4}"
    r"|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}"
    r"|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}",
    re.IGNORECASE,
)
MONTH_RANGE = re.compile(
    r"\b(\d{1,2})\s*(?:[-–—]|\bto\b)\s*(\d{1,2})\s+"
    r"(January|February|March|April|May|June|July|August|September|October|"
    r"November|December)\s+(\d{4})\b",
    re.IGNORECASE,
)
BENGALI_DIGITS = str.maketrans("০১২৩৪৫৬৭৮৯", "0123456789")


def parse_date(value):
    value = " ".join(value.translate(BENGALI_DIGITS).strip().split())
    value = value.replace("/", "-").replace(".", "-")
    formats = [
        "%Y-%m-%d",
        "%d-%m-%Y",
        "%m-%d-%Y",
        "%d %B %Y",
        "%d %b %Y",
        "%B %d %Y",
        "%b %d %Y",
    ]
    for fmt in formats:
        try:
            return datetime.strptime(value.replace(",", ""), fmt).date().isoformat()
        except ValueError:
            continue
    return None


def _first_date(text):
    match = DATE_TOKEN.search(text)
    return parse_date(match.group()) if match else None


def extract_cap_submission_deadline(pages):
    """Read an explicitly labelled CAP submission deadline from report text."""
    label = re.compile(r"\bCAP\s+submission\s+deadline\s*[:：-]?", re.IGNORECASE)
    for page in pages:
        for line in page.get("text", "").translate(BENGALI_DIGITS).splitlines():
            match = label.search(line)
            if match:
                deadline = _first_date(line[match.end() :])
                if deadline:
                    return deadline
    return None


def _date_pair(text):
    month_range = MONTH_RANGE.search(text)
    if month_range:
        first, last, month, year = month_range.groups()
        try:
            return (
                datetime.strptime(
                    f"{first} {month} {year}", "%d %B %Y"
                ).date().isoformat(),
                datetime.strptime(
                    f"{last} {month} {year}", "%d %B %Y"
                ).date().isoformat(),
            )
        except ValueError:
            pass
    dates = [parse_date(m.group()) for m in DATE_TOKEN.finditer(text)]
    dates = [value for value in dates if value]
    if len(dates) >= 2:
        return dates[0], dates[1]
    return None, None


def _label_value(lines, pattern):
    for line in lines:
        match = pattern.search(line)
        if match:
            value = line[match.end() :].strip(" \t:–—-|")
            if value:
                return value
    return None


def extract_metadata(pages, filename, scheduled_date=None):
    lines = [
        line.strip()
        for page in pages
        for line in page.get("text", "").translate(BENGALI_DIGITS).splitlines()
        if line.strip()
    ]
    text = "\n".join(lines)
    lower = (text + "\n" + filename).lower()
    header = re.sub(
        r"[-_]+", " ", ("\n".join(lines[:18]) + "\n" + filename).lower()
    )

    if re.search(
        r"\b(corrective action plan|\bcap[-\s]?(?:\d|:)|cap status)\b", header
    ):
        role = "cap"
    elif re.search(
        r"\b(incident register|accident register|injury register|incident log)\b",
        header,
    ):
        role = "incident"
    elif re.search(
        r"\b(maintenance log|maintenance record|equipment service log)\b", header
    ):
        role = "maintenance"
    elif re.search(
        r"\b(drill record|drill log|training attendance|fire drill attendance)\b",
        header,
    ):
        role = "drill"
    elif re.search(
        r"\b(operating procedure|standard operating procedure|\bsop\b|procedure)\b",
        header,
    ):
        role = "sop"
    elif re.search(
        r"\b(inspection report|inspection review|safety inspection|inspection date|"
        r"inspection)\b",
        header,
    ):
        role = "inspection"
    else:
        role = "other"

    inspection_date = None
    inspection_label = re.compile(
        r"(?:inspection|visit|audit)\s+(?:date|on)|পরিদর্শনের?\s+তারিখ",
        re.IGNORECASE,
    )
    for line in lines:
        match = inspection_label.search(line)
        if match:
            inspection_date = _first_date(line[match.end() :])
            if inspection_date:
                break

    issued_on = inspection_date if role == "inspection" else None
    if not issued_on:
        issue_label = re.compile(
            r"(?:issue\s+date|issued\s+on|date\s+of\s+issue|document\s+date|"
            r"report\s+date|date\s+of\s+report|record\s+date|publication\s+date|dated)",
            re.IGNORECASE,
        )
        for line in lines:
            match = issue_label.search(line)
            if match:
                issued_on = _first_date(line[match.end() :])
                if issued_on:
                    break
    if not issued_on and role == "inspection":
        issued_on = inspection_date

    period_start = period_end = None
    start_label = re.compile(
        r"(?:period\s+start(?:s|ing)?|period\s+begins?|"
        r"coverage\s+(?:starts?|begins?))\b",
        re.IGNORECASE,
    )
    end_label = re.compile(
        r"(?:period\s+ends?|end\s+date|coverage\s+(?:ends?|through)|"
        r"valid\s+until)\b",
        re.IGNORECASE,
    )
    for line in lines:
        match = start_label.search(line)
        if match and not period_start:
            period_start = _first_date(line[match.end() :])
        match = end_label.search(line)
        if match and not period_end:
            period_end = _first_date(line[match.end() :])
    if not (period_start and period_end):
        period_label = re.compile(
            r"(?:reporting|review|inspection|incident|coverage)?\s*period|"
            r"period covered|period of review|coverage window",
            re.IGNORECASE,
        )
        for line in lines:
            if period_label.search(line):
                start, end = _date_pair(line)
                period_start = period_start or start
                period_end = period_end or end
                if period_start or period_end:
                    break

    title_pattern = re.compile(
        r"(?:document\s+title|report\s+title|document\s+name|title)\s*[:–—-]\s*",
        re.IGNORECASE,
    )
    title = _label_value(lines, title_pattern)
    if title:
        title = title[:160].strip()

    issuer = "unknown"
    if role == "inspection":
        issuer = "external"
    elif re.search(r"\b(factory|management|prepared by factory)\b", lower):
        issuer = "factory"
    elif re.search(r"\b(auditor|independent reviewer|inspection body)\b", lower):
        issuer = "external"

    warnings = []
    if scheduled_date and role == "inspection":
        if not inspection_date:
            warnings.append("OCR could not read an inspection date from the PDF.")
        elif inspection_date != scheduled_date:
            warnings.append(
                f"PDF inspection date {inspection_date} does not match the date "
                f"scheduled by the admin ({scheduled_date})."
            )

    return {
        "title": title,
        "role": role,
        "issued_on": issued_on,
        "inspection_date": inspection_date,
        "period_start": period_start,
        "period_end": period_end,
        "issuer": issuer,
        "warnings": warnings,
        "readable_pages": sum(page.get("quality") == "readable" for page in pages),
        "pages_checked": len(pages),
    }
