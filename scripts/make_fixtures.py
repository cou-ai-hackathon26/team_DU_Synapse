"""Build team-owned synthetic inputs. Answers from evaluation/labels.json never enter a PDF or the app."""

import argparse
import json
import os
from shutil import copyfile
import textwrap
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

ROOT = Path(__file__).resolve().parents[1]
FACTORY = "Shaluk Threadworks Ltd."


def font_bn(size):
    path = os.environ.get(
        "BENGALI_FONT", "/usr/share/fonts/truetype/noto/NotoSansBengali-Regular.ttf"
    )
    return ImageFont.truetype(path, size)


def render(path, title, lines, scan=False, factory=FACTORY):
    path.parent.mkdir(parents=True, exist_ok=True)
    pdf = canvas.Canvas(str(path), pagesize=A4, invariant=1)
    pdf.setTitle(title)
    if scan:
        img = Image.new("RGB", (1240, 1754), "#fffefa")
        draw = ImageDraw.Draw(img)

        def line(text, pos, size, fill="#17251e", bangla=False):
            font = (
                font_bn(size) if bangla else ImageFont.truetype("DejaVuSans.ttf", size)
            )
            draw.text(pos, text, font=font, fill=fill)

        line("SYNTHETIC DOCUMENT  /  SAFETYPROOF", (76, 86), 21, "#475d53")
        line(title, (76, 158), 42)
        line(factory, (76, 235), 27)
        draw.line((76, 307, 1164, 307), fill="#7c8c81", width=2)
        y = 370
        for content in lines:
            bn = any("\u0980" <= c <= "\u09ff" for c in content)
            for row in textwrap.wrap(
                content, width=48 if bn else 58, break_long_words=False
            ):
                line(row, (76, y), 31, bangla=bn)
                y += 59
            y += 28
        line("Fictional training record  /  Page 1", (76, 1640), 22, "#526858")
        pdf.drawImage(ImageReader(img), 0, 0, A4[0], A4[1])
    else:
        pdf.setFillColor(HexColor("#245a49"))
        pdf.setFont("Helvetica-Bold", 10)
        pdf.drawString(48, 778, "SAFETYPROOF  /  SYNTHETIC DOCUMENT")
        pdf.setFillColor(HexColor("#152923"))
        pdf.setFont("Helvetica-Bold", 22)
        pdf.drawString(48, 730, title)
        pdf.setFont("Helvetica", 12)
        pdf.drawString(48, 705, factory)
        pdf.setStrokeColor(HexColor("#91aaa0"))
        pdf.line(48, 685, 545, 685)
        y = 648
        for content in lines:
            for row in textwrap.wrap(content, width=77, break_long_words=False):
                pdf.drawString(48, y, row)
                y -= 19
            y -= 13
        pdf.setFont("Helvetica", 9)
        pdf.drawString(
            48,
            47,
            "Fictional training record. All people, locations and events are invented.",
        )
        pdf.drawRightString(544, 47, "Page 1")
    pdf.showPage()
    pdf.save()


def demo():
    docs = [
        (
            "march-inspection.pdf",
            "March inspection",
            "inspection",
            "2026-03-06",
            "2026-03-01",
            "2026-03-06",
            "external",
            False,
            [
                "Inspection date: 6 March 2026. Area: Building A, ground floor.",
                "Finding FI-16. Exit E-02 was obstructed by cartons on 6 March 2026.",
                "Required action: clear the aisle and provide a follow-up inspection record.",
                "Inspector-reported severity: high.",
            ],
        ),
        (
            "april-inspection.pdf",
            "April inspection review",
            "inspection",
            "2026-04-30",
            "2026-04-01",
            "2026-04-30",
            "external",
            False,
            [
                "Monthly review covering the whole factory, 1-30 April 2026.",
                "No workplace injuries occurred during April 2026.",
                "One emergency drill was held in each month from February through April 2026.",
                "Follow-up observations: emergency lighting operated in Building A on 28 April.",
            ],
        ),
        (
            "fire-procedure.pdf",
            "Fire drill procedure",
            "sop",
            "2026-01-02",
            None,
            None,
            "factory",
            False,
            [
                "Procedure FS-02, issued 2 January 2026.",
                "The safety officer must schedule a practice drill each month and retain the dated attendance record.",
                "This document describes the procedure. Completed drills are recorded separately.",
            ],
        ),
        (
            "incident-register.pdf",
            "April incident register",
            "incident",
            "2026-04-30",
            "2026-04-01",
            "2026-04-30",
            "factory",
            True,
            [
                "ঘটনার তারিখ: ১৫ এপ্রিল ২০২৬",
                "১৫ এপ্রিল কাটিং মেশিনে একজন শ্রমিক আহত হন।",
                "স্থান: ভবন এ, কাটিং বিভাগ।",
                "রেকর্ড নম্বর: ০৪১৫",
            ],
        ),
        (
            "corrective-action-plan.pdf",
            "March corrective action plan",
            "cap",
            "2026-03-12",
            None,
            None,
            "factory",
            False,
            [
                "CA-01 for finding FI-16: Remove cartons and clear Exit E-02.",
                "CA-01 target: 20 March 2026. Reported status: planned.",
                "CA-02 for finding FI-16: Mark the aisle at Exit E-02 with floor paint.",
                "CA-02 target: 25 March 2026. Reported status: in progress.",
                "CA-03: Replace two faded directional signs at Building B.",
            ],
        ),
    ]
    catalog = {
        "factory": FACTORY,
        "title": "April safety review",
        "programme": "Fictional internal documentary review",
        "period_start": "2026-04-01",
        "period_end": "2026-04-30",
        "documents": [],
    }
    for name, title, role, issued, start, end, issuer, scan, lines in docs:
        original = ROOT / "fixtures/demo" / name
        render(original, title, lines, scan)
        publication = ROOT / "frontend/public/factory-documents" / name
        publication.parent.mkdir(parents=True, exist_ok=True)
        copyfile(original, publication)
        catalog["documents"].append(
            {
                "filename": name,
                "title": title,
                "role": role,
                "issued_on": issued,
                "period_start": start,
                "period_end": end,
                "issuer": issuer,
                "scan": scan,
            }
        )
    (ROOT / "fixtures/demo/manifest.json").write_text(
        json.dumps(catalog, indent=2) + "\n"
    )
    render(
        ROOT / "fixtures/live/exit-follow-up.pdf",
        "Exit follow-up inspection",
        [
            "External follow-up, 12 May 2026. Finding FI-16, Building A, ground floor.",
            "On 12 May 2026 the inspector verified that Exit E-02 was clear and its aisle was unobstructed.",
        ],
    )


def closure_example():
    render(
        ROOT / "fixtures/live/april-exit-follow-up.pdf",
        "April exit follow-up inspection",
        [
            "External follow-up inspection: 28 April 2026. Reference FU-FI16-APR28.",
            "Original finding FI-16: cartons obstructed Exit E-02 on 6 March 2026, Building A, ground floor.",
            "On 28 April 2026, the follow-up inspector observed that all cartons had been removed from Exit E-02. Exit E-02 and its access aisle were clear and unobstructed.",
            "Outcome: the obstruction recorded in finding FI-16 was verified as resolved on 28 April 2026.",
            "The actual work completion date was not established. This observation does not prove completion by the CAP deadline of 20 March 2026.",
            "Scope: exit obstruction only. Aisle floor markings and directional signage were not verified in this follow-up.",
        ],
    )


def evaluation():
    labels = json.loads((ROOT / "evaluation/labels.json").read_text())
    for case in labels:
        folder = ROOT / "evaluation/output/inputs" / case["id"]
        factory = case["factory"]
        for doc in case["docs"]:
            render(
                folder / doc["filename"],
                doc["title"],
                doc["lines"],
                doc.get("scan", False),
                factory=factory,
            )
    print(f"Generated {len(labels)} synthetic assessment bundles.")


def hazard_history_example():
    folder = ROOT / "output" / "pdf" / "hazard-history"
    factory = "Kadam Weaving Works"
    inspections = [
        ("01-march-inspection.pdf", "March safety inspection", "9 March 2026",
         "Finding FI-26. On 9 March 2026, eight cartons blocked the access aisle to emergency Exit E-07."),
        ("03-april-follow-up.pdf", "April follow-up inspection", "13 April 2026",
         "Finding FI-26. On 13 April 2026, Exit E-07 was still obstructed by cartons in the access aisle."),
        ("04-may-follow-up.pdf", "May follow-up inspection", "11 May 2026",
         "On 11 May 2026, the inspector independently verified that finding FI-26 was resolved: Exit E-07 and its access aisle were clear, and the door opened fully."),
        ("05-june-follow-up.pdf", "June follow-up inspection", "8 June 2026",
         "Finding FI-26. On 8 June 2026, packed cartons again blocked the access aisle to Exit E-07."),
    ]
    for filename, title, date, observation in inspections:
        render(folder / filename, title, [
            f"Inspection date: {date}.",
            "Issuer: Lakeview Safety Inspection Service, external inspector.",
            "Inspection area: Building A, ground floor, emergency exit aisle.",
            observation,
            "Inspection method: The reviewer walked the marked route from the packing area to the exterior door and visually checked the access aisle from both directions. The reviewer compared the location with the posted evacuation map and recorded the condition on the day of the visit.",
            "Scope: This inspection covers the ground-floor access aisle and the emergency exit at the end of that aisle. Other floors, fire suppression equipment, electrical installations, evacuation drills and training records are outside the scope of this visit.",
        ], factory=factory)
    render(folder / "02-bangla-corrective-action-plan.pdf", "Corrective action plan", [
        "Issue date: 12 March 2026. Issuer: Factory management.",
        "Finding ID: FI-26. Action ID: CA-26. Exit: E-07.",
        "সংশোধনী কর্মপরিকল্পনা: জরুরি বহির্গমন পথ থেকে কার্টন সরানো।",
        "কারখানার দাবি: কার্টন সরানো হয়েছে এবং পথটি এখন খোলা।",
        "কারখানার নিজস্ব নথি। কোনো স্বাধীন পরিদর্শন করা হয়নি।",
    ], scan=True, factory=factory)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--evaluation", action="store_true")
    p.add_argument("--closure-example", action="store_true")
    p.add_argument("--hazard-history-example", action="store_true")
    args = p.parse_args()
    if args.evaluation:
        evaluation()
    elif args.closure_example:
        closure_example()
    elif args.hazard_history_example:
        hazard_history_example()
    else:
        demo()
