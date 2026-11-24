"""Small client for Supabase Auth, PostgREST and Storage. Browser reads keep their JWT."""

from urllib.parse import quote
import httpx
from .config import BUCKET, Settings


class PlatformError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


class Platform:
    def __init__(self, settings: Settings, client: httpx.AsyncClient):
        self.settings, self.http = settings, client
        self.base = settings.supabase_url.rstrip("/")

    async def call(
        self,
        method,
        path,
        *,
        token=None,
        admin=False,
        params=None,
        data=None,
        body=None,
        headers=None,
        raw=False,
    ):
        key = (
            self.settings.supabase_service_role_key
            if admin
            else self.settings.supabase_anon_key
        )
        if not key:
            raise PlatformError(503, "Supabase connection is not configured.")
        auth = {"apikey": key}
        if token:
            auth["Authorization"] = "Bearer " + token
        elif not key.startswith(("sb_secret_", "sb_publishable_")):
            auth["Authorization"] = "Bearer " + key
        try:
            r = await self.http.request(
                method,
                self.base + path,
                headers={**auth, **(headers or {})},
                params=params,
                json=data,
                content=body,
            )
        except httpx.RequestError as exc:
            raise PlatformError(503, "Supabase could not be reached.") from exc
        if not r.is_success:
            try:
                detail = r.json()
                message = str(
                    detail.get("message")
                    or detail.get("error_description")
                    or detail.get("error")
                    or "Request failed"
                )
            except ValueError:
                message = "Supabase rejected the request"
            raise PlatformError(r.status_code, message[:400])
        if raw:
            return r.content
        return r.json() if r.content else None

    async def rows(self, table, *, token=None, fields="*", filters=None, order=None):
        params = {"select": fields, **(filters or {})}
        if order:
            params["order"] = order
        rows = []
        while True:
            batch = await self.call(
                "GET",
                "/rest/v1/" + table,
                token=token,
                admin=token is None,
                params={**params, "limit": "500", "offset": str(len(rows))},
            )
            rows.extend(batch)
            if len(batch) < 500:
                return rows

    async def one(self, table, ident, *, token=None, fields="*"):
        rows = await self.rows(
            table, token=token, fields=fields, filters={"id": "eq." + str(ident)}
        )
        if not rows:
            raise PlatformError(404, "This record is unavailable.")
        return rows[0]

    async def rpc(self, name, **arguments):
        return await self.call(
            "POST", "/rest/v1/rpc/sp_" + name, admin=True, data=arguments
        )

    async def signed(self, path, *, upload=False):
        suffix = (
            ("/upload/sign/" if upload else "/sign/")
            + BUCKET
            + "/"
            + quote(path, safe="/")
        )
        result = await self.call(
            "POST",
            "/storage/v1/object" + suffix,
            admin=True,
            data={} if upload else {"expiresIn": 300},
        )
        link = result.get("url") or result.get("signedURL")
        if not link or not link.startswith("/object/"):
            raise PlatformError(502, "Storage returned an invalid source link.")
        return self.base + "/storage/v1" + link

    async def download(self, path):
        return await self.call(
            "GET",
            "/storage/v1/object/" + BUCKET + "/" + quote(path, safe="/"),
            admin=True,
            raw=True,
        )

    async def put(self, path, content):
        return await self.call(
            "POST",
            "/storage/v1/object/" + BUCKET + "/" + path,
            admin=True,
            body=content,
            headers={"Content-Type": "application/pdf", "x-upsert": "false"},
        )

    async def remove(self, paths):
        if paths:
            await self.call(
                "DELETE",
                "/storage/v1/object/" + BUCKET,
                admin=True,
                data={"prefixes": paths},
            )
