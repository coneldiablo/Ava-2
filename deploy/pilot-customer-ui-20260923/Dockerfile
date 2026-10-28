FROM ava-pilot-customer-ui:20260922

# This release only changes the customer-facing frontend. The running CRM,
# WhatsApp connector, native module gateway and databases remain untouched.
COPY dist/ /app/frontend/dist/
LABEL ava.release.scope="customer-whatsapp-relink-and-direct-sso-entry"
