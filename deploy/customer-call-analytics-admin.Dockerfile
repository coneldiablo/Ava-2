# This release layer preserves the deployed Admin frontend and its reviewed
# customer hotfixes. The source files below are overlaid only after their
# baseline SHA-256 has been compared with the running image.
ARG BASE_IMAGE=ava-customer-admin:dd9c2e7-attempts
FROM ${BASE_IMAGE}

COPY admin_ui/backend/api/calls.py /app/api/calls.py
COPY src/core/call_history.py /opt/ava-runtime-source/src/core/call_history.py
