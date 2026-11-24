"""Run labelled synthetic bundles through the hosted model and optionally compare a full-bundle baseline."""

import argparse
import asyncio
from collections import Counter
import json
import os
from pathlib import Path
import time
from uuid import uuid4

import httpx

from safetyproof.ai import BASELINE, Gemini
from safetyproof.config import settings
from safetyproof.models import Verdict
from safetyproof.verify import normalized

HERE = Path(__file__).resolve().parent
FLAGS = {"contradicted", "unsupported", "unresolved"}


def comparable(text):
    return " ".join(normalized(text).split()).strip(".।")


async def evaluate(http, admin, reviewer_id, bundle, cfg, baseline):
    start = time.perf_counter()
    metrics = {"id": bundle["id"], "expected": bundle["expected"]}
    response = await admin.post(
        "/v1/admin/cases",
        json={
            "title": bundle["id"],
            "factory": bundle["factory"],
            "reviewer_id": reviewer_id,
        },
    )
    response.raise_for_status()
    cid = response.json()["id"]
    base = "/v1/cases/" + cid

    async def get(path):
        res = await http.get(path)
        res.raise_for_status()
        return res.json()

    async def poll(path, predicate, timeout=900):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            data = await get(path)
            if predicate(data):
                return data
            await asyncio.sleep(2)
        raise RuntimeError("Timed out while waiting for processing.")

    try:
        for doc in bundle["docs"]:
            meta = {
                k: doc[k]
                for k in (
                    "filename",
                    "role",
                    "title",
                    "issued_on",
                    "period_start",
                    "period_end",
                    "issuer",
                )
            }
            reserved = await http.post(
                base + "/uploads",
                json={
                    **meta,
                    "confirmed_factory": bundle["factory"],
                    "request_key": str(uuid4()),
                },
            )
            reserved.raise_for_status()
            ticket = reserved.json()
            infile = HERE / "output" / "inputs" / bundle["id"] / doc["filename"]
            # Do not carry the evaluation reviewer's bearer token to a signed upload.
            async with httpx.AsyncClient() as storage:
                upload = await storage.put(
                    ticket["upload_url"],
                    content=infile.read_bytes(),
                    headers={"content-type": "application/pdf", "x-upsert": "false"},
                )
                upload.raise_for_status()
            queued = await http.post(
                "/v1/document-versions/" + ticket["version_id"] + "/finalize"
            )
            queued.raise_for_status()

        case = await poll(
            base,
            lambda d: (
                len(d["versions"]) == len(bundle["docs"])
                and all(j["state"] in {"done", "failed"} for j in d["jobs"])
            ),
        )
        versions = {v["id"]: v for v in case["versions"]}
        request = await http.post(
            base + "/runs",
            json={"version_ids": list(versions), "request_key": str(uuid4())},
        )
        request.raise_for_status()
        ticket = request.json()
        run_path = "/v1/runs/" + ticket["run_id"]
        completed = await poll(
            run_path,
            lambda d: d["status"] in {"complete", "partial", "failed", "paused"},
        )
        if completed["status"] not in {"complete", "partial"}:
            raise RuntimeError(
                (await get("/v1/jobs/" + ticket["job_id"]))["error"]
                or completed["status"]
            )
        results = await get(run_path + "/results")
        target = bundle["target"]

        def same_source(result):
            ref = result["claim"]["source"]
            return (
                versions[ref["version_id"]]["filename"] == target["filename"]
                and ref["page"] == target["page"]
                and comparable(target["quote"]) in comparable(ref["quote"])
            )

        match = next((r for r in results if same_source(r)), None)
        actual = match["outcome"] if match else "missed_extraction"
        citations = bundle["citations"]
        matched_citations = []
        retrieved_citations = []
        if match:
            retrieved = match["coverage"]["retrieved"]
            # The API publishes candidate IDs and exact cited anchors; the database provides passage lookup.
            chunks = (
                (await get("/v1/runs/" + ticket["run_id"] + "/retrieval")).get(
                    match["id"], []
                )
                if citations
                else []
            )
            for expected in citations:
                matched_citations.append(
                    any(
                        versions[ref["version_id"]]["filename"] == expected["filename"]
                        and ref["page"] == expected["page"]
                        and comparable(ref["quote"]) in comparable(expected["quote"])
                        for ref in match["evidence"]
                    )
                )
                retrieved_citations.append(
                    any(
                        item["id"] in retrieved
                        and versions[item["version_id"]]["filename"]
                        == expected["filename"]
                        and item["page_no"] == expected["page"]
                        and comparable(expected["quote"]) in comparable(item["text"])
                        for item in chunks
                    )
                )
        metrics.update(
            actual=actual,
            passed=actual in [bundle["expected"], *bundle["acceptable"]],
            extra_flags=dict(
                Counter(
                    r["outcome"]
                    for r in results
                    if r is not match and r["outcome"] in FLAGS
                )
            ),
            usage=completed["usage"],
            citations_checked=len(citations),
            citations_correct=sum(matched_citations),
            retrieved_correct=sum(retrieved_citations),
            seconds=round(time.perf_counter() - start, 2),
        )

        if baseline:
            passages = []
            for vid, v in versions.items():
                for p in await get("/v1/document-versions/" + vid + "/pages"):
                    passages.append(
                        {
                            "id": p["id"],
                            "document": v["filename"],
                            "role": next(
                                d["role"]
                                for d in bundle["docs"]
                                if d["filename"] == v["filename"]
                            ),
                            "page": p["page_no"],
                            "text": p["text"],
                        }
                    )
            outcome, _ = await baseline.structured(
                BASELINE, {"target": target, "pages": passages}, Verdict
            )
            label = outcome["label"]
            metrics["baseline"] = {
                "supports": "supported",
                "contradicts": "contradicted",
                "ambiguous": "needs_review",
                "insufficient": "unresolved"
                if bundle["expected"] == "unresolved"
                else "unsupported",
            }[label]
    finally:
        response = await admin.delete(f"/v1/admin/cases/{cid}")
        response.raise_for_status()
    return metrics


async def main():
    cli = argparse.ArgumentParser()
    cli.add_argument("--split", choices=["development", "held_out"], default="held_out")
    cli.add_argument("--limit", type=int)
    cli.add_argument("--baseline", action="store_true")
    args = cli.parse_args()
    cfg = settings()
    if not cfg.gemini_api_key:
        cli.error("GEMINI_API_KEY is required for real model evaluation.")
    if not (cfg.admin_email and cfg.admin_password):
        cli.error(
            "ADMIN_EMAIL and ADMIN_PASSWORD are required to assign evaluation cases."
        )
    email, password = os.environ.get("EVAL_EMAIL"), os.environ.get("EVAL_PASSWORD")
    if not (email and password):
        email, password = tuple(
            json.loads((HERE.parent / ".local/accounts.json").read_text())["reviewer"][
                k
            ]
            for k in ("email", "password")
        )
    out = HERE / "output"
    out.mkdir(exist_ok=True)
    if not (out / "inputs").is_dir():
        cli.error(
            "Generate synthetic test PDFs with scripts/make_fixtures.py --evaluation."
        )
    fixtures = [
        c
        for c in json.loads((HERE / "labels.json").read_text())
        if c["split"] == args.split
    ]
    if args.limit:
        fixtures = fixtures[: args.limit]
    baseline = Gemini(cfg) if args.baseline else None
    rows = []
    try:
        async with httpx.AsyncClient() as auth:
            result = await auth.post(
                cfg.supabase_url + "/auth/v1/token",
                params={"grant_type": "password"},
                headers={"apikey": cfg.supabase_anon_key},
                json={"email": email, "password": password},
            )
            result.raise_for_status()
            reviewer = result.json()
            result = await auth.post(
                cfg.supabase_url + "/auth/v1/token",
                params={"grant_type": "password"},
                headers={"apikey": cfg.supabase_anon_key},
                json={"email": cfg.admin_email, "password": cfg.admin_password},
            )
            result.raise_for_status()
            admin_token = result.json()["access_token"]
        api_url = os.environ.get("EVAL_API_URL", "http://127.0.0.1:8000")
        async with (
            httpx.AsyncClient(
                base_url=api_url,
                timeout=30,
                headers={"Authorization": "Bearer " + reviewer["access_token"]},
            ) as http,
            httpx.AsyncClient(
                base_url=api_url,
                timeout=30,
                headers={"Authorization": "Bearer " + admin_token},
            ) as admin,
        ):
            for fixture in fixtures:
                row = await evaluate(
                    http, admin, reviewer["user"]["id"], fixture, cfg, baseline
                )
                rows.append(row)
                print(f"{row['id']}: {row['actual']} ({row['seconds']}s)", flush=True)
                (out / (args.split + "-runs.json")).write_text(
                    json.dumps(rows, ensure_ascii=False, indent=2) + "\n"
                )
    finally:
        if baseline:
            await baseline.client.aio.aclose()
    expected_counts = Counter(r["expected"] for r in rows)
    predictions = Counter(r["actual"] for r in rows)
    extra_flags = Counter()
    for row in rows:
        extra_flags.update(row["extra_flags"])
    predictions.update(extra_flags)
    correct = Counter(r["expected"] for r in rows if r["actual"] == r["expected"])

    def rate(n, d):
        return round(n / d, 3) if d else None

    summary = {
        label: {
            "precision": rate(correct[label], predictions[label]),
            "recall": rate(correct[label], expected_counts[label]),
            "f1": rate(2 * correct[label], predictions[label] + expected_counts[label]),
        }
        for label in sorted(FLAGS)
    }
    print(
        json.dumps(
            {
                "results": summary,
                "extra_flags": dict(extra_flags),
                "citation_matches": sum(r["citations_correct"] for r in rows),
                "retrieval_matches": sum(r["retrieved_correct"] for r in rows),
                "expected_citations": sum(r["citations_checked"] for r in rows),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    asyncio.run(main())
