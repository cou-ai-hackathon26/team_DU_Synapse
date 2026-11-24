"""Read endpoint scope checks with test-only records; no network or database writes."""

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from safetyproof import main
from safetyproof.accounts import account_router


def endpoint(path):
    return next(route.endpoint for route in account_router(main.user, main.db).routes if getattr(route, "path", None) == path)


class ReadDB:
    def __init__(self):
        self.reads = []

    async def one(self, table, ident, **kwargs):
        self.reads.append((table, ident, kwargs))
        return {"id": ident, "name": "Assigned factory"}

    async def rows(self, table, **kwargs):
        self.reads.append((table, kwargs))
        if table == "reviewer_factories":
            return [{"factories": {"id": "assigned", "name": "Assigned factory"}}]
        return []


@pytest.mark.asyncio
async def test_reviewer_assignments_filter_current_identity_and_reject_manager():
    handler = endpoint("/v1/reviewer/factories")
    db = ReadDB()
    rows = await handler(u=SimpleNamespace(role="reviewer", id="self"), db=db)
    assert rows[0]["factories"]["id"] == "assigned"
    assert db.reads[0][1]["filters"] == {"reviewer_id": "eq.self"}
    db.reads.clear()
    with pytest.raises(HTTPException) as caught:
        await handler(u=SimpleNamespace(role="factory_manager", id="self"), db=db)
    assert caught.value.status_code == 403
    assert db.reads == []


@pytest.mark.asyncio
async def test_manager_scope_uses_bound_factory_and_user_token_for_records():
    handler = endpoint("/v1/manager/work")
    db = ReadDB()
    result = await handler(u=SimpleNamespace(role="factory_manager", factory_id="bound", token="test-only"), db=db)
    assert result["factory"]["id"] == "bound"
    assert db.reads[0][:2] == ("factories", "bound")
    for table, kwargs in db.reads[1:]:
        assert table in {"corrective_tasks", "cases"}
        assert kwargs["token"] == "test-only"


@pytest.mark.asyncio
async def test_corrective_data_requires_current_case_membership():
    class Membership:
        async def rows(self, table, **kwargs):
            assert table == "case_members"
            assert kwargs["token"] == "test-only"
            assert kwargs["filters"] == {"case_id": "eq.selected-case"}
            return []

    with pytest.raises(HTTPException) as caught:
        await main.corrective_role(Membership(), SimpleNamespace(token="test-only"), "selected-case")
    assert caught.value.status_code == 404
