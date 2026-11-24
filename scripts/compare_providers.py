"""Compare Gemini and xAI on identical synthetic follow-up statements."""

import asyncio
import argparse
import json
from pathlib import Path
import statistics
import sys
import time

from safetyproof.ai import BLIND, Gemini, InferenceFailure
from safetyproof.config import settings
from safetyproof.models import SecondOpinion


CASES = [
    {
        "id": "independent_closure",
        "expected": "entails",
        "hypothesis": "Finding FI-16 at Exit E-02 was independently verified as corrected.",
        "premises": [
            {
                "text": "External follow-up inspection, 12 May 2026. Finding FI-16: the inspector observed that all cartons had been removed and Exit E-02 was clear and unobstructed."
            }
        ],
    },
    {
        "id": "factory_self_report",
        "expected": "insufficient",
        "hypothesis": "Finding FI-16 at Exit E-02 was independently verified as corrected.",
        "premises": [
            {
                "text": "Factory CAP update: cartons removed from Exit E-02. Status: completed by factory maintenance team."
            }
        ],
    },
    {
        "id": "continued_obstruction",
        "expected": "contradicts",
        "hypothesis": "Finding FI-16 at Exit E-02 was independently verified as corrected.",
        "premises": [
            {
                "text": "Independent follow-up inspection, 12 May 2026: Finding FI-16 remains open; cartons still obstruct Exit E-02."
            }
        ],
    },
    {
        "id": "different_asset",
        "expected": "insufficient",
        "hypothesis": "Finding FI-16 at Exit E-02 was independently verified as corrected.",
        "premises": [
            {
                "text": "Independent follow-up inspection: Exit E-07 on the second floor was clear. Exit E-02 and FI-16 were not inspected."
            }
        ],
    },
    {
        "id": "same_asset_without_repeat_id",
        "expected": "entails",
        "hypothesis": "The obstruction finding for Exit E-02 was independently verified as corrected.",
        "premises": [
            {
                "text": "At the later independent follow-up, the inspector rechecked Building A ground-floor Exit E-02 and observed that the access aisle was clear and unobstructed."
            }
        ],
    },
    {
        "id": "future_plan_only",
        "expected": "insufficient",
        "hypothesis": "Finding FI-16 at Exit E-02 was independently verified as corrected.",
        "premises": [
            {
                "text": "Corrective plan: remove stored cartons and request an independent follow-up inspection next month."
            }
        ],
    },
]


async def evaluate(name, ai):
    rows = []
    for case in CASES:
        started = time.perf_counter()
        try:
            result, usage = await ai.structured(
                BLIND,
                {
                    "hypothesis": case["hypothesis"],
                    "premises": case["premises"],
                },
                SecondOpinion,
            )
            actual = result["relation"]
            error = None
        except InferenceFailure as exc:
            actual = None
            usage = {}
            error = str(exc)
        rows.append(
            {
                "id": case["id"],
                "expected": case["expected"],
                "actual": actual,
                "passed": actual == case["expected"],
                "seconds": round(time.perf_counter() - started, 3),
                "usage": usage,
                "error": error,
            }
        )
        print(
            f"{name:6} {case['id']:<28} expected={case['expected']:<12} actual={actual or 'error'}",
            flush=True,
        )
    completed = [row for row in rows if not row["error"]]
    return {
        "provider": name,
        "model": next(
            iter(completed[0]["usage"].get("model_versions", {})), "unknown"
        )
        if completed
        else "unknown",
        "correct": sum(row["passed"] for row in rows),
        "total": len(rows),
        "errors": sum(bool(row["error"]) for row in rows),
        "mean_seconds": round(
            statistics.mean(row["seconds"] for row in rows), 3
        ),
        "rows": rows,
    }


def recommendation(results):
    ranked = sorted(
        results,
        key=lambda result: (
            -result["correct"],
            result["errors"],
            result["mean_seconds"],
        ),
    )
    first, second = ranked
    if (
        first["correct"],
        first["errors"],
        first["mean_seconds"],
    ) == (
        second["correct"],
        second["errors"],
        second["mean_seconds"],
    ):
        return "tie"
    return first["provider"]


async def main():
    cli = argparse.ArgumentParser()
    cli.add_argument(
        "--provider", choices=["both", "gemini", "xai"], default="both"
    )
    args = cli.parse_args()
    cfg = settings()
    missing = []
    if args.provider in ("both", "gemini") and not cfg.gemini_keys():
        missing.append("GEMINI_API_KEY or GEMINI_API_KEYS")
    if args.provider in ("both", "xai") and not cfg.xai_api_key:
        missing.append("XAI_API_KEY")
    if missing:
        print("Missing: " + ", ".join(missing), file=sys.stderr)
        return 2

    providers = []
    if args.provider in ("both", "gemini"):
        providers.append(
            ("gemini", Gemini(cfg.model_copy(update={"llm_provider": "gemini"})))
        )
    if args.provider in ("both", "xai"):
        providers.append(
            ("xai", Gemini(cfg.model_copy(update={"llm_provider": "xai"})))
        )
    try:
        results = [await evaluate(name, provider) for name, provider in providers]
    finally:
        await asyncio.gather(*(provider.aclose() for _, provider in providers))

    report = {
        "scope": "synthetic follow-up statement relation checks",
        "cases": len(CASES),
        "results": results,
        "recommendation": recommendation(results) if len(results) == 2 else None,
    }
    output = Path("evaluation/output/provider-comparison.json")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print("\nSummary")
    for result in results:
        print(
            f"{result['provider']}: {result['correct']}/{result['total']} correct, "
            f"{result['errors']} errors, {result['mean_seconds']}s mean"
        )
    if report["recommendation"]:
        print("Recommendation: " + report["recommendation"])
    else:
        print("Recommendation: run both providers for a comparison")
    print("Report: " + str(output))
    return 0 if not any(result["errors"] for result in results) else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
