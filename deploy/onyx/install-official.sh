#!/bin/sh
set -eu

ONYX_TAG="v4.7.0"
ONYX_COMMIT="a1b9e02eb65cc114c65381cbef5e555e1753ed0a"
TARGET="${1:-/opt/onyx-v4.7.0}"
REPOSITORY="https://github.com/onyx-dot-app/onyx.git"

if [ -e "$TARGET" ] && [ ! -d "$TARGET/.git" ]; then
  echo "Refusing to overwrite non-Onyx path: $TARGET" >&2
  exit 1
fi

if [ ! -d "$TARGET/.git" ]; then
  git clone --depth 1 --branch "$ONYX_TAG" "$REPOSITORY" "$TARGET"
fi

ACTUAL_COMMIT="$(git -C "$TARGET" rev-parse HEAD)"
if [ "$ACTUAL_COMMIT" != "$ONYX_COMMIT" ]; then
  echo "Unexpected Onyx commit: $ACTUAL_COMMIT (expected $ONYX_COMMIT)" >&2
  exit 1
fi

DEPLOY_DIR="$TARGET/deployment/docker_compose"
if [ ! -f "$DEPLOY_DIR/.env" ]; then
  cp "$(dirname "$0")/.env.example" "$DEPLOY_DIR/.env"
  chmod 600 "$DEPLOY_DIR/.env"
  echo "Created $DEPLOY_DIR/.env. Fill the secrets before starting Onyx."
fi
if [ ! -f "$DEPLOY_DIR/.env.nginx" ]; then
  cp "$DEPLOY_DIR/env.nginx.template" "$DEPLOY_DIR/.env.nginx"
  chmod 600 "$DEPLOY_DIR/.env.nginx"
fi

echo "Onyx $ONYX_TAG is pinned at $ONYX_COMMIT in $TARGET."
echo "Next: edit .env and .env.nginx, then run preflight.sh from the AVA repository."
