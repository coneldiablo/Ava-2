from fastapi import APIRouter, HTTPException, UploadFile, File
import yaml
from yaml.constructor import ConstructorError
from yaml.nodes import MappingNode, SequenceNode, ScalarNode
import os
import re
import asyncio
import glob
import tempfile
import sys
import logging
import ssl
import smtplib
from email.message import EmailMessage
from contextlib import contextmanager
from pydantic import BaseModel
from typing import Dict, Any, Optional, Union
from urllib.parse import quote, urlparse
import settings

MAX_BACKUPS = 5

router = APIRouter()
logger = logging.getLogger(__name__)

def _is_prefix(key: str, prefixes: tuple[str, ...]) -> bool:
    return any(key.startswith(p) for p in prefixes)

def _running_container_names() -> set:
    """Return a set of container names that are currently running."""
    try:
        import docker
        client = docker.from_env()
        return {c.name for c in client.containers.list(filters={"status": "running"})}
    except Exception:
        return set()

def _upsert_env_key(key: str, value: str) -> None:
    """Insert or update a single key in the project .env file."""
    env_path = settings.ENV_PATH
    lines: list[str] = []
    if os.path.exists(env_path):
        with open(env_path, "r") as f:
            lines = f.readlines()

    found = False
    for i, line in enumerate(lines):
        stripped = line.lstrip("# ").strip()
        if stripped.startswith(f"{key}="):
            lines[i] = f"{key}={value}\n"
            found = True
            break

    if not found:
        if lines and not lines[-1].endswith("\n"):
            lines.append("\n")
        lines.append(f"{key}={value}\n")

    with open(env_path, "w") as f:
        f.writelines(lines)

def _ai_engine_env_key(key: str) -> bool:
    return (
        _is_prefix(key, ("ASTERISK_", "LOG_", "DIAG_", "CALL_HISTORY_", "HEALTH_CHECK_"))
        or key in ("HEALTH_API_TOKEN", "HEALTH_BIND_PORT")
        or key in (
            "OPENAI_API_KEY",
            "GROQ_API_KEY",
            "DEEPGRAM_API_KEY",
            "GOOGLE_API_KEY",
            "GOOGLE_CLOUD_PROJECT",
            "GOOGLE_CLOUD_LOCATION",
            "GOOGLE_APPLICATION_CREDENTIALS",
            "TELNYX_API_KEY",
            "RESEND_API_KEY",
            "ELEVENLABS_API_KEY",
            "ELEVENLABS_AGENT_ID",
            "TZ",
            "STREAMING_LOG_LEVEL",
        )
        or _is_prefix(key, ("AUDIO_TRANSPORT", "DOWNSTREAM_MODE", "AUDIOSOCKET_", "EXTERNAL_MEDIA_", "BARGE_IN_"))
        or _is_prefix(key, ("SMTP_",))
        or _is_prefix(key, ("LOCAL_WS_",))
    )

def _local_ai_env_key(key: str) -> bool:
    return (
        _is_prefix(key, ("LOCAL_", "KROKO_", "FASTER_WHISPER_", "WHISPER_CPP_", "MELOTTS_", "KOKORO_"))
        or key in ("SHERPA_MODEL_PATH",)
    )

def _admin_ui_env_key(key: str) -> bool:
    return (
        key in ("JWT_SECRET", "DOCKER_SOCK", "DOCKER_GID", "TZ")
        or _is_prefix(key, ("UVICORN_", "ADMIN_UI_"))
    )

def _assert_no_duplicate_yaml_keys(node: yaml.Node) -> None:
    """
    Detect duplicate mapping keys before calling yaml.safe_load().

    We avoid yaml.load() here to keep CodeQL happy while still enforcing our
    "no duplicate keys" constraint for Admin UI config edits.
    """
    if isinstance(node, MappingNode):
        seen: dict[str, ScalarNode] = {}
        for key_node, value_node in node.value:
            if isinstance(key_node, ScalarNode):
                key = str(key_node.value)
            else:
                key = str(key_node)
            if key in seen:
                raise ConstructorError(
                    "while constructing a mapping",
                    node.start_mark,
                    f"found duplicate key ({key!r})",
                    key_node.start_mark,
                )
            if isinstance(key_node, ScalarNode):
                seen[key] = key_node
            _assert_no_duplicate_yaml_keys(value_node)
    elif isinstance(node, SequenceNode):
        for item in node.value:
            _assert_no_duplicate_yaml_keys(item)

def _safe_load_no_duplicates(content: str):
    node = yaml.compose(content, Loader=yaml.SafeLoader)
    if node is not None:
        _assert_no_duplicate_yaml_keys(node)
    return yaml.safe_load(content)

def _deep_merge_dicts(base: dict, override: dict) -> dict:
    """
    Recursively deep-merge *override* into a copy of *base*.

    Deletion semantics:
    - If the override explicitly sets a key to null/None, that key is removed from
      the merged output. This is important because our operator override file is
      merged on top of a git-tracked base file and needs a way to represent
      "delete this upstream default".
    """
    merged = dict(base)
    for key, override_val in override.items():
        if override_val is None:
            merged.pop(key, None)
            continue
        base_val = merged.get(key)
        if isinstance(base_val, dict) and isinstance(override_val, dict):
            merged[key] = _deep_merge_dicts(base_val, override_val)
        else:
            merged[key] = override_val
    return merged

def _read_base_config_dict() -> dict:
    """Read base config/ai-agent.yaml as a dict (no local overrides)."""
    if not os.path.exists(settings.CONFIG_PATH):
        return {}
    with open(settings.CONFIG_PATH, "r") as f:
        base = _safe_load_no_duplicates(f.read()) or {}
    return base if isinstance(base, dict) else {}

def _compute_local_override(base: dict, desired: dict) -> dict:
    """
    Compute a minimal operator-local override that, when merged over *base*,
    yields *desired* (including deletions via null tombstones).
    """
    if not isinstance(base, dict) or not isinstance(desired, dict):
        return desired

    override: dict = {}

    for key, desired_val in desired.items():
        if key not in base:
            override[key] = desired_val
            continue

        base_val = base.get(key)
        if isinstance(base_val, dict) and isinstance(desired_val, dict):
            child = _compute_local_override(base_val, desired_val)
            if child:
                override[key] = child
            continue

        if base_val != desired_val:
            override[key] = desired_val

    for key in base.keys():
        if key not in desired:
            override[key] = None

    return override

def _read_merged_config_dict() -> dict:
    """
    Read and return the merged config (base + local override) as a dict.

    Loads ``config/ai-agent.yaml`` (base), then deep-merges
    ``config/ai-agent.local.yaml`` (operator overrides) on top if it exists.
    """
    if not os.path.exists(settings.CONFIG_PATH):
        return {}
    with open(settings.CONFIG_PATH, "r") as f:
        base = _safe_load_no_duplicates(f.read()) or {}

    if not os.path.exists(settings.LOCAL_CONFIG_PATH):
        return base

    try:
        with open(settings.LOCAL_CONFIG_PATH, "r") as f:
            local = _safe_load_no_duplicates(f.read()) or {}
    except Exception:
        return base

    if not isinstance(local, dict):
        return base

    return _deep_merge_dicts(base, local)

def _read_merged_config_content() -> str:
    """Return the merged config as a YAML string (for display / validation)."""
    merged = _read_merged_config_dict()
    return yaml.dump(merged, default_flow_style=False, sort_keys=False) if merged else ""

def _write_local_config(content: str) -> None:
    """
    Atomically write *content* to the local override config file.

    Creates a backup of the existing local file (if any), validates permissions,
    and performs an atomic temp-file + rename write.
    """
    import datetime
    dir_path = os.path.dirname(settings.LOCAL_CONFIG_PATH)
    if dir_path:
        os.makedirs(dir_path, exist_ok=True)

    if os.path.exists(settings.LOCAL_CONFIG_PATH):
        timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_path = f"{settings.LOCAL_CONFIG_PATH}.bak.{timestamp}"
        with open(settings.LOCAL_CONFIG_PATH, "r") as src:
            with open(backup_path, "w") as dst:
                dst.write(src.read())
        _rotate_backups(settings.LOCAL_CONFIG_PATH)

    original_mode = None
    for candidate in (settings.LOCAL_CONFIG_PATH, settings.CONFIG_PATH):
        if os.path.exists(candidate):
            original_mode = os.stat(candidate).st_mode
            break

    with tempfile.NamedTemporaryFile("w", dir=dir_path, delete=False, suffix=".tmp") as f:
        f.write(content)
        temp_path = f.name

    if original_mode is not None:
        os.chmod(temp_path, original_mode)

    os.replace(temp_path, settings.LOCAL_CONFIG_PATH)

ANSI_ESCAPE = re.compile(r'\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])')

def strip_ansi_codes(text: str) -> str:
    """Remove ANSI escape codes from text for clean log files."""
    return ANSI_ESCAPE.sub('', text)

def _url_host(url: str) -> str:
    try:
        return (urlparse(str(url)).hostname or "").lower()
    except Exception:
        return ""

_SAFE_BASE_URLS: dict[str, str] = {
    "api.telnyx.com": "https://api.telnyx.com/v2/ai",
    "api.openai.com": "https://api.openai.com/v1",
    "api.groq.com": "https://api.groq.com/openai/v1",
    "openrouter.ai": "https://openrouter.ai/api/v1",
    "api.anthropic.com": "https://api.anthropic.com/v1",
    "api.deepgram.com": "https://api.deepgram.com/v1",
    "api.elevenlabs.io": "https://api.elevenlabs.io/v1",
    "generativelanguage.googleapis.com": "https://generativelanguage.googleapis.com/v1beta",
}

def _safe_base_url(user_url: str, fallback: str) -> str:
    """Return a hardcoded base URL for a known provider host, or *fallback*.

    The returned string is NEVER derived from *user_url* — only the hostname
    is extracted for lookup.  This breaks the CodeQL taint chain.
    """
    host = _url_host(user_url)
    return _SAFE_BASE_URLS.get(host, fallback)

def _rotate_backups(base_path: str) -> None:
    """
    A11: Keep only the last MAX_BACKUPS backup files.
    Deletes oldest backups when limit is exceeded.
    """
    pattern = f"{base_path}.bak.*"
    backups = sorted(glob.glob(pattern), key=os.path.getmtime, reverse=True)
    
    for old_backup in backups[MAX_BACKUPS:]:
        try:
            os.remove(old_backup)
        except OSError:
            pass

class ConfigUpdate(BaseModel):
    content: str

@contextmanager
def _temporary_dotenv(path: str, defaults: Dict[str, str] | None = None):
    """
    Temporarily load KEY=VALUE pairs from a .env file into os.environ.

    This keeps config schema validation consistent with how ai-engine injects
    credentials/settings from environment variables at runtime.
    """
    env_pairs: Dict[str, str] = {}
    try:
        if path and os.path.exists(path):
            from dotenv import dotenv_values
            raw = dotenv_values(path)
            for key, value in (raw or {}).items():
                if key and value is not None:
                    env_pairs[str(key)] = str(value)
    except Exception:
        env_pairs = {}

    previous: Dict[str, Any] = {}
    for key, value in env_pairs.items():
        previous[key] = os.environ.get(key)
        os.environ[key] = value

    applied_defaults: Dict[str, str] = {}
    for key, value in (defaults or {}).items():
        if key not in os.environ or os.environ.get(key, "").strip() == "":
            previous[key] = os.environ.get(key)
            os.environ[key] = value
            applied_defaults[key] = value

    try:
        yield
    finally:
        for key, old_value in previous.items():
            if old_value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = str(old_value)

def _resolve_json_schema_ref(schema_root: Dict[str, Any], ref: str) -> Dict[str, Any]:
    if not ref.startswith("#/"):
        return {}
    node: Any = schema_root
    for part in ref.lstrip("#/").split("/"):
        if isinstance(node, dict) and part in node:
            node = node[part]
        else:
            return {}
    return node if isinstance(node, dict) else {}

def _collect_unknown_keys(data: Any, schema_root: Dict[str, Any], schema_node: Dict[str, Any], prefix: str) -> list:
    """
    Best-effort unknown-key detection using Pydantic's JSON schema.

    We only warn when the schema node is a structured object with explicit
    properties and does NOT allow additionalProperties (dict-like blobs).
    """
    if not isinstance(schema_node, dict):
        return []

    if "$ref" in schema_node:
        resolved = _resolve_json_schema_ref(schema_root, schema_node["$ref"])
        if resolved:
            schema_node = resolved

    for union_key in ("anyOf", "oneOf", "allOf"):
        if union_key in schema_node:
            return []

    if not isinstance(data, dict):
        return []

    properties = schema_node.get("properties")
    if not isinstance(properties, dict):
        return []

    additional = schema_node.get("additionalProperties")
    if additional not in (None, False):
        warnings: list = []
        for key, subschema in properties.items():
            if key in data:
                next_prefix = f"{prefix}.{key}" if prefix else key
                warnings.extend(_collect_unknown_keys(data[key], schema_root, subschema, next_prefix))
        return warnings

    warnings: list = []
    known_keys = set(properties.keys())
    for key in data.keys():
        if key not in known_keys:
            full = f"{prefix}.{key}" if prefix else str(key)
            warnings.append(f"Unknown config key: {full} (will be ignored)")

    for key, subschema in properties.items():
        if key in data:
            next_prefix = f"{prefix}.{key}" if prefix else key
            warnings.extend(_collect_unknown_keys(data[key], schema_root, subschema, next_prefix))

    return warnings

def _validate_ai_agent_config(content: str) -> Dict[str, Any]:
    """
    Validate ai-agent.yaml content against the canonical AppConfig schema.

    Returns:
      {"warnings": [...]} on success

    Raises:
      HTTPException(400) on validation errors
    """
    try:
        parsed = _safe_load_no_duplicates(content) or {}
    except yaml.YAMLError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid YAML: {str(exc)}")

    if not isinstance(parsed, dict):
        raise HTTPException(status_code=400, detail="Invalid YAML: expected a mapping at the document root")

    project_root = getattr(settings, "PROJECT_ROOT", None)
    if project_root and project_root not in sys.path:
        sys.path.insert(0, project_root)

    try:
        from pydantic import ValidationError
        from src.config import AppConfig, load_config
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Server misconfiguration: cannot import config schema (src.config). Error: {exc}",
        )

    warnings: list[str] = []

    try:
        asterisk_block = parsed.get("asterisk") if isinstance(parsed.get("asterisk"), dict) else {}
        if isinstance(asterisk_block, dict) and any(k in asterisk_block for k in ("username", "password")):
            warnings.append("Asterisk credentials in YAML are ignored; set ASTERISK_ARI_USERNAME/ASTERISK_ARI_PASSWORD in .env instead.")

        providers_block = parsed.get("providers") if isinstance(parsed.get("providers"), dict) else {}
        if isinstance(providers_block, dict):
            for provider_name, provider_cfg in providers_block.items():
                if isinstance(provider_cfg, dict) and "api_key" in provider_cfg:
                    warnings.append(f"providers.{provider_name}.api_key in YAML is ignored; set the provider API key in .env instead.")
    except Exception:
        pass

    env_required_defaults: Dict[str, str] = {}
    try:
        from dotenv import dotenv_values
        dotenv_map = dotenv_values(settings.ENV_PATH) if os.path.exists(settings.ENV_PATH) else {}
        get_dotenv = lambda k: str(dotenv_map.get(k) or "").strip()

        ari_user_present = bool(get_dotenv("ASTERISK_ARI_USERNAME") or get_dotenv("ARI_USERNAME") or os.environ.get("ASTERISK_ARI_USERNAME") or os.environ.get("ARI_USERNAME"))
        ari_pass_present = bool(get_dotenv("ASTERISK_ARI_PASSWORD") or get_dotenv("ARI_PASSWORD") or os.environ.get("ASTERISK_ARI_PASSWORD") or os.environ.get("ARI_PASSWORD"))

        if not ari_user_present:
            warnings.append("Missing ARI username in .env (ASTERISK_ARI_USERNAME or ARI_USERNAME). Engine will not connect to Asterisk ARI until set.")
            env_required_defaults["ASTERISK_ARI_USERNAME"] = "__MISSING__"
        if not ari_pass_present:
            warnings.append("Missing ARI password in .env (ASTERISK_ARI_PASSWORD or ARI_PASSWORD). Engine will not connect to Asterisk ARI until set.")
            env_required_defaults["ASTERISK_ARI_PASSWORD"] = "__MISSING__"
    except Exception:
        pass

    dir_path = os.path.dirname(settings.CONFIG_PATH)
    with tempfile.NamedTemporaryFile("w", dir=dir_path, delete=False, suffix=".validate.yaml") as f:
        f.write(content)
        tmp_path = f.name

    try:
        with _temporary_dotenv(settings.ENV_PATH, defaults=env_required_defaults):
            load_config(tmp_path)
    except ValidationError as exc:
        raise HTTPException(status_code=400, detail=f"Config schema validation failed: {exc}")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Config validation failed: {exc}")
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass

    try:
        schema = AppConfig.model_json_schema()
        warnings.extend(_collect_unknown_keys(parsed, schema, schema, prefix=""))
    except Exception:
        pass

    return {"warnings": warnings}

@router.post("/yaml")
async def update_yaml_config(update: ConfigUpdate):
    try:
        validation = _validate_ai_agent_config(update.content)
        warnings = validation.get("warnings") or []

        old_merged = _read_merged_config_dict()

        new_parsed = _safe_load_no_duplicates(update.content) or {}
        if not isinstance(new_parsed, dict):
            raise HTTPException(status_code=400, detail="Config YAML must be a mapping at the top level")

        base = _read_base_config_dict()
        local_override = _compute_local_override(base, new_parsed)
        local_content = yaml.dump(local_override or {}, default_flow_style=False, sort_keys=False)

        _write_local_config(local_content)
        
        recommended_method = "restart"
        
        try:
            if old_merged:
                hot_reload_keys = {'contexts', 'profiles', 'mcp'}
                
                all_keys = set(old_merged.keys()) | set(new_parsed.keys())
                changed_keys = set()
                for key in all_keys:
                    if old_merged.get(key) != new_parsed.get(key):
                        changed_keys.add(key)
                
                if changed_keys and changed_keys.issubset(hot_reload_keys):
                    recommended_method = "hot_reload"
        except Exception:
            pass
        
        apply_plan = ([{"service": "ai_engine", "method": "hot_reload", "endpoint": "/api/system/containers/ai_engine/reload"}]
                     if recommended_method == "hot_reload"
                     else [{"service": "ai_engine", "method": "restart", "endpoint": "/api/system/containers/ai_engine/restart"}])

        return {
            "status": "success",
            "restart_required": recommended_method != "hot_reload",
            "recommended_apply_method": recommended_method,
            "apply_plan": apply_plan,
            "message": f"Configuration saved. {'Hot reload' if recommended_method == 'hot_reload' else 'Restart'} AI Engine to apply changes.",
            "warnings": warnings,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/yaml")
async def get_yaml_config():
    print(f"Accessing config at {settings.CONFIG_PATH}")
    if not os.path.exists(settings.CONFIG_PATH):
        print("Config file not found")
        raise HTTPException(status_code=404, detail="Config file not found")
    try:
        config_content = _read_merged_config_content()
        _safe_load_no_duplicates(config_content)
        return {"content": config_content}
    except yaml.YAMLError as e:
        logger.info("YAML parse error while reading config YAML", exc_info=True)
        error_info = {
            "type": "yaml_error",
            "message": "Invalid YAML",
            "line": None,
            "column": None,
            "context": None,
            "snippet": None,
        }
        if hasattr(e, 'problem_mark') and e.problem_mark:
            mark = e.problem_mark
            error_info["line"] = mark.line + 1
            error_info["column"] = mark.column + 1
        if hasattr(e, 'context_mark') and e.context_mark:
            ctx_mark = e.context_mark
            error_info["context"] = f"Line {ctx_mark.line + 1}, column {ctx_mark.column + 1}"
        if error_info["line"]:
            try:
                lines = config_content.splitlines()
                line_num = error_info["line"] - 1
                start = max(0, line_num - 2)
                end = min(len(lines), line_num + 3)
                snippet_lines = []
                for i in range(start, end):
                    prefix = ">>> " if i == line_num else "    "
                    snippet_lines.append(f"{prefix}{i+1}: {lines[i]}")
                error_info["snippet"] = "\n".join(snippet_lines)
            except Exception:
                pass
        return {
            "content": config_content,
            "yaml_error": error_info
        }
    except Exception as e:
        logger.error("Unexpected error while reading config YAML", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to read config YAML") from e

@router.get("/env")
async def get_env_config():
    """
    Read .env file and return parsed key-value pairs.
    Uses dotenv_values for correct parsing of quoted/escaped values.
    """
    env_vars = {}
    if os.path.exists(settings.ENV_PATH):
        try:
            from dotenv import dotenv_values
            env_vars = dotenv_values(settings.ENV_PATH)
            env_vars = {k: v for k, v in env_vars.items() if v is not None}
        except ImportError:
            with open(settings.ENV_PATH, 'r') as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith('#'):
                        if '=' in line:
                            key, value = line.split('=', 1)
                            value = value.strip()
                            if (value.startswith('"') and value.endswith('"')) or \
                               (value.startswith("'") and value.endswith("'")):
                                value = value[1:-1]
                            env_vars[key.strip()] = value
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))
    return env_vars

@router.post("/env")
async def update_env(env_data: Dict[str, Optional[str]]):
    """
    Update .env file with provided key-value pairs.
    
    - Pass a string value to set/update a key
    - Pass None or "__DELETE__" to remove a key entirely (line is removed, not commented)
    - Values with spaces, #, quotes, $, etc. are automatically quoted
    - Already-quoted values from UI are stored as-is (no double-quoting)
    """
    try:
        try:
            log_to_file_raw = env_data.get("LOG_TO_FILE")
            log_to_file = str(log_to_file_raw or "").strip().lower()
            enabled = log_to_file in ("1", "true", "yes", "on")
            if enabled and not (str(env_data.get("LOG_FILE_PATH") or "").strip()):
                env_data["LOG_FILE_PATH"] = "/mnt/asterisk_media/ai-engine.log"
        except Exception:
            pass

        for key, value in env_data.items():
            if not key or not key.strip():
                raise HTTPException(status_code=400, detail="Empty key not allowed")
            if value is not None and '\n' in str(value):
                raise HTTPException(status_code=400, detail=f"Newlines not allowed in value: {key}")
            if '\n' in key:
                raise HTTPException(status_code=400, detail=f"Newlines not allowed in key: {key}")
            if '=' in key:
                raise HTTPException(status_code=400, detail=f"Key cannot contain '=': {key}")
        
        if os.path.exists(settings.ENV_PATH):
            import datetime
            timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
            backup_path = f"{settings.ENV_PATH}.bak.{timestamp}"
            with open(settings.ENV_PATH, 'r') as src:
                with open(backup_path, 'w') as dst:
                    dst.write(src.read())
            _rotate_backups(settings.ENV_PATH)

        lines = []
        if os.path.exists(settings.ENV_PATH):
            with open(settings.ENV_PATH, 'r') as f:
                lines = f.readlines()

        from collections import defaultdict
        key_occurrences = defaultdict(list)
        existing_values = {}
        for i, line in enumerate(lines):
            stripped = line.strip()
            if stripped and not stripped.startswith('#'):
                if '=' in stripped:
                    key, raw_val = stripped.split('=', 1)
                    key = key.strip()
                    key_occurrences[key].append(i)
                    val = raw_val.strip()
                    if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
                        val = val[1:-1]
                    existing_values[key] = val

        new_lines = lines.copy()
        
        if new_lines and not new_lines[-1].endswith('\n'):
            new_lines[-1] += '\n'

        keys_to_delete = set()
        keys_to_update = set()
        
        for key, value in env_data.items():
            if not key:
                continue
            
            if value is None or value == "__DELETE__":
                keys_to_delete.add(key)
                continue
            
            str_value = str(value)
            
            existing_val = existing_values.get(key)
            cmp_value = str_value
            if (cmp_value.startswith('"') and cmp_value.endswith('"')) or (cmp_value.startswith("'") and cmp_value.endswith("'")):
                cmp_value = cmp_value[1:-1]
            if existing_val != cmp_value:
                keys_to_update.add(key)
            
            already_quoted = (
                (str_value.startswith('"') and str_value.endswith('"') and len(str_value) >= 2) or
                (str_value.startswith("'") and str_value.endswith("'") and len(str_value) >= 2)
            )
            
            if already_quoted:
                line_content = f"{key}={str_value}\n"
            else:
                needs_quoting = (
                    not str_value or
                    ' ' in str_value or
                    '#' in str_value or
                    '"' in str_value or
                    "'" in str_value or
                    '$' in str_value or
                    '`' in str_value or
                    '\\' in str_value
                )
                
                if needs_quoting:
                    escaped_value = str_value.replace('\\', '\\\\').replace('"', '\\"')
                    line_content = f'{key}="{escaped_value}"\n'
                else:
                    line_content = f"{key}={str_value}\n"
            
            occurrences = key_occurrences.get(key, [])
            if occurrences:
                last_idx = occurrences[-1]
                new_lines[last_idx] = line_content
                for idx in occurrences[:-1]:
                    new_lines[idx] = None
            else:
                new_lines.append(line_content)
        
        for key in keys_to_delete:
            for idx in key_occurrences.get(key, []):
                new_lines[idx] = None
        
        new_lines = [line for line in new_lines if line is not None]

        dir_path = os.path.dirname(settings.ENV_PATH)
        original_mode = None
        if os.path.exists(settings.ENV_PATH):
            original_mode = os.stat(settings.ENV_PATH).st_mode
        
        with tempfile.NamedTemporaryFile('w', dir=dir_path, delete=False, suffix='.tmp') as f:
            f.writelines(new_lines)
            temp_path = f.name
        
        if original_mode is not None:
            os.chmod(temp_path, original_mode)
        
        os.replace(temp_path, settings.ENV_PATH)
        
        changed_keys = sorted(set(keys_to_update) | set(keys_to_delete))

        impacts_ai_engine = any(_ai_engine_env_key(k) for k in changed_keys)
        impacts_local_ai = any(_local_ai_env_key(k) for k in changed_keys)
        impacts_admin_ui = any(_admin_ui_env_key(k) for k in changed_keys)

        running = _running_container_names()

        apply_plan = []
        if impacts_ai_engine and "ai_engine" in running:
            apply_plan.append({"service": "ai_engine", "method": "recreate", "endpoint": "/api/system/containers/ai_engine/restart"})
        if impacts_local_ai and "local_ai_server" in running:
            apply_plan.append({"service": "local_ai_server", "method": "recreate", "endpoint": "/api/system/containers/local_ai_server/restart"})
        if impacts_admin_ui and "admin_ui" in running:
            apply_plan.append({"service": "admin_ui", "method": "restart", "endpoint": "/api/system/containers/admin_ui/restart"})

        message = "Environment saved. Restart impacted services to apply changes."
        if impacts_admin_ui:
            message += " (Restarting Admin UI will invalidate sessions if JWT_SECRET changed.)"

        return {
            "status": "success",
            "restart_required": bool(apply_plan),
            "recommended_apply_method": "recreate",
            "apply_plan": apply_plan,
            "changed_keys": changed_keys,
            "message": message,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/env/status")
async def get_env_status():
    """
    Detect whether the running containers are out-of-sync with the project's `.env` file.

    This allows the UI to keep showing a correct "Apply Changes" plan even after a refresh,
    since `.env` edits persist but container environments only update on recreate/restart.
    """
    try:
        from dotenv import dotenv_values
    except Exception as e:
        raise HTTPException(status_code=500, detail="python-dotenv is required for env status") from e

    env_map = dotenv_values(settings.ENV_PATH) if os.path.exists(settings.ENV_PATH) else {}
    env_map = {k: str(v) for k, v in (env_map or {}).items() if k and v is not None}

    try:
        import docker
        client = docker.from_env()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Docker unavailable for env status: {str(e)}")

    def _container_env(name: str) -> Dict[str, str]:
        try:
            c = client.containers.get(name)
            raw = (c.attrs.get("Config", {}) or {}).get("Env", []) or []
            out: Dict[str, str] = {}
            for item in raw:
                if not isinstance(item, str) or "=" not in item:
                    continue
                k, v = item.split("=", 1)
                out[str(k)] = str(v)
            return out
        except Exception:
            return {}

    def _diff_keys(*, desired: Dict[str, str], actual: Dict[str, str], key_pred) -> list[str]:
        keys = set()
        keys.update([k for k in desired.keys() if key_pred(k)])
        keys.update([k for k in actual.keys() if key_pred(k)])
        diffs = []
        for k in sorted(keys):
            want = str(desired.get(k, "") or "")
            got = str(actual.get(k, "") or "")
            if want != got:
                diffs.append(k)
        return diffs

    running = _running_container_names()

    ai_env = _container_env("ai_engine") if "ai_engine" in running else {}
    local_env = _container_env("local_ai_server") if "local_ai_server" in running else {}
    admin_env = _container_env("admin_ui") if "admin_ui" in running else {}

    drift_ai = _diff_keys(desired=env_map, actual=ai_env, key_pred=_ai_engine_env_key) if "ai_engine" in running else []
    drift_local = _diff_keys(desired=env_map, actual=local_env, key_pred=_local_ai_env_key) if "local_ai_server" in running else []
    drift_admin = _diff_keys(desired=env_map, actual=admin_env, key_pred=_admin_ui_env_key) if "admin_ui" in running else []

    apply_plan = []
    if drift_local:
        apply_plan.append({"service": "local_ai_server", "method": "recreate", "endpoint": "/api/system/containers/local_ai_server/restart"})
    if drift_ai:
        apply_plan.append({"service": "ai_engine", "method": "recreate", "endpoint": "/api/system/containers/ai_engine/restart"})
    if drift_admin:
        apply_plan.append({"service": "admin_ui", "method": "restart", "endpoint": "/api/system/containers/admin_ui/restart"})

    return {
        "pending_restart": bool(apply_plan),
        "apply_plan": apply_plan,
        "drift": {
            "ai_engine": drift_ai,
            "local_ai_server": drift_local,
            "admin_ui": drift_admin,
        },
    }

class ProviderTestRequest(BaseModel):
    name: str
    config: Dict[str, Any]

class SmtpTestRequest(BaseModel):
    to_email: str
    from_email: Optional[str] = None
    subject: Optional[str] = None
    text: Optional[str] = None
    smtp_host: Optional[str] = None
    smtp_port: Optional[Union[int, str]] = None
    smtp_username: Optional[str] = None
    smtp_password: Optional[str] = None
    smtp_tls_mode: Optional[str] = None
    smtp_tls_verify: Optional[Union[bool, str]] = None
    smtp_timeout_seconds: Optional[Union[float, str]] = None

@router.post("/providers/test")
async def test_provider_connection(request: ProviderTestRequest):
    """Test connection to a provider based on its configuration"""
    try:
        import httpx
        import os
        
        def get_env_key(key_name: str) -> str:
            """Read API key from .env file"""
            if os.path.exists(settings.ENV_PATH):
                with open(settings.ENV_PATH, 'r') as f:
                    for line in f:
                        line = line.strip()
                        if line.startswith(f"{key_name}="):
                            value = line.split('=', 1)[1].strip()
                            if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
                                value = value[1:-1]
                            return value
            return ''
        
        def substitute_env_vars(item):
            import re
            if isinstance(item, dict):
                return {k: substitute_env_vars(v) for k, v in item.items()}
            elif isinstance(item, list):
                return [substitute_env_vars(i) for i in item]
            elif isinstance(item, str):
                pattern = r'\$\{([a-zA-Z_][a-zA-Z0-9_]*)(?:(:-|:=|[-=])([^}]*))?\}'
                
                def replace(match):
                    var_name = match.group(1)
                    default_value = match.group(3)
                    val = get_env_key(var_name)
                    if val:
                        return val
                    val = os.getenv(var_name)
                    if val is not None and val != "":
                        return val
                    if default_value is not None:
                        return default_value
                    return "" 
                
                return re.sub(pattern, replace, item)
            return item

        def get_provider_proxy_url(config: Dict[str, Any]) -> Optional[str]:
            proxy_url = str(
                config.get("proxy_url")
                or get_env_key("AI_PROVIDER_PROXY_URL")
                or os.getenv("AI_PROVIDER_PROXY_URL")
                or ""
            ).strip()
            if proxy_url.lower() in ("none", "false", "off", "direct"):
                return None
            return proxy_url or None

        provider_config = substitute_env_vars(request.config)
        provider_name = request.name.lower()
        
        if 'local' in provider_name or provider_config.get('type') == 'local':
            import websockets
            import json
            
            ws_url = provider_config.get('base_url') or provider_config.get('ws_url') or 'ws://127.0.0.1:8765'
            if '${' in ws_url:
                ws_url = 'ws://127.0.0.1:8765'
            
            try:
                def _fallback_ws_url(url: str) -> str:
                    """
                    In host-networked deployments, `local_ai_server` DNS does not resolve because it is not
                    a Docker bridge network hostname. Fall back to localhost for best compatibility.
                    """
                    try:
                        if 'local_ai_server' in url:
                            return url.replace('local_ai_server', '127.0.0.1')
                    except Exception:
                        pass
                    return url

                async def _try_connect(url: str):
                    async with websockets.connect(url, open_timeout=5.0) as ws:
                        await ws.send(json.dumps({"type": "status"}))
                        response = await asyncio.wait_for(ws.recv(), timeout=5.0)
                        data = json.loads(response)
                        return data

                try:
                    data = await _try_connect(ws_url)
                    effective_url = ws_url
                except Exception as e:
                    alt = _fallback_ws_url(ws_url)
                    if alt != ws_url:
                        data = await _try_connect(alt)
                        effective_url = alt
                    else:
                        raise e

                if data.get("type") == "status_response" and data.get("status") == "ok":
                    models = data.get("models", {})
                    stt_loaded = models.get("stt", {}).get("loaded", False)
                    llm_loaded = models.get("llm", {}).get("loaded", False)
                    tts_loaded = models.get("tts", {}).get("loaded", False)

                    stt_backend = data.get("stt_backend", "unknown")
                    tts_backend = data.get("tts_backend", "unknown")
                    llm_model = models.get("llm", {}).get("path", "").split("/")[-1] if models.get("llm", {}).get("path") else "none"

                    status_parts = []
                    status_parts.append(f"STT: {stt_backend} ✓" if stt_loaded else "STT: not loaded")
                    status_parts.append(f"LLM: {llm_model} ✓" if llm_loaded else "LLM: not loaded")
                    status_parts.append(f"TTS: {tts_backend} ✓" if tts_loaded else "TTS: not loaded")

                    all_loaded = stt_loaded and llm_loaded and tts_loaded
                    return {
                        "success": all_loaded,
                        "message": f"Local AI Server connected ({effective_url}). {' | '.join(status_parts)}",
                    }
                return {"success": False, "message": "Local AI Server responded but status invalid"}
            except Exception as e:
                logger.debug("Local AI Server validation failed", error=str(e), exc_info=True)
                return {"success": False, "message": f"Cannot connect to Local AI Server at {ws_url} (see server logs)"}
        
        if 'elevenlabs' in provider_name or 'agent_id' in provider_config:
            api_key = get_env_key('ELEVENLABS_API_KEY')
            if not api_key:
                return {"success": False, "message": "ELEVENLABS_API_KEY not set in .env file"}
            
            async with httpx.AsyncClient() as client:
                response = await client.get(
                    "https://api.elevenlabs.io/v1/voices",
                    headers={"xi-api-key": api_key, "Accept": "application/json"},
                    timeout=10.0
                )
                if response.status_code == 200:
                    data = response.json()
                    voice_count = len(data.get('voices', []))
                    return {"success": True, "message": f"Connected to ElevenLabs ({voice_count} voices available)"}
                return {"success": False, "message": f"ElevenLabs API error: HTTP {response.status_code}"}
        
        provider_type_for_realtime = str(provider_config.get('type') or '').lower()
        if (
            provider_name == 'openai_realtime'
            or provider_type_for_realtime == 'openai_realtime'
            or 'realtime_base_url' in provider_config
            or 'turn_detection' in provider_config
        ):
            api_key = get_env_key('OPENAI_API_KEY')
            if not api_key:
                return {"success": False, "message": "OPENAI_API_KEY not set in .env file"}
            model = str(provider_config.get('model') or 'gpt-realtime-2').strip() or 'gpt-realtime-2'
            proxy_url = get_provider_proxy_url(provider_config)
            client_kwargs: Dict[str, Any] = {"timeout": 10.0}
            if proxy_url:
                client_kwargs["proxy"] = proxy_url
            async with httpx.AsyncClient(**client_kwargs) as client:
                response = await client.get(
                    f"https://api.openai.com/v1/models/{quote(model, safe='')}",
                    headers={"Authorization": f"Bearer {api_key}"},
                )
                if response.status_code == 200:
                    suffix = " via configured proxy" if proxy_url else ""
                    return {"success": True, "message": f"Connected to OpenAI Realtime model {model}{suffix}"}
                if response.status_code == 404:
                    return {"success": False, "message": f"OpenAI model not available for this account: {model} (HTTP 404)"}
                if response.status_code == 401:
                    return {"success": False, "message": "Invalid OPENAI_API_KEY (HTTP 401)"}
                suffix = " via configured proxy" if proxy_url else " without proxy"
                return {"success": False, "message": f"OpenAI API error for model {model}{suffix}: HTTP {response.status_code}"}

        provider_type = str(provider_config.get('type') or '').lower()
        chat_base_url = (provider_config.get('chat_base_url') or provider_config.get('base_url') or '').rstrip('/')
        host = _url_host(chat_base_url)
        is_telnyx = provider_type in ('telnyx', 'telenyx') or ('telnyx' in provider_name) or host == 'api.telnyx.com'
        if is_telnyx:
            base_url = _safe_base_url(chat_base_url, 'https://api.telnyx.com/v2/ai')
            api_key = get_env_key('TELNYX_API_KEY') or os.getenv('TELNYX_API_KEY') or ''
            if not api_key:
                return {"success": False, "message": "TELNYX_API_KEY not set in .env"}

            model = (provider_config.get('chat_model') or provider_config.get('model') or '').strip()
            if not model:
                model = "Qwen/Qwen3-235B-A22B"

            api_key_ref = (provider_config.get('api_key_ref') or '').strip()
            if model.startswith('openai/') and not api_key_ref:
                return {
                    "success": False,
                    "message": "Telnyx external models like openai/* require api_key_ref (Integration Secret identifier).",
                }

            def _telnyx_error_summary(resp: httpx.Response) -> str:
                try:
                    j = resp.json()
                    if isinstance(j, dict) and isinstance(j.get("errors"), list) and j["errors"]:
                        e0 = j["errors"][0] if isinstance(j["errors"][0], dict) else {}
                        code = e0.get("code")
                        title = e0.get("title")
                        detail = e0.get("detail")
                        parts = [p for p in [code, title, detail] if p]
                        if parts:
                            return " / ".join(str(p) for p in parts)
                except Exception:
                    pass
                text = (resp.text or "").strip().replace("\n", " ")
                return text[:180] if text else f"HTTP {resp.status_code}"

            try:
                async with httpx.AsyncClient(timeout=20.0) as client:
                    models_resp = await client.get(
                        f"{base_url}/models",
                        headers={"Authorization": f"Bearer {api_key}"},
                    )
                    if models_resp.status_code != 200:
                        return {"success": False, "message": f"Telnyx /models failed: {_telnyx_error_summary(models_resp)}"}

                    payload: Dict[str, Any] = {
                        "model": model,
                        "messages": [
                            {"role": "system", "content": "You are a test assistant."},
                            {"role": "user", "content": "Reply with exactly: OK"},
                        ],
                        "temperature": 0.0,
                        "max_tokens": 16,
                    }
                    if api_key_ref:
                        payload["api_key_ref"] = api_key_ref

                    chat_resp = await client.post(
                        f"{base_url}/chat/completions",
                        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                        json=payload,
                    )
                    if chat_resp.status_code == 200:
                        return {"success": True, "message": f"Connected to Telnyx. Chat completion OK with model: {model}"}
                    return {"success": False, "message": f"Telnyx chat completion failed: {_telnyx_error_summary(chat_resp)}"}
            except Exception as e:
                logger.debug("Telnyx provider validation failed", error=str(e), exc_info=True)
                return {"success": False, "message": f"Cannot connect to Telnyx at {base_url} (see server logs)"}

        if provider_type == 'openai':
            chat_base_url = _safe_base_url(
                provider_config.get('chat_base_url') or '', 'https://api.openai.com/v1'
            )
            api_key = provider_config.get('api_key')
            if not api_key:
                inferred_env = None
                host = _url_host(chat_base_url)
                if 'groq' in provider_name or host == 'api.groq.com':
                    inferred_env = 'GROQ_API_KEY'
                elif 'openai' in provider_name or host == 'api.openai.com':
                    inferred_env = 'OPENAI_API_KEY'

                if inferred_env:
                    api_key = get_env_key(inferred_env) or os.getenv(inferred_env) or ''

            if not api_key:
                return {"success": False, "message": "API key missing for OpenAI-compatible provider (set api_key or env var)"}

            try:
                async with httpx.AsyncClient() as client:
                    response = await client.get(
                        f"{chat_base_url}/models",
                        headers={"Authorization": f"Bearer {api_key}"},
                        timeout=10.0,
                    )
                    if response.status_code == 200:
                        try:
                            data = response.json()
                            models = data.get('data') or []
                            return {"success": True, "message": f"Connected (OpenAI-compatible). Found {len(models)} models."}
                        except Exception:
                            return {"success": True, "message": f"Connected (OpenAI-compatible) (HTTP {response.status_code})"}
                    if response.status_code == 401:
                        return {"success": False, "message": "Invalid API key (401)"}
                    return {"success": False, "message": f"Provider API error: HTTP {response.status_code}"}
            except Exception as e:
                logger.debug("OpenAI-compatible provider validation failed", error=str(e), exc_info=True)
                return {"success": False, "message": f"Cannot connect to provider at {chat_base_url} (see server logs)"}

        if provider_config.get('type') == 'groq':
            api_key = provider_config.get('api_key') or get_env_key('GROQ_API_KEY') or os.getenv('GROQ_API_KEY') or ''
            if not api_key:
                return {"success": False, "message": "GROQ_API_KEY not set (set api_key or env var)"}

            base_url = 'https://api.groq.com/openai/v1'

            try:
                async with httpx.AsyncClient() as client:
                    response = await client.get(
                        f"{base_url}/models",
                        headers={"Authorization": f"Bearer {api_key}"},
                        timeout=10.0,
                    )
                    if response.status_code == 200:
                        try:
                            data = response.json()
                            models = data.get('data') or []
                            return {"success": True, "message": f"Connected (Groq Speech). Found {len(models)} models."}
                        except Exception:
                            return {"success": True, "message": f"Connected (Groq Speech) (HTTP {response.status_code})"}
                    if response.status_code == 401:
                        return {"success": False, "message": "Invalid API key (401)"}
                    return {"success": False, "message": f"Provider API error: HTTP {response.status_code}"}
            except Exception as e:
                logger.debug("Groq Speech provider validation failed", error=str(e), exc_info=True)
                return {"success": False, "message": f"Cannot connect to provider at {base_url} (see server logs)"}
                
        elif 'google_live' in provider_config or ('llm_model' in provider_config and 'gemini' in provider_config.get('llm_model', '')):
            api_key = get_env_key('GOOGLE_API_KEY')
            if not api_key:
                return {"success": False, "message": "GOOGLE_API_KEY not set in .env file"}
            async with httpx.AsyncClient() as client:
                response = await client.get(
                    f"https://generativelanguage.googleapis.com/v1beta/models?key={api_key}",
                    timeout=10.0
                )
                if response.status_code == 200:
                    return {"success": True, "message": f"Connected to Google API (HTTP {response.status_code})"}
                return {"success": False, "message": f"Google API error: HTTP {response.status_code}"}
                
        elif 'ws_url' in provider_config:
            ws_url = provider_config.get('ws_url', '')
            if not ws_url:
                 return {"success": False, "message": "No WebSocket URL provided"}
            
            try:
                import websockets
                async with websockets.connect(ws_url, open_timeout=5.0) as ws:
                    await ws.close()
                return {"success": True, "message": "Local AI server is reachable via WebSocket"}
            except ImportError:
                 return {"success": False, "message": "websockets library not installed"}
            except Exception as e:
                return {"success": False, "message": f"Cannot reach local AI server at {ws_url}. Error: {str(e)}"}
        
        if 'ollama' in provider_name or provider_config.get('type') == 'ollama':
            import aiohttp
            base_url = provider_config.get('base_url', 'http://localhost:11434').rstrip('/')
            try:
                async with aiohttp.ClientSession() as session:
                    url = f"{base_url}/api/tags"
                    timeout = aiohttp.ClientTimeout(total=10)
                    async with session.get(url, timeout=timeout) as response:
                        if response.status == 200:
                            data = await response.json()
                            models = data.get("models", [])
                            return {"success": True, "message": f"Connected to Ollama! Found {len(models)} models."}
                        else:
                            return {"success": False, "message": f"Ollama returned status {response.status}"}
            except aiohttp.ClientConnectorError:
                return {"success": False, "message": f"Cannot connect to Ollama at {base_url}. Ensure Ollama is running and accessible."}
            except asyncio.TimeoutError:
                return {"success": False, "message": "Connection timeout - is Ollama running?"}
            except Exception as e:
                return {"success": False, "message": f"Ollama connection failed: {str(e)}"}
                
        elif 'model' in provider_config or 'stt_model' in provider_config or 'chat_model' in provider_config or 'tts_model' in provider_config:
            if provider_config.get('model', '').startswith('nova') or 'deepgram' in provider_name.lower():
                api_key = get_env_key('DEEPGRAM_API_KEY')
                if not api_key:
                    return {"success": False, "message": "DEEPGRAM_API_KEY not set in .env file"}
                async with httpx.AsyncClient() as client:
                    response = await client.get(
                        "https://api.deepgram.com/v1/projects",
                        headers={"Authorization": f"Token {api_key}"},
                        timeout=10.0
                    )
                    if response.status_code == 200:
                        return {"success": True, "message": f"Connected to Deepgram (HTTP {response.status_code})"}
                    return {"success": False, "message": f"Deepgram API error: HTTP {response.status_code}"}
            else:
                api_key = get_env_key('OPENAI_API_KEY')
                if api_key:
                   async with httpx.AsyncClient() as client:
                        try:
                            response = await client.get(
                                "https://api.openai.com/v1/models",
                                headers={"Authorization": f"Bearer {api_key}"},
                                timeout=5.0
                            )
                            if response.status_code == 200:
                                return {"success": True, "message": f"Connected to OpenAI (HTTP {response.status_code})"}
                        except:
                            pass
                
                return {"success": True, "message": "Provider configuration valid (No specific connection test available)"}
        
        if provider_config.get('type') == 'azure' or 'azure' in provider_name:
            api_key = get_env_key('AZURE_SPEECH_KEY') or os.getenv('AZURE_SPEECH_KEY') or ''
            if not api_key:
                return {"success": False, "message": "AZURE_SPEECH_KEY not set in .env file"}
            region = provider_config.get('region', 'eastus')
            import re
            _azure_region_re = re.compile(r"^[a-z][a-z0-9-]{0,48}[a-z0-9]$")
            region = str(region).strip().lower()
            if not region or not _azure_region_re.match(region):
                return {"success": False, "message": f"Invalid Azure region '{region}'. Expected lowercase alphanumeric (e.g. 'eastus')."}
            token_url = f"https://{region}.api.cognitive.microsoft.com/sts/v1.0/issueToken"
            try:
                async with httpx.AsyncClient() as client:
                    response = await client.post(
                        token_url,
                        headers={"Ocp-Apim-Subscription-Key": api_key},
                        timeout=10.0,
                    )
                    if response.status_code == 200:
                        capabilities = provider_config.get('capabilities', [])
                        cap_str = '/'.join(str(c).upper() for c in capabilities) if capabilities else 'Speech'
                        return {"success": True, "message": f"Connected to Azure Speech Service ({region}). {cap_str} key valid."}
                    if response.status_code == 401:
                        return {"success": False, "message": "Invalid AZURE_SPEECH_KEY (401 Unauthorized)"}
                    return {"success": False, "message": f"Azure Speech API returned HTTP {response.status_code} for region '{region}'"}
            except Exception as e:
                logger.debug("Azure Speech provider validation failed", error=str(e), exc_info=True)
                return {"success": False, "message": f"Cannot connect to Azure Speech Service at region '{region}' (see server logs)"}

        return {"success": False, "message": "Unknown provider type - cannot test"}
        
    except httpx.TimeoutException:
        return {"success": False, "message": "Connection timeout"}
    except Exception as e:
        return {"success": False, "message": f"Test failed: {str(e)}"}

@router.get("/export")
async def export_configuration():
    """Export configuration as a ZIP file"""
    try:
        import zipfile
        import io
        from datetime import datetime
        
        zip_buffer = io.BytesIO()
        
        with zipfile.ZipFile(zip_buffer, 'w', zipfile.ZIP_DEFLATED) as zip_file:
            if os.path.exists(settings.CONFIG_PATH):
                zip_file.write(settings.CONFIG_PATH, 'ai-agent.yaml')
            if os.path.exists(settings.LOCAL_CONFIG_PATH):
                zip_file.write(settings.LOCAL_CONFIG_PATH, 'ai-agent.local.yaml')
            
            if os.path.exists(settings.ENV_PATH):
                zip_file.write(settings.ENV_PATH, '.env')
            
            timestamp = datetime.now().isoformat()
            zip_file.writestr('backup_info.txt', f'Backup created: {timestamp}\n')
        
        zip_buffer.seek(0)
        
        from fastapi.responses import StreamingResponse
        return StreamingResponse(
            zip_buffer, 
            media_type="application/zip",
            headers={"Content-Disposition": f"attachment; filename=config-backup-{datetime.now().strftime('%Y%m%d-%H%M%S')}.zip"}
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/env/smtp/test")
async def test_smtp_settings(req: SmtpTestRequest):
    """
    Send a test email using SMTP_* settings from the project's .env file.

    This validates connectivity + auth using the *configured* SMTP settings (as saved by the UI),
    even before the ai_engine container is force-recreated to pick up env_file changes.
    """
    try:
        from dotenv import dotenv_values
    except Exception as e:
        raise HTTPException(status_code=500, detail="python-dotenv is required for SMTP test") from e

    if not (req.to_email or "").strip():
        raise HTTPException(status_code=400, detail="to_email is required")

    env_map = dotenv_values(settings.ENV_PATH) if os.path.exists(settings.ENV_PATH) else {}

    host = str((req.smtp_host if req.smtp_host is not None else (env_map or {}).get("SMTP_HOST")) or "").strip()
    if not host:
        raise HTTPException(status_code=400, detail="SMTP_HOST is not set (save it in .env or pass smtp_host)")

    tls_mode = str((req.smtp_tls_mode if req.smtp_tls_mode is not None else (env_map or {}).get("SMTP_TLS_MODE")) or "starttls").strip().lower()
    if tls_mode not in {"starttls", "smtps", "none"}:
        raise HTTPException(status_code=400, detail="SMTP_TLS_MODE must be starttls, smtps, or none")

    port_raw = str((req.smtp_port if req.smtp_port is not None else (env_map or {}).get("SMTP_PORT")) or "").strip()
    try:
        port = int(port_raw) if port_raw else (465 if tls_mode == "smtps" else 587)
    except Exception:
        raise HTTPException(status_code=400, detail="SMTP_PORT must be an integer")

    username = str((req.smtp_username if req.smtp_username is not None else (env_map or {}).get("SMTP_USERNAME")) or "").strip() or None
    password = str((req.smtp_password if req.smtp_password is not None else (env_map or {}).get("SMTP_PASSWORD")) or "").strip() or None

    timeout_raw = str((req.smtp_timeout_seconds if req.smtp_timeout_seconds is not None else (env_map or {}).get("SMTP_TIMEOUT_SECONDS")) or "10").strip()
    try:
        timeout_s = float(timeout_raw or "10")
    except Exception:
        timeout_s = 10.0

    tls_verify_raw = req.smtp_tls_verify if req.smtp_tls_verify is not None else (env_map or {}).get("SMTP_TLS_VERIFY")
    if isinstance(tls_verify_raw, bool):
        tls_verify = tls_verify_raw
    else:
        tls_verify = str(tls_verify_raw or "true").strip().lower() in {"1", "true", "yes", "on"}
    context = ssl.create_default_context()
    if not tls_verify:
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE

    from_email = (req.from_email or "").strip()
    if not from_email:
        from_email = (username or "test@localhost")

    subject = (req.subject or "").strip() or "Asterisk AI Voice Agent - SMTP Test"
    text = (req.text or "").strip() or (
        "This is a test email sent by the Admin UI to verify your SMTP settings.\n\n"
        "If you received this, SMTP is configured correctly."
    )

    msg = EmailMessage()
    msg["To"] = req.to_email.strip()
    msg["From"] = from_email
    msg["Subject"] = subject
    msg.set_content(text)

    def _send_sync() -> None:
        if tls_mode == "smtps":
            with smtplib.SMTP_SSL(host=host, port=port, timeout=timeout_s, context=context) as smtp:
                smtp.ehlo()
                if username and password:
                    smtp.login(username, password)
                smtp.send_message(msg, to_addrs=[req.to_email.strip()])
            return

        with smtplib.SMTP(host=host, port=port, timeout=timeout_s) as smtp:
            smtp.ehlo()
            if tls_mode == "starttls":
                smtp.starttls(context=context)
                smtp.ehlo()
            if username and password:
                smtp.login(username, password)
            smtp.send_message(msg, to_addrs=[req.to_email.strip()])

    try:
        await asyncio.to_thread(_send_sync)
        return {
            "success": True,
            "message": "Test email accepted by SMTP server",
            "host": host,
            "port": port,
            "tls_mode": tls_mode,
            "tls_verify": tls_verify,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"SMTP test failed: {str(e)}")

@router.get("/export-logs")
async def export_logs():
    """Export logs and sanitized configuration for troubleshooting"""
    try:
        import zipfile
        import io
        import glob
        from datetime import datetime
        import subprocess
        
        zip_buffer = io.BytesIO()
        
        with zipfile.ZipFile(zip_buffer, 'w', zipfile.ZIP_DEFLATED) as zip_file:
            try:
                import yaml
                parsed = _read_merged_config_dict()

                import re
                email_pattern = re.compile(r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}')
                hostname_pattern = re.compile(r'\b(?:pbx|sip|voip|trunk|asterisk)[a-zA-Z0-9.-]*\.[a-zA-Z]{2,}\b', re.IGNORECASE)
                
                def redact(obj):
                    if isinstance(obj, dict):
                        out = {}
                        for k, v in obj.items():
                            key = str(k).lower()
                            if any(s in key for s in ["api_key", "apikey", "token", "secret", "password", "pass", "key"]):
                                out[k] = "[REDACTED]"
                            elif "email" in key:
                                out[k] = "[EMAIL_REDACTED]"
                            else:
                                out[k] = redact(v)
                        return out
                    if isinstance(obj, list):
                        return [redact(v) for v in obj]
                    if isinstance(obj, str):
                        result = email_pattern.sub('[EMAIL_REDACTED]', obj)
                        result = hostname_pattern.sub('[HOSTNAME_REDACTED]', result)
                        return result
                    return obj

                if parsed:
                    redacted = redact(parsed)
                    zip_file.writestr(
                        'ai-agent-sanitized.yaml',
                        yaml.safe_dump(redacted, sort_keys=False, default_flow_style=False),
                    )
            except Exception:
                if os.path.exists(settings.CONFIG_PATH):
                    with open(settings.CONFIG_PATH, 'r') as f:
                        zip_file.writestr('ai-agent-sanitized.yaml', f.read())
            
            if os.path.exists(settings.ENV_PATH):
                env_keys = []
                with open(settings.ENV_PATH, 'r') as f:
                    for line in f:
                        if '=' in line and not line.startswith('#'):
                            key = line.split('=')[0].strip()
                            env_keys.append(f"{key}=[REDACTED]")
                zip_file.writestr('.env.sanitized', '\n'.join(env_keys))

            for os_release in ("/host/etc/os-release", "/etc/os-release"):
                if os.path.exists(os_release):
                    try:
                        with open(os_release, "r") as f:
                            zip_file.writestr("os-release.txt", f.read())
                        break
                    except Exception:
                        pass

            def add_cmd(name: str, cmd: list):
                try:
                    result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
                    content = (result.stdout or "") + ("\n" + result.stderr if result.stderr else "")
                    zip_file.writestr(name, content.strip() + "\n")
                except Exception as e:
                    zip_file.writestr(name, f"Failed to run {cmd}: {e}\n")

            add_cmd("docker-version.txt", ["docker", "version"])
            add_cmd("docker-compose-version.txt", ["docker", "compose", "version"])
            add_cmd("docker-ps.txt", ["docker", "ps", "-a"])
            
            try:
                import docker
                client = docker.from_env()
                containers_to_log = ['ai_engine', 'local_ai_server', 'admin_ui']
                
                found_logs = False
                for container_name in containers_to_log:
                    try:
                        container = client.containers.get(container_name)
                        logs = container.logs().decode('utf-8', errors='replace')
                        if logs:
                            clean_logs = strip_ansi_codes(logs)
                            import re
                            clean_logs = re.sub(r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}', '[EMAIL_REDACTED]', clean_logs)
                            clean_logs = re.sub(r'\b(?:pbx|sip|voip|trunk|asterisk)[a-zA-Z0-9.-]*\.[a-zA-Z]{2,}\b', '[HOSTNAME_REDACTED]', clean_logs, flags=re.IGNORECASE)
                            clean_logs = re.sub(r'(api_key_preview=)[^\s\]]+', r'\1[REDACTED]', clean_logs)
                            zip_file.writestr(f'{container_name}.log', clean_logs)
                            found_logs = True
                    except Exception as e:
                        zip_file.writestr(f'{container_name}_error.txt', f"Could not fetch logs: {str(e)}")
                
                if not found_logs:
                    zip_file.writestr('logs_info.txt', 'No logs retrieved from containers.')

            except Exception as e:
                 zip_file.writestr('docker_error.txt', f"Failed to connect to Docker API: {str(e)}")

            timestamp = datetime.now().isoformat()
            zip_file.writestr('export_info.txt', f'Debug export created: {timestamp}\n')
        
        zip_buffer.seek(0)
        
        from fastapi.responses import StreamingResponse
        return StreamingResponse(
            zip_buffer, 
            media_type="application/zip",
            headers={"Content-Disposition": f"attachment; filename=debug-logs-{datetime.now().strftime('%Y%m%d-%H%M%S')}.zip"}
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/import")
async def import_configuration(file: UploadFile = File(...)):
    """Import configuration from a ZIP file"""
    try:
        import zipfile
        import io
        import shutil
        import datetime
        
        content = await file.read()
        zip_buffer = io.BytesIO(content)
        
        if not zipfile.is_zipfile(zip_buffer):
             raise HTTPException(status_code=400, detail="Invalid file format. Must be a ZIP file.")
        
        timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        
        if os.path.exists(settings.LOCAL_CONFIG_PATH):
            backup_path = f"{settings.LOCAL_CONFIG_PATH}.bak.{timestamp}"
            shutil.copy2(settings.LOCAL_CONFIG_PATH, backup_path)
            
        if os.path.exists(settings.ENV_PATH):
            backup_path = f"{settings.ENV_PATH}.bak.{timestamp}"
            shutil.copy2(settings.ENV_PATH, backup_path)
        
        with zipfile.ZipFile(zip_buffer, 'r') as zip_ref:
            file_names = zip_ref.namelist()
            if 'ai-agent.yaml' not in file_names and 'ai-agent.local.yaml' not in file_names and '.env' not in file_names:
                raise HTTPException(status_code=400, detail="ZIP must contain ai-agent.yaml, ai-agent.local.yaml, or .env")
            
            if 'ai-agent.local.yaml' in file_names:
                with open(settings.LOCAL_CONFIG_PATH, 'wb') as f:
                    f.write(zip_ref.read('ai-agent.local.yaml'))
            elif 'ai-agent.yaml' in file_names:
                with open(settings.LOCAL_CONFIG_PATH, 'wb') as f:
                    f.write(zip_ref.read('ai-agent.yaml'))
                    
            if '.env' in file_names:
                with open(settings.ENV_PATH, 'wb') as f:
                    f.write(zip_ref.read('.env'))
                    
        return {"success": True, "message": "Configuration imported successfully."}
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Import failed: {str(e)}")

def update_yaml_provider_field(provider_name: str, field: str, value: Any) -> bool:
    """
    Update a single field in a provider's YAML config.

    This helper is used by model-management flows (local-ai sync).

    Reads the merged config (base + local), applies the change, validates,
    and writes the result to the LOCAL override file so the git-tracked
    base stays clean.
    """
    try:
        base_config = _read_base_config_dict()
        merged_config = _read_merged_config_dict()
        if not merged_config:
            return False

        providers = merged_config.get('providers')
        if not isinstance(providers, dict):
            providers = {}
        provider_block = providers.get(provider_name)
        if not isinstance(provider_block, dict):
            provider_block = {}

        if value is None:
            provider_block.pop(field, None)
        else:
            provider_block[field] = value

        providers[provider_name] = provider_block
        merged_config['providers'] = providers

        merged_content = yaml.dump(merged_config, default_flow_style=False, sort_keys=False)

        _validate_ai_agent_config(merged_content)

        local_override = _compute_local_override(base_config, merged_config)
        content = yaml.dump(local_override, default_flow_style=False, sort_keys=False)

        _write_local_config(content)

        return True
    except Exception as e:
        print(f"Error updating YAML provider field: {e}")
        return False

@router.get("/options/{provider_type}")

async def get_provider_options(provider_type: str):
    """Get available options (models, voices) for a specific provider."""
    
    DEEPGRAM_MODELS = [
        {"id": "nova-2", "name": "Nova 2 (General)", "cost": "Low", "latency": "Ultra Low"},
        {"id": "nova-2-phonecall", "name": "Nova 2 (Phonecall)", "cost": "Low", "latency": "Ultra Low"},
        {"id": "nova-2-medical", "name": "Nova 2 (Medical)", "cost": "Low", "latency": "Ultra Low"},
        {"id": "nova-2-meeting", "name": "Nova 2 (Meeting)", "cost": "Low", "latency": "Ultra Low"},
        {"id": "nova-2-general", "name": "Nova 2 (General Legacy)", "cost": "Low", "latency": "Ultra Low"},
        {"id": "listen", "name": "General (Listen)", "cost": "Medium", "latency": "Low"},
    ]
    
    OPENAI_LLM_MODELS = [
        {"id": "gpt-4o", "name": "GPT-4o (Omni)", "description": "Most capable"},
        {"id": "gpt-4o-mini", "name": "GPT-4o Mini", "description": "Fast & Cheap"},
        {"id": "gpt-4-turbo", "name": "GPT-4 Turbo", "description": "High intelligence"},
        {"id": "gpt-3.5-turbo", "name": "GPT-3.5 Turbo", "description": "Legacy fast"},
    ]
    
    OPENAI_STT_MODELS = [
        {"id": "whisper-1", "name": "Whisper V1"}
    ]

    OPENAI_REALTIME_MODELS = [
        {"id": "gpt-realtime-2", "name": "GPT Realtime 2"},
        {"id": "gpt-realtime-1.5", "name": "GPT Realtime 1.5"},
        {"id": "gpt-realtime", "name": "GPT Realtime"},
    ]

    OPENAI_REALTIME_VOICES = [
        {"id": "alloy", "name": "Alloy"},
        {"id": "ash", "name": "Ash"},
        {"id": "ballad", "name": "Ballad"},
        {"id": "coral", "name": "Coral"},
        {"id": "echo", "name": "Echo"},
        {"id": "sage", "name": "Sage"},
        {"id": "shimmer", "name": "Shimmer"},
        {"id": "verse", "name": "Verse"},
        {"id": "marin", "name": "Marin", "recommended": True},
        {"id": "cedar", "name": "Cedar", "recommended": True},
    ]
    
    GOOGLE_MODELS = [
        {"id": "gemini-1.5-flash", "name": "Gemini 1.5 Flash (Fastest)"},
        {"id": "gemini-1.5-pro", "name": "Gemini 1.5 Pro (Best Quality)"},
    ]

    GOOGLE_VOICES = [
        {"id": "en-US-Standard-A", "name": "US Female Standard"},
        {"id": "en-US-Standard-B", "name": "US Male Standard"},
        {"id": "en-US-Neural2-A", "name": "US Female Neural"},
        {"id": "en-US-Neural2-C", "name": "US Male Neural"},
        {"id": "en-US-Studio-O", "name": "US Female Studio"},
        {"id": "en-US-Studio-Q", "name": "US Male Studio"},
    ]

    if provider_type == "deepgram":
        return {"models": DEEPGRAM_MODELS}
        
    elif provider_type == "openai":
        return {
            "stt_models": OPENAI_STT_MODELS,
            "llm_models": OPENAI_LLM_MODELS,
            "tts_models": [{"id": "tts-1", "name": "TTS-1"}, {"id": "tts-1-hd", "name": "TTS-1 HD"}]
        }

    elif provider_type == "openai_realtime":
        return {
            "models": OPENAI_REALTIME_MODELS,
            "voices": OPENAI_REALTIME_VOICES,
            "reasoning_efforts": [
                {"id": "low", "name": "Low"},
                {"id": "medium", "name": "Medium"},
                {"id": "high", "name": "High"},
            ],
            "speed": {"min": 0.25, "max": 1.5, "step": 0.05, "default": 1.0},
            "max_output_tokens": {"min": 1, "max": 4096, "default": 4096},
            "parallel_tool_calls": {"default": False},
        }
        
    elif provider_type == "google":
        return {
            "models": GOOGLE_MODELS,
            "voices": GOOGLE_VOICES
        }
        
    elif provider_type == "elevenlabs":
        return {
            "models": [
                {"id": "eleven_turbo_v2_5", "name": "Turbo v2.5"},
                {"id": "eleven_multilingual_v2", "name": "Multilingual v2"},
                {"id": "eleven_monolingual_v1", "name": "Monolingual v1"}
            ]
        }
        
    elif provider_type == "local":
        return {"message": "Use /api/local-ai/models for dynamic local models"}
        
    return {"error": "Unknown provider type"}

VERTEX_CREDENTIALS_PATH = "/app/project/secrets/gcp-service-account.json"
VERTEX_REGIONS = [
    {"value": "us-central1", "label": "US Central (Iowa)"},
    {"value": "us-east1", "label": "US East (South Carolina)"},
    {"value": "us-east4", "label": "US East (Northern Virginia)"},
    {"value": "us-west1", "label": "US West (Oregon)"},
    {"value": "us-west4", "label": "US West (Las Vegas)"},
    {"value": "europe-west1", "label": "Europe West (Belgium)"},
    {"value": "europe-west2", "label": "Europe West (London)"},
    {"value": "europe-west3", "label": "Europe West (Frankfurt)"},
    {"value": "europe-west4", "label": "Europe West (Netherlands)"},
    {"value": "asia-east1", "label": "Asia East (Taiwan)"},
    {"value": "asia-northeast1", "label": "Asia Northeast (Tokyo)"},
    {"value": "asia-southeast1", "label": "Asia Southeast (Singapore)"},
    {"value": "australia-southeast1", "label": "Australia (Sydney)"},
]

@router.get("/vertex-ai/regions")
async def get_vertex_regions():
    """Return available Vertex AI regions."""
    return {"regions": VERTEX_REGIONS}

@router.get("/vertex-ai/credentials")
async def get_vertex_credentials_status():
    """Check if Vertex AI credentials are uploaded and return metadata."""
    import json
    
    if not os.path.exists(VERTEX_CREDENTIALS_PATH):
        return {
            "uploaded": False,
            "filename": None,
            "project_id": None,
            "client_email": None,
            "uploaded_at": None,
        }
    
    try:
        stat = os.stat(VERTEX_CREDENTIALS_PATH)
        with open(VERTEX_CREDENTIALS_PATH, 'r') as f:
            creds = json.load(f)
        
        return {
            "uploaded": True,
            "filename": "gcp-service-account.json",
            "project_id": creds.get("project_id"),
            "client_email": creds.get("client_email"),
            "uploaded_at": stat.st_mtime,
        }
    except Exception as e:
        logger.error(f"Error reading Vertex AI credentials: {e}")
        return {
            "uploaded": True,
            "filename": "gcp-service-account.json",
            "project_id": None,
            "client_email": None,
            "error": "Failed to read credentials file",
        }

@router.post("/vertex-ai/credentials")
async def upload_vertex_credentials(file: UploadFile = File(...)):
    """Upload a GCP service account JSON file for Vertex AI authentication."""
    import json
    
    if not file.filename or not file.filename.endswith('.json'):
        raise HTTPException(status_code=400, detail="File must be a JSON file")
    
    try:
        content = await file.read()
        creds = json.loads(content)
        
        required_fields = ["type", "project_id", "private_key", "client_email"]
        missing = [f for f in required_fields if f not in creds]
        if missing:
            raise HTTPException(
                status_code=400, 
                detail=f"Invalid service account JSON. Missing fields: {', '.join(missing)}"
            )
        
        if creds.get("type") != "service_account":
            raise HTTPException(
                status_code=400,
                detail="JSON file must be a service account key (type: service_account)"
            )
        
        os.makedirs(os.path.dirname(VERTEX_CREDENTIALS_PATH), exist_ok=True)
        
        temp_path = VERTEX_CREDENTIALS_PATH + ".tmp"
        with open(temp_path, 'wb') as f:
            f.write(content)
        os.chmod(temp_path, 0o600)
        os.replace(temp_path, VERTEX_CREDENTIALS_PATH)
        
        try:
            _upsert_env_key("GOOGLE_APPLICATION_CREDENTIALS", "/app/project/secrets/gcp-service-account.json")
        except Exception:
            logger.warning("Could not auto-set GOOGLE_APPLICATION_CREDENTIALS in .env")

        logger.info(f"Vertex AI credentials uploaded: project={creds.get('project_id')}")
        
        return {
            "status": "success",
            "message": "Service account JSON uploaded successfully",
            "project_id": creds.get("project_id"),
            "client_email": creds.get("client_email"),
        }
        
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON file")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error uploading Vertex AI credentials: {e}")
        raise HTTPException(status_code=500, detail="Failed to upload credentials")

@router.delete("/vertex-ai/credentials")
async def delete_vertex_credentials():
    """Delete the uploaded Vertex AI credentials file."""
    if not os.path.exists(VERTEX_CREDENTIALS_PATH):
        raise HTTPException(status_code=404, detail="No credentials file found")
    
    try:
        os.remove(VERTEX_CREDENTIALS_PATH)
        logger.info("Vertex AI credentials deleted")
        return {"status": "success", "message": "Credentials deleted"}
    except Exception as e:
        logger.error(f"Error deleting Vertex AI credentials: {e}")
        raise HTTPException(status_code=500, detail="Failed to delete credentials")

@router.post("/vertex-ai/verify")
async def verify_vertex_credentials():
    """Verify Vertex AI credentials by attempting to get an access token."""
    import json
    
    if not os.path.exists(VERTEX_CREDENTIALS_PATH):
        raise HTTPException(status_code=400, detail="No credentials file uploaded")
    
    try:
        import asyncio
        from google.oauth2 import service_account
        from google.auth.transport.requests import Request
        
        def _refresh_credentials():
            """Blocking credential refresh - run in thread to avoid blocking event loop."""
            creds = service_account.Credentials.from_service_account_file(
                VERTEX_CREDENTIALS_PATH,
                scopes=["https://www.googleapis.com/auth/cloud-platform"]
            )
            creds.refresh(Request())
            return creds
        
        credentials = await asyncio.to_thread(_refresh_credentials)
        
        with open(VERTEX_CREDENTIALS_PATH, 'r') as f:
            creds_data = json.load(f)
        
        return {
            "status": "success",
            "message": "Credentials verified successfully",
            "project_id": creds_data.get("project_id"),
            "client_email": creds_data.get("client_email"),
            "token_expiry": credentials.expiry.isoformat() if credentials.expiry else None,
        }
        
    except ImportError:
        try:
            with open(VERTEX_CREDENTIALS_PATH, 'r') as f:
                creds_data = json.load(f)
            
            required = ["type", "project_id", "private_key", "client_email"]
            if all(k in creds_data for k in required):
                return {
                    "status": "success",
                    "message": "Credentials file structure is valid (full verification requires google-auth)",
                    "project_id": creds_data.get("project_id"),
                    "client_email": creds_data.get("client_email"),
                    "warning": "Install google-auth for full token verification",
                }
            else:
                raise HTTPException(status_code=400, detail="Invalid credentials structure")
        except json.JSONDecodeError:
            raise HTTPException(status_code=400, detail="Invalid JSON in credentials file")
            
    except Exception as e:
        logger.error(f"Error verifying Vertex AI credentials: {e}")
        raise HTTPException(status_code=400, detail="Verification failed - check credentials are valid")
