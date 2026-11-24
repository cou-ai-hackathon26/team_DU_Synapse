"""Push deliveries run a bounded job slice. Postgres retains checkpoints and leases."""

import asyncio
from datetime import UTC, datetime

import httpx
from pydantic import BaseModel
from vercel.queue import RetryAfter, Topic, send, subscribe

from .ai import Gemini
from .config import settings
from .platform import Platform, PlatformError
from .worker import process


class Work(BaseModel):
    job_id: str


jobs = Topic[Work]("safetyproof-jobs")


async def publish(job_id: str, available_at: str):
    # Repeated sends are safe because claiming and publishing results are transactional.
    await send(jobs, Work(job_id=job_id), idempotency_key=f"{job_id}:{available_at}")


@subscribe(
    topic=jobs,
    consumer_group="evidence-processing",
    max_concurrency=1,
    max_attempts=100,
)
async def consume(work: Work):
    cfg = settings()
    async with httpx.AsyncClient(timeout=35) as http:
        db = Platform(cfg, http)
        try:
            record = await db.one("jobs", work.job_id)
        except PlatformError as exc:
            if exc.status == 404:
                return  # A case deleted while its notification was in flight.
            raise
        if record["state"] in ("done", "failed", "paused"):
            return
        job = await db.rpc("claim_job", jid=work.job_id)
        if not job:
            raise RetryAfter(15)
        ai = Gemini(cfg)
        try:
            async with asyncio.timeout(230):
                await process(db, ai, cfg, job)
        except TimeoutError:
            await db.rpc("yield_job", jid=job["id"], ticket=job["lease"])
            raise RetryAfter(2)
        finally:
            await ai.aclose()
        current = await db.one("jobs", work.job_id)
        if current["state"] in ("queued", "running"):
            available = datetime.fromisoformat(current["available_at"])
            delay = max(2, int((available - datetime.now(UTC)).total_seconds()))
            raise RetryAfter(delay)
