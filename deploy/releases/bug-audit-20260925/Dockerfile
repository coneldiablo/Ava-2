ARG BASE_IMAGE=ava-command-center-crm:20260924-v1
FROM ${BASE_IMAGE}

# Keep the exact production application and its native CRM/knowledge routes.
# Only the audited files below replace files in the previously released image.
COPY src/routes/customer-team.routes.js /app/src/routes/customer-team.routes.js
COPY src/routes/identity.routes.js /app/src/routes/identity.routes.js
COPY src/routes/module-access.routes.js /app/src/routes/module-access.routes.js
COPY src/services/auth.service.js /app/src/services/auth.service.js
COPY src/services/identity/invitation-errors.js /app/src/services/identity/invitation-errors.js
COPY src/services/identity/owner-verification-store.js /app/src/services/identity/owner-verification-store.js
COPY src/services/identity/public-url.js /app/src/services/identity/public-url.js
COPY src/services/identity/system-mailer.service.js /app/src/services/identity/system-mailer.service.js
COPY src/services/twenty/schema-manifest.json /app/src/services/twenty/schema-manifest.json
COPY src/services/twenty/twenty-store.service.js /app/src/services/twenty/twenty-store.service.js
COPY src/services/twenty/twenty.service.js /app/src/services/twenty/twenty.service.js
COPY frontend/dist/ /app/frontend/dist/
