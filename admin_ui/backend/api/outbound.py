"""
Outbound Campaign Dialer API endpoints (Milestone 22).

MVP scope:
- Campaign CRUD + status transitions (running/paused/stopped)
- CSV lead import (skip_existing default)
- Leads list + ignore/recycle/delete
- Attempts list + basic stats
- Voicemail drop media upload + WAV preview (for browser playback)
- Optional consent media upload + WAV preview (for browser playback)
"""

import io
import csv
import hmac
import json
import logging
import os
import re
import sys
import uuid
import wave
import audioop
from datetime import datetime, timezone
from src.audio.resampler import resample_audio
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, File, Header, HTTPException, Query, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field
from pathlib import Path
import yaml
import aiohttp
try:
    from zoneinfo import ZoneInfo, available_timezones
except Exception:
    ZoneInfo = None
    available_timezones = None

project_root = os.environ.get("PROJECT_ROOT", "/app/project")
if project_root not in sys.path:
    sys.path.insert(0, project_root)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/outbound", tags=["outbound"])
internal_router = APIRouter(prefix="/internal/outbound", tags=["outbound-internal"])

def _dotenv_value(key: str) -> Optional[str]:
    """Read a key from the project's `.env` file (best-effort)."""
    try:
        env_path = os.path.join(project_root, ".env")
        if not os.path.exists(env_path):
            return None
        from dotenv import dotenv_values

        raw = dotenv_values(env_path)
        val = raw.get(key)
        if val is None:
            return None
        return str(val).strip()
    except Exception:
        return None

def _get_outbound_store():
    try:
        from src.core.outbound_store import get_outbound_store
        return get_outbound_store()
    except ImportError as e:
        logger.error("Failed to import outbound_store module: %s", e)
        raise HTTPException(status_code=500, detail="Outbound dialer module not available")

def _media_dir() -> str:
    return "/mnt/asterisk_media/ai-generated"

def _vm_upload_max_bytes() -> int:
    try:
        return max(1, int(os.getenv("AAVA_VM_UPLOAD_MAX_BYTES", "12582912")))
    except Exception:
        return 12582912

def _truthy_flag(value: Any, default: bool = False) -> bool:
    if value is None or value == "":
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    return str(value).strip().lower() not in ("0", "false", "no", "off")

DEFAULT_CONSENT_MEDIA_URI = "sound:ai-generated/aava-consent-default"
DEFAULT_VOICEMAIL_MEDIA_URI = "sound:ai-generated/aava-voicemail-default"

class RecordingRow(BaseModel):
    media_uri: str
    filename: str
    size_bytes: int = 0

def _media_uri_exists(media_uri: str) -> bool:
    uri = (media_uri or "").strip()
    if not uri.startswith("sound:ai-generated/"):
        return False
    base = os.path.basename(uri.split("sound:ai-generated/", 1)[1].strip())
    if not base:
        return False
    if (not _SAFE_NAME_RE.match(base)) or (".." in base):
        return False
    p = os.path.join(_media_dir(), f"{base}.ulaw")
    return os.path.exists(p)

def _safe_ai_generated_basename(media_uri: str) -> str:
    uri = (media_uri or "").strip()
    if not uri.startswith("sound:ai-generated/"):
        raise HTTPException(status_code=400, detail="media_uri must be in sound:ai-generated/")
    raw_base = uri.split("sound:ai-generated/", 1)[1].strip()
    base = os.path.basename(raw_base)
    if not base:
        raise HTTPException(status_code=400, detail="Invalid media_uri")
    if base != raw_base or (".." in base) or (not _SAFE_NAME_RE.match(base)):
        raise HTTPException(status_code=400, detail="Invalid media_uri basename")
    return base

_SAFE_NAME_RE = re.compile(r"^[a-zA-Z0-9_.-]+$")

def _ulaw_to_wav_bytes(ulaw_data: bytes) -> bytes:
    pcm16 = audioop.ulaw2lin(ulaw_data, 2)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wavf:
        wavf.setnchannels(1)
        wavf.setsampwidth(2)
        wavf.setframerate(8000)
        wavf.writeframes(pcm16)
    return buf.getvalue()

def _read_media_ulaw(media_uri: str) -> bytes:
    base = _safe_ai_generated_basename(media_uri)
    media_dir = _media_dir()
    target = f"{base}.ulaw"
    try:
        for entry in os.listdir(media_dir):
            if entry != target:
                continue
            ulaw_path = os.path.join(media_dir, entry)
            with open(ulaw_path, "rb") as f:
                return f.read()
    except FileNotFoundError:
        pass
    raise HTTPException(status_code=404, detail="Media file not found on server")

def _convert_upload_to_ulaw(data: bytes, ext: str) -> bytes:
    if not data:
        raise HTTPException(status_code=400, detail="Empty upload")
    max_bytes = _vm_upload_max_bytes()
    if len(data) > max_bytes:
        raise HTTPException(status_code=400, detail=f"Upload too large (max {max_bytes} bytes)")

    if ext == ".ulaw":
        return data

    try:
        with wave.open(io.BytesIO(data), "rb") as wavf:
            nch = wavf.getnchannels()
            sampwidth = wavf.getsampwidth()
            fr = wavf.getframerate()
            nframes = wavf.getnframes()
            frames = wavf.readframes(nframes)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid WAV file: {e}")

    if nch not in (1, 2):
        raise HTTPException(status_code=400, detail="WAV must be mono or stereo (1–2 channels)")
    if sampwidth not in (1, 2, 3, 4):
        raise HTTPException(status_code=400, detail="Unsupported WAV sample width")

    if sampwidth != 2:
        frames = audioop.lin2lin(frames, sampwidth, 2)
    if nch == 2:
        frames = audioop.tomono(frames, 2, 0.5, 0.5)
    if fr != 8000:
        frames, _ = resample_audio(frames, fr, 8000)
    return audioop.lin2ulaw(frames, 2)

@router.get("/recordings", response_model=List[RecordingRow])
async def list_recordings():
    """
    List available recordings in the shared media directory.

    These are selectable by campaigns and can be reused across campaigns by referencing `media_uri`.
    """
    media_dir = _media_dir()
    try:
        os.makedirs(media_dir, exist_ok=True)
    except Exception:
        pass

    rows: List[RecordingRow] = []
    try:
        for entry in sorted(os.listdir(media_dir)):
            if not entry.endswith(".ulaw"):
                continue
            filename = entry
            base = entry[:-5]
            path = os.path.join(media_dir, entry)
            try:
                size_bytes = int(os.path.getsize(path))
            except Exception:
                size_bytes = 0
            rows.append(
                RecordingRow(
                    media_uri=f"sound:ai-generated/{base}",
                    filename=filename,
                    size_bytes=size_bytes,
                )
            )
    except Exception:
        return []
    return rows

@router.get("/recordings/preview.wav")
async def preview_recording_wav(media_uri: str = Query(...)):
    """
    Preview any `sound:ai-generated/*` recording as WAV (browser-playable).
    Useful for Create Campaign flow (no campaign_id yet).
    """
    ulaw_data = _read_media_ulaw(media_uri)
    wav_bytes = _ulaw_to_wav_bytes(ulaw_data)
    return Response(content=wav_bytes, media_type="audio/wav")

@router.post("/recordings/upload")
async def upload_recording_to_library(kind: str = Query("generic"), file: UploadFile = File(...)):
    """
    Upload a recording to the shared library (`AAVA_MEDIA_DIR`), returning its `media_uri`.

    - Accepts `.ulaw` (8kHz μ-law) or `.wav` (PCM; auto-converted to 8kHz μ-law).
    - Enforces max upload size via `AAVA_VM_UPLOAD_MAX_BYTES`.
    """
    filename = (file.filename or "").strip() or "recording.ulaw"
    ext = os.path.splitext(filename)[1].lower().strip()
    if ext not in (".ulaw", ".wav"):
        raise HTTPException(status_code=400, detail="Upload must be .ulaw (8kHz μ-law) or .wav (PCM) audio")

    raw_name = os.path.basename(filename)
    if raw_name and not _SAFE_NAME_RE.match(raw_name):
        raise HTTPException(status_code=400, detail="Invalid filename")

    media_dir = _media_dir()
    os.makedirs(media_dir, exist_ok=True)
    unique = f"outbound-recording-{uuid.uuid4().hex[:10]}.ulaw"
    path = os.path.join(media_dir, unique)

    data = await file.read()
    ulaw_data = _convert_upload_to_ulaw(data, ext)

    with open(path, "wb") as f:
        f.write(ulaw_data)

    media_uri = f"sound:ai-generated/{unique[:-5]}"
    return {"media_uri": media_uri}

def _detect_server_timezone() -> str:
    """
    Best-effort detection of server timezone as an IANA string.
    Prefer explicit env var (TZ or AAVA_SERVER_TIMEZONE), then /etc/localtime symlink, then /etc/timezone.
    """
    def _validate_iana(tz: str) -> Optional[str]:
        tz = (tz or "").strip()
        if not tz:
            return None
        if tz.upper() == "UTC":
            return "UTC"
        if ZoneInfo is None:
            return tz
        try:
            ZoneInfo(tz)
            return tz
        except Exception:
            return None

    env_tz = _validate_iana(_dotenv_value("TZ") or "")
    if env_tz:
        return env_tz
    env_tz = _validate_iana(os.getenv("TZ") or "")
    if env_tz:
        return env_tz
    env_tz = _validate_iana(_dotenv_value("AAVA_SERVER_TIMEZONE") or "")
    if env_tz:
        return env_tz
    env_tz = _validate_iana(os.getenv("AAVA_SERVER_TIMEZONE") or "")
    if env_tz:
        return env_tz

    try:
        target = os.path.realpath("/etc/localtime")
        marker = f"{os.sep}zoneinfo{os.sep}"
        if marker in target:
            tz = target.split(marker, 1)[1].strip(os.sep)
            if tz:
                validated = _validate_iana(tz)
                if validated:
                    return validated
    except Exception:
        pass

    try:
        tz = Path("/etc/timezone").read_text(encoding="utf-8").strip()
        validated = _validate_iana(tz)
        if validated:
            return validated
    except Exception:
        pass

    return "UTC"

def _load_known_context_names() -> List[str]:
    """
    Best-effort list of known context names from the active config.

    Reads the merged config (base + local override) so operator-added
    contexts in ai-agent.local.yaml are included.
    """
    try:
        from api.config import _read_merged_config_dict
        parsed = _read_merged_config_dict()
    except Exception:
        try:
            from settings import CONFIG_PATH
            if not os.path.exists(CONFIG_PATH):
                return []
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                parsed = yaml.safe_load(f) or {}
        except Exception:
            return []
    if not isinstance(parsed, dict):
        return []
    ctxs = parsed.get("contexts") or {}
    if not isinstance(ctxs, dict):
        return []
    return [str(k).strip() for k in ctxs.keys() if str(k).strip()]

@router.get("/meta")
async def outbound_meta():
    """
    UI helper metadata:
    - server_timezone: what the server/container thinks is the local timezone (IANA)
    - iana_timezones: list for validation/autocomplete
    """
    tz = _detect_server_timezone()
    tzs: List[str] = []
    if available_timezones is not None:
        try:
            tzs = sorted(list(available_timezones()))
        except Exception:
            tzs = []
    return {
        "server_timezone": tz,
        "iana_timezones": tzs,
        "server_now_iso": datetime.now(timezone.utc).isoformat(),
        "default_amd_options": {
            "initial_silence_ms": 2000,
            "greeting_ms": 2000,
            "after_greeting_silence_ms": 1000,
            "total_analysis_time_ms": 5000,
        },
    }

class CampaignCreateRequest(BaseModel):
    source_number_id: Optional[str] = Field(None, max_length=100)
    name: str = Field(..., min_length=1)
    business_id: Optional[int] = Field(None, ge=1)
    instance_id: Optional[int] = Field(None, ge=1)
    timezone: str = "UTC"
    run_start_at_utc: Optional[str] = None
    run_end_at_utc: Optional[str] = None
    daily_window_start_local: str = "09:00"
    daily_window_end_local: str = "17:00"
    max_concurrent: int = Field(1, ge=1, le=5)
    min_interval_seconds_between_calls: int = Field(5, ge=0, le=3600)
    max_attempts: int = Field(3, ge=1, le=20)
    retry_initial_delay_seconds: int = Field(60, ge=1, le=86400)
    retry_backoff_multiplier: float = Field(2.0, ge=1.0, le=10.0)
    retry_max_delay_seconds: int = Field(3600, ge=1, le=604800)
    default_context: str = "default"
    callerid: Optional[str] = None
    callerid_name: Optional[str] = None
    voicemail_drop_enabled: bool = False
    voicemail_drop_mode: str = "upload"
    voicemail_drop_text: Optional[str] = None
    voicemail_drop_media_uri: Optional[str] = None
    consent_enabled: bool = False
    consent_media_uri: Optional[str] = None
    consent_timeout_seconds: int = Field(5, ge=1, le=30)
    amd_options: Dict[str, Any] = Field(default_factory=dict)

class CampaignStatusRequest(BaseModel):
    status: str
    cancel_pending: bool = False

class LeadRecycleRequest(BaseModel):
    mode: str = Field("redial", pattern="^(redial|reset)$")

class TestRunRequest(BaseModel):
    phone_number: str = Field(..., min_length=2, max_length=64)
    name: Optional[str] = Field(default=None, max_length=200)

class LeadImportResponse(BaseModel):
    accepted: int = 0
    rejected: int = 0
    duplicates: int = 0
    errors: List[Dict[str, Any]] = Field(default_factory=list)
    error_csv: str = ""
    error_csv_truncated: bool = False
    warnings: List[Dict[str, Any]] = Field(default_factory=list)
    warnings_truncated: bool = False

class SalesBrainCampaignSyncRequest(BaseModel):
    source_number_id: Optional[str] = Field(None, max_length=100)
    start: bool = False
    sync_leads: bool = True
    max_concurrent: int = Field(1, ge=1, le=5)
    min_interval_seconds_between_calls: int = Field(10, ge=0, le=3600)

class SalesBrainCampaignStatusRequest(BaseModel):
    status: str = Field(..., pattern="^(running|paused|stopped)$")
    cancel_pending: bool = False

def _sales_brain_base_url() -> str:
    return (
        os.getenv("SALES_BRAIN_BASE_URL")
        or _dotenv_value("SALES_BRAIN_BASE_URL")
        or "http://127.0.0.1:3011"
    ).rstrip("/")

def _sales_brain_service_token() -> str:
    return (
        os.getenv("CRM_SERVICE_API_TOKEN")
        or _dotenv_value("CRM_SERVICE_API_TOKEN")
        or ""
    ).strip()

async def _require_sales_brain_service_token(
    authorization: Optional[str] = Header(default=None),
) -> None:
    expected = _sales_brain_service_token()
    if not expected:
        raise HTTPException(status_code=503, detail="CRM_SERVICE_API_TOKEN is not configured")
    scheme, _, token = str(authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not token or not hmac.compare_digest(token, expected):
        raise HTTPException(status_code=401, detail="Invalid service token")

async def _fetch_sales_brain_campaign_export(
    sales_campaign_id: str,
    request: SalesBrainCampaignSyncRequest,
) -> Dict[str, Any]:
    token = _sales_brain_service_token()
    if not token:
        raise HTTPException(status_code=503, detail="CRM_SERVICE_API_TOKEN is not configured")

    url = f"{_sales_brain_base_url()}/api/ml/outbound/campaigns/{sales_campaign_id}/ava-export"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    payload = {
        "sync_leads": request.sync_leads,
        "max_concurrent": request.max_concurrent,
        "min_interval_seconds_between_calls": request.min_interval_seconds_between_calls,
        "voicemail_drop_enabled": False,
        "consent_enabled": False,
    }
    try:
        timeout = aiohttp.ClientTimeout(total=15)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(url, headers=headers, json=payload) as response:
                data = await response.json(content_type=None)
                if response.status >= 400:
                    raise HTTPException(
                        status_code=502,
                        detail=f"Sales Brain export failed ({response.status}): {data.get('error') or data}",
                    )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Sales Brain is unavailable: {exc}")

    if not isinstance(data, dict) or data.get("success") is False:
        raise HTTPException(status_code=502, detail=str((data or {}).get("error") or "Invalid Sales Brain response"))
    return data

def _sales_brain_export_to_csv(export_data: Dict[str, Any]) -> bytes:
    output = io.StringIO()
    writer = csv.DictWriter(
        output,
        fieldnames=["name", "phone_number", "context", "timezone", "caller_id", "custom_vars"],
    )
    writer.writeheader()
    for lead in export_data.get("leads") or []:
        writer.writerow({
            "name": lead.get("name") or "",
            "phone_number": lead.get("phone_number") or "",
            "context": lead.get("context") or "",
            "timezone": lead.get("timezone") or "",
            "caller_id": lead.get("caller_id") or "",
            "custom_vars": json.dumps(lead.get("custom_vars") or {}, ensure_ascii=False),
        })
    return output.getvalue().encode("utf-8")

def _derive_sales_brain_business_id(export_data: Dict[str, Any]) -> Optional[int]:
    campaign = export_data.get("campaign") if isinstance(export_data.get("campaign"), dict) else {}
    for value in (
        campaign.get("business_id"),
        campaign.get("instance_id"),
        campaign.get("instanceId"),
        export_data.get("business_id"),
        export_data.get("instance_id"),
        export_data.get("instanceId"),
    ):
        try:
            if value not in (None, ""):
                return max(1, int(value))
        except Exception:
            pass

    for lead in export_data.get("leads") or []:
        if not isinstance(lead, dict):
            continue
        custom_vars = lead.get("custom_vars") if isinstance(lead.get("custom_vars"), dict) else {}
        for key in ("business_id", "instance_id", "instanceId", "sales_brain_instance_id"):
            try:
                value = custom_vars.get(key)
                if value not in (None, ""):
                    return max(1, int(value))
            except Exception:
                pass
    return None

@router.get("/sample.csv")
async def download_sample_csv():
    """
    Download a sample CSV for lead import.

    Columns supported by the importer (full format):
      - name (optional)
      - phone_number (required)
        - Can be E.164 (+15551234567) or an internal extension (e.g., 2765)
      - context (optional)
      - timezone (optional)
      - caller_id (optional)
      - custom_vars (optional JSON object)
    """
    csv_text = (
        "name,phone_number,context,timezone,caller_id,custom_vars\n"
        "Extension Test,2765,demo_outbound,America/Phoenix,6789,\"{\"\"name\"\":\"\"Extension Test\"\",\"\"note\"\":\"\"Call internal extension\"\"}\"\n"
        "Alice Example,+15557654321,demo_outbound,America/Phoenix,6789,\"{\"\"name\"\":\"\"Alice Example\"\",\"\"account_id\"\":\"\"A-1002\"\",\"\"note\"\":\"\"US lead example\"\"}\"\n"
        "International Example,+447700900123,demo_outbound,America/Phoenix,6789,\"{\"\"name\"\":\"\"International Example\"\",\"\"account_id\"\":\"\"A-1003\"\",\"\"note\"\":\"\"International lead example\"\"}\"\n"
    )
    return Response(
        content=csv_text,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="outbound_sample_leads.csv"'},
    )

@router.get("/campaigns")
async def list_campaigns(
    include_archived: bool = Query(False),
    business_id: Optional[int] = Query(None, ge=1, description="Filter by business/tenant"),
):
    store = _get_outbound_store()
    return await store.list_campaigns(include_archived=bool(include_archived), business_id=business_id)

@router.post("/campaigns")
async def create_campaign(req: CampaignCreateRequest):
    store = _get_outbound_store()
    payload = req.model_dump()
    try:
        if _truthy_flag(payload.get("voicemail_drop_enabled"), default=False) and not (payload.get("voicemail_drop_media_uri") or "").strip():
            if _media_uri_exists(DEFAULT_VOICEMAIL_MEDIA_URI):
                payload["voicemail_drop_media_uri"] = DEFAULT_VOICEMAIL_MEDIA_URI
        if _truthy_flag(payload.get("consent_enabled"), default=False) and not (payload.get("consent_media_uri") or "").strip():
            if _media_uri_exists(DEFAULT_CONSENT_MEDIA_URI):
                payload["consent_media_uri"] = DEFAULT_CONSENT_MEDIA_URI
    except Exception:
        pass
    return await store.create_campaign(payload)

@router.post("/sales-brain/campaigns/{sales_campaign_id}/sync")
async def sync_sales_brain_campaign(
    sales_campaign_id: str,
    req: SalesBrainCampaignSyncRequest,
):
    return await _sync_sales_brain_campaign(sales_campaign_id, req)

@internal_router.post(
    "/sales-brain/campaigns/{sales_campaign_id}/sync",
    dependencies=[Depends(_require_sales_brain_service_token)],
)
async def sync_sales_brain_campaign_internal(
    sales_campaign_id: str,
    req: SalesBrainCampaignSyncRequest,
):
    return await _sync_sales_brain_campaign(sales_campaign_id, req)

@internal_router.post(
    "/sales-brain/campaigns/{sales_campaign_id}/status",
    dependencies=[Depends(_require_sales_brain_service_token)],
)
async def set_sales_brain_campaign_status_internal(
    sales_campaign_id: str,
    req: SalesBrainCampaignStatusRequest,
):
    store = _get_outbound_store()
    campaign = await store.find_campaign_by_external("sales_brain", sales_campaign_id)
    if campaign is None:
        raise HTTPException(status_code=404, detail="AVA campaign is not synchronized")
    try:
        updated = await store.set_campaign_status(
            str(campaign["id"]),
            req.status,
            cancel_pending=bool(req.cancel_pending),
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {
        "success": True,
        "sales_brain_campaign_id": sales_campaign_id,
        "ava_campaign": updated,
    }


@internal_router.get(
    "/sales-brain/campaigns/{sales_campaign_id}/status",
    dependencies=[Depends(_require_sales_brain_service_token)],
)
async def get_sales_brain_campaign_status_internal(sales_campaign_id: str):
    """Read-only evidence for a lost CRM command ACK; never dispatch a call."""
    campaign = await _get_outbound_store().find_campaign_by_external("sales_brain", sales_campaign_id)
    if campaign is None:
        raise HTTPException(status_code=404, detail="AVA campaign is not synchronized")
    if campaign.get("external_source") != "sales_brain" or campaign.get("external_id") != sales_campaign_id:
        raise HTTPException(status_code=503, detail="Campaign status unavailable")
    return {
        "success": True,
        "sales_brain_campaign_id": sales_campaign_id,
        "ava_campaign": {key: campaign.get(key) for key in (
            "id", "business_id", "external_source", "external_id", "status", "source_number_id"
        )},
    }


@internal_router.get(
    "/sales-brain/campaigns/{sales_campaign_id}/attempts",
    dependencies=[Depends(_require_sales_brain_service_token)],
)
async def list_sales_brain_campaign_attempts_internal(
    sales_campaign_id: str,
    page: int = Query(1, ge=1, le=10000),
    page_size: int = Query(20, ge=1, le=50),
):
    """Read-only, tenant-checked bridge for the customer CRM's attempt history."""
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", sales_campaign_id):
        raise HTTPException(status_code=400, detail="Invalid campaign ID")

    store = _get_outbound_store()
    campaign = await store.find_campaign_by_external("sales_brain", sales_campaign_id)
    if campaign is None:
        raise HTTPException(status_code=404, detail="AVA campaign is not synchronized")
    try:
        business_id = int(campaign["business_id"])
        campaign_id = str(campaign["id"])
        if business_id < 1 or not campaign_id or campaign.get("external_source") != "sales_brain" or campaign.get("external_id") != sales_campaign_id:
            raise ValueError("invalid campaign scope")
        result = await store.list_attempts(campaign_id, page=page, page_size=page_size)
        rows = result["attempts"]
        if not isinstance(rows, list) or len(rows) > page_size:
            raise ValueError("invalid attempt page")
        from src.core.outbound_errors import sanitize_outbound_error

        attempts = []
        allowed = (
            "id", "campaign_id", "business_id", "name", "phone_number",
            "started_at_utc", "ended_at_utc", "duration_seconds", "provider",
            "call_id", "outcome", "amd_status", "consent_result", "error_stage",
            "error_code", "retryable", "error_message",
        )
        for row in rows:
            if not isinstance(row, dict) or str(row.get("campaign_id")) != campaign_id or int(row.get("business_id")) != business_id:
                raise ValueError("attempt scope mismatch")
            safe = {key: row.get(key) for key in allowed}
            safe["error_message"] = sanitize_outbound_error(row.get("error_message"), max_length=240) or None
            attempts.append(safe)
        total = int(result["total"])
        total_pages = int(result["total_pages"])
        if total < 0 or total_pages < 0 or int(result["page"]) != page or int(result["page_size"]) != page_size:
            raise ValueError("invalid pagination")
    except (KeyError, TypeError, ValueError, OverflowError):
        logger.error("Outbound attempt history scope or pagination validation failed")
        raise HTTPException(status_code=503, detail="Attempt history unavailable")

    return {
        "sales_brain_campaign_id": sales_campaign_id,
        "ava_campaign": {
            "id": campaign_id,
            "business_id": business_id,
            "external_source": "sales_brain",
            "external_campaign_id": sales_campaign_id,
        },
        "attempts": attempts,
        "total": total,
        "page": page,
        "page_size": page_size,
        "total_pages": total_pages,
    }

async def _sync_sales_brain_campaign(
    sales_campaign_id: str,
    req: SalesBrainCampaignSyncRequest,
):
    store = _get_outbound_store()
    export_data = await _fetch_sales_brain_campaign_export(sales_campaign_id, req)
    external_source = str(export_data.get("external_source") or "sales_brain")
    external_id = str(export_data.get("external_campaign_id") or sales_campaign_id)
    campaign_payload = dict(export_data.get("campaign") or {})
    if 'source_number_id' in req.model_fields_set:
        campaign_payload['source_number_id'] = req.source_number_id
    business_id = _derive_sales_brain_business_id(export_data)
    if business_id is not None:
        campaign_payload.setdefault("business_id", business_id)
        campaign_payload.setdefault("instance_id", business_id)
    campaign_payload.update({
        "external_source": external_source,
        "external_id": external_id,
    })

    campaign = await store.find_campaign_by_external(external_source, external_id)
    created = campaign is None
    if created:
        campaign = await store.create_campaign(campaign_payload)
    else:
        campaign = await store.update_campaign(str(campaign["id"]), campaign_payload)

    csv_bytes = _sales_brain_export_to_csv(export_data)
    import_result = await store.import_leads_csv(
        str(campaign["id"]),
        csv_bytes,
        skip_existing=False,
        max_error_rows=50,
        known_contexts=_load_known_context_names() or None,
    )

    if req.start and int(import_result.get("accepted") or 0) + int(import_result.get("duplicates") or 0) > 0:
        campaign = await store.set_campaign_status(str(campaign["id"]), "running", cancel_pending=False)

    return {
        "success": True,
        "created": created,
        "sales_brain_campaign_id": external_id,
        "ava_campaign": campaign,
        "import": import_result,
        "source_leads": len(export_data.get("leads") or []),
    }

@router.get("/campaigns/{campaign_id}")
async def get_campaign(campaign_id: str):
    store = _get_outbound_store()
    try:
        return await store.get_campaign(campaign_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Campaign not found")

@router.patch("/campaigns/{campaign_id}")
async def update_campaign(campaign_id: str, body: Dict[str, Any]):
    store = _get_outbound_store()
    try:
        return await store.update_campaign(campaign_id, body or {})
    except KeyError:
        raise HTTPException(status_code=404, detail="Campaign not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.post("/campaigns/{campaign_id}/clone")
async def clone_campaign(campaign_id: str):
    store = _get_outbound_store()
    try:
        return await store.clone_campaign(campaign_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Campaign not found")

@router.post("/campaigns/{campaign_id}/test-runs")
async def create_test_run(campaign_id: str, req: TestRunRequest):
    store = _get_outbound_store()
    try:
        return await store.create_test_campaign(
            campaign_id,
            req.phone_number,
            name=req.name,
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="Campaign not found")
    except RuntimeError as exc:
        if "active call" in str(exc).lower():
            raise HTTPException(status_code=409, detail=str(exc))
        raise HTTPException(status_code=400, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

@router.post("/campaigns/{campaign_id}/archive")
async def archive_campaign(campaign_id: str):
    store = _get_outbound_store()
    try:
        campaign = await store.get_campaign(campaign_id)
        if str(campaign.get("status") or "").strip().lower() == "running":
            raise HTTPException(status_code=400, detail="Pause/stop the campaign before archiving")
        return await store.set_campaign_status(campaign_id, "archived", cancel_pending=False)
    except KeyError:
        raise HTTPException(status_code=404, detail="Campaign not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.delete("/campaigns/{campaign_id}")
async def delete_campaign(campaign_id: str):
    store = _get_outbound_store()
    try:
        await store.delete_campaign(campaign_id)
        return {"ok": True}
    except KeyError:
        raise HTTPException(status_code=404, detail="Campaign not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.post("/campaigns/{campaign_id}/status")
async def set_campaign_status(campaign_id: str, req: CampaignStatusRequest):
    store = _get_outbound_store()
    try:
        if req.status.strip().lower() == "running":
            campaign = await store.get_campaign(campaign_id)
            stats = await store.campaign_stats(campaign_id)
            lead_states = (stats or {}).get("lead_states") or {}
            pending = int(lead_states.get("pending") or 0)
            if pending <= 0:
                canceled = int(lead_states.get("canceled") or 0)
                completed = int(lead_states.get("completed") or 0)
                raise HTTPException(
                    status_code=400,
                    detail=f"No pending leads to dial (canceled={canceled}, completed={completed}). Recycle leads back to pending, then Start again.",
                )
            if _truthy_flag(campaign.get("voicemail_drop_enabled"), default=False):
                media_uri = (campaign.get("voicemail_drop_media_uri") or "").strip()
                if not media_uri and _media_uri_exists(DEFAULT_VOICEMAIL_MEDIA_URI):
                    media_uri = DEFAULT_VOICEMAIL_MEDIA_URI
                    campaign = await store.update_campaign(campaign_id, {"voicemail_drop_media_uri": media_uri})
                if not media_uri:
                    raise HTTPException(
                        status_code=400,
                        detail="Voicemail drop is enabled but no voicemail recording is set. Upload/generate voicemail before starting.",
                    )
            if _truthy_flag(campaign.get("consent_enabled"), default=False):
                consent_uri = (campaign.get("consent_media_uri") or "").strip()
                if not consent_uri and _media_uri_exists(DEFAULT_CONSENT_MEDIA_URI):
                    consent_uri = DEFAULT_CONSENT_MEDIA_URI
                    campaign = await store.update_campaign(campaign_id, {"consent_media_uri": consent_uri})
                if not consent_uri:
                    raise HTTPException(
                        status_code=400,
                        detail="Consent gate is enabled but no consent recording is set. Upload consent before starting.",
                    )
            tz_name = (campaign.get("timezone") or "").strip() or "UTC"
            if ZoneInfo is not None and tz_name.upper() != "UTC":
                try:
                    ZoneInfo(tz_name)
                except Exception:
                    raise HTTPException(
                        status_code=400,
                        detail=f"Invalid timezone '{tz_name}'. Use an IANA timezone like 'America/Phoenix' or 'UTC'.",
                    )
        return await store.set_campaign_status(campaign_id, req.status, cancel_pending=bool(req.cancel_pending))
    except KeyError:
        raise HTTPException(status_code=404, detail="Campaign not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.get("/campaigns/{campaign_id}/stats")
async def campaign_stats(campaign_id: str):
    store = _get_outbound_store()
    return await store.campaign_stats(campaign_id)

@router.post("/campaigns/{campaign_id}/leads/import", response_model=LeadImportResponse)
async def import_leads(
    campaign_id: str,
    file: UploadFile = File(...),
    skip_existing: bool = Query(True),
    max_error_rows: int = Query(20, ge=1, le=200),
):
    store = _get_outbound_store()
    try:
        data = await file.read()
        known_contexts = _load_known_context_names()
        result = await store.import_leads_csv(
            campaign_id,
            data,
            skip_existing=bool(skip_existing),
            max_error_rows=int(max_error_rows),
            known_contexts=known_contexts or None,
        )
        return LeadImportResponse(**result)
    except KeyError:
        raise HTTPException(status_code=404, detail="Campaign not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.get("/campaigns/{campaign_id}/leads")
async def list_leads(
    campaign_id: str,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    state: Optional[str] = Query(None),
    q: Optional[str] = Query(None),
):
    store = _get_outbound_store()
    return await store.list_leads(campaign_id, page=page, page_size=page_size, state=state, q=q)

@router.post("/leads/{lead_id}/cancel")
async def cancel_lead(lead_id: str):
    store = _get_outbound_store()
    ok = await store.cancel_lead(lead_id)
    if not ok:
        raise HTTPException(status_code=400, detail="Lead cannot be canceled in its current state")
    return {"ok": True}

@router.post("/leads/{lead_id}/ignore")
async def ignore_lead(lead_id: str):
    store = _get_outbound_store()
    ok = await store.ignore_lead(lead_id)
    if not ok:
        raise HTTPException(status_code=400, detail="Lead cannot be ignored in its current state")
    return {"ok": True}

@router.post("/leads/{lead_id}/recycle")
async def recycle_lead(lead_id: str, req: LeadRecycleRequest):
    store = _get_outbound_store()
    ok = await store.recycle_lead(lead_id, mode=req.mode)
    if not ok:
        raise HTTPException(status_code=400, detail="Lead cannot be recycled in its current state")
    return {"ok": True}

@router.delete("/leads/{lead_id}")
async def delete_lead(lead_id: str):
    store = _get_outbound_store()
    try:
        await store.delete_lead(lead_id)
        return {"ok": True}
    except KeyError:
        raise HTTPException(status_code=404, detail="Lead not found")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.get("/campaigns/{campaign_id}/attempts")
async def list_attempts(
    campaign_id: str,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
):
    store = _get_outbound_store()
    return await store.list_attempts(campaign_id, page=page, page_size=page_size)

@router.post("/campaigns/{campaign_id}/voicemail/upload")
async def upload_voicemail_media(campaign_id: str, file: UploadFile = File(...)):
    store = _get_outbound_store()
    filename = (file.filename or "").strip() or "voicemail.ulaw"
    ext = os.path.splitext(filename)[1].lower().strip()
    if ext not in (".ulaw", ".wav"):
        raise HTTPException(status_code=400, detail="Upload must be .ulaw (8kHz μ-law) or .wav (PCM) audio")

    raw_name = os.path.basename(filename)
    if not _SAFE_NAME_RE.match(raw_name):
        raise HTTPException(status_code=400, detail="Invalid filename")

    media_dir = _media_dir()
    os.makedirs(media_dir, exist_ok=True)
    unique = f"outbound-vm-{uuid.uuid4().hex[:10]}.ulaw"
    path = os.path.join(media_dir, unique)
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty upload")
    max_bytes = _vm_upload_max_bytes()
    if len(data) > max_bytes:
        raise HTTPException(status_code=400, detail=f"Upload too large (max {max_bytes} bytes)")

    if ext == ".ulaw":
        ulaw_data = data
    else:
        try:
            with wave.open(io.BytesIO(data), "rb") as wavf:
                nch = wavf.getnchannels()
                sampwidth = wavf.getsampwidth()
                fr = wavf.getframerate()
                nframes = wavf.getnframes()
                frames = wavf.readframes(nframes)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Invalid WAV file: {e}")

        if nch not in (1, 2):
            raise HTTPException(status_code=400, detail="WAV must be mono or stereo (1–2 channels)")
        if sampwidth not in (1, 2, 3, 4):
            raise HTTPException(status_code=400, detail="Unsupported WAV sample width")

        if sampwidth != 2:
            frames = audioop.lin2lin(frames, sampwidth, 2)
        if nch == 2:
            frames = audioop.tomono(frames, 2, 0.5, 0.5)

        if fr != 8000:
            frames, _ = resample_audio(frames, fr, 8000)

        ulaw_data = audioop.lin2ulaw(frames, 2)

    with open(path, "wb") as f:
        f.write(ulaw_data)

    media_uri = f"sound:ai-generated/{unique[:-5]}"
    try:
        campaign = await store.update_campaign(campaign_id, {"voicemail_drop_media_uri": media_uri})
    except KeyError:
        raise HTTPException(status_code=404, detail="Campaign not found")
    return {"media_uri": media_uri, "campaign": campaign}

@router.post("/campaigns/{campaign_id}/consent/upload")
async def upload_consent_media(campaign_id: str, file: UploadFile = File(...)):
    store = _get_outbound_store()
    filename = (file.filename or "").strip() or "consent.ulaw"
    ext = os.path.splitext(filename)[1].lower().strip()
    if ext not in (".ulaw", ".wav"):
        raise HTTPException(status_code=400, detail="Upload must be .ulaw (8kHz μ-law) or .wav (PCM) audio")

    raw_name = os.path.basename(filename)
    if not _SAFE_NAME_RE.match(raw_name):
        raise HTTPException(status_code=400, detail="Invalid filename")

    media_dir = _media_dir()
    os.makedirs(media_dir, exist_ok=True)
    unique = f"outbound-consent-{uuid.uuid4().hex[:10]}.ulaw"
    path = os.path.join(media_dir, unique)
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty upload")
    max_bytes = _vm_upload_max_bytes()
    if len(data) > max_bytes:
        raise HTTPException(status_code=400, detail=f"Upload too large (max {max_bytes} bytes)")

    if ext == ".ulaw":
        ulaw_data = data
    else:
        try:
            with wave.open(io.BytesIO(data), "rb") as wavf:
                nch = wavf.getnchannels()
                sampwidth = wavf.getsampwidth()
                fr = wavf.getframerate()
                nframes = wavf.getnframes()
                frames = wavf.readframes(nframes)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Invalid WAV file: {e}")

        if nch not in (1, 2):
            raise HTTPException(status_code=400, detail="WAV must be mono or stereo (1–2 channels)")
        if sampwidth not in (1, 2, 3, 4):
            raise HTTPException(status_code=400, detail="Unsupported WAV sample width")

        if sampwidth != 2:
            frames = audioop.lin2lin(frames, sampwidth, 2)
        if nch == 2:
            frames = audioop.tomono(frames, 2, 0.5, 0.5)
        if fr != 8000:
            frames, _ = resample_audio(frames, fr, 8000)
        ulaw_data = audioop.lin2ulaw(frames, 2)

    with open(path, "wb") as f:
        f.write(ulaw_data)

    media_uri = f"sound:ai-generated/{unique[:-5]}"
    try:
        campaign = await store.update_campaign(campaign_id, {"consent_media_uri": media_uri})
    except KeyError:
        raise HTTPException(status_code=404, detail="Campaign not found")
    return {"media_uri": media_uri, "campaign": campaign}

@router.get("/campaigns/{campaign_id}/voicemail/preview.wav")
async def preview_voicemail_wav(campaign_id: str):
    store = _get_outbound_store()
    try:
        campaign = await store.get_campaign(campaign_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Campaign not found")

    media_uri = (campaign.get("voicemail_drop_media_uri") or "").strip()
    ulaw_data = _read_media_ulaw(media_uri)

    wav_bytes = _ulaw_to_wav_bytes(ulaw_data)
    return Response(content=wav_bytes, media_type="audio/wav")

@router.get("/campaigns/{campaign_id}/consent/preview.wav")
async def preview_consent_wav(campaign_id: str):
    store = _get_outbound_store()
    try:
        campaign = await store.get_campaign(campaign_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Campaign not found")

    media_uri = (campaign.get("consent_media_uri") or "").strip()
    ulaw_data = _read_media_ulaw(media_uri)

    wav_bytes = _ulaw_to_wav_bytes(ulaw_data)
    return Response(content=wav_bytes, media_type="audio/wav")
