from __future__ import annotations

import logging
from typing import Any, Dict

from capabilities import detect_capabilities
from control_plane import apply_switch_model_request
from status_builder import build_status_response


class ModelManager:
    def __init__(self, server: Any):
        self._server = server

    async def switch_model(self, data: Dict[str, Any]) -> Dict[str, Any]:
        dry_run = bool(data.get("dry_run", False))
        new_config, changed = apply_switch_model_request(self._server.config, data)

        if not changed:
            return {
                "type": "switch_response",
                "status": "no_change",
                "message": "No valid model parameters provided",
            }

        self._server.config = new_config
        self._server._apply_config(self._server.config)
        self._server.buffer_timeout_ms = self._server.config.stt_idle_ms

        logging.info("📝 Configuration updated: %s", ", ".join(changed))
        if dry_run:
            logging.info("🧪 SWITCH MODEL DRY-RUN - Skipping reload_models()")
        else:
            await self._server.reload_models()

        return {
            "type": "switch_response",
            "status": "success",
            "message": (
                f"Models switched (dry_run): {', '.join(changed)}"
                if dry_run
                else f"Models switched and reloaded: {', '.join(changed)}"
            ),
            "changed": changed,
        }

    def status(self) -> Dict[str, Any]:
        return build_status_response(self._server)

    def capabilities(self) -> Dict[str, Any]:
        return detect_capabilities(self._server.config)

