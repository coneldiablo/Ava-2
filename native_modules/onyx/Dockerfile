# Build context: repository root. This is the storage-boundary increment, NOT
# the completed native-login adapter and NOT eligible for production rollout.
FROM onyxdotapp/onyx-backend:v4.7.0@sha256:473fdffe4e67fb67dcdac154c57d595ba73d7bf64b5926d24807a86d7e888d6f
USER root
COPY native_modules/upstreams.lock.json /tmp/ava-extension/upstreams.lock.json
COPY native_modules/onyx/ava_namespace.py native_modules/onyx/install_namespace.py /tmp/ava-extension/
RUN AVA_EXTENSION_BUILD=1 python /tmp/ava-extension/install_namespace.py \
    && python -m compileall -q /app/onyx/ava_namespace.py /app/onyx/configs/app_configs.py /app/onyx/document_index/opensearch/client.py \
    && rm -rf /tmp/ava-extension
LABEL org.opencontainers.image.source="https://github.com/coneldiablo/ava-server-prod-private" \
      org.opencontainers.image.description="AVA isolated knowledge storage boundary; native login not yet accepted" \
      ava.upstream.revision="a1b9e02eb65cc114c65381cbef5e555e1753ed0a"
# The released upstream image currently runs as root. The isolated deployment
# helper must provide writable per-tenant mounts owned by this existing UID.
USER 1001:1001
