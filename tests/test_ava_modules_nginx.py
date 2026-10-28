"""Routing checks for the public Onyx/Twenty module vhost."""

import re
from pathlib import Path


CONF = Path(__file__).resolve().parents[1] / "deploy/nginx/ava-modules.conf"


def _locations():
    config = CONF.read_text()
    https_server = config.split("server {", 2)[2]
    assert "listen 443 ssl;" in https_server
    locations = []
    for match in re.finditer(r"\blocation\s+(=|~)?\s*(\S+)\s*\{", https_server):
        depth = 1
        end = match.end()
        while depth:
            depth += (https_server[end] == "{") - (https_server[end] == "}")
            end += 1
        locations.append((match.group(1), match.group(2), https_server[match.end() : end - 1]))
    return https_server, locations


def _location_for(path, locations):
    for kind, pattern, body in locations:
        if kind == "=" and path == pattern:
            return body
    for kind, pattern, body in locations:
        if kind == "~" and re.search(pattern, path):
            return body
    return max(
        ((pattern, body) for kind, pattern, body in locations if kind is None and path.startswith(pattern)),
        key=lambda item: len(item[0]),
    )[1]


def test_only_live_onyx_streams_disable_edge_buffering():
    _, locations = _locations()
    streams = [
        "/api/chat/send-chat-message",
        "/api/chat/chat-session/123/resume-stream",
        "/api/voice/synthesize",
        "/api/image-generation/generate",
        "/api/build/sessions/123/scheduled-run-events",
        "/api/build/sessions/123/subagents/456/send-message",
        "/api/build/sessions/123/turns/456/events",
        "/api/build/debug/opencode-logs/stream",
    ]
    buffered = [
        "/", "/app", "/static/app.js", "/api/chat/get-user-chat-sessions",
        "/api/chat/file/image.png", "/api/build/sessions/123/send-message",
        "/api/build/sessions/123/artifacts", "/api/manage/users/download",
        "/api/knowledge/stream", "/graphql/stream", "/graphql",
    ]
    for path in streams:
        assert "proxy_buffering off;" in _location_for(path, locations), path
    for path in buffered:
        assert "proxy_buffering on;" in _location_for(path, locations), path


def test_stream_locations_retain_proxy_and_crm_redirect():
    https_server, locations = _locations()
    assert "crm.meludtech.tech http://127.0.0.1:3000;" in CONF.read_text()
    assert "knowledge.meludtech.tech http://127.0.0.1:3080;" in CONF.read_text()
    assert "proxy_set_header X-Forwarded-For $remote_addr;" in https_server
    assert "proxy_set_header Upgrade $http_upgrade;" in https_server
    for _, _, body in locations:
        assert "proxy_pass $ava_module_backend;" in body
        assert "if ($ava_crm_legacy_ui_redirect)" in body
        assert "return 307 https://app.crm.meludtech.tech$request_uri;" in body
