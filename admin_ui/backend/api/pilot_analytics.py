"""Pilot analytics.

One tenant-scoped endpoint that answers the questions a pilot manager actually
asks: how many calls, how many landed, how long they lasted, how much work
landed on a human, and what is breaking.

Data comes from three existing sources — call history, outbound attempts and
the WhatsApp CRM. If one of them is down the response is marked partial and
says which source is missing, rather than reporting zeros that look like facts.
"""

import logging
import os
import sys
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import httpx
from dotenv import dotenv_values
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field

import settings

project_root = os.environ.get("PROJECT_ROOT", "/app/project")
if project_root not in sys.path:
    sys.path.insert(0, project_root)

logger = logging.getLogger(__name__)

router = APIRouter()

PERIODS = {"24h": timedelta(hours=24), "7d": timedelta(days=7), "30d": timedelta(days=30)}
MAX_RANGE_DAYS = 90
DEFAULT_PERIOD = "24h"

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

class CallCounts(BaseModel):
    incoming: int = 0
    outgoing_attempts: int = 0
    outgoing_answered: int = 0

class OutcomeBreakdown(BaseModel):
    answered: int = 0
    no_answer: int = 0
    failed: int = 0
    voicemail: int = 0
    other: int = 0

class ProviderError(BaseModel):
    error_stage: str
    error_code: str
    provider: Optional[str] = None
    count: int = 0
    last_seen_at: Optional[str] = None
    message_preview: Optional[str] = None

class ManagerTaskMetrics(BaseModel):
    created: int = 0
    by_status: Dict[str, int] = Field(default_factory=dict)

class FollowupMetrics(BaseModel):
    sent: int = 0
    created: int = 0
    by_status: Dict[str, int] = Field(default_factory=dict)

class AnalyticsPeriod(BaseModel):
    preset: Optional[str] = None
    start_at: str
    end_at: str
    days: float = 0.0

class PilotAnalyticsResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    business_id: int
    generated_at: str
    timezone: str = "UTC"
    period: AnalyticsPeriod
    partial: bool = False
    sources: Dict[str, str] = Field(default_factory=dict)

    calls: CallCounts = Field(default_factory=CallCounts)
    incoming_breakdown: OutcomeBreakdown = Field(default_factory=OutcomeBreakdown)
    outgoing_breakdown: OutcomeBreakdown = Field(default_factory=OutcomeBreakdown)
    totals: OutcomeBreakdown = Field(default_factory=OutcomeBreakdown)

    average_answered_call_duration_seconds: float = 0.0
    average_answered_incoming_duration_seconds: float = 0.0
    average_answered_outgoing_duration_seconds: float = 0.0
    total_answered_duration_seconds: float = 0.0

    raw_call_outcomes: Dict[str, int] = Field(default_factory=dict)
    raw_attempt_outcomes: Dict[str, int] = Field(default_factory=dict)

    errors: List[ProviderError] = Field(default_factory=list)
    error_stages: Dict[str, int] = Field(default_factory=dict)

    manager_tasks: Optional[ManagerTaskMetrics] = None
    followups: Optional[FollowupMetrics] = None

def _parse_boundary(value: str, field: str, *, end_of_day: bool) -> datetime:
    text = str(value or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail=f"{field} is empty")
    try:
        if len(text) == 10:
            parsed = datetime.fromisoformat(text)
            if end_of_day:
                parsed = parsed.replace(hour=23, minute=59, second=59, microsecond=999999)
        else:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"{field} must be an ISO date or datetime",
        ) from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)

def resolve_period(
    period: Optional[str],
    start_date: Optional[str],
    end_date: Optional[str],
    *,
    now: Optional[datetime] = None,
) -> AnalyticsPeriod:
    """Custom range wins over a preset; the preset is the fallback."""
    now = now or datetime.now(timezone.utc)

    if start_date or end_date:
        if not (start_date and end_date):
            raise HTTPException(
                status_code=400,
                detail="start_date and end_date must be provided together",
            )
        start = _parse_boundary(start_date, "start_date", end_of_day=False)
        end = _parse_boundary(end_date, "end_date", end_of_day=True)
        if start > end:
            raise HTTPException(status_code=400, detail="start_date must be before end_date")
        if (end - start) > timedelta(days=MAX_RANGE_DAYS):
            raise HTTPException(
                status_code=400,
                detail=f"date range must not exceed {MAX_RANGE_DAYS} days",
            )
        return AnalyticsPeriod(
            preset=None,
            start_at=start.isoformat(),
            end_at=end.isoformat(),
            days=round((end - start).total_seconds() / 86400, 2),
        )

    preset = (period or DEFAULT_PERIOD).strip().lower()
    if preset not in PERIODS:
        raise HTTPException(
            status_code=400,
            detail=f"period must be one of {', '.join(PERIODS)}",
        )
    delta = PERIODS[preset]
    start = now - delta
    return AnalyticsPeriod(
        preset=preset,
        start_at=start.isoformat(),
        end_at=now.isoformat(),
        days=round(delta.total_seconds() / 86400, 2),
    )

async def _fetch_call_metrics(
    business_id: int,
    period: AnalyticsPeriod,
) -> tuple:
    """Returns (metrics, source_status)."""
    try:
        from src.core.pilot_analytics import empty_call_metrics, get_pilot_analytics_store
    except ImportError as exc:
        logger.error(f"Pilot analytics module unavailable: {exc}")
        return {}, "unavailable"

    try:
        store = get_pilot_analytics_store()
        metrics = await store.get_call_metrics(
            business_id=business_id,
            start_date=datetime.fromisoformat(period.start_at),
            end_date=datetime.fromisoformat(period.end_at),
        )
        return metrics, "ok"
    except Exception as exc:
        logger.error(f"Pilot analytics call aggregation failed: {exc}", exc_info=True)
        return empty_call_metrics(), "unavailable"

async def _fetch_crm_metrics(business_id: int, period: AnalyticsPeriod) -> tuple:
    """Returns (crm_payload, source_status)."""
    token = _service_token()
    if not token:
        return None, "not_configured"

    url = f"{_crm_base_url()}/api/ml/pilot-analytics"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                url,
                params={
                    "instanceId": business_id,
                    "start_at": period.start_at,
                    "end_at": period.end_at,
                },
                headers={"Authorization": f"Bearer {token}"},
            )
        if response.status_code >= 400:
            logger.warning(f"CRM pilot analytics returned {response.status_code}")
            return None, "unavailable"
        data = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        logger.warning(f"CRM pilot analytics unreachable: {exc}")
        return None, "unavailable"

    if not isinstance(data, dict) or data.get("success") is False:
        return None, "unavailable"
    return data, "ok"

def _server_timezone() -> str:
    """Fallback when the business timezone is unknown."""
    return (os.getenv("TZ") or "UTC").strip() or "UTC"

@router.get("/pilot-analytics", response_model=PilotAnalyticsResponse)
async def get_pilot_analytics(
    business_id: int = Query(..., ge=1, description="Tenant scope; equals WhatsApp CRM instanceId"),
    period: Optional[str] = Query(default=None, description="24h | 7d | 30d"),
    start_date: Optional[str] = Query(default=None, description="ISO date or datetime (UTC)"),
    end_date: Optional[str] = Query(default=None, description="ISO date or datetime (UTC)"),
    timezone_name: Optional[str] = Query(default=None, alias="timezone"),
):
    resolved_period = resolve_period(period, start_date, end_date)

    call_metrics, call_source = await _fetch_call_metrics(business_id, resolved_period)
    crm_payload, crm_source = await _fetch_crm_metrics(business_id, resolved_period)

    sources = {
        "call_history": call_source,
        "outbound": call_source,
        "whatsapp_crm": crm_source,
    }
    partial = any(status != "ok" for status in sources.values())

    display_timezone = (
        timezone_name
        or (crm_payload or {}).get("timezone")
        or _server_timezone()
    )

    payload: Dict[str, Any] = {
        "business_id": business_id,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "timezone": display_timezone,
        "period": resolved_period,
        "partial": partial,
        "sources": sources,
        "calls": call_metrics.get("calls", {}),
        "incoming_breakdown": call_metrics.get("incoming_breakdown", {}),
        "outgoing_breakdown": call_metrics.get("outgoing_breakdown", {}),
        "totals": call_metrics.get("totals", {}),
        "average_answered_call_duration_seconds": call_metrics.get(
            "average_answered_call_duration_seconds", 0.0
        ),
        "average_answered_incoming_duration_seconds": call_metrics.get(
            "average_answered_incoming_duration_seconds", 0.0
        ),
        "average_answered_outgoing_duration_seconds": call_metrics.get(
            "average_answered_outgoing_duration_seconds", 0.0
        ),
        "total_answered_duration_seconds": call_metrics.get("total_answered_duration_seconds", 0.0),
        "raw_call_outcomes": call_metrics.get("raw_call_outcomes", {}),
        "raw_attempt_outcomes": call_metrics.get("raw_attempt_outcomes", {}),
        "errors": call_metrics.get("errors", []),
        "error_stages": call_metrics.get("error_stages", {}),
    }

    if crm_payload:
        payload["manager_tasks"] = crm_payload.get("manager_tasks") or {}
        payload["followups"] = crm_payload.get("followups") or {}

    return PilotAnalyticsResponse(**payload)
