"""Separate worker-only HTTP surface for Community knowledge bootstrap/indexing."""
from __future__ import annotations

import asyncio
import hmac
import json
import os
from pathlib import Path
import sqlite3
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .core import Denied, Unavailable, identifier, integer, read_secret
from .knowledge_api import KnowledgeAPI

MAX_BODY = 768 * 1024


class WorkerConfig:
    def __init__(self, business_id: int, deployment_id: str, namespace: str) -> None:
        self.business_id, self.deployment_id = integer(business_id), identifier(deployment_id)
        if not isinstance(namespace, str) or namespace != "ava_" + deployment_id.replace("-", ""):
            raise Denied()
        self.namespace = namespace

    def native_id(self, ava_user_id: str) -> str:
        return str(uuid.uuid5(uuid.UUID(self.deployment_id), "ava-user:" + identifier(ava_user_id)))


class ReadonlyState:
    """Read exactly the auth-sidecar's durable fence; never take its writer lock."""
    def __init__(self, path: Path) -> None:
        if path.is_symlink():
            raise Denied()
        self.db = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=3)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA query_only=ON")

    def contour(self) -> dict:
        row = self.db.execute("SELECT * FROM ava_native_contour WHERE singleton=1").fetchone()
        if row is None:
            raise Denied()
        return dict(row)

    def user(self, user_id: str) -> dict | None:
        row = self.db.execute("SELECT * FROM ava_native_users WHERE user_id=?", (user_id,)).fetchone()
        return dict(row) if row else None

    def close(self) -> None:
        self.db.close()


async def _payload(request: Request, worker_key_file: str) -> dict:
    if any(request.headers.get(name) for name in ("origin", "cookie", "sec-fetch-site")):
        raise Denied()
    auth = request.headers.get("authorization")
    if not auth or not auth.startswith("Bearer "):
        raise Denied()
    try:
        supplied = auth[7:].encode("ascii", "strict")
    except UnicodeEncodeError:
        raise Denied() from None
    if not hmac.compare_digest(supplied, read_secret(worker_key_file)):
        raise Denied()
    async def consume() -> bytes:
        chunks, size = [], 0
        async for chunk in request.stream():
            size += len(chunk)
            if size > MAX_BODY:
                raise Denied()
            chunks.append(chunk)
        return b"".join(chunks)
    try:
        raw = await asyncio.wait_for(consume(), timeout=3)
        value = json.loads(raw)
    except (TimeoutError, asyncio.TimeoutError, ValueError, UnicodeDecodeError):
        raise Denied() from None
    if not isinstance(value, dict):
        raise Denied()
    return value


def build_knowledge_app() -> FastAPI:
    config = WorkerConfig(int(os.environ["AVA_BUSINESS_ID"]), os.environ["AVA_DEPLOYMENT_ID"], os.environ["AVA_DEPLOYMENT_NAMESPACE"])
    state = ReadonlyState(Path(os.environ["AVA_AUTH_STATE_FILE"]))
    worker_key_file = os.environ["AVA_AUTH_WORKER_KEY_FILE"]
    api = KnowledgeAPI(config, state, state_factory=lambda: ReadonlyState(Path(os.environ["AVA_AUTH_STATE_FILE"])))

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        try:
            from onyx.db.engine.sql_engine import SqlEngine
            SqlEngine.init_engine(pool_size=2, max_overflow=0)
            SqlEngine.get_engine()
        except ImportError:
            state.close()
            raise Unavailable() from None
        try:
            yield
        finally:
            state.close()
            try:
                SqlEngine.reset_engine()
            except Exception:
                pass

    app = FastAPI(openapi_url=None, docs_url=None, redoc_url=None, lifespan=lifespan)

    @app.middleware("http")
    async def boundary(request: Request, call_next):
        try:
            return await call_next(request)
        except Denied:
            return JSONResponse({"detail": "denied", "code": Denied.code}, status_code=403)
        except Unavailable:
            return JSONResponse({"detail": "unavailable", "code": Unavailable.code}, status_code=503)
        except Exception:
            return JSONResponse({"detail": "unavailable", "code": "AVA_NATIVE_INTERNAL"}, status_code=503)

    @app.post("/v1/knowledge/bootstrap")
    async def bootstrap(request: Request):
        return await api.bootstrap_knowledge(await _payload(request, worker_key_file))

    @app.post("/v1/knowledge/upsert")
    async def upsert(request: Request):
        return await api.upsert_knowledge(await _payload(request, worker_key_file))

    @app.post("/v1/knowledge/delete")
    async def delete(request: Request):
        return await api.delete_knowledge(await _payload(request, worker_key_file))

    return app


app = build_knowledge_app()
