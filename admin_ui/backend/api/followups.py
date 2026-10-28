"""WhatsApp follow-up approval queue.

Thin proxy over the WhatsApp CRM follow-up API. The CRM owns the drafts and the
approval policy; this module only forwards the tenant scope, restricts the set
of actions a manager can take, and normalizes errors.

Sending is never a side effect of a GET here: a message reaches a guest only
through an explicit approve action.
"""

import os
from typing import Any, Dict, List, Optional

import httpx
from dotenv import dotenv_values
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field

import settings

router = APIRouter()

DRAFT_STATUSES = ("draft", "approved", "sent", "rejected", "failed")
DRAFT_ACTIONS = ("edit", "approve", "reject")

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

class FollowupDraft(BaseModel):
    model_config = ConfigDict(extra="allow")

    draft_id: str
    business_id: int
    call_id: Optional[str] = None
    call_link: Optional[str] = None
    manager_task_id: Optional[str] = None
    phone: Optional[str] = None
    text: str = ""
    original_text: str = ""
    edited: bool = False
    status: str = "draft"
    source: str = "sales_brain"
    approved_by: Optional[str] = None
    approved_at: Optional[str] = None
    edited_by: Optional[str] = None
    edited_at: Optional[str] = None
    sent_at: Optional[str] = None
    failure_reason: Optional[str] = None
    attempts: int = 0
    created_at: Optional[str] = None
    updated_at: Optional[str] = None

class FollowupPolicy(BaseModel):
    model_config = ConfigDict(extra="allow")

    auto_send_enabled: bool = False
    requires_manager_approval: bool = True

class FollowupListResponse(BaseModel):
    business_id: int
    counts: Dict[str, int] = Field(default_factory=dict)
    policy: FollowupPolicy = Field(default_factory=FollowupPolicy)
    drafts: List[FollowupDraft] = Field(default_factory=list)

class FollowupActionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action: str
    text: Optional[str] = None
    approved_by: Optional[str] = None
    rejected_by: Optional[str] = None
    edited_by: Optional[str] = None

class FollowupActionResponse(BaseModel):
    model_config = ConfigDict(extra="allow")

    draft: Optional[FollowupDraft] = None
    sent: bool = False
    status: Optional[str] = None
    error: Optional[str] = None
    requires_whatsapp_authorization: bool = False

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
        async with httpx.AsyncClient(timeout=15.0) as client:
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
    return data

@router.get("/followups", response_model=FollowupListResponse)
async def list_followup_drafts(
    business_id: int = Query(..., ge=1, description="Tenant scope; equals WhatsApp CRM instanceId"),
    status: Optional[str] = Query(default=None),
    call_id: Optional[str] = Query(default=None),
    manager_task_id: Optional[str] = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
):
    if status and status not in DRAFT_STATUSES:
        raise HTTPException(status_code=400, detail=f"status must be one of {', '.join(DRAFT_STATUSES)}")

    params: Dict[str, Any] = {"instanceId": business_id, "limit": limit}
    if status:
        params["status"] = status
    if call_id:
        params["call_id"] = call_id
    if manager_task_id:
        params["manager_task_id"] = manager_task_id

    data = await _crm_request("GET", "/api/ml/followup-drafts", params=params)
    if data.get("success") is False:
        raise HTTPException(status_code=400, detail=data.get("error") or "follow-up request failed")
    return {
        "business_id": business_id,
        "counts": data.get("counts") or {},
        "policy": data.get("policy") or {},
        "drafts": data.get("drafts") or [],
    }

@router.patch("/followups/{draft_id}", response_model=FollowupActionResponse)
async def act_on_followup_draft(
    draft_id: str,
    request: FollowupActionRequest,
    business_id: int = Query(..., ge=1, description="Tenant scope; equals WhatsApp CRM instanceId"),
):
    action = request.action.strip().lower()
    if action not in DRAFT_ACTIONS:
        raise HTTPException(status_code=400, detail=f"action must be one of {', '.join(DRAFT_ACTIONS)}")
    if action == "edit" and not (request.text or "").strip():
        raise HTTPException(status_code=400, detail="text is required to edit a draft")

    payload = request.model_dump(exclude_none=True)
    payload["action"] = action
    payload["instanceId"] = business_id

    data = await _crm_request("PATCH", f"/api/ml/followup-drafts/{draft_id}", payload)
    if data.get("success") is False and not data.get("draft"):
        raise HTTPException(status_code=400, detail=data.get("error") or "follow-up action failed")

    return {
        "draft": data.get("draft"),
        "sent": bool(data.get("sent")),
        "status": data.get("status"),
        "error": data.get("error"),
        "requires_whatsapp_authorization": bool(data.get("requires_whatsapp_authorization")),
    }
