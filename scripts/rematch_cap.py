"""Recompute deterministic CAP links for one case without repeating AI inference.

PYTHONPATH=backend .venv/bin/python scripts/rematch_cap.py --case-id UUID --apply
Use --metadata to recover explicit adjacent status/deadline lines as well.
Verification results, action IDs and reviewer events remain unchanged.
The original analyses are backed up locally before any updates.
"""

import argparse
import asyncio
import json
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID

import httpx
from safetyproof.cap import (
    MATCHING_VERSION,
    METADATA_VERSION,
    complete_action_metadata,
    suggest_links,
)
from safetyproof.config import ROOT, settings
from safetyproof.platform import Platform


async def rematch(case_id, apply, metadata=False):
    async with httpx.AsyncClient(timeout=35) as client:
        db = Platform(settings(), client)
        await db.one("cases", case_id)
        runs = await db.rows(
            "verification_runs",
            fields="id,cap_analysis,manifest",
            filters={
                "case_id": "eq." + str(case_id),
                "status": "in.(complete,partial)",
            },
        )
        results = await db.rows(
            "results",
            fields="id,run_id,claim",
            filters={"case_id": "eq." + str(case_id)},
        )
        chunks, pages = {}, {}
        if metadata:
            cap_ids = {
                doc["id"]
                for run in runs
                for doc in run["manifest"]
                if doc["role"] == "cap"
            }
            if cap_ids:
                filters = {
                    "case_id": "eq." + str(case_id),
                    "version_id": "in.(" + ",".join(cap_ids) + ")",
                }
                raw_chunks, raw_pages = await asyncio.gather(
                    db.rows("chunks", filters=filters),
                    db.rows("pages", filters=filters),
                )
                chunks = {chunk["id"]: chunk for chunk in raw_chunks}
                pages = {page["id"]: page for page in raw_pages}
        updates = []
        for run in runs:
            old = run["cap_analysis"]
            if old is None:
                continue
            targets = {
                row["id"]: row["claim"] for row in results if row["run_id"] == run["id"]
            }
            versions = {doc["id"]: doc for doc in run["manifest"]}
            actions = (
                [
                    complete_action_metadata(action, chunks, pages, versions)
                    for action in old["actions"]
                ]
                if metadata
                else old["actions"]
            )
            suggestions = suggest_links(targets, actions)
            if (
                old.get("matching_version") == MATCHING_VERSION
                and old["suggestions"] == suggestions
                and old["actions"] == actions
                and (not metadata or old.get("metadata_version") == METADATA_VERSION)
            ):
                continue
            updated = {
                **old,
                "actions": actions,
                "suggestions": suggestions,
                "matching_version": MATCHING_VERSION,
                "matching_updated_at": datetime.now(UTC).isoformat(),
            }
            if metadata:
                updated["metadata_version"] = METADATA_VERSION
            updates.append((run, updated))
            print(
                f"{run['id']}: {len(old['suggestions'])} -> {len(suggestions)} suggested links"
            )
        if not apply or not updates:
            print(
                f"{len(updates)} runs {'would be updated' if not apply else 'need updates'}."
            )
            return
        folder = ROOT / ".local" / "cap-rematch"
        folder.mkdir(parents=True, exist_ok=True, mode=0o700)
        backup = (
            folder / f"{case_id}-{datetime.now(UTC).strftime('%Y%m%dT%H%M%S%fZ')}.json"
        )
        backup.write_text(json.dumps([run for run, _ in updates], indent=2) + "\n")
        backup.chmod(0o600)
        for run, updated in updates:
            await db.call(
                "PATCH",
                "/rest/v1/verification_runs",
                admin=True,
                params={"id": "eq." + run["id"], "status": "in.(complete,partial)"},
                data={"cap_analysis": updated},
            )
        print(f"Updated {len(updates)} runs. Original analyses: {backup}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case-id", type=UUID, required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--metadata", action="store_true")
    args = parser.parse_args()
    asyncio.run(rematch(args.case_id, args.apply, args.metadata))
