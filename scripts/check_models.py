"""Run a small synthetic smoke test against the configured Gemini project."""

import asyncio
import sys

from safetyproof.ai import BLIND, Gemini, InferenceFailure
from safetyproof.config import settings
from safetyproof.models import SecondOpinion


async def main():
    cfg = settings()
    if not cfg.gemini_api_key:
        print(
            "Set GEMINI_API_KEY in the ignored .env file to run the live check.",
            file=sys.stderr,
        )
        return 2
    ai = Gemini(cfg)
    request = {
        "hypothesis": "No workplace injuries occurred in April 2026.",
        "premises": [{"text": "১৫ এপ্রিল ২০২৬ কাটিং বিভাগে একজন শ্রমিক আহত হন।"}],
    }
    try:
        first, _ = await ai.structured(
            "Compare the hypothesis and the evidence. Return the natural-language inference relationship.",
            request,
            SecondOpinion,
        )
        second, _ = await ai.structured(BLIND, request, SecondOpinion)
        vectors, _ = await ai.embed(
            [request["premises"][0]["text"]], "RETRIEVAL_DOCUMENT"
        )
    except InferenceFailure as exc:
        print(str(exc), file=sys.stderr)
        return 1
    finally:
        await ai.client.aio.aclose()
    ok = (
        first["relation"] == second["relation"] == "contradicts"
        and len(vectors[0]) == 768
    )
    print(
        f"Structured verdict {first['relation']}; blind verdict {second['relation']}; embedding dimensions {len(vectors[0])}"
    )
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
