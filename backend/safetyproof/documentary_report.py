import re


DOCUMENT_REVIEW_MARKER = "Review method: documentary review only"
REGISTER_START = "Carry-forward register"
REGISTER_END = "End of carry-forward register"
# A published report has one explicitly delimited entry per finding or claim.
# Notes and quoted evidence are printed separately and stay out of new results.
ENTRY = re.compile(
    r"(?m)^Carry-forward (finding(?: ([A-Z]{1,8}[-/]\d{1,8}))?|claim):\s*"
    r"(?:\[Period (\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})\]\s*)?"
    r"([\s\S]+?)\s+\[End review entry\]",
    re.IGNORECASE,
)


def is_document_review(page):
    return any(
        line.strip().casefold() == DOCUMENT_REVIEW_MARKER.casefold()
        for line in page.get("text", "").splitlines()[:18]
    )


def carried_entries(pages, chunks_by_page):
    in_register = False
    for page in sorted(pages, key=lambda value: value["page_no"]):
        text = page["text"]
        start = 0
        if not in_register:
            heading = re.search(rf"(?m)^{REGISTER_START}$", text)
            if not heading:
                continue
            start = heading.end()
            in_register = True
        end = re.search(rf"(?m)^{REGISTER_END}$", text)
        chunks = chunks_by_page[page["id"]]
        for match in ENTRY.finditer(text, start, end.start() if end else len(text)):
            kind, reference, start_date, end_date, _ = match.groups()
            # Wrapped entries can cross a retrieval chunk. Preserve the original
            # PDF page coordinates and identify the first persisted chunk.
            chunk = next((c for c in chunks if c["start_at"] <= match.start() < c["end_at"]), None)
            if not chunk:
                continue
            quote = match.group().strip()
            yield {
                "chunk_id": chunk["id"], "quote": quote,
                "kind": kind.split()[0].lower(),
                "finding_id": reference,
                "severity": "unknown",
                "start_date": start_date, "end_date": end_date,
                "documentary_carry_forward": True,
            }, {
                **chunk, "start_at": match.start(), "text": quote,
            }
        if end:
            return


def original_statement(quote):
    match = ENTRY.fullmatch(quote)
    return match.group(5).strip() if match else quote
