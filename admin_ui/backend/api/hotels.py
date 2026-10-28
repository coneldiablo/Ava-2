import os
from typing import Any, Dict, List, Optional

import httpx
from dotenv import dotenv_values
from fastapi import APIRouter, File, Header, HTTPException, UploadFile
from pydantic import BaseModel, ConfigDict, Field

import settings

router = APIRouter()

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

class WorkingHoursDay(BaseModel):
    enabled: bool = True
    start: str = Field(default="09:00", pattern=r"^\d{2}:\d{2}$")
    end: str = Field(default="18:00", pattern=r"^\d{2}:\d{2}$")

class HotelProfileRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    name: Optional[str] = None
    isActive: Optional[bool] = None
    hotelTone: Optional[str] = None
    hotelTimezone: Optional[str] = None
    hotelWorkingHours: Optional[Dict[str, WorkingHoursDay]] = None
    sipTrunkNumber: Optional[str] = None
    sipCallerId: Optional[str] = None
    sipAliases: Optional[List[str]] = None
    knowledgeBaseInstanceId: Optional[int] = None
    voiceContextName: Optional[str] = None
    aiProvider: Optional[str] = None
    ai_provider: Optional[str] = None
    voiceName: Optional[str] = None
    voice: Optional[str] = None
    voiceGreetingTemplate: Optional[str] = None
    outboundOpenerTemplate: Optional[str] = None

class HotelProfileResponse(BaseModel):
    model_config = ConfigDict(extra="allow")

    id: int
    businessId: int
    business_id: int
    instanceId: int
    instance_id: int
    businessType: str = "hotel"
    name: str
    isActive: bool = True
    greenApiInstance: Optional[Any] = None
    whatsappStatus: Optional[str] = None
    greenApiStatus: Optional[str] = None
    hotelTone: str = ""
    hotelTimezone: str = "UTC"
    hotelWorkingHours: Dict[str, Any] = Field(default_factory=dict)
    sipTrunkNumber: str = ""
    sipCallerId: str = ""
    sipAliases: List[str] = Field(default_factory=list)
    knowledgeBaseInstanceId: int
    voiceContextName: str = "unified_sales_agent"
    aiProvider: Optional[str] = None
    ai_provider: Optional[str] = None
    voiceName: Optional[str] = None
    voice: Optional[str] = None
    voiceGreetingTemplate: str = ""
    outboundOpenerTemplate: str = ""
    pms: Optional[Dict[str, Any]] = None
    createdAt: Optional[str] = None
    updatedAt: Optional[str] = None

class HotelProfilesResponse(BaseModel):
    profiles: List[HotelProfileResponse]

class HotelProfileMutationResponse(BaseModel):
    profile: HotelProfileResponse

async def _crm_request(
    method: str,
    path: str,
    payload: Optional[Dict[str, Any]] = None,
    *,
    headers: Optional[Dict[str, str]] = None,
    timeout_seconds: float = 10.0,
) -> Dict[str, Any]:
    token = _service_token()
    if not token:
        raise HTTPException(status_code=503, detail="CRM_SERVICE_API_TOKEN is not configured")

    url = f"{_crm_base_url()}{path}"
    req_headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    if headers:
        req_headers.update(headers)

    try:
        async with httpx.AsyncClient(timeout=timeout_seconds) as client:
            response = await client.request(
                method,
                url,
                json=payload,
                headers=req_headers,
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

async def _crm_file_request(method: str, path: str, files: List[UploadFile]) -> Dict[str, Any]:
    token = _service_token()
    if not token:
        raise HTTPException(status_code=503, detail="CRM_SERVICE_API_TOKEN is not configured")
    if not files:
        raise HTTPException(status_code=400, detail="files are required")

    multipart_files = []
    try:
        for upload in files:
            content = await upload.read()
            multipart_files.append(
                (
                    "files",
                    (
                        upload.filename or "knowledge-base-upload",
                        content,
                        upload.content_type or "application/octet-stream",
                    ),
                )
            )

        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.request(
                method,
                f"{_crm_base_url()}{path}",
                files=multipart_files,
                headers={"Authorization": f"Bearer {token}"},
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

@router.get("/hotels", response_model=HotelProfilesResponse)
async def list_hotels():
    data = await _crm_request("GET", "/api/ml/hotel-profiles")
    return {"profiles": data.get("profiles") or []}

@router.get("/hotels/{business_id}", response_model=HotelProfileMutationResponse)
async def get_hotel(business_id: int):
    data = await _crm_request("GET", f"/api/ml/hotel-profiles/{business_id}")
    return {"profile": data.get("profile")}

@router.post("/hotels", response_model=HotelProfileMutationResponse)
async def create_hotel(
    profile: HotelProfileRequest,
    idempotency_key: Optional[str] = Header(None, alias="Idempotency-Key"),
):
    payload = profile.model_dump(exclude_none=True)
    custom_headers = {}
    if idempotency_key:
        custom_headers["Idempotency-Key"] = idempotency_key
    data = await _crm_request("POST", "/api/ml/hotel-profiles", payload, headers=custom_headers)
    return {"profile": data.get("profile")}


@router.get("/hotels/{business_id}/provisioning")
async def get_hotel_provisioning(business_id: int):
    return await _crm_request("GET", f"/api/ml/hotel-profiles/{business_id}/provisioning")


@router.post("/hotels/{business_id}/provisioning/retry")
async def retry_hotel_provisioning(business_id: int, payload: Optional[Dict[str, Any]] = None):
    return await _crm_request(
        "POST",
        f"/api/ml/hotel-profiles/{business_id}/provisioning/retry",
        payload or {},
    )


@router.put("/hotels/{business_id}", response_model=HotelProfileMutationResponse)
async def update_hotel(business_id: int, profile: HotelProfileRequest):
    payload = profile.model_dump(exclude_none=True)
    data = await _crm_request("PUT", f"/api/ml/hotel-profiles/{business_id}", payload)
    return {"profile": data.get("profile")}

class PmsConfigurationRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    provider: str = "bnovo"
    enabled: bool = False
    account_id: Optional[Any] = None
    api_password: Optional[str] = None
    currency: str = "RUB"
    mappings: Dict[str, Any] = Field(default_factory=dict)


class TwentyConfigurationRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    enabled: bool = False
    mode: str = "shadow"
    base_url: Optional[str] = None
    workspace_id: Optional[str] = None
    api_key: Optional[str] = None
    webhook_secret: Optional[str] = None
    mappings: Dict[str, Any] = Field(default_factory=dict)


@router.get("/hotels/{business_id}/pms")
async def get_hotel_pms(business_id: int):
    return await _crm_request("GET", f"/api/ml/hotel-profiles/{business_id}/pms")


@router.put("/hotels/{business_id}/pms")
async def update_hotel_pms(business_id: int, payload: PmsConfigurationRequest):
    return await _crm_request(
        "PUT",
        f"/api/ml/hotel-profiles/{business_id}/pms",
        payload.model_dump(exclude_none=True),
    )


@router.delete("/hotels/{business_id}/pms")
async def delete_hotel_pms(business_id: int):
    return await _crm_request("DELETE", f"/api/ml/hotel-profiles/{business_id}/pms")


@router.post("/hotels/{business_id}/pms/test")
async def test_hotel_pms(business_id: int):
    return await _crm_request("POST", f"/api/ml/hotel-profiles/{business_id}/pms/test", {})


@router.post("/hotels/{business_id}/pms/sync")
async def sync_hotel_pms(business_id: int):
    return await _crm_request("POST", f"/api/ml/hotel-profiles/{business_id}/pms/sync", {})


@router.post("/hotels/{business_id}/pms/webhooks")
async def connect_hotel_pms_webhooks(business_id: int, payload: Optional[Dict[str, Any]] = None):
    return await _crm_request(
        "POST",
        f"/api/ml/hotel-profiles/{business_id}/pms/webhooks",
        payload or {},
    )


@router.get("/hotels/{business_id}/pms/bookings")
async def get_hotel_pms_bookings(business_id: int, limit: int = 100):
    return await _crm_request(
        "GET",
        f"/api/ml/hotel-profiles/{business_id}/pms/bookings?limit={max(1, min(limit, 500))}",
    )


@router.get("/hotels/{business_id}/pms/booking-requests")
async def get_hotel_pms_booking_requests(business_id: int, limit: int = 100):
    return await _crm_request(
        "GET",
        f"/api/ml/hotel-profiles/{business_id}/pms/booking-requests?limit={max(1, min(limit, 500))}",
    )


@router.get("/hotels/{business_id}/twenty")
async def get_hotel_twenty(business_id: int):
    return await _crm_request("GET", f"/api/ml/hotel-profiles/{business_id}/twenty")


@router.put("/hotels/{business_id}/twenty")
async def update_hotel_twenty(business_id: int, payload: TwentyConfigurationRequest):
    return await _crm_request(
        "PUT",
        f"/api/ml/hotel-profiles/{business_id}/twenty",
        payload.model_dump(exclude_none=True),
    )


@router.delete("/hotels/{business_id}/twenty")
async def delete_hotel_twenty(business_id: int):
    return await _crm_request("DELETE", f"/api/ml/hotel-profiles/{business_id}/twenty")


@router.post("/hotels/{business_id}/twenty/test")
async def test_hotel_twenty(business_id: int):
    return await _crm_request("POST", f"/api/ml/hotel-profiles/{business_id}/twenty/test", {})


@router.post("/hotels/{business_id}/twenty/sync")
async def sync_hotel_twenty(business_id: int):
    return await _crm_request("POST", f"/api/ml/hotel-profiles/{business_id}/twenty/sync", {})


@router.post("/hotels/{business_id}/twenty/webhook")
async def configure_hotel_twenty_webhook(business_id: int, payload: Optional[Dict[str, Any]] = None):
    return await _crm_request(
        "POST",
        f"/api/ml/hotel-profiles/{business_id}/twenty/webhook",
        payload or {},
    )

@router.get("/hotels/{business_id}/knowledge-base")
async def get_hotel_knowledge_base(business_id: int):
    return await _crm_request("GET", f"/api/ml/hotel-profiles/{business_id}/knowledge-base")

@router.post("/hotels/{business_id}/knowledge-base/upload")
async def upload_hotel_knowledge_base_files(
    business_id: int,
    files: List[UploadFile] = File(...),
):
    return await _crm_file_request(
        "POST",
        f"/api/ml/hotel-profiles/{business_id}/knowledge-base/upload",
        files,
    )

@router.post("/hotels/{business_id}/knowledge-base/text")
async def upload_hotel_knowledge_base_text(business_id: int, payload: Dict[str, Any]):
    return await _crm_request(
        "POST",
        f"/api/ml/hotel-profiles/{business_id}/knowledge-base/text",
        payload,
    )

@router.post("/hotels/{business_id}/knowledge-base/search")
async def search_hotel_knowledge_base(business_id: int, payload: Dict[str, Any]):
    return await _crm_request(
        "POST",
        f"/api/ml/hotel-profiles/{business_id}/knowledge-base/search",
        payload,
    )

@router.delete("/hotels/{business_id}/knowledge-base/{file_id}")
async def delete_hotel_knowledge_base_file(business_id: int, file_id: int):
    return await _crm_request(
        "DELETE",
        f"/api/ml/hotel-profiles/{business_id}/knowledge-base/{file_id}",
    )

@router.post("/hotels/{business_id}/knowledge-base/smoke-test")
async def run_hotel_knowledge_base_smoke_test(business_id: int, payload: Dict[str, Any]):
    return await _crm_request(
        "POST",
        f"/api/ml/hotel-profiles/{business_id}/knowledge-base/smoke-test",
        payload,
        timeout_seconds=180.0,
    )
