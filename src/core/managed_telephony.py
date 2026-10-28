"""Private CRM routing/quotas. Provider credentials never enter the engine."""
import asyncio
import os
import math
import re
from urllib.parse import quote

import aiohttp


class TelephonyUnavailable(RuntimeError):
    def __init__(self, code="TELEPHONY_UNAVAILABLE"):
        self.code = code if re.fullmatch(r"TELEPHONY_[A-Z_]+", str(code)) else "TELEPHONY_UNAVAILABLE"
        super().__init__(self.code)


def recording_filename(business_id, channel_id):
    """The only managed filename format accepted by engine and recording API."""
    if (type(business_id) is not int or business_id < 1 or not isinstance(channel_id, str)
            or not re.fullmatch(r'[a-zA-Z0-9_.-]{1,200}', channel_id)):
        raise TelephonyUnavailable('TELEPHONY_RECORDING_FAILED')
    return f'ava-{business_id}-{channel_id}.wav'


class ManagedTelephony:
    def __init__(self, base_url=None, token=None):
        self.base_url = (base_url or os.getenv("SALES_BRAIN_BASE_URL") or os.getenv("WHATSAPP_CRM_BASE_URL") or "").rstrip("/")
        self.token = token or os.getenv("CRM_SERVICE_API_TOKEN") or os.getenv("WHATSAPP_CRM_API_TOKEN")

    async def request(self, method, path, body=None):
        if not self.base_url or not self.token:
            raise TelephonyUnavailable("TELEPHONY_ENGINE_NOT_CONFIGURED")
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=2)) as http:
                async with http.request(method, self.base_url + "/api/internal/telephony" + path,
                                        json=body, headers={"Authorization": "Bearer " + self.token}, allow_redirects=False) as response:
                    data = await response.json()
                    if response.status != 200 or data.get("success") is not True:
                        raise TelephonyUnavailable(data.get("code"))
                    return data
        except TelephonyUnavailable:
            raise
        except Exception:
            raise TelephonyUnavailable() from None

    async def resolve(self, number):
        normalized = str(number or '').lstrip('+')
        if re.fullmatch(r'8\d{10}', normalized):
            normalized = '7' + normalized[1:]
        if re.fullmatch(r'\d{10}', normalized):
            normalized = '7' + normalized
        if not re.fullmatch(r'7\d{10}', normalized):
            raise TelephonyUnavailable('TELEPHONY_DID_UNAVAILABLE')
        data = await self.request("GET", "/resolve/" + quote(normalized, safe=""))
        if (type(data.get('businessId')) is not int or data['businessId'] < 1
                or data.get('number') != normalized
                or not isinstance(data.get('contextName'), str) or not data['contextName'].strip()
                or (data.get('phoneId') is not None and not _phone_id(data['phoneId']))):
            raise TelephonyUnavailable('TELEPHONY_ROUTE_INVALID')
        if not data.get('phoneId') and data.get('legacy') is not True:
            raise TelephonyUnavailable('TELEPHONY_ROUTE_INVALID')
        return data

    async def source(self, business_id, phone_id=None):
        query = "?sourceNumberId=" + quote(str(phone_id), safe="") if phone_id else ""
        data = await self.request("GET", f"/source/{int(business_id)}" + query)
        if data.get('managed') is False and not phone_id:
            return data
        if (data.get('managed') is not True or not _phone_id(data.get('phoneId'))
                or (phone_id and data['phoneId'] != phone_id)
                or data.get('endpoint') != 'ava-phone-' + data['phoneId'].replace('-', '')
                or not re.fullmatch(r'7\d{10}', str(data.get('number') or ''))):
            raise TelephonyUnavailable('TELEPHONY_SOURCE_UNAVAILABLE')
        return data

    async def reserve(self, business_id, call_id, *, source_id=None, number=None, direction="outbound"):
        data = await self.request("POST", "/calls/reserve", {"businessId": int(business_id), "callId": str(call_id),
                                  "sourceId": source_id, "number": number, "direction": direction})
        if direction == 'outbound' and (data.get('managed') is not True or data.get('phoneId') != source_id
                or type(data.get('maxSeconds')) is not int or not 1 <= data['maxSeconds'] <= 300):
            raise TelephonyUnavailable('TELEPHONY_RESERVATION_INVALID')
        return data

    async def finish(self, business_id, call_id, seconds, channel_id=None):
        # Failed settlement keeps the durable reservation. Host reconciliation
        # clears it only after it proves there are no remaining channels.
        seconds = float(seconds)
        if not math.isfinite(seconds):
            return None
        for attempt in range(3):
            try:
                return await self.request("POST", "/calls/" + quote(str(call_id), safe="") + "/finish",
                                          {"businessId": int(business_id), "seconds": max(0, seconds), "channelId": channel_id})
            except TelephonyUnavailable:
                if attempt == 2:
                    return None
                await asyncio.sleep(0.2 * (attempt + 1))


def _phone_id(value):
    return isinstance(value, str) and re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', value)


async def set_required_variable(ari, channel_id, name, value):
    try:
        result = await ari.send_command('POST', f'channels/{channel_id}/variable', data={'variable': name, 'value': value})
        return isinstance(result, dict) and int(result.get('status') or 204) < 300
    except Exception:
        return False


async def enforce_duration(ari, channel_id, seconds):
    """Deadline belongs to the real Asterisk channel, survives transfers and engine restarts."""
    try:
        result = await set_required_variable(ari, channel_id, "TIMEOUT(absolute)", str(max(1, min(300, int(seconds)))))
    except Exception:
        raise TelephonyUnavailable('TELEPHONY_DEADLINE_FAILED') from None
    if not result:
        raise TelephonyUnavailable('TELEPHONY_DEADLINE_FAILED')
