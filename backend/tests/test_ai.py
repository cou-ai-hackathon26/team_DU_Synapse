import json

import httpx
import pytest

from safetyproof.ai import Gemini
from safetyproof.config import Settings
from safetyproof.models import SecondOpinion


@pytest.mark.asyncio
async def test_xai_structured_response_uses_strict_schema_and_private_storage():
    captured = {}

    async def respond(request):
        captured.update(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "model": "grok-4.7",
                "output": [
                    {"type": "reasoning", "encrypted_content": "opaque"},
                    {
                        "type": "message",
                        "content": [
                            {
                                "type": "output_text",
                                "text": '{"relation":"entails"}',
                            }
                        ],
                    },
                ],
                "usage": {"input_tokens": 12, "output_tokens": 3},
            },
        )

    cfg = Settings(
        _env_file=None,
        llm_provider="xai",
        xai_api_key="test-xai-key",
        xai_model="grok-4.7",
        xai_reasoning_effort="low",
    )
    ai = Gemini(cfg)
    await ai.xai_client.aclose()
    ai.xai_client = httpx.AsyncClient(
        base_url="https://api.x.ai/v1", transport=httpx.MockTransport(respond)
    )
    try:
        result, usage = await ai.structured(
            "Compare the statement.",
            {"hypothesis": "closed", "premises": [{"text": "verified"}]},
            SecondOpinion,
        )
    finally:
        await ai.aclose()

    assert result == {"relation": "entails"}
    assert usage["input_tokens"] == 12
    assert captured["store"] is False
    assert captured["reasoning"] == {"effort": "low"}
    assert captured["text"]["format"]["type"] == "json_schema"
    assert captured["text"]["format"]["strict"] is True


def test_xai_readiness_still_requires_embedding_key():
    missing_embedding = Settings(
        _env_file=None, llm_provider="xai", xai_api_key="test-xai-key"
    )
    ready = missing_embedding.model_copy(update={"gemini_api_key": "embedding-key"})

    assert missing_embedding.ai_ready() is False
    assert ready.ai_ready() is True
    assert ready.provenance()["llm"] == "grok-4.7"
    assert ready.provenance()["llm_provider"] == "xai"
