from fastapi import FastAPI, HTTPException, Depends, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
import settings
from dotenv import load_dotenv
import os
import sys
import logging
import secrets
from pathlib import Path
import shutil
import httpx

# The container keeps the Admin backend in /app and mounts the full AVA source
# at PROJECT_ROOT=/app/project. Add that mounted source before importing shared
# runtime modules such as the tenant-scoped Onyx worker.
_project_root = (os.getenv("PROJECT_ROOT") or settings.PROJECT_ROOT or "").strip()
if _project_root and Path(_project_root).exists() and _project_root not in sys.path:
    sys.path.insert(0, _project_root)

# A reviewed immutable image may supply shared runtime code separately from
# the mutable deployment/configuration mount. Reject arbitrary import roots.
_shared_source_root = os.getenv("AVA_SHARED_SOURCE_ROOT", "")
if _shared_source_root:
    if _shared_source_root != "/opt/ava-runtime-source" or not Path(_shared_source_root, "src").is_dir():
        raise RuntimeError("Invalid AVA shared runtime image")
    sys.path.insert(0, _shared_source_root)

from src.core.onyx_worker_runtime import OnyxWorkerRuntime


def _ensure_outbound_prompt_assets() -> None:
    """
    Install shipped outbound prompt assets into the runtime media directory.

    This keeps "out of the box" campaigns functional without requiring the user to upload
    consent/voicemail recordings before first use.
    """
    try:
        project_root = (os.getenv("PROJECT_ROOT") or "/app/project").strip() or "/app/project"
        src_dir = Path(project_root) / "assets" / "outbound_prompts" / "en-US"
        if not src_dir.exists():
            return

        media_dir = Path(os.getenv("AAVA_MEDIA_DIR") or "/mnt/asterisk_media/ai-generated")
        try:
            media_dir.mkdir(parents=True, exist_ok=True)
        except Exception:
            pass

        mapping = {
            "aava-consent-default.ulaw": "aava-consent-default.ulaw",
            "aava-voicemail-default.ulaw": "aava-voicemail-default.ulaw",
        }
        for src_name, dst_name in mapping.items():
            src = src_dir / src_name
            dst = media_dir / dst_name
            if not src.exists():
                continue
            if dst.exists() and dst.stat().st_size == src.stat().st_size:
                continue
            try:
                data = src.read_bytes()
                dst.write_bytes(data)
            except Exception:
                continue
    except Exception:
        # Never block Admin UI startup for this.
        pass

# Load environment variables (wizard will create .env from .env.example on first Next click)
load_dotenv(settings.ENV_PATH)

# NOTE: DB permission alignment is handled by install/preflight steps (host-side),
# keeping runtime code minimal and CI security scanners happy.
_ensure_outbound_prompt_assets()

def _cleanup_orphaned_model_downloads() -> None:
    """
    Clean up orphaned .part files and .extract_* directories in the local AI models directory
    that may have been left behind by interrupted downloads/extractions.
    """
    try:
        models_dir = Path(os.getenv("AAVA_MODELS_DIR") or "/mnt/asterisk_models")
        if not models_dir.exists():
            return
        
        cleaned_up = 0
        
        # Clean up files matching *.part
        for part_file in models_dir.rglob("*.part"):
            try:
                if part_file.is_file():
                    part_file.unlink()
                    cleaned_up += 1
            except Exception:
                pass
                
        # Clean up directories matching .extract_*
        for root, dirs, files in os.walk(models_dir):
            for d in list(dirs):  # Use list to safely modify while iterating
                if d.startswith(".extract_"):
                    extract_path = Path(root) / d
                    try:
                        shutil.rmtree(extract_path)
                        cleaned_up += 1
                        dirs.remove(d) # Remove to prevent os.walk from entering it
                    except Exception:
                        pass
        
        if cleaned_up > 0:
            logging.getLogger(__name__).info("Cleaned up %d orphaned model download temp file(s)/dir(s).", cleaned_up)
            
    except Exception as e:
        logging.getLogger(__name__).warning("Failed to clean up orphaned model downloads: %s", e)

_cleanup_orphaned_model_downloads()

# SECURITY: Admin UI binds to 0.0.0.0 by default (DX-first).
# If JWT_SECRET is missing/placeholder, generate an ephemeral secret so tokens
# aren't signed with a known insecure key. Scripts (preflight/install) should
# persist a strong JWT_SECRET into .env for stable restarts.
_uvicorn_host = os.getenv("UVICORN_HOST", "0.0.0.0")
_is_remote_bind = _uvicorn_host not in ("127.0.0.1", "localhost", "::1")
_placeholder_secrets = {"", "change-me-please", "changeme"}
_raw_jwt_secret = (os.getenv("JWT_SECRET", "") or "").strip()

if _is_remote_bind and _raw_jwt_secret in _placeholder_secrets:
    os.environ["JWT_SECRET"] = secrets.token_hex(32)
    logging.getLogger(__name__).warning(
        "JWT_SECRET is missing/placeholder while Admin UI is remote-accessible on %s. "
        "Generated an ephemeral JWT_SECRET for this process. For production, set a strong "
        "JWT_SECRET in .env and restrict port 3003 (firewall/VPN/reverse proxy).",
        _uvicorn_host,
    )

from api import config, system, wizard, logs, local_ai, ollama, mcp, calls, outbound, tools, docs, hotels, tasks, followups, pilot_analytics, onyx, onyx_mcp, onyx_runtime  # noqa: E402
import auth  # noqa: E402

# Allow disabling API docs in production for security hardening
_enable_api_docs = os.getenv("ENABLE_API_DOCS", "true").lower() in ("1", "true", "yes")

app = FastAPI(
    title="Asterisk AI Voice Agent Admin API",
    description="""
REST API for managing the Asterisk AI Voice Agent system.

## Authentication
Most endpoints require JWT authentication. Obtain a token via `POST /api/auth/login`.

## API Groups

| Group | Description |
|-------|-------------|
| **auth** | Login, password management, user info |
| **config** | YAML configuration, environment variables, provider settings |
| **system** | Container management, health checks, updates, ARI testing |
| **wizard** | Setup wizard, local AI model management |
| **local-ai** | Local AI server model switching, backends, capabilities |
| **calls** | Call history, transcripts, statistics, export |
| **outbound** | Campaign management, leads, recordings |
| **tools** | Tool catalog, HTTP tool testing, email templates |
| **logs** | Container logs and structured log events |
| **mcp** | MCP server status and testing (proxied from AI Engine) |
| **ollama** | Ollama connection testing and model listing |
| **documentation** | In-app documentation browser |

## Related Services

| Service | Endpoints |
|---------|-----------|
| **AI Engine Health Server** (port 15000) | `/health`, `/metrics`, `/live`, `/ready`, `/reload` |
""",
    version="6.2.0",
    docs_url="/docs" if _enable_api_docs else None,
    redoc_url="/redoc" if _enable_api_docs else None,
    openapi_url="/openapi.json" if _enable_api_docs else None,
    openapi_tags=[
        {"name": "auth", "description": "Authentication and user management"},
        {"name": "config", "description": "Configuration management (YAML, .env, providers)"},
        {"name": "system", "description": "System operations, containers, updates, health"},
        {"name": "wizard", "description": "Setup wizard and local AI model downloads"},
        {"name": "local-ai", "description": "Local AI server management"},
        {"name": "calls", "description": "Call history and analytics"},
        {"name": "outbound", "description": "Outbound campaigns and lead management"},
        {"name": "hotels", "description": "Hotel profile configuration"},
        {"name": "tasks", "description": "Manager handoff task queue"},
        {"name": "followups", "description": "WhatsApp follow-up approval queue"},
        {"name": "pilot-analytics", "description": "Tenant-scoped pilot metrics"},
        {"name": "tools", "description": "Tool catalog and HTTP tool testing"},
        {"name": "logs", "description": "Container logs and events"},
        {"name": "mcp", "description": "MCP server status (proxied from AI Engine)"},
        {"name": "ollama", "description": "Ollama integration testing"},
        {"name": "documentation", "description": "In-app documentation browser"},
    ],
)

_onyx_worker_runtime = OnyxWorkerRuntime(db_path=os.getenv("DB_PATH"))


@app.on_event("startup")
async def _start_onyx_worker() -> None:
    _onyx_worker_runtime.start()


@app.on_event("shutdown")
async def _stop_onyx_worker() -> None:
    await _onyx_worker_runtime.stop()

# Initialize users (create default admin if needed)
auth.load_users()

# Warn if JWT_SECRET isn't set (localhost-only is okay for dev)
if getattr(auth, "USING_PLACEHOLDER_SECRET", False):
    logging.getLogger(__name__).warning(
        "JWT_SECRET is missing/placeholder; Admin UI is using an insecure secret. "
        "Set JWT_SECRET in .env for production (recommended: openssl rand -hex 32)."
    )

# Configure CORS
def _parse_cors_origins() -> list[str]:
    raw = (settings.get_setting("ADMIN_UI_CORS_ORIGINS", "") or "").strip()
    if not raw:
        # Safe-ish local defaults.
        return ["http://localhost:3003", "http://127.0.0.1:3003"]
    if raw == "*":
        return ["*"]
    # Comma-separated list
    return [o.strip() for o in raw.split(",") if o.strip()]


cors_origins = _parse_cors_origins()
cors_allow_credentials = "*" not in cors_origins

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=cors_allow_credentials,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
# Public routes
app.include_router(auth.router, prefix="/api/auth", tags=["auth"])
app.include_router(outbound.internal_router, prefix="/api")
app.include_router(calls.internal_router, prefix="/api")

# Protected routes
app.include_router(config.router, prefix="/api/config", tags=["config"], dependencies=[Depends(auth.get_current_user)])
app.include_router(system.router, prefix="/api/system", tags=["system"], dependencies=[Depends(auth.get_current_user)])
app.include_router(wizard.router, prefix="/api/wizard", tags=["wizard"], dependencies=[Depends(auth.get_current_user)])
app.include_router(logs.router, prefix="/api/logs", tags=["logs"], dependencies=[Depends(auth.get_current_user)])
app.include_router(local_ai.router, prefix="/api/local-ai", tags=["local-ai"], dependencies=[Depends(auth.get_current_user)])
app.include_router(mcp.router, dependencies=[Depends(auth.get_current_user)])
app.include_router(ollama.router, tags=["ollama"], dependencies=[Depends(auth.get_current_user)])
app.include_router(calls.router, prefix="/api", tags=["calls"], dependencies=[Depends(auth.get_current_user)])
app.include_router(outbound.router, prefix="/api", tags=["outbound"], dependencies=[Depends(auth.get_current_user)])
app.include_router(hotels.router, prefix="/api", tags=["hotels"], dependencies=[Depends(auth.get_current_user)])
app.include_router(tasks.router, prefix="/api", tags=["tasks"], dependencies=[Depends(auth.get_current_user)])
app.include_router(followups.router, prefix="/api", tags=["followups"], dependencies=[Depends(auth.get_current_user)])
app.include_router(pilot_analytics.router, prefix="/api", tags=["pilot-analytics"], dependencies=[Depends(auth.get_current_user)])
app.include_router(tools.router, prefix="/api/tools", tags=["tools"], dependencies=[Depends(auth.get_current_user)])
app.include_router(docs.router, tags=["documentation"], dependencies=[Depends(auth.get_current_user)])
app.include_router(onyx.router, dependencies=[Depends(auth.get_current_user)])
# MCP discovery and per-execution capability auth are enforced inside this router.
# Browser JWTs and discovery-only keys cannot execute an MCP action.
app.include_router(onyx_mcp.router)
app.include_router(onyx_runtime.router)

@app.get("/health")
async def health_check():
    return {"status": "healthy"}

from fastapi import WebSocket, WebSocketDisconnect
import websockets
import asyncio
import httpx

@app.websocket("/api/sandbox-ws")
async def sandbox_websocket(websocket: WebSocket, key: str = ""):
    await websocket.accept()
    if not key:
        await websocket.close(code=4000, reason="Missing API key")
        return
        
    url = f"wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key={key}"
    try:
        async with websockets.connect(url, max_size=10_000_000) as google_ws:
            async def forward_to_google():
                try:
                    while True:
                        data = await websocket.receive()
                        if "text" in data:
                            await google_ws.send(data["text"])
                        elif "bytes" in data:
                            await google_ws.send(data["bytes"])
                except WebSocketDisconnect:
                    logging.info("[sandbox-ws] Browser disconnected — closing Google WS")
                    await google_ws.close()
                except Exception as e:
                    logging.error(f"[sandbox-ws] Error forwarding to Google: {e}")
                    try:
                        await google_ws.close()
                    except:
                        pass
                    
            async def forward_to_client():
                import websockets.exceptions as ws_exc
                try:
                    while True:
                        msg = await google_ws.recv()
                        if isinstance(msg, bytes):
                            await websocket.send_bytes(msg)
                        else:
                            await websocket.send_text(msg)
                except ws_exc.ConnectionClosedOK as e:
                    reason = e.rcvd.reason if e.rcvd and e.rcvd.reason else "Google closed connection normally"
                    logging.info(f"[sandbox-ws] Google WS closed OK (code={e.rcvd.code if e.rcvd else '?'}): {reason}")
                    try:
                        await websocket.close(code=1000, reason=reason)
                    except:
                        pass
                except ws_exc.ConnectionClosedError as e:
                    reason = e.rcvd.reason if e.rcvd and e.rcvd.reason else "Google closed connection with error"
                    code = e.rcvd.code if e.rcvd else 1011
                    logging.error(f"[sandbox-ws] Google WS closed with error (code={code}): {reason}")
                    try:
                        await websocket.close(code=1011, reason=reason)
                    except:
                        pass
                except Exception as e:
                    logging.error(f"[sandbox-ws] Error forwarding to client: {e}")
                    try:
                        await websocket.close(code=1011)
                    except:
                        pass
                        
            await asyncio.gather(forward_to_google(), forward_to_client())
            
    except Exception as e:
        logging.error(f"Sandbox proxy connection error to Google: {e}")
        try:
            await websocket.close(code=1011)
        except:
            pass

# Serve static files (Frontend)
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

# Mount static files if directory exists (production/docker)
static_dir = os.path.join(os.path.dirname(__file__), "static")
if os.path.exists(static_dir):
    static_files = StaticFiles(directory=static_dir, html=False)
    assets_dir = os.path.join(static_dir, "assets")
    if os.path.isdir(assets_dir):
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")
    index_file = os.path.join(static_dir, "index.html")
    ui_renderer_enabled = (os.getenv("UI_RENDERER_ENABLED", "") or "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    ui_renderer_port = (os.getenv("UI_RENDERER_PORT") or "3100").strip() or "3100"
    ui_renderer_url = (os.getenv("UI_RENDERER_URL") or f"http://127.0.0.1:{ui_renderer_port}").rstrip("/")
    proxy_timeout = httpx.Timeout(connect=2.0, read=20.0, write=20.0, pool=5.0)
    hop_by_hop_headers = {
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "content-length",
    }

    async def proxy_ui_request(request: Request) -> Response:
        target_url = f"{ui_renderer_url}{request.url.path}"
        if request.url.query:
            target_url = f"{target_url}?{request.url.query}"

        upstream_headers = {
            "accept": request.headers.get("accept", "*/*"),
            "accept-encoding": request.headers.get("accept-encoding", "gzip, deflate"),
            "user-agent": request.headers.get("user-agent", "admin-ui-backend"),
        }
        if request.headers.get("x-forwarded-proto"):
            upstream_headers["x-forwarded-proto"] = request.headers["x-forwarded-proto"]

        try:
            async with httpx.AsyncClient(follow_redirects=False, timeout=proxy_timeout) as client:
                upstream = await client.request(
                    request.method,
                    target_url,
                    headers=upstream_headers,
                )
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=f"UI renderer unavailable: {exc}") from exc

        response_headers = {
            key: value
            for key, value in upstream.headers.items()
            if key.lower() not in hop_by_hop_headers
        }
        if upstream.headers.get("content-type", "").startswith("text/html"):
            response_headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
            response_headers["Pragma"] = "no-cache"
            response_headers["Expires"] = "0"

        return Response(
            content=upstream.content if request.method != "HEAD" else b"",
            status_code=upstream.status_code,
            headers=response_headers,
            media_type=upstream.headers.get("content-type"),
        )

    @app.api_route("/{full_path:path}", methods=["GET", "HEAD"])
    async def serve_react_app(request: Request, full_path: str):
        # API routes are already handled above
        if full_path.startswith("api/") or full_path in ("docs", "redoc", "openapi.json"):
            raise HTTPException(status_code=404, detail="Not found")

        # Use Starlette's safe static path lookup to prevent traversal.
        if full_path:
            resolved_path, stat_result = static_files.lookup_path(full_path.lstrip("/"))
            if stat_result and os.path.isfile(resolved_path):
                return FileResponse(resolved_path)

        # Legacy static SPA builds still work if they produce index.html.
        if os.path.isfile(index_file):
            response = FileResponse(index_file)
            response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
            response.headers["Pragma"] = "no-cache"
            response.headers["Expires"] = "0"
            return response

        # React Router v7 framework builds generate HTML via the server bundle.
        if ui_renderer_enabled:
            return await proxy_ui_request(request)

        raise HTTPException(status_code=404, detail="Frontend build is missing index.html and UI renderer is disabled")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
