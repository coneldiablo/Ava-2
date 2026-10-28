#!/bin/sh
set -eu

UI_RENDERER_WORKDIR="${UI_RENDERER_WORKDIR:-/app/ui}"
UI_RENDERER_PORT="${UI_RENDERER_PORT:-3100}"

ui_pid=""
api_pid=""

cleanup() {
  if [ -n "$ui_pid" ] && kill -0 "$ui_pid" 2>/dev/null; then
    kill "$ui_pid" 2>/dev/null || true
    wait "$ui_pid" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

if [ "${UI_RENDERER_ENABLED:-0}" = "1" ] || [ "${UI_RENDERER_ENABLED:-}" = "true" ]; then
  if command -v node >/dev/null 2>&1 && [ -f "$UI_RENDERER_WORKDIR/build/server/index.js" ]; then
    (
      cd "$UI_RENDERER_WORKDIR"
      PORT="$UI_RENDERER_PORT" node build/server/index.js
    ) &
    ui_pid="$!"

    ready=0
    i=0
    while [ "$i" -lt 30 ]; do
      if ! kill -0 "$ui_pid" 2>/dev/null; then
        echo "UI renderer exited before becoming ready." >&2
        wait "$ui_pid" 2>/dev/null || true
        exit 1
      fi

      if curl --silent --show-error --output /dev/null --max-time 1 "http://127.0.0.1:$UI_RENDERER_PORT/"; then
        ready=1
        break
      fi

      i=$((i + 1))
      sleep 1
    done

    if [ "$ready" -ne 1 ]; then
      echo "UI renderer did not become ready on port $UI_RENDERER_PORT." >&2
      exit 1
    fi
  else
    echo "UI renderer is enabled, but the Node runtime or build/server/index.js is missing." >&2
    exit 1
  fi
fi

uvicorn main:app \
  --host "${UVICORN_HOST:-0.0.0.0}" \
  --port "${UVICORN_PORT:-3003}" \
  --log-config /app/uvicorn_log_config.yaml &
api_pid="$!"

while kill -0 "$api_pid" 2>/dev/null; do
  if [ -n "$ui_pid" ] && ! kill -0 "$ui_pid" 2>/dev/null; then
    echo "UI renderer exited unexpectedly." >&2
    kill "$api_pid" 2>/dev/null || true
    wait "$api_pid" 2>/dev/null || true
    exit 1
  fi
  sleep 1
done

wait "$api_pid"
