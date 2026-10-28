"""Probe the actual pinned Onyx main router and AVA guard in an empty QA DB.

No native handler or authentication dependency is replaced. ASGI lifespan is
not started: indexing/model startup, UI, network TLS and guest answers remain
separate acceptance gates. This probe cannot run against production IDs.
"""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import secrets
import tempfile
import time
import traceback
import uuid

from .core import Config, Denied, Service, Store, Unavailable, read_secret
from .native import CommunityOnyx


async def probe() -> dict:
    if os.environ.get('AVA_NATIVE_QA') != 'true' or int(os.environ['AVA_BUSINESS_ID']) not in (900001, 900002):
        raise Denied()
    config = Config(int(os.environ['AVA_BUSINESS_ID']), os.environ['AVA_DEPLOYMENT_ID'],
                    os.environ['AVA_DEPLOYMENT_NAMESPACE'], read_secret(os.environ['AVA_AUTH_ENCRYPTION_KEY_FILE'], key=True))
    # The real /me handler uses the synchronous native DB engine normally
    # initialized by lifespan. Start that engine only, with a small QA pool;
    # indexing/model/background startup remains deliberately out of scope.
    from onyx.db.engine.sql_engine import SqlEngine
    SqlEngine.init_engine(pool_size=2, max_overflow=0)
    native = CommunityOnyx()
    with tempfile.TemporaryDirectory(prefix='ava-native-main-qa-') as directory:
        root = Path(directory)
        gateway = secrets.token_urlsafe(32)
        gateway_file = root / 'gateway.key'
        gateway_file.write_text(gateway)
        gateway_file.chmod(0o600)
        store = Store(root / 'state.sqlite', config)
        service = Service(store, native)
        user = {'businessId': config.business_id, 'deploymentId': config.deployment_id, 'nativeScope': config.namespace,
                'userId': str(uuid.uuid4()), 'subject': 'qa-main-' + uuid.uuid4().hex, 'role': 'manager', 'revision': 1}
        configured = {'AVA_NATIVE_HTTP_GUARD': 'true', 'AVA_AUTH_STATE_FILE': str(root / 'state.sqlite'),
                      'AVA_NATIVE_HTTP_GATEWAY_KEY_FILE': str(gateway_file)}
        previous = {key: os.environ.get(key) for key in configured}
        os.environ.update(configured)
        binding = str(uuid.uuid4())
        try:
            provisioned = await service.provision(user)
            session = await service.create_session({**user, 'nativeUserId': provisioned['nativeUserId'],
                'bindingId': binding, 'expiresAt': int(time.time() * 1000) + 300000})
            from onyx.main import get_application
            from .http_guard import NativeHTTPGuard
            import httpx

            application = get_application()
            if sum(item.cls is NativeHTTPGuard for item in application.user_middleware) != 1:
                raise Unavailable()
            routes = [route.path for route in application.routes if getattr(route, 'endpoint', None)
                      and route.endpoint.__name__ == 'verify_user_logged_in']
            if len(routes) != 1:
                raise Unavailable()
            headers = {'Cookie': session['nativeCookie'], 'X-Ava-Native-Peer': gateway, 'X-Ava-Native-Binding': binding}
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=application), base_url='https://native.invalid') as client:
                health = await client.get('/ava-native-healthz')
                own = await client.get(routes[0], headers=headers)
                denied = await client.get(routes[0], headers={'Cookie': session['nativeCookie']})
                bad_binding = await client.get(routes[0], headers={**headers, 'X-Ava-Native-Binding': str(uuid.uuid4())})
                if own.status_code != 200:
                    print(json.dumps({'stage': 'native_main_readback', 'status': own.status_code}))
                    raise Unavailable()
                own_identity = own.json().get('id') == provisioned['nativeUserId']
                receipt = await service.revoke({'bindingId': binding})
                revoked = await client.get(routes[0], headers=headers)
                evidence = {'main_hook_installed': True, 'health_minimal': health.status_code == 200 and health.json() == {'ok': True},
                            'native_main_user_readback': own_identity, 'native_main_peer_required': denied.status_code == 403,
                            'native_main_binding_required': bad_binding.status_code == 403,
                            'native_main_revoked_denied': receipt['nativeSessionAbsent'] is True and revoked.status_code == 403}
                if not all(evidence.values()):
                    raise Unavailable()
                return {'qa_only': True, 'business_id': config.business_id, 'evidence': evidence,
                        'native_lifespan_started': False, 'browser_tls_tested': False, 'guest_search_tested': False}
        finally:
            if store.user(user['userId']):
                await service.disable({key: user[key] for key in ('businessId', 'deploymentId', 'nativeScope', 'revision')})
            store.close()
            for key, value in previous.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value


def main() -> int:
    try:
        print(json.dumps(asyncio.run(probe())))
        return 0
    except Exception as error:
        frames = [{'file': Path(frame.filename).name, 'function': frame.name, 'line': frame.lineno}
                  for frame in traceback.extract_tb(error.__traceback__)[-6:]]
        print(json.dumps({'ok': False, 'stage': 'native_http_wiring_failed', 'error_type': type(error).__name__, 'frames': frames}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
