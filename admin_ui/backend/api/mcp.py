from fastapi import APIRouter, HTTPException
import os
import httpx
import json
import re
from typing import Any

router = APIRouter(prefix="/api/mcp", tags=["mcp"])

_SAFE_SERVER_ID = re.compile(r"^[A-Za-z0-9_.-]+$")

def _ai_engine_base_urls() -> list[str]:
    """Return candidate ai-engine health base URLs (no trailing /health)."""
    candidates: list[str] = []
    env = os.getenv("HEALTH_CHECK_AI_ENGINE_URL")
    if env:
        candidates.append(env.replace("/health", ""))
    candidates.extend(["http://127.0.0.1:15000", "http://ai-engine:15000", "http://ai_engine:15000"])
    out: list[str] = []
    for c in candidates:
        c = (c or "").strip().rstrip("/")
        if c and c not in out:
            out.append(c)
    return out

def _docker_ai_engine_containers() -> list[Any]:
    """Best-effort Docker fallback for host-network ai_engine deployments."""
    try:
        import docker
    except Exception:
        return []

    try:
        client = docker.from_env()
        containers = client.containers.list(all=False)
    except Exception:
        return []

    matches: list[Any] = []
    for container in containers:
        name = str(getattr(container, "name", "") or "")
        image = ""
        try:
            image = str(getattr(getattr(container, "image", None), "tags", []) or "")
        except Exception:
            image = ""
        label_service = ""
        try:
            label_service = str((container.labels or {}).get("com.docker.compose.service") or "")
        except Exception:
            label_service = ""
        haystack = f"{name} {image} {label_service}".lower()
        if "ai_engine" in haystack or "ai-engine" in haystack:
            matches.append(container)
    return matches

def _docker_exec_ai_engine(path: str, method: str = "GET") -> dict[str, Any] | None:
    """Call ai_engine localhost endpoint from inside its container."""
    url = f"http://127.0.0.1:15000{path}"
    script = (
        "import json,sys,urllib.request,urllib.error\n"
        f"url={json.dumps(url)}\n"
        f"method={json.dumps(method.upper())}\n"
        "data=b'' if method=='POST' else None\n"
        "try:\n"
        "    req=urllib.request.Request(url,data=data,method=method)\n"
        "    with urllib.request.urlopen(req,timeout=15) as r:\n"
        "        body=r.read().decode('utf-8')\n"
        "        print(json.dumps({'status':r.status,'body':body}))\n"
        "except urllib.error.HTTPError as e:\n"
        "    body=e.read().decode('utf-8','replace')\n"
        "    print(json.dumps({'status':e.code,'body':body}))\n"
        "except Exception as e:\n"
        "    print(json.dumps({'status':0,'body':str(e)}))\n"
    )

    for container in _docker_ai_engine_containers():
        try:
            result = container.exec_run(["python3", "-c", script], stdout=True, stderr=True)
            output = (getattr(result, "output", b"") or b"").decode("utf-8", errors="replace").strip()
            if not output:
                continue
            payload = json.loads(output.splitlines()[-1])
            status = int(payload.get("status") or 0)
            body = str(payload.get("body") or "")
            if status == 200:
                return json.loads(body)
        except Exception:
            continue
    return None

@router.get("/status")
async def get_mcp_status():
    """Proxy MCP status from ai-engine (runs MCP servers)."""
    last_error = "AI Engine is not reachable"
    for base in _ai_engine_base_urls():
        url = f"{base}/mcp/status"
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.get(url)
            if resp.status_code == 200:
                return resp.json()
            last_error = resp.text or f"HTTP {resp.status_code}"
        except httpx.HTTPError as e:
            last_error = str(e)
            continue
    fallback = _docker_exec_ai_engine("/mcp/status", method="GET")
    if fallback is not None:
        return fallback
    raise HTTPException(status_code=503, detail=last_error)

@router.post("/servers/{server_id}/test")
async def test_mcp_server(server_id: str):
    """Proxy a safe MCP server test to ai-engine container context."""
    if not _SAFE_SERVER_ID.match(server_id or ""):
        raise HTTPException(status_code=400, detail="Invalid MCP server id")

    last_error = "AI Engine is not reachable"
    for base in _ai_engine_base_urls():
        url = f"{base}/mcp/test/{server_id}"
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                resp = await client.post(url)
            if resp.status_code in (200, 500):
                return resp.json()
            last_error = resp.text or f"HTTP {resp.status_code}"
        except httpx.HTTPError as e:
            last_error = str(e)
            continue
    fallback = _docker_exec_ai_engine(f"/mcp/test/{server_id}", method="POST")
    if fallback is not None:
        return fallback
    raise HTTPException(status_code=503, detail=last_error)
