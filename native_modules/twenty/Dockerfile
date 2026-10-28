# Build from repository root:
# docker build --build-arg TWENTY_IMAGE=twentycrm/twenty:v2.37.0 \
#   -f native_modules/twenty/Dockerfile -t ava-twenty-native:local .
# Production must replace TWENTY_IMAGE with the approved immutable digest.
ARG TWENTY_IMAGE=twentycrm/twenty:v2.37.0
FROM ${TWENTY_IMAGE}

# These files are verified against the locked Community source by
# prepare-twenty-community-extension.py. The preload hooks Nest's HTTP factory
# only; Twenty's normal worker entry point is deliberately unchanged.
USER root
RUN mkdir -p /app/packages/twenty-server/dist/ava-native /var/lib/ava-native /var/lib/ava-storage /var/lib/ava-runtime-credentials
COPY native_modules/twenty/adapter.cjs native_modules/twenty/install.cjs native_modules/twenty/preload.cjs native_modules/twenty/runtime-config.cjs native_modules/twenty/bootstrap.cjs native_modules/twenty/crm-bootstrap.cjs native_modules/twenty/initializer.cjs /app/packages/twenty-server/dist/ava-native/
COPY native_modules/twenty/qa/ /app/packages/twenty-server/dist/ava-native/qa/
COPY native_modules/twenty/schema-bootstrap.cjs native_modules/twenty/runtime-key.cjs /app/packages/twenty-server/dist/ava-native/
COPY native_modules/twenty/attach-existing-workspace.cjs /app/packages/twenty-server/dist/ava-native/
COPY whatsapp_crm/src/services/twenty/schema-manifest.json /app/packages/twenty-server/dist/ava-native/schema-manifest.json
RUN chown -R node:node /app/packages/twenty-server/dist/ava-native /var/lib/ava-native /var/lib/ava-storage /var/lib/ava-runtime-credentials \
    && chmod 700 /var/lib/ava-native /var/lib/ava-storage /var/lib/ava-runtime-credentials
USER node
ENV NODE_OPTIONS="--require=/app/packages/twenty-server/dist/ava-native/preload.cjs"
