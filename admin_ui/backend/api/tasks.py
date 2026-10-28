"""Manager handoff queue.

Thin proxy over the WhatsApp CRM manager-task API. The CRM stays the source of
truth for tasks; this module only forwards the tenant scope and normalizes
errors the same way the hotel profile proxy does.
"""

import os
from typing import Any, Dict, List, Optional

import httpx
from dotenv import dotenv_values
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field

import settings

router = APIRouter()

TASK_STATUSES = ("new", "in_progress", "done", "cancelled")

def _dotenv_value(key: str) -> Optional[str]:
    try:
        if not os.path.exists(settings.ENV_PATH):
            return None
        value = dotenv_values(settings.ENV_PATH).get(key)
        return str(value).strip() if value is not None else None
    except Exception:
        return None

def _crm_base_url() -> str:
    return (
        os.getenv("WHATSAPP_CRM_BASE_URL")
        or os.getenv("SALES_BRAIN_BASE_URL")
        or _dotenv_value("WHATSAPP_CRM_BASE_URL")
        or _dotenv_value("SALES_BRAIN_BASE_URL")
        or "http://127.0.0.1:3011"
    ).rstrip("/")

def _service_token() -> str:
    return (
        os.getenv("CRM_SERVICE_API_TOKEN")
        or os.getenv("WHATSAPP_CRM_API_TOKEN")
        or os.getenv("SALES_BRAIN_API_TOKEN")
        or _dotenv_value("CRM_SERVICE_API_TOKEN")
        or _dotenv_value("WHATSAPP_CRM_API_TOKEN")
        or _dotenv_value("SALES_BRAIN_API_TOKEN")
        or ""
    ).strip()

class ManagerTask(BaseModel):
    model_config = ConfigDict(extra="allow")

    task_id: str
    business_id: int
    call_id: Optional[str] = None
    call_link: Optional[str] = None
    phone: Optional[str] = None
    customer_name: Optional[str] = None
    summary: str = ""
    reason: str = "manual"
    priority: str = "normal"
    status: str = "new"
    source: str = "sales_brain"
    assignee: Optional[str] = None
    resolution_note: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    closed_at: Optional[str] = None

class ManagerTaskListResponse(BaseModel):
    business_id: int
    counts: Dict[str, int] = Field(default_factory=dict)
    tasks: List[ManagerTask] = Field(default_factory=list)

class ManagerTaskUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Optional[str] = None
    assignee: Optional[str] = None
    priority: Optional[str] = None
    resolution_note: Optional[str] = None

class ManagerTaskResponse(BaseModel):
    task: ManagerTask

async def _crm_request(
    method: str,
    path: str,
    payload: Optional[Dict[str, Any]] = None,
    params: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    token = _service_token()
    if not token:
        raise HTTPException(status_code=503, detail="CRM_SERVICE_API_TOKEN is not configured")

    url = f"{_crm_base_url()}{path}"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.request(
                method,
                url,
                json=payload,
                params=params,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                },
            )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=503, detail=f"WhatsApp CRM is not reachable: {exc}") from exc

    try:
        data = response.json()
    except ValueError as exc:
        raise HTTPException(status_code=502, detail="WhatsApp CRM returned invalid JSON") from exc

    if response.status_code >= 400:
        detail = data.get("error") or data.get("detail") or response.text
        raise HTTPException(status_code=response.status_code, detail=detail)
    if data.get("success") is False:
        raise HTTPException(status_code=400, detail=data.get("error") or "manager task request failed")
    return data

@router.get("/tasks", response_model=ManagerTaskListResponse)
async def list_manager_tasks(
    business_id: int = Query(..., ge=1, description="Tenant scope; equals WhatsApp CRM instanceId"),
    status: Optional[str] = Query(default=None),
    call_id: Optional[str] = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
):
    if status and status not in TASK_STATUSES:
        raise HTTPException(status_code=400, detail=f"status must be one of {', '.join(TASK_STATUSES)}")

    params: Dict[str, Any] = {"instanceId": business_id, "limit": limit}
    if status:
        params["status"] = status
    if call_id:
        params["call_id"] = call_id

    data = await _crm_request("GET", "/api/ml/manager-tasks", params=params)
    return {
        "business_id": business_id,
        "counts": data.get("counts") or {},
        "tasks": data.get("tasks") or [],
    }

@router.patch("/tasks/{task_id}", response_model=ManagerTaskResponse)
async def update_manager_task(
    task_id: str,
    patch: ManagerTaskUpdateRequest,
    business_id: int = Query(..., ge=1, description="Tenant scope; equals WhatsApp CRM instanceId"),
):
    if patch.status and patch.status not in TASK_STATUSES:
        raise HTTPException(status_code=400, detail=f"status must be one of {', '.join(TASK_STATUSES)}")

    payload = patch.model_dump(exclude_none=True)
    if not payload:
        raise HTTPException(status_code=400, detail="no fields to update")
    payload["instanceId"] = business_id

    data = await _crm_request("PATCH", f"/api/ml/manager-tasks/{task_id}", payload)
    task = data.get("task")
    if not task:
        raise HTTPException(status_code=404, detail="manager task not found")
    return {"task": task}
