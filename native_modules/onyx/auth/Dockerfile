# Build context: prepared Onyx backend directory, after prepare-onyx-auth-extension.py.
# This sidecar must have no published host port; bind it only to the container
# network/private loopback selected by the deployment orchestrator.
ARG ONYX_STORAGE_IMAGE
FROM ${ONYX_STORAGE_IMAGE}
USER root
COPY onyx/ava_auth /app/onyx/ava_auth
# The verified storage image supplies the pinned Onyx requirements, including
# cryptography. Do not resolve packages during an auth-image build.
USER 1001
ENV PYTHONPATH=/app
EXPOSE 4011
CMD ["uvicorn", "onyx.ava_auth.app:app", "--host", "0.0.0.0", "--port", "4011", "--no-access-log"]
