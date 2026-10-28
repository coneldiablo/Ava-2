# Customer UI hotfix, 23 September 2026

The image layers the reviewed frontend build over the exact 22 September CRM
image. It adds the hotel-owner WhatsApp number replacement action and skips the
intermediate AVA login click when OIDC is enabled. It does not replace any live
WhatsApp session, change Keycloak configuration, or modify tenant data.

Before deployment, verify the current CRM image is
`sha256:5c1aad6fb8fe8b4e06e3fa5d7915e244e23261c18f86d7844e9eb6e1952813a4`.
Run `npm run build` in `whatsapp_crm/frontend` and copy only its `dist` into
this Docker build context on the server. Build `ava-pilot-customer-ui:20260923`
without a network connection and validate the Compose configuration with this
`override.json` appended after the existing CRM runtime override. Recreate
only `whatsapp_crm`; keep the earlier release override in the Compose file list
for rollback.

Rollback: remove this override from the same Compose command and recreate only
`whatsapp_crm`. The previous `ava-pilot-customer-ui:20260922` image remains
available. No schema rollback is needed.

Live verification: CRM is `healthy` with no restarts; both AVA health endpoints
returned 200; an anonymous customer API request returned 401. An unauthenticated
browser visit to `wh.meludtech.tech` reached the Russian AVA identity password
form automatically, without a second click. The new number-replacement button
was covered by owner/foreign-business HTTP tests, but was deliberately not
clicked against the currently linked production WhatsApp number. No live
message delivery was claimed by this release.
