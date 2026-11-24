"""CAP reservations are per inspection, using fixture data only."""

from uuid import uuid4

import pytest
from fastapi import HTTPException

from safetyproof.main import User, reserve_upload
from safetyproof.models import UploadInput


@pytest.mark.asyncio
async def test_manager_can_submit_separate_second_and_third_caps_but_not_duplicate_one_case():
    first, second, third = uuid4(), uuid4(), uuid4()
    caps = {str(first): [{"id": str(uuid4())}]}
    actor = User(id=str(uuid4()), token="test-only", role="factory_manager")

    class DB:
        async def one(self, table, cid, *, token):
            assert table == "cases" and token == actor.token
            return {"inspection_on": "2026-09-01" if cid == second else "2026-10-01"}

        async def rows(self, table, *, token, fields, filters):
            assert table == "documents" and token == actor.token
            assert filters["role"] == "eq.cap" and filters["deleted_at"] == "is.null"
            return caps.get(filters["case_id"].removeprefix("eq."), [])

        async def rpc(self, name, **kwargs):
            assert name == "reserve" and kwargs["actor_id"] == actor.id
            caps[kwargs["cid"]] = [{"id": str(uuid4())}]
            return {"id": str(uuid4()), "status": "awaiting_upload", "object_key": "fixture-only"}

        async def signed(self, key, *, upload):
            assert upload and key == "fixture-only"
            return "fixture-only-upload-url"

    for cid, issued in [(second, "2026-09-09"), (third, "2026-10-07")]:
        body = UploadInput(request_key=uuid4(), filename="cap.pdf", title="Inspection CAP", role="cap",
                           issued_on=issued, issuer="factory", confirmed_factory="Test factory")
        ticket = await reserve_upload(cid, body, u=actor, d=DB())
        assert ticket["status"] == "awaiting_upload"
        with pytest.raises(HTTPException) as duplicate:
            await reserve_upload(cid, body, u=actor, d=DB())
        assert duplicate.value.status_code == 409
