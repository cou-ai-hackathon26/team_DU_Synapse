"""Read printed PDFs one page at a time. Anchors use Unicode character offsets and top-left unit boxes."""

import hashlib
import io
import json
import re
import sys
from collections import defaultdict
from pathlib import Path
from uuid import UUID, uuid5
from .config import PARSER


def chunks_for(page, version_id):
    """Group adjacent whole lines. A chunk never crosses a page."""
    groups, current = [], []
    for block in page["blocks"]:
        if current and block["end"] - current[0]["start"] > 950:
            groups.append(current)
            current = []
        current.append(block)
    if current:
        groups.append(current)
    chunks = []
    for blocks in groups:
        start, end = blocks[0]["start"], blocks[-1]["end"]
        chunks.append(
            {
                "id": str(
                    uuid5(UUID(version_id), f"{PARSER}/{page['page_no']}/{start}")
                ),
                "page_id": page["id"],
                "page_no": page["page_no"],
                "start_at": start,
                "end_at": end,
                "text": page["text"][start:end],
            }
        )
    return chunks


def native_lines(page):
    lines = page.extract_text_lines(strip=True, return_chars=False, layout=False) or []
    return [
        (
            line["text"],
            [
                line["x0"] / page.width,
                line["top"] / page.height,
                line["x1"] / page.width,
                line["bottom"] / page.height,
            ],
        )
        for line in lines
    ]


def scan_lines(pdf, index, lang_path):
    import tesserocr

    page = pdf[index]
    width, height = page.get_size()
    if min(width, height) <= 0:
        raise ValueError("Invalid PDF page size.")
    scale = min(2.5, 2000 / max(width, height))
    bitmap = page.render(scale=scale)
    img = bitmap.to_pil().convert("L")
    try:
        with tesserocr.PyTessBaseAPI(
            path=lang_path, lang="eng+ben", psm=tesserocr.PSM.AUTO
        ) as api:
            api.SetImage(img)
            tsv = api.GetTSVText(0)
    finally:
        bitmap.close()
        page.close()
    groups, conf = defaultdict(list), []
    for line in tsv.splitlines():
        parts = line.split("\t", 11)
        if len(parts) != 12 or parts[0] != "5" or not parts[11].strip():
            continue
        x, y, w, h = map(int, parts[6:10])
        groups[tuple(parts[2:5])].append((parts[11].strip(), x, y, x + w, y + h))
        conf.append(float(parts[10]))
    lines = [
        (
            " ".join(v[0] for v in words),
            [
                min(v[1] for v in words) / img.width,
                min(v[2] for v in words) / img.height,
                max(v[3] for v in words) / img.width,
                max(v[4] for v in words) / img.height,
            ],
        )
        for words in groups.values()
    ]
    img.close()
    return lines, ("readable" if conf and sum(conf) / len(conf) >= 60 else "uncertain")


def parse_pdf(data, version_id, tessdata, offset=0, batch_size=None):
    import pdfplumber
    import pypdfium2 as pdfium

    if b"%PDF-" not in data[:1024]:
        raise ValueError("Upload a valid PDF.")
    pages, chunks = [], []
    with pdfplumber.open(io.BytesIO(data)) as doc:
        if doc.doc.encryption:
            raise ValueError("Password-protected PDFs are unsupported.")
        pdf = pdfium.PdfDocument(data)
        try:
            total_pages = len(pdf)
            if not 0 <= offset < total_pages:
                raise ValueError("The PDF has no pages at the requested offset.")
            end = (
                total_pages
                if batch_size is None
                else min(total_pages, offset + batch_size)
            )
            for i in range(offset, end):
                page = doc.pages[i]
                method, quality = "native", "readable"
                lines = native_lines(page)
                text = " ".join(t for t, _ in lines)
                has_scan = any(
                    max(0, image["x1"] - image["x0"])
                    * max(0, image["bottom"] - image["top"])
                    >= 0.25 * page.width * page.height
                    for image in page.images
                )
                if (
                    has_scan
                    or len(re.findall(r"[^\W_]", text)) < 14
                    or "(cid:" in text
                    or "\ufffd" in text
                ):
                    method = "ocr"
                    if not all(
                        (Path(tessdata) / (lang + ".traineddata")).is_file()
                        for lang in ("eng", "ben")
                    ):
                        raise ValueError(
                            "English and Bangla OCR language data are required. Install them and retry."
                        )
                    lines, quality = scan_lines(pdf, i, tessdata)
                blocks, parts, text_offset = [], [], 0
                for t, box in lines:
                    t = t.strip()
                    if not t:
                        continue
                    parts.append(t)
                    blocks.append(
                        {
                            "start": text_offset,
                            "end": text_offset + len(t),
                            "box": [round(max(0, min(1, x)), 5) for x in box],
                        }
                    )
                    text_offset += len(t) + 1
                if text_offset > 100_000:
                    raise ValueError("Page exceeds the text processing limit.")
                item = {
                    "id": str(uuid5(UUID(version_id), f"{PARSER}/page/{i + 1}")),
                    "page_no": i + 1,
                    "method": method,
                    "quality": quality if blocks else "unreadable",
                    "text": "\n".join(parts),
                    "blocks": blocks,
                }
                pages.append(item)
                if item["quality"] == "readable":
                    chunks.extend(chunks_for(item, version_id))
                page.close()
        finally:
            pdf.close()
    return {
        "offset": offset,
        "total_pages": total_pages,
        "pages": pages,
        "chunks": chunks,
        "readable_pages": sum(p["quality"] == "readable" for p in pages),
        "parser": PARSER,
        "sha256": hashlib.sha256(data).hexdigest(),
    }


if __name__ == "__main__":
    import resource

    resource.setrlimit(resource.RLIMIT_CPU, (80, 85))
    resource.setrlimit(resource.RLIMIT_AS, (410 * 1024**2, 410 * 1024**2))
    try:
        result = parse_pdf(
            sys.stdin.buffer.read(),
            sys.argv[1],
            sys.argv[2],
            int(sys.argv[3]) if len(sys.argv) > 3 else 0,
            int(sys.argv[4]) if len(sys.argv) > 4 else None,
        )
        sys.stdout.write(json.dumps(result, ensure_ascii=False))
    except Exception as exc:
        detail = (
            str(exc)
            if isinstance(exc, ValueError)
            else "PDF could not be read. Check for encryption or a damaged file."
        )
        sys.stderr.write(detail[:220])
        sys.exit(2)
