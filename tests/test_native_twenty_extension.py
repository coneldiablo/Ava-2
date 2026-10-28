"""Focused contract checks for the AVA-owned Twenty Community extension."""
import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_pinned_twenty_extension_is_community_only_and_bootstrapable():
    adapter = ROOT / "native_modules/twenty/adapter.cjs"
    installer = ROOT / "native_modules/twenty/install.cjs"
    prepare = ROOT / "scripts/prepare-twenty-community-extension.py"
    assert "revokeSessionByIdForUserWorkspace" in installer.read_text()
    assert "UserSessionCookieService" in installer.read_text()
    assert "app.use(nativeRequestGuard)" in installer.read_text()
    assert "native_guard_order_invalid" in installer.read_text()
    assert "native_body_parser_missing" in installer.read_text()
    assert "authProvider: 'sso'" in installer.read_text()
    assert "userAgent: 'ava-native'" in installer.read_text()
    assert "__Host-twenty-session" in installer.read_text()
    assert "native_auth_mutation_forbidden" in installer.read_text()
    assert "nativeCookie" in adapter.read_text()
    assert "nativeSessionAbsent: true" in adapter.read_text()
    assert "native_revoke_cache_not_confirmed" in adapter.read_text()
    assert "isSessionResolvable" in installer.read_text()
    assert "ee/" not in prepare.read_text().lower()
    subprocess.run(["node", "--check", str(adapter)], check=True)
    subprocess.run(["node", "--check", str(installer)], check=True)


def test_peer_listener_separates_gateway_and_worker_credentials():
    adapter = ROOT / "native_modules/twenty/adapter.cjs"
    program = f"""
const http = require('node:http');
const {{ peerServer }} = require({json.dumps(str(adapter))});
const server = peerServer({{
  async createSession(body) {{ return {{ ...body, nativeCookie: '__Host-twenty-session=abc', nativeSessionId: '00000000-0000-4000-8000-000000000001' }}; }},
  async revoke(body) {{ return {{ bindingId: body.bindingId, nativeSessionAbsent: true }}; }},
  async provision() {{ return {{ ok: true }}; }}, async verify() {{ return {{ ok: true }}; }}, async disable() {{ return {{ ok: true }}; }},
}}, {{ gatewaySecret: () => 'g'.repeat(43), workerSecret: () => 'w'.repeat(43) }});
server.listen(0, '127.0.0.1', async () => {{
  const port = server.address().port;
  const call = (path, secret, body) => new Promise((resolve, reject) => {{
    const request = http.request({{ hostname: '127.0.0.1', port, path, method: 'POST', headers: {{ authorization: 'Bearer ' + secret, 'content-type': 'application/json' }} }}, response => {{ let data=''; response.on('data', x => data += x); response.on('end', () => resolve([response.statusCode, JSON.parse(data)])); }});
    request.on('error', reject); request.end(JSON.stringify(body));
  }});
  const body = {{ businessId: 1, deploymentId: '00000000-0000-4000-8000-000000000002', bindingId: '00000000-0000-4000-8000-000000000003', userId: 'u', nativeUserId: '00000000-0000-4000-8000-000000000004', nativeScope: '00000000-0000-4000-8000-000000000005', subject: 's', role: 'manager', revision: 1, expiresAt: Date.now()+60000 }};
  const [ok, payload] = await call('/v1/sessions/create', 'g'.repeat(43), body);
  const [denied] = await call('/v1/sessions/create', 'w'.repeat(43), body);
  server.close(() => {{ if (ok !== 200 || denied !== 401 || payload.nativeCookie !== '__Host-twenty-session=abc') process.exitCode = 1; }});
}});
"""
    subprocess.run(["node", "-e", program], check=True, timeout=10)


def test_preload_defers_adapter_until_nest_routes_are_initialized():
    preload = ROOT / "native_modules/twenty/preload.cjs"
    program = f"""
const Module = require('node:module');
let installed = 0, initialized = 0, listened = 0;
const factory = {{ async create() {{
  const raw = {{ async init() {{ initialized++; }}, async listen() {{ listened++; }} }};
  // Mirrors Nest 11 createProxy: its set trap accepts but discards assignment.
  return new Proxy(raw, {{ get: Reflect.get, set() {{ return true; }} }});
}} }};
const load = Module._load;
Module._load = function(request, parent, isMain) {{
  if (request === '@nestjs/core') return {{ NestFactory: factory }};
  if (request === './install.cjs') return {{ install: async () => {{ if (!initialized) throw new Error('installed_too_early'); installed++; }} }};
  return load.call(this, request, parent, isMain);
}};
(async () => {{
  require({json.dumps(str(preload))});
  const app = await factory.create();
  if (installed) throw new Error('installed_during_create');
  await app.listen(3000);
  if (initialized !== 1 || installed !== 1 || listened !== 1) throw new Error('bad_lifecycle');
}})().catch(error => {{ console.error(error); process.exitCode = 1; }});
"""
    subprocess.run(["node", "-e", program], check=True, timeout=10)


def test_peer_secret_rotation_and_symlink_are_fail_closed():
    adapter = ROOT / "native_modules/twenty/adapter.cjs"
    program = f"""
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const {{ configFromEnv }} = require({json.dumps(str(adapter))});
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ava-native-secret-')); fs.chmodSync(dir, 0o700);
const write = (name, value) => {{ const target = path.join(dir, name); fs.writeFileSync(target, value); fs.chmodSync(target, 0o600); return target; }};
const g = write('gateway', 'g'.repeat(43)); const w = write('worker', 'w'.repeat(43)); const k = write('key', Buffer.alloc(32, 7).toString('base64'));
const env = {{ AVA_BUSINESS_ID:'1', AVA_DEPLOYMENT_ID:'00000000-0000-4000-8000-000000000001', AVA_NATIVE_SCOPE:'00000000-0000-4000-8000-000000000002', AVA_DEPLOYMENT_REVISION:'1', AVA_NATIVE_OWNER_ROLE_ID:'00000000-0000-4000-8000-000000000003', AVA_NATIVE_MANAGER_ROLE_ID:'00000000-0000-4000-8000-000000000004', SERVER_URL:'https://qa.invalid/', AVA_NATIVE_GATEWAY_SECRET_FILE:g, AVA_NATIVE_WORKER_SECRET_FILE:w, AVA_NATIVE_SESSION_KEY_FILE:k }};
const config = configFromEnv(env); fs.writeFileSync(g, 'z'.repeat(43)); fs.chmodSync(g, 0o600);
if (config.gatewaySecret() !== 'z'.repeat(43)) throw new Error('rotation_not_observed');
const link = path.join(dir, 'link'); fs.symlinkSync(g, link); env.AVA_NATIVE_GATEWAY_SECRET_FILE = link;
try {{ configFromEnv(env); throw new Error('symlink_accepted'); }} catch (error) {{ if (error.code !== 'secret_file_unreadable') throw error; }}
"""
    subprocess.run(["node", "-e", program], check=True, timeout=10)


def test_graphql_auth_mutations_are_checked_from_ast_not_operation_name():
    installer = ROOT / "native_modules/twenty/install.cjs"
    program = f"""
const Module = require('node:module'); const original = Module._load;
const ast = query => ({{ kind: 'Document', definitions: [...query.matchAll(/\\b(generateApiKeyToken|updatePasswordViaResetToken|people|currentUser)\\b/g)].map(match => ({{ kind: 'Field', name: {{ value: match[1] }} }})) }});
Module._load = function(request, parent, isMain) {{
  if (request === 'graphql') return {{ parse(query) {{ if (query === 'bad') throw new Error('bad'); return ast(query); }}, visit(node, visitor) {{ for (const field of node.definitions) visitor.Field(field); }} }};
  return original.call(this, request, parent, isMain);
}};
const {{ assertSafeGraphqlDocument, isNativeGraphqlPath }} = require({json.dumps(str(installer))});
const denied = query => {{ try {{ assertSafeGraphqlDocument({{ operationName: 'SafeName', query }}); return false; }} catch (error) {{ return error.code === 'native_auth_mutation_forbidden'; }} }};
if (!denied('mutation SafeName {{ alias: generateApiKeyToken {{ token }} }}')) throw new Error('alias_bypass');
if (!denied('query SafeName {{ ...Hidden }} fragment Hidden on Query {{ updatePasswordViaResetToken {{ ok }} }}')) throw new Error('fragment_bypass');
assertSafeGraphqlDocument({{ operationName: 'SafeName', query: 'query SafeName {{ people {{ id }} }}' }});
if (!isNativeGraphqlPath('/graphql') || !isNativeGraphqlPath('/metadata') || isNativeGraphqlPath('/admin-panel')) throw new Error('graphql_path_routing');
for (const body of [{{ operationName: 'SafeName' }}, [{{ query: 'query {{ people {{ id }} }}' }}], {{ query: 'bad' }}, {{ query: 'query {{ people {{ id }} }}', extensions: {{ persistedQuery: {{}} }} }}]) {{ try {{ assertSafeGraphqlDocument(body); throw new Error('unverifiable_accepted'); }} catch (error) {{ if (!['native_graphql_unverifiable','native_graphql_malformed'].includes(error.code)) throw error; }} }}
"""
    subprocess.run(["node", "-e", program], check=True, timeout=10)


def test_native_revoke_cache_proof_fails_closed_and_expiry_is_finite():
    installer = ROOT / "native_modules/twenty/install.cjs"
    program = f"""
const {{ isNativeSessionResolvable, assertCappedResolvedSession }} = require({json.dumps(str(installer))});
const cookie = '__Host-twenty-session=token';
const good = {{ resolveSession: async () => ({{ payload: {{ userId: 'u', workspaceId: 'w' }} }}) }};
(async () => {{
  if (await isNativeSessionResolvable(good, cookie, 'u', 'w') !== true) throw new Error('good_session_failed');
  const missing = {{ resolveSession: async () => {{ const e = new Error(); e.code = 'UNAUTHENTICATED'; throw e; }} }};
  if (await isNativeSessionResolvable(missing, cookie, 'u', 'w') !== false) throw new Error('unauth_not_absent');
  for (const service of [{{ resolveSession: async () => {{ throw new Error('redis down'); }} }}, {{ resolveSession: async () => ({{ payload: {{ userId: 'other', workspaceId: 'w' }} }}) }}]) {{
    try {{ await isNativeSessionResolvable(service, cookie, 'u', 'w'); throw new Error('failure_accepted'); }}
    catch (error) {{ if (!['native_session_cache_unverifiable', 'native_session_identity_mismatch'].includes(error.code)) throw error; }}
  }}
  try {{ await isNativeSessionResolvable(good, 'bad-cookie', 'u', 'w'); throw new Error('malformed_accepted'); }} catch (error) {{ if (error.code !== 'native_cookie_invalid') throw error; }}
  const cap = new Date(Date.now() + 1000);
  assertCappedResolvedSession({{ payload: {{ userId: 'u', workspaceId: 'w' }}, expiresAt: cap.toISOString() }}, 'u', 'w', cap);
  for (const resolved of [{{ payload: {{ userId: 'u', workspaceId: 'w' }}, expiresAt: 'NaN' }}, {{ payload: {{ userId: 'other', workspaceId: 'w' }}, expiresAt: cap.toISOString() }}]) {{
    try {{ assertCappedResolvedSession(resolved, 'u', 'w', cap); throw new Error('invalid_resolve_accepted'); }} catch (error) {{ if (error.code !== 'native_session_scope_invalid') throw error; }}
  }}
}})().catch(error => {{ console.error(error); process.exitCode = 1; }});
"""
    subprocess.run(["node", "-e", program], check=True, timeout=10)
