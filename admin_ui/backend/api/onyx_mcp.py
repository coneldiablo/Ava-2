"""Stateless Streamable HTTP MCP, separately authenticated from browser JWTs."""
import asyncio
import json
import logging
import os

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response

from src.core.onyx_mcp_bridge import OnyxMcpBridge, OnyxMcpError
from src.core.onyx_policy_gateway import PolicyGatewayError

router = APIRouter(prefix='/api/integrations/onyx', tags=['onyx'])
logger = logging.getLogger(__name__)
MAX_BODY_BYTES = 64 * 1024
PROTOCOL_VERSION = '2025-06-18'


def _response(body, status=200):
    return JSONResponse(body, status_code=status, headers={'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'})


def _rpc_error(request_id, code, message, status=200):
    return _response({'jsonrpc': '2.0', 'id': request_id, 'error': {'code': code, 'message': message}}, status)


@router.api_route('/mcp', methods=['POST', 'GET', 'DELETE'])
async def handle_mcp(request: Request):
    origin = request.headers.get('origin')
    allowed_origins = {item.strip() for item in os.getenv('ONYX_MCP_ALLOWED_ORIGINS', '').split(',') if item.strip()}
    if origin is not None and origin not in allowed_origins:
        return _response({'error': 'ONYX_MCP_ORIGIN_FORBIDDEN'}, 403)
    bridge = OnyxMcpBridge()
    try:
        discovery_hash = await asyncio.to_thread(bridge.authenticate_discovery, request.headers.get('authorization'))
    except OnyxMcpError as error:
        return _response({'error': error.code}, error.status)
    if request.method != 'POST':
        return Response(status_code=405, headers={'Allow': 'POST', 'Cache-Control': 'no-store'})
    version = request.headers.get('mcp-protocol-version')
    if version and version not in {'2025-03-26', PROTOCOL_VERSION}:
        return _response({'error': 'ONYX_MCP_PROTOCOL_UNSUPPORTED'}, 400)
    accept = request.headers.get('accept', '')
    if 'application/json' not in accept or 'text/event-stream' not in accept:
        return _response({'error': 'ONYX_MCP_ACCEPT_REQUIRED'}, 406)
    if request.headers.get('content-type', '').split(';')[0].strip() != 'application/json':
        return _response({'error': 'ONYX_MCP_JSON_REQUIRED'}, 415)
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > MAX_BODY_BYTES:
            return _response({'error': 'ONYX_MCP_BODY_LIMIT'}, 413)
    try:
        message = json.loads(body)
    except (ValueError, UnicodeError):
        return _rpc_error(None, -32700, 'Parse error', 400)
    if (not isinstance(message, dict) or message.get('jsonrpc') != '2.0'
            or not isinstance(message.get('method'), str)):
        return _rpc_error(None, -32600, 'Invalid request', 400)
    request_id = message.get('id')
    method, params = message['method'], message.get('params', {})
    if 'id' not in message:
        if method in {'notifications/initialized', 'notifications/cancelled'}:
            return Response(status_code=202, headers={'Cache-Control': 'no-store'})
        return _rpc_error(None, -32600, 'Invalid notification', 400)
    if type(request_id) not in (int, str) or isinstance(request_id, str) and len(request_id) > 200:
        return _rpc_error(None, -32600, 'Invalid request ID', 400)
    if not isinstance(params, dict):
        return _rpc_error(request_id, -32602, 'Invalid params')
    if method == 'initialize':
        result = {'protocolVersion': PROTOCOL_VERSION, 'capabilities': {'tools': {'listChanged': False}},
                  'serverInfo': {'name': 'ava-policy-gateway', 'version': '1.0.0'},
                  'instructions': 'Tools are read-only. Data access needs a separate short-lived AVA execution capability; discovery credentials alone cannot access hotel or customer data.'}
    elif method == 'ping':
        result = {}
    elif method == 'tools/list':
        result = bridge.list_tools()
    elif method == 'tools/call':
        if set(params)-{'name','arguments','_meta'} or not isinstance(params.get('name'), str):
            return _rpc_error(request_id, -32602, 'Invalid tool params')
        try:
            data = await asyncio.to_thread(bridge.call_tool, discovery_hash=discovery_hash,
                execution_token=request.headers.get('x-ava-execution'), name=params['name'],
                arguments=params.get('arguments', {}), request_id=request_id)
            result = {'content': [{'type': 'text', 'text': json.dumps(data, ensure_ascii=False)}],
                      'structuredContent': data, 'isError': False}
        except (OnyxMcpError, PolicyGatewayError) as error:
            logger.info('Onyx MCP request rejected code=%s', error.code)
            result = {'content': [{'type': 'text', 'text': json.dumps({'error_code': error.code})}], 'isError': True}
        except Exception:
            logger.warning('Onyx MCP request failed code=ONYX_MCP_INTERNAL_ERROR')
            result = {'content': [{'type': 'text', 'text': '{"error_code":"ONYX_MCP_INTERNAL_ERROR"}'}], 'isError': True}
    else:
        return _rpc_error(request_id, -32601, 'Method not found')
    return _response({'jsonrpc': '2.0', 'id': request_id, 'result': result})
