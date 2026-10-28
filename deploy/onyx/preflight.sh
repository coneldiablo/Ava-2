#!/bin/sh
set -eu

TARGET="${1:-/opt/onyx-v4.7.0}"
DEPLOY_DIR="$TARGET/deployment/docker_compose"
ENV_FILE="$DEPLOY_DIR/.env"
NGINX_ENV_FILE="$DEPLOY_DIR/.env.nginx"
EXPECTED_COMMIT="a1b9e02eb65cc114c65381cbef5e555e1753ed0a"

test -f "$ENV_FILE" || { echo "Missing $ENV_FILE" >&2; exit 1; }
test -f "$NGINX_ENV_FILE" || { echo "Missing $NGINX_ENV_FILE" >&2; exit 1; }
test "$(git -C "$TARGET" rev-parse HEAD)" = "$EXPECTED_COMMIT" || {
  echo "Onyx checkout is not the reviewed v4.7.0 commit" >&2
  exit 1
}
test -z "$(git -C "$TARGET" status --porcelain --untracked-files=no)" || {
  echo "Onyx tracked files are modified; refusing deployment" >&2
  exit 1
}

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

require_strong() {
  name="$1"
  eval "value=\${$name:-}"
  if [ "${#value}" -lt 20 ]; then
    echo "$name must contain at least 20 characters" >&2
    exit 1
  fi
  case "$value" in
    password|minioadmin|StrongPassword123\!*|replace-*|change-*)
      echo "$name still contains an unsafe placeholder" >&2
      exit 1
      ;;
  esac
}

test "${IMAGE_TAG:-}" = "v4.7.0" || { echo "IMAGE_TAG must be v4.7.0" >&2; exit 1; }
case "${WEB_DOMAIN:-}" in
  https://*) ;;
  *) echo "WEB_DOMAIN must be a public HTTPS URL" >&2; exit 1 ;;
esac

for name in POSTGRES_PASSWORD DB_READONLY_PASSWORD OPENSEARCH_ADMIN_PASSWORD \
  S3_AWS_ACCESS_KEY_ID S3_AWS_SECRET_ACCESS_KEY MINIO_ROOT_USER MINIO_ROOT_PASSWORD; do
  require_strong "$name"
done

case "${S3_ENDPOINT_URL:-}" in
  http://minio:9000|https://*) ;;
  *) echo "S3_ENDPOINT_URL must use the internal MinIO address or HTTPS" >&2; exit 1 ;;
esac

docker compose \
  --env-file "$ENV_FILE" \
  -f "$DEPLOY_DIR/docker-compose.prod-no-letsencrypt.yml" \
  config --quiet

echo "Onyx v4.7.0 preflight passed. No containers were started."
