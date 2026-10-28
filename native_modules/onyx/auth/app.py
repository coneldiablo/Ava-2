"""Private, signed peer API for AVA-to-Onyx native sessions (port 4011)."""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import hmac
import json
import os
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .core import Config, Denied, Service, Store, Unavailable, identifier, integer, read_secret
from .native import CommunityOnyx


MAX_BODY = 16 * 1024
BODY_TIMEOUT_SECONDS = 3


class PeerVerifier:
    def __init__(self, gateway_key_file: str, worker_key_file: str) -> None:
        self.key_files = {"gateway": gateway_key_file, "worker": worker_key_file}

    def verify(self, request: Request, peer: str) -> None:
        # This is a machine peer protocol, not browser authentication.
        if any(request.headers.get(name) for name in ("origin", "cookie", "sec-fetch-site")):
            raise Denied()
        authorization = request.headers.get("authorization")
        if not authorization or not authorization.startswith("Bearer "):
            raise Denied()
        # Re-read on every request so an atomic secret-file rotation takes
        # effect without accepting a second stale key or restarting the app.
        expected = read_secret(self.key_files[peer])
        try:
            supplied = authorization[7:].encode("ascii", "strict")
        except UnicodeEncodeError:
            raise Denied() from None
        if not hmac.compare_digest(supplied, expected):
            raise Denied()


async def bounded_body(request: Request) -> bytes:
    async def consume() -> bytes:
        parts, size = [], 0
        async for part in request.stream():
            size += len(part)
            if size > MAX_BODY:
                raise Denied()
            parts.append(part)
        return b"".join(parts)
    try:
        return await asyncio.wait_for(consume(), timeout=BODY_TIMEOUT_SECONDS)
    except (TimeoutError, asyncio.TimeoutError):
        raise Denied() from None


def build_app() -> FastAPI:
    business_id = integer(int(os.environ["AVA_BUSINESS_ID"]))
    deployment_id = identifier(os.environ["AVA_DEPLOYMENT_ID"])
    namespace = os.environ["AVA_DEPLOYMENT_NAMESPACE"]
    encryption_key = read_secret(os.environ["AVA_AUTH_ENCRYPTION_KEY_FILE"], key=True)
    store = Store(Path(os.environ["AVA_AUTH_STATE_FILE"]), Config(business_id, deployment_id, namespace, encryption_key))
    service = Service(store, CommunityOnyx())
    verifier = PeerVerifier(os.environ["AVA_AUTH_GATEWAY_KEY_FILE"], os.environ["AVA_AUTH_WORKER_KEY_FILE"])

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        await service.recover()
        try:
            yield
        finally:
            store.close()

    app = FastAPI(openapi_url=None, docs_url=None, redoc_url=None, lifespan=lifespan)

    @app.middleware("http")
    async def safe_private_boundary(request: Request, call_next):
        """Contain unexpected dependency errors before Uvicorn can render them.

        This private peer does not log exception text: Redis/SQL driver errors
        may embed connection strings, statements, or credentials. Known
        protocol errors retain their distinct safe status and code.
        """
        try:
            return await call_next(request)
        except Denied:
            return JSONResponse({"detail": "denied", "code": Denied.code}, status_code=403)
        except Unavailable:
            return JSONResponse({"detail": "unavailable", "code": Unavailable.code}, status_code=503)
        except Exception:
            return JSONResponse({"detail": "unavailable", "code": "AVA_NATIVE_INTERNAL"}, status_code=503)

    @app.exception_handler(Denied)
    async def denied(_request: Request, _exc: Denied):
        return JSONResponse({"detail": "denied", "code": Denied.code}, status_code=403)

    @app.exception_handler(Unavailable)
    async def unavailable(_request: Request, _exc: Unavailable):
        return JSONResponse({"detail": "unavailable", "code": Unavailable.code}, status_code=503)

    async def payload(request: Request, peer: str) -> dict:
        verifier.verify(request, peer)
        raw = await bounded_body(request)
        try:
            value = json.loads(raw)
        except Exception:
            raise Denied() from None
        if not isinstance(value, dict):
            raise Denied()
        return value

    @app.post("/v1/sessions/create")
    async def create(request: Request):
        return await service.create_session(await payload(request, "gateway"))

    @app.post("/v1/sessions/revoke")
    async def revoke(request: Request):
        return await service.revoke(await payload(request, "gateway"))

    @app.post("/v1/provision")
    async def provision(request: Request):
        return await service.provision(await payload(request, "worker"))

    @app.post("/v1/reconcile")
    async def reconcile(request: Request):
        return await service.reconcile(await payload(request, "worker"))

    @app.post("/v1/verify")
    async def verify(request: Request):
        return await service.verify(await payload(request, "worker"))

    @app.post("/v1/disable")
    async def disable(request: Request):
        return await service.disable(await payload(request, "worker"))

    @app.post("/v1/users/disable")
    async def disable_user(request: Request):
        return await service.disable_user(await payload(request, "worker"))

    return app


app = build_app()
