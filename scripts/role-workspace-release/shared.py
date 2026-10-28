"""Pinned imports and small contracts shared by the role release adapters."""
import hashlib
import importlib.util
from pathlib import Path
import re

BASE = '5aef32a22e3333ed1bcb0d7f5caf839c762d03f1'
PRIVATE_RUNTIME = 'instagram_private/server.js'
PRIVATE_VALIDATION_ALIAS = 'src/__reviewed_instagram_private_server.js'
COLUMN_MIGRATIONS = {'ava_workspace_reply_actions': [
    ['text', 'TEXT'], ['dispatchStartedAt', 'TEXT'], ['dispatchCompletedAt', 'TEXT'], ['dispatchOwnerJson', 'TEXT']]}
PINS = {
    'registration_operator': ('ava-registration-release/release_operator.py', '979ced343eb58e88e9b5f7368f66ae01449743bf3968c78c9d89c088a929e19e'),
    'registration_builder': ('ava-registration-release/build_bundle.py', 'e368ee13ce0ef3b3440efe0bb72f0be62b00caabd10c7626cb15158d2f8cf0f7'),
    'voice_operator': ('voice-cleanup-release/operator.py', '74b3ca627c1bd0a48c2b738d9c6769c1411908ce0aaaae1e1bebb42555dfd067'),
}


def require(value, code):
    if not value:
        raise RuntimeError(code)


def reviewed(name):
    relative, digest = PINS[name]
    # Keep scripts/<original location> on the host; do not flatten imports.
    path = Path(__file__).parents[1] / relative
    require(hashlib.sha256(path.read_bytes()).hexdigest() == digest, 'REVIEWED_HELPER_DRIFT')
    spec = importlib.util.spec_from_file_location('role_' + name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def environment(value):
    require(isinstance(value, dict) and set(value) <= {'whatsapp_crm', 'provisioning_worker'}, 'ENV_SERVICE_INVALID')
    result = {name: {} for name in ('whatsapp_crm', 'provisioning_worker')}
    for name, settings in value.items():
        require(name == 'whatsapp_crm' or not settings, 'MEMORY_ENV_CRM_ONLY')
        require(isinstance(settings, dict) and set(settings) <= {'CRM_MEMORY_ENABLED', 'CRM_MEMORY_BUSINESS_IDS', 'CRM_MEMORY_SCOPE'}, 'ENV_KEY_NOT_REVIEWED')
        for key, val in settings.items():
            require(isinstance(val, str), 'ENV_VALUE_INVALID')
            valid = val in ('true', 'false') if key == 'CRM_MEMORY_ENABLED' else val in ('allowlist', 'all_active') if key == 'CRM_MEMORY_SCOPE' else bool(re.fullmatch(r'[1-9][0-9]*(?:,[1-9][0-9]*)*', val))
            require(valid, 'MEMORY_SCOPE_INVALID')
        require(settings.get('CRM_MEMORY_ENABLED') != 'true' or settings.get('CRM_MEMORY_SCOPE') == 'all_active'
                or bool(settings.get('CRM_MEMORY_BUSINESS_IDS')), 'MEMORY_TENANT_SCOPE_REQUIRED')
        result[name] = dict(settings)
    return result


def schema(value):
    require(isinstance(value, list), 'SCHEMA_CONTRACT_REQUIRED')
    names = set()
    for obj in value:
        require(isinstance(obj, dict) and set(obj) == {'name', 'type', 'tbl_name', 'sqlHash'} and
                obj['type'] in ('table', 'index', 'trigger') and isinstance(obj['name'], str) and
                obj['name'] and obj['name'] not in names and isinstance(obj['tbl_name'], str) and
                bool(re.fullmatch('[0-9a-f]{64}', obj['sqlHash'] or '')), 'SCHEMA_CONTRACT_INVALID')
        names.add(obj['name'])
    return value


def trigger_replacements(value):
    require(isinstance(value, list) and len(value) <= 1, 'TRIGGER_REPLACEMENT_CONTRACT_INVALID')
    for obj in value:
        require(isinstance(obj, dict) and set(obj) == {'name', 'type', 'tbl_name', 'baseSqlHash', 'sqlHash'}
                and obj['name'] == 'ava_dialogue_ava_workspace_reply_actions_update'
                and obj['type'] == 'trigger' and obj['tbl_name'] == 'ava_workspace_reply_actions'
                and all(isinstance(obj[key], str) and re.fullmatch('[0-9a-f]{64}', obj[key])
                        for key in ('baseSqlHash', 'sqlHash')), 'TRIGGER_REPLACEMENT_CONTRACT_INVALID')
    return value


def modules(value):
    require(isinstance(value, list) and value and len(set(value)) == len(value) and
            all(isinstance(x, str) and re.fullmatch(r'[a-z][a-z0-9-]*(?:\.(?:service|store))?', x) for x in value), 'SCHEMA_MODULES_INVALID')
    return value
