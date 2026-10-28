# Optional Instagram Direct adapter (off by default)

This package is an opt-in AVA Instagram Direct channel. The server makes no private API request unless `INSTAGRAM_PRIVATE_CONNECTOR_ENABLED=true` and `CHANNEL_CREDENTIALS_MASTER_KEY` is configured. Each business owner supplies their own Instagram username, password, and optional 2FA code through the owner-scoped login endpoint; no AVA username allowlist or preconfigured confirmation sender is needed. The optional Python dependency in [`requirements.txt`](requirements.txt) points to the exact upstream GitHub commit for `instagrapi` 3.0.21. Python 3.10+ is required by upstream. The official Meta connector remains separate.

`instagrapi` uses Instagram's **unofficial private API**. Its maintainers warn that production use is fragile because account trust, device state, challenges, and rate limits can change independently. Use an official Instagram API for an eligible business account where it supports the workflow. This adapter makes no claim of compatibility with Instagram's terms or of operational reliability.

The wrapper supports only caller-supplied credential login (optional 6–8 digit verification code), in-memory `get_settings`/`set_settings`, bounded normal-inbox `direct_threads`, and one manually confirmed text reply to a verified existing thread. It never resolves challenges, retries, polls, scrapes users, creates threads, sends bulk messages, processes media, or generates AI replies. Challenges, login-required responses, and HTTP 429/rate limiting pause the instance. Stop and review the account in Instagram's official app; do not loop or bypass controls. A failed send may have been delivered, so never automatically retry it.

Session settings and passwords are secrets. The adapter never logs or writes them. The Node coordinator passes credentials over child-process stdin, stores only encrypted session settings using the existing 32-byte channel master key, and returns redacted status codes. Password and 2FA code are never persisted. Failed-login device settings are retained for 15 minutes, encrypted with separate authenticated context and scoped to the business and an HMAC of the username. The next owner-initiated attempt reuses that device; successful login and disconnect clear it. Saved settings cannot re-enable library retries. No interactive challenge handler may consume the worker stdin. `get_settings()` deliberately returns the session object to the server and should be treated like a credential. The maximum output is 20 threads × 20 text messages, with message text truncated to 2,000 characters. Only one-to-one normal-inbox text messages are imported. Manual reply input is limited to 1,000 characters. Non-text messages and pending requests are omitted.

Server flow: owner-scoped `/api/businesses/:businessId/instagram-private` endpoints handle status, login, manual poll, reply, and disconnect. A two-minute server poll uses a SQLite lease per business. A global unique account ID prevents simultaneous binding to two businesses. Incoming message IDs have durable receipts and are inserted with the CRM transcript in one SQLite transaction. The UI shows `awaiting_inbound` after login and `connected` only after a new inbound normal-inbox text Direct from any peer is stored. The message must postdate login, match its thread's peer, and not come from the logged-in account; old inbox items and outbound messages cannot confirm connection. Rate limits, challenges, login expiry, and uncertain sends pause the account. Disconnect refuses an in-flight login, poll, or reply, then atomically removes the encrypted session and account claim. The owner may connect that Instagram account to another business afterward; conversation and receipt history remain scoped to the old business and are never transferred.

Production enablement requires `INSTAGRAM_PRIVATE_CONNECTOR_ENABLED=true` and a persistent, secret 32-byte `CHANNEL_CREDENTIALS_MASTER_KEY` shared by the CRM processes. The image already copies this package, installs its pinned Python dependency, and sets `INSTAGRAM_PRIVATE_PYTHON` to its virtualenv interpreter. Other hosts must install that dependency in the interpreter specified by `INSTAGRAM_PRIVATE_PYTHON` (default `python3`). No Instagram username, password, 2FA code, or sender ID belongs in environment variables. A real owner's login, challenge behavior, and fresh incoming Direct must still be checked on a live account before calling that account connected; local tests do not prove live provider acceptance.

Minimal opt-in use in a separate controlled process, with an account you own and explicit human approval for each reply:

```python
from whatsapp_crm.instagram_private import InstagramPrivateAdapter

adapter = InstagramPrivateAdapter(enabled=True)  # never enabled by default
adapter.login(username, password, verification_code=code_or_none)
threads = adapter.list_threads(amount=5, messages_per_thread=5)
# Display the exact thread and draft to a human; after they approve:
message_id = adapter.reply_to_existing_thread(thread_id, approved_text, manually_confirmed=True)
```

No real account is needed for tests. From repository root: `python -m pytest whatsapp_crm/instagram_private/test_adapter.py -q`. Tests inject a fake client and do not import `instagrapi` or use the network.

Upstream references: [repository and warning](https://github.com/subzeroid/instagrapi), [Direct API](https://subzeroid.github.io/instagrapi/latest/usage-guide/direct/), [pinned release](https://github.com/subzeroid/instagrapi/releases/tag/3.0.21).
