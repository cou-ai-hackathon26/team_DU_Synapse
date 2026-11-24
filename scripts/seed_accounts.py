"""Provision the configured admin and optionally seed three pending demo reviewers."""

import argparse
import asyncio

import httpx
from safetyproof.accounts import check_password, provision, replace_assignments
from safetyproof.config import settings
from safetyproof.platform import Platform

DEMO_REVIEWERS = (
    (
        "Nafisa Rahman",
        "nafisa.reviewer@safetyproof.test",
        "Independent Auditor",
        ("Shaluk Threadworks Ltd.", "Meghdubi Knitcraft Ltd."),
    ),
    (
        "Tanvir Hossain",
        "tanvir.reviewer@safetyproof.test",
        "Compliance Officer",
        ("Doyel Loomwear Ltd.", "Titas Needleworks Ltd.", "Bunon Creek Apparels Ltd."),
    ),
    (
        "Samira Choudhury",
        "samira.reviewer@safetyproof.test",
        "Buyer Sustainability Team",
        (
            "Karnaphuli Stitchworks Ltd.",
            "Rupsha Weavecraft Ltd.",
            "Kadam Cottonworks Ltd.",
        ),
    ),
)


async def seed_demo_reviewers(db):
    factories = {f["name"]: f["id"] for f in await db.rows("factories")}
    for name, email, role_type, names in DEMO_REVIEWERS:
        if await db.rows(
            "account_profiles", fields="id", filters={"email": "eq." + email}
        ):
            continue
        uid = await provision(
            db,
            email,
            {
                "full_name": name,
                "role": "reviewer",
                "status": "pending",
                "role_type": role_type,
            },
        )
        await replace_assignments(db, uid, [factories[n] for n in names])


async def seed(demo_reviewers):
    cfg = settings()
    if not cfg.admin_email or not cfg.admin_password:
        raise SystemExit("Set ADMIN_EMAIL and ADMIN_PASSWORD before running the seed.")
    check_password(cfg.admin_password)
    async with httpx.AsyncClient(timeout=30) as client:
        db = Platform(cfg, client)
        email = cfg.admin_email.strip().lower()
        existing = await db.rows(
            "account_profiles", fields="role,status", filters={"email": "eq." + email}
        )
        if existing:
            if existing[0] != {"role": "admin", "status": "active"}:
                raise SystemExit(
                    "The configured email already belongs to a different account. Choose a new admin email."
                )
        else:
            await provision(
                db,
                email,
                {
                    "full_name": "SafetyProof Administrator",
                    "role": "admin",
                    "status": "active",
                },
                cfg.admin_password,
            )
        if demo_reviewers:
            await seed_demo_reviewers(db)
        print("Account seed complete.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--demo-reviewers", action="store_true")
    asyncio.run(seed(parser.parse_args().demo_reviewers))
