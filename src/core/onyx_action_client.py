"""Restricted transport from the Onyx policy gateway to AVA's service API.

No URL, authorization header or tenant field is accepted from agent arguments.
The service token remains in AVA; redirects are forbidden to avoid forwarding it.
"""

import json
import os
import urllib.error
import urllib.parse
import urllib.request

from src.core.onyx_client import redact_onyx_error


class AvaActionError(RuntimeError):
    def __init__(self, message, code="AVA_ACTION_FAILED"):
        super().__init__(redact_onyx_error(message))
        self.code = code


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class AvaActionClient:
    PATHS = {
        "/pms/lookup-booking", "/pms/check-availability", "/manager-task",
        "/stage/update", "/followup/approve", "/followup/send", "/followup/draft",
    }

    def post(self, path, business_id, payload):
        if path not in self.PATHS:
            raise AvaActionError("Unsupported AVA action endpoint", "AVA_ENDPOINT_FORBIDDEN")
        base = (os.getenv("SALES_BRAIN_BASE_URL") or os.getenv("WHATSAPP_CRM_BASE_URL")
                or "http://127.0.0.1:3011").rstrip("/")
        parsed = urllib.parse.urlsplit(base)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise AvaActionError("Invalid AVA service URL", "AVA_URL_INVALID")
        token = os.getenv("SALES_BRAIN_API_TOKEN") or os.getenv("CRM_SERVICE_API_TOKEN")
        if not token:
            raise AvaActionError("AVA service token is not configured", "AVA_TOKEN_MISSING")
        body = {**payload, "business_id": business_id, "instance_id": business_id, "instanceId": business_id}
        request = urllib.request.Request(
            f"{base}/api/ml{path}", method="POST",
            data=json.dumps(body, ensure_ascii=False, allow_nan=False).encode(),
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json", "Accept": "application/json"},
        )
        try:
            with urllib.request.build_opener(_NoRedirect()).open(request, timeout=15) as response:
                raw = response.read(256 * 1024 + 1)
                if len(raw) > 256 * 1024:
                    raise AvaActionError("AVA response exceeded size limit", "AVA_RESPONSE_TOO_LARGE")
                result = json.loads(raw)
        except urllib.error.HTTPError as error:
            # Do not retain upstream bodies: they may include raw provider responses.
            raise AvaActionError(f"AVA service returned HTTP {error.code}", f"AVA_HTTP_{error.code}") from None
        except (OSError, urllib.error.URLError, TimeoutError) as error:
            raise AvaActionError("AVA service unavailable; action outcome needs reconciliation", "AVA_TRANSPORT_UNCERTAIN") from error
        except (ValueError, UnicodeError) as error:
            raise AvaActionError("Invalid AVA service response", "AVA_INVALID_RESPONSE") from error
        if not isinstance(result, dict):
            raise AvaActionError("Invalid AVA service response", "AVA_INVALID_RESPONSE")
        if result.get("success") is False:
            raise AvaActionError(result.get("error") or result.get("status") or "AVA action rejected", "AVA_ACTION_REJECTED")
        for field in ("business_id", "instance_id", "instanceId"):
            if field in result and str(result[field]) != str(business_id):
                raise AvaActionError("AVA response tenant mismatch", "AVA_RESPONSE_SCOPE_MISMATCH")
        return result
