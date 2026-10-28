# OpenWA product context overlay

This overlay retains the deployed OpenWA **0.23.4** runtime and its WhatsApp
sessions. It adds only the product metadata already exposed by the installed
`whatsapp-web.js` 1.34.7 `Message`: `productId`, `title`, `description` and
`businessOwnerJid`. The current `unknown` type mapping remains unchanged.

The shared mapper supplies direct products to live callbacks and chat history.
The inbound quote and history quote serializers retain the same product fields,
with the existing `_serialized` / `$1` message ID fallback. The message-row
serializer saves the optional product beside existing media, quote and call
metadata. Own-send quoted-message enrichment is outside this overlay's scope.
No new raw advertisement/referral shape is inferred or exposed.

Upstream implementation references:

- [OpenWA product/order implementation c400af9](https://github.com/rmyndharis/OpenWA/commit/c400af938d6f740428a88e63301f3c2770ee83e0)
- [OpenWA v0.23.4](https://github.com/rmyndharis/OpenWA/tree/v0.23.4)

The four fixtures in `tests/fixtures/openwa-0.23.4/` are the exact compiled
preimages read from the deployed image, with the upstream MIT license retained.
The patch fails closed unless every preimage and the retained media dependency
hash match `manifest.json`; every patched file also has an exact expected hash.

## Offline checks

```sh
node --test tests/openwa-product-context.test.cjs
python3 -m unittest discover -s tests -p test_openwa_product_context_release.py
```

## Guarded release contract

Use a fresh private release directory, with these files staged:

```text
release-parent/core.py              # pinned neuro-gemini release core
release-parent/gateway/operator.py  # scripts/openwa-product-context-release.py
release-parent/gateway/patch.cjs
release-parent/gateway/manifest.json
```

Run `operator.py prepare --root /absolute/release-parent/gateway`, then `apply`
with that exact root. Prepare builds with network disabled and validates the
candidate hashes. Apply acquires the shared AVA release lock, checks source,
image, compose, environment, mount, network and other-container state, backs up
the live SQLite databases with online backup, and recreates only OpenWA.
Docker health and the HTTP readiness endpoint must pass before receipt creation.
The named authentication volume and prior media dependency fix are verified.

`apply-started` prevents automatic replay of an uncertain apply outcome. A failed
candidate triggers image rollback while retaining the live database and auth
volume. Explicit `rollback` uses the recorded base image and also does not restore
the database. Stage/apply this release after other AVA releases have finished,
because unrelated container changes intentionally fail the snapshot guard.

The offline checks exercise synthetic messages and SQLite rows. They do not
establish a real customer WhatsApp round trip or authorize sending messages.
