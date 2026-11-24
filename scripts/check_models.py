"""Smoke-test the configured structured provider and Gemini embeddings."""

import asyncio
import sys

from safetyproof.ai import BLIND, Gemini, InferenceFailure
from safetyproof.config import settings
from safetyproof.models import SecondOpinion


async def main():
    cfg = settings()
    if not cfg.gemini_keys():
        print(
            "Set GEMINI_API_KEY or GEMINI_API_KEYS for retrieval embeddings.",
            file=sys.stderr,
        )
        return 2
    if cfg.llm_provider == "xai" and not cfg.xai_api_key:
        print("Set XAI_API_KEY for xAI structured inference.", file=sys.stderr)
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
        await ai.aclose()
    ok = (
        first["relation"] == second["relation"] == "contradicts"
        and len(vectors[0]) == 768
    )
    print(
        f"{cfg.llm_provider} structured verdict {first['relation']}; blind verdict {second['relation']}; embedding dimensions {len(vectors[0])}"
    )
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
