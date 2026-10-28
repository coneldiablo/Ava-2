"""Small production client for the Onyx v4 public API.

The client intentionally exposes only the ingestion operations AVA needs.  It
never accepts a raw API key from a request: credentials are resolved from an
environment-variable reference stored in the tenant link.
"""

from __future__ import annotations

import asyncio
import json
import os
from contextlib import closing
import re
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Dict, Optional


RETRYABLE_HTTP_STATUSES = {408, 409, 425, 429, 500, 502, 503, 504}
_ENV_REF_RE = re.compile(r"^[A-Z][A-Z0-9_]{2,127}$")


def redact_onyx_error(value: Any, limit: int = 500) -> str:
    text = str(value or "Onyx request failed")
    text = re.sub(r"\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+", r"\1 [REDACTED]", text, flags=re.I)
    text = re.sub(r"(https?://)[^\s/@]+:[^\s/@]+@", r"\1[REDACTED]@", text, flags=re.I)
    text = re.sub(
        r"(\b(?:token|password|secret|api[_-]?key)\b[\"']?\s*[:=]\s*)(?:\"[^\"]*\"|'[^']*'|[^\s&,;]+)",
        r"\1[REDACTED]", text, flags=re.I,
    )
    text = re.sub(
        r"([?&](?:token|password|secret|api[_-]?key)=)[^&\s]+",
        r"\1[REDACTED]",
        text,
        flags=re.I,
    )
    for name, secret in os.environ.items():
        if secret and len(secret) >= 8 and any(marker in name.upper() for marker in ("TOKEN", "SECRET", "PASSWORD", "API_KEY")):
            text = text.replace(secret, "[REDACTED]")
    return text[:limit]


class OnyxClientError(RuntimeError):
    def __init__(self, message: str, *, code: str, status_code: int = 503, retryable: bool = False):
        super().__init__(redact_onyx_error(message))
        self.code = code
        self.status_code = status_code
        self.retryable = retryable


def normalize_onyx_base_url(value: str) -> str:
    raw = str(value or "").strip().rstrip("/")
    parsed = urllib.parse.urlsplit(raw)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise OnyxClientError(
            "Onyx base URL must be a valid HTTP(S) URL",
            code="ONYX_BASE_URL_INVALID",
            status_code=400,
        )
    if parsed.username or parsed.password:
        raise OnyxClientError(
            "Credentials in the Onyx URL are forbidden",
            code="ONYX_URL_CREDENTIALS_FORBIDDEN",
            status_code=400,
        )
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rstrip("/"), "", ""))


def normalize_credential_ref(value: str) -> str:
    reference = str(value or "").strip()
    if reference.startswith("env:"):
        reference = reference[4:]
    if not _ENV_REF_RE.fullmatch(reference):
        raise OnyxClientError(
            "Onyx credential_ref must name an environment variable",
            code="ONYX_CREDENTIAL_REF_INVALID",
            status_code=400,
        )
    return reference


def resolve_api_key(credential_ref: str, db_path: Optional[str] = None) -> str:
    reference = normalize_credential_ref(credential_ref)
    managed = bool(re.fullmatch(r'ONYX_API_KEY_HOTEL_\d+', reference))
    if not managed:
        legacy = str(os.getenv(reference) or '').strip()
        if legacy and not legacy.startswith('sk-onyx-tenant-'):
            return legacy
        raise OnyxClientError('Onyx credential is not configured', code='ONYX_CREDENTIAL_MISSING', status_code=503)
    # Managed credentials are checked on every request without env fallback.
    # A revoked/deleted managed row must never revive an old cached key.
    try:
        from src.core.onyx_db import get_db_connection
        with closing(get_db_connection(db_path, readonly=True)) as conn:
            exists = conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='onyx_tenant_credentials'").fetchone()
            row = conn.execute(
                "SELECT * FROM onyx_tenant_credentials WHERE env_ref = ?",
                (reference,),
            ).fetchone() if exists else None
            if row is not None:
                active = conn.execute('SELECT isActive FROM instances WHERE id=?', (row['business_id'],)).fetchone()
                if active is None or not active['isActive']:
                    raise ValueError('Business unavailable')
        if row is not None:
            import base64
            from cryptography.hazmat.primitives.ciphers.aead import AESGCM
            data = dict(row)
            if not data.get('enabled') or not data.get('token_encrypted'):
                raise ValueError('Managed credential unavailable')
            business_id = int(data['business_id'])
            if reference != f'ONYX_API_KEY_HOTEL_{business_id}':
                raise ValueError('Credential scope mismatch')
            raw_key = os.getenv('ONYX_CREDENTIALS_MASTER_KEY', '').strip()
            key = bytes.fromhex(raw_key) if re.fullmatch(r'[a-fA-F0-9]{64}', raw_key) else base64.b64decode(raw_key, validate=True)
            version, iv, tag, ciphertext = data['token_encrypted'].split('.')
            if version != 'v2' or len(key) != 32:
                raise ValueError('Invalid credential format')
            decode = lambda value: base64.urlsafe_b64decode(value + '=' * (-len(value) % 4))
            return AESGCM(key).decrypt(decode(iv), decode(ciphertext) + decode(tag),
                f'ava:onyx:{business_id}:{reference}:v2'.encode()).decode()
    except Exception:
        raise OnyxClientError('Managed Onyx credential cannot be resolved',
            code='ONYX_CREDENTIALS_INVALID', status_code=503) from None

    raise OnyxClientError(
        "Managed Onyx credential is not configured",
        code="ONYX_CREDENTIAL_MISSING",
        status_code=503,
    )


@dataclass(frozen=True)
class OnyxResponse:
    status_code: int
    body: Any


class OnyxClient:
    def __init__(
        self,
        *,
        base_url: str,
        credential_ref: str,
        cc_pair_id: int,
        timeout_seconds: float = 20.0,
    ) -> None:
        self.base_url = normalize_onyx_base_url(base_url)
        self.credential_ref = normalize_credential_ref(credential_ref)
        self.cc_pair_id = int(cc_pair_id or 0)
        if self.cc_pair_id < 1:
            raise OnyxClientError(
                "A dedicated Onyx cc_pair_id is required for tenant isolation",
                code="ONYX_CC_PAIR_REQUIRED",
                status_code=400,
            )
        self.timeout_seconds = max(1.0, min(float(timeout_seconds), 60.0))

    def _url(self, path: str) -> str:
        return f"{self.base_url}/{path.lstrip('/')}"

    def _request_sync(self, method: str, path: str, payload: Optional[Dict[str, Any]] = None) -> OnyxResponse:
        api_key = resolve_api_key(self.credential_ref)
        body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            self._url(path),
            data=body,
            method=method.upper(),
            headers={
                "Authorization": f"Bearer {api_key}",
                "Accept": "application/json",
                "Content-Type": "application/json",
                "User-Agent": "AVA-Onyx-Bridge/1.0",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                raw = response.read(2 * 1024 * 1024)
                parsed = json.loads(raw.decode("utf-8")) if raw else None
                return OnyxResponse(status_code=int(response.status), body=parsed)
        except urllib.error.HTTPError as error:
            raw = error.read(64 * 1024).decode("utf-8", errors="replace")
            status = int(error.code or 500)
            if status == 401:
                code = "ONYX_UNAUTHORIZED"
            elif status == 403:
                code = "ONYX_FORBIDDEN"
            elif status == 404:
                code = "ONYX_NOT_FOUND"
            elif status == 429:
                code = "ONYX_RATE_LIMITED"
            elif status >= 500:
                code = "ONYX_UPSTREAM_UNAVAILABLE"
            else:
                code = "ONYX_REQUEST_REJECTED"
            raise OnyxClientError(
                raw or error.reason,
                code=code,
                status_code=status,
                retryable=status in RETRYABLE_HTTP_STATUSES,
            ) from None
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise OnyxClientError(
                error,
                code="ONYX_NETWORK_ERROR",
                status_code=503,
                retryable=True,
            ) from None
        except (UnicodeError, json.JSONDecodeError) as error:
            raise OnyxClientError(
                error,
                code="ONYX_INVALID_RESPONSE",
                status_code=502,
                retryable=True,
            ) from None

    async def request(self, method: str, path: str, payload: Optional[Dict[str, Any]] = None) -> OnyxResponse:
        return await asyncio.to_thread(self._request_sync, method, path, payload)

    async def test_connection(self) -> Dict[str, Any]:
        # /me validates the key.  The cc-pair call also proves that the scoped
        # key may access the exact ingestion boundary assigned to this hotel.
        user = await self.request("GET", "/me")
        pair = await self.request("GET", f"/manage/admin/cc-pair/{self.cc_pair_id}")
        return {"authenticated": True, "user": user.body, "cc_pair": pair.body}

    async def upsert_document(self, event: Dict[str, Any]) -> Dict[str, Any]:
        payload = json.loads(event.get("payload_json") or "{}")
        business_id = int(event["business_id"])
        external_id = str(payload.get("external_id") or f"ava:{business_id}:{event['entity_type']}:{event['source_id']}")
        content = str(payload.get("content") or "").strip()
        if not content:
            raise OnyxClientError(
                "Onyx ingestion payload has no content",
                code="ONYX_DOCUMENT_EMPTY",
                status_code=422,
            )
        source_url = str(payload.get("source_url") or f"/hotels/{business_id}/knowledge-base")
        metadata = {
            "business_id": str(business_id),
            "ava_entity_type": str(event["entity_type"]),
            "ava_source_id": str(event["source_id"]),
            "ava_content_hash": str(payload.get("content_hash") or ""),
        }
        for key, value in (payload.get("metadata") or {}).items():
            if key in {"business_id", "source_id", "source", "version", "mime_type"}:
                metadata[str(key)] = str(value)
        response = await self.request("POST", "/onyx-api/ingestion", {
            "document": {
                "id": external_id,
                "sections": [{"type": "text", "text": content, "link": source_url}],
                "source": "ingestion_api",
                "semantic_identifier": str(payload.get("title") or external_id)[:500],
                "title": str(payload.get("title") or external_id)[:500],
                "metadata": metadata,
                "from_ingestion_api": True,
            },
            "cc_pair_id": self.cc_pair_id,
        })
        result = response.body if isinstance(response.body, dict) else {}
        return {
            "status": "ok",
            "document_id": str(result.get("document_id") or external_id),
            "already_existed": bool(result.get("already_existed")),
        }

    async def delete_document(self, document_id: str) -> Dict[str, Any]:
        # Onyx stores ingestion IDs URL-normalized (for example ``ava%3A1``).
        # The path router decodes one layer before the lookup, so encode the
        # normalized storage ID once more.  Unquoting first keeps this
        # idempotent when a caller supplies the ID returned by Onyx itself.
        storage_id = urllib.parse.quote(urllib.parse.unquote(str(document_id)), safe="")
        encoded = urllib.parse.quote(storage_id, safe="")
        await self.request("DELETE", f"/onyx-api/ingestion/{encoded}")
        return {"status": "ok", "document_id": str(document_id), "deleted": True}

    async def apply_outbox_event(self, event: Dict[str, Any]) -> Dict[str, Any]:
        if str(event.get("operation") or "").upper() == "DELETE":
            payload = json.loads(event.get("payload_json") or "{}")
            document_id = payload.get("external_id") or f"ava:{event['business_id']}:{event['entity_type']}:{event['source_id']}"
            return await self.delete_document(str(document_id))
        return await self.upsert_document(event)
