import asyncio
import json
import logging
import os
import sys
from contextlib import suppress
from pathlib import Path

import httpx

from .ai import InferenceFailure
from .document_metadata import extract_metadata
from .platform import PlatformError
from .verify import run_verification

log = logging.getLogger(__name__)
def check_inspection_date(pages, declared_date, submitted_date=None):
    metadata = extract_metadata(pages, "inspection-report.pdf")
    actual = metadata["inspection_date"]
    if not actual:
        if submitted_date == declared_date:
            return
        raise ValueError("Enter the scheduled inspection date when OCR cannot read it.")
    if actual != declared_date:
        raise ValueError(
            f"The PDF inspection date ({actual}) does not match the date scheduled by the admin ({declared_date})."
        )


async def isolated_pdf(data, vid, tessdata, offset, batch_size):
    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "safetyproof.pdf",
        vid,
        tessdata,
        str(offset),
        str(batch_size),
        env={
            **os.environ,
            "OMP_THREAD_LIMIT": "1",
            "PYTHONPATH": os.pathsep.join(
                dict.fromkeys([str(Path(__file__).resolve().parents[1]), *sys.path])
            ),
        },
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(data), timeout=160)
    finally:
        if proc.returncode is None:
            proc.kill()
            await proc.wait()
    if proc.returncode:
        log.warning(
            "PDF parser exited %s: %s",
            proc.returncode,
            err.decode(errors="replace")[-1000:],
        )
        msg = (
            err.decode(errors="replace")[-250:]
            if proc.returncode == 2
            else "PDF exceeds the parser resource budget."
        )
        raise ValueError(msg)
    return json.loads(out)


async def process(db, ai, cfg, job):
    async def step(op, payload):
        return await db.rpc(
            "step", jid=job["id"], ticket=job["lease"], op=op, payload=payload
        )

    async def renew():
        while True:
            await asyncio.sleep(40)
            await step("progress", {})

    heartbeat = asyncio.create_task(renew())
    try:
        if job["kind"] == "ingest":
            v = await db.one("document_versions", job["version_id"])
            await step("progress", {"stage": "Reading PDF and checking scan quality"})
            data = await db.download(v["object_key"])
            offset = job["completed"]
            scheduled_inspection_date = None
            if offset == 0:
                doc = await db.one("documents", v["document_id"], fields="role")
                if doc["role"] == "inspection":
                    case = await db.one("cases", job["case_id"], fields="inspection_on")
                    scheduled_inspection_date = case["inspection_on"]
            while True:
                parsed = await isolated_pdf(
                    data, v["id"], cfg.tessdata_prefix, offset, 8
                )
                if scheduled_inspection_date and offset == 0:
                    check_inspection_date(
                        parsed["pages"],
                        scheduled_inspection_date,
                        v.get("issued_on"),
                    )
                await db.rpc(
                    "ingest_batch", jid=job["id"], ticket=job["lease"], batch=parsed
                )
                offset += len(parsed["pages"])
                if offset == parsed["total_pages"]:
                    break
        else:
            run = await db.one("verification_runs", job["run_id"])
            if run["config"] != cfg.provenance():
                raise InferenceFailure(
                    "Analysis settings changed. Start a new run to use this configuration.",
                    pause=True,
                )
            await run_verification(db, ai, job, run, step)
    except (
        InferenceFailure,
        ValueError,
        PlatformError,
        httpx.RequestError,
        TimeoutError,
    ) as exc:
        transient = (
            isinstance(exc, (InferenceFailure, httpx.RequestError, TimeoutError))
            or isinstance(exc, PlatformError)
            and exc.status >= 500
        )
        retry = transient and job["attempts"] < 3
        state = (
            "paused"
            if getattr(exc, "pause", False)
            else "queued"
            if retry
            else "failed"
        )
        msg = (
            str(exc)
            if isinstance(exc, (ValueError, PlatformError, InferenceFailure))
            else "A processing service timed out. Retry the job."
        )
        await step(
            "error",
            {
                "state": state,
                "message": msg[:350],
                "delay": max(2 ** job["attempts"], getattr(exc, "delay", 0)),
            },
        )
    except Exception as exc:
        log.error(
            "Unexpected processing error %s in job %s", type(exc).__name__, job["id"]
        )
        await step(
            "error",
            {
                "state": "failed",
                "message": "Processing failed unexpectedly. Inspect the service log and retry.",
            },
        )
    finally:
        heartbeat.cancel()
        with suppress(asyncio.CancelledError, PlatformError):
            await heartbeat


async def loop(db, ai, cfg, wake):
    while True:
        wake.clear()
        try:
            job = await db.rpc("claim")
            if job:
                await process(db, ai, cfg, job)
                continue
        except (PlatformError, httpx.RequestError) as exc:
            log.warning("Worker connection unavailable (%s)", type(exc).__name__)
        with suppress(TimeoutError):
            await asyncio.wait_for(wake.wait(), timeout=3)
