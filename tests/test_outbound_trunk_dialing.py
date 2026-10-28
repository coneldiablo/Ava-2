import pytest

from src.engine import Engine


class FakeARI:
    def __init__(self, existing_endpoints=None):
        self.existing_endpoints = set(existing_endpoints or [])
        self.requests = []

    async def send_command(self, method, path, tolerate_statuses=None, **kwargs):
        self.requests.append((method, path))
        if path in self.existing_endpoints:
            tech, endpoint = path.split("/", 2)[1:]
            return {"technology": tech, "resource": endpoint, "state": "online"}
        return {"status": 404}


def make_engine(existing_endpoints=None):
    engine = Engine.__new__(Engine)
    engine.ari_client = FakeARI(existing_endpoints=existing_endpoints)
    engine._outbound_dial_context = "from-internal"
    engine._outbound_dial_prefix = ""
    engine._outbound_channel_tech = "auto"
    engine._outbound_pjsip_endpoint_cache = {}
    engine._outbound_pjsip_endpoint_cache_ttl_seconds = 300
    engine._outbound_trunk_endpoint = "mts-exolve-9285348831"
    engine._outbound_trunk_tech = "PJSIP"
    engine._outbound_internal_extension_pattern = r"^[1-9][0-9]{2,5}$"
    return engine


@pytest.mark.asyncio
async def test_external_phone_dials_direct_trunk_after_endpoint_probe_miss():
    engine = make_engine()

    endpoint = await engine._outbound_choose_endpoint("79285348831")

    assert endpoint == "PJSIP/79285348831@mts-exolve-9285348831"
    assert ("GET", "endpoints/PJSIP/79285348831") in engine.ari_client.requests
    assert ("GET", "endpoints/SIP/79285348831") in engine.ari_client.requests


@pytest.mark.asyncio
async def test_internal_extension_prefers_existing_pjsip_endpoint():
    engine = make_engine(existing_endpoints={"endpoints/PJSIP/6003"})

    endpoint = await engine._outbound_choose_endpoint("6003")

    assert endpoint == "PJSIP/6003"


@pytest.mark.asyncio
async def test_missing_internal_extension_falls_back_to_local_not_trunk():
    engine = make_engine()

    endpoint = await engine._outbound_choose_endpoint("6004")

    assert endpoint == "Local/6004@from-internal"


@pytest.mark.asyncio
async def test_feature_code_falls_back_to_local_not_trunk():
    engine = make_engine()

    endpoint = await engine._outbound_choose_endpoint("*43")

    assert endpoint == "Local/*43@from-internal"
