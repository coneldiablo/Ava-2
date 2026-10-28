# Ask AVA and overnight briefing: independent acceptance fixture

Baseline: `9b0c961057d04d12e1ead2ceeed7b9463a1e6263`.

Run `node tests/fixtures/dashboard-ask-baseline-repro.js` from `whatsapp_crm` with dependencies installed. The fixture uses only an in-memory SQLite database and a loopback HTTP server. It makes no paid or production request. It deliberately records legacy behavior and is outside the regular `*.test.js` suite so a corrected implementation is not forced to preserve it.

Run `node tests/run-tests.js dashboard-ask-postfix` against the integrated facts and Ask changes. This is the post-fix regression suite: it stubs AITunnel at the HTTP client, requires two different questions to invoke the model, accepts an honest insufficient churn answer and a plan based on a real task, verifies fresh facts after a durable save, rejects malformed or uncited model output and an invented churn claim, compares the 20:00 local night boundary with the fact packet, checks that clock progress alone reuses an ongoing night summary, and checks simultaneous night/yesterday requests. It is expected to fail on the baseline until the dependent implementation is integrated.

Observed on baseline:

| Probe | Result |
| --- | --- |
| Two different churn questions, one naming a client | Identical canned answer |
| Two different revenue forecast questions, one naming a deal | Identical canned answer |
| Model / knowledge calls for those four questions | Zero |
| Answer metadata | HTTP 200, `success: true`, `provenance: crm_records` |
| Different business without membership | HTTP 403 |
| Foreign tenant marker in responses | Absent |
| Persisted new client, same explicit period | Hidden by the 20-second snapshot cache |
| Moscow and New York overnight windows | Different |

The route invokes `Knowledge.askKnowledge` only when `AI.ask().unsupported` is true. The churn and forecast regex branches return `unsupported: false` without invoking a model. `snapshot()` caches by business and period; its key has no source revision. These are the causes demonstrated by the fixture, rather than evidence that the LLM generated repeated text.

## Acceptance against the integrated candidate

Use this fixture to compare baseline and candidate, then use candidate tests or a revised acceptance fixture to establish the following. Do not rely on HTTP 200 or `grounded: true` alone.

1. Ask with two materially different questions over the same tenant facts. Verify the prompt reaches the configured AI path and that each response addresses its question. A model may decline a forecast or churn inference when facts are insufficient; that decline must reflect the requested scope and must not claim a calculated prediction.
2. Save an overnight event and ask again for the same business and window. The new source revision must change the fact packet and invalidate any generated-summary cache. Verify the returned source ID and timestamp identify the saved event.
3. Use two businesses with different timezones, a midnight boundary, and a different set of records. Verify each business's night window and that neither prompt, model output, citation, cache entry, nor client response contains the other business's marker.
4. Test empty and partial sources. Return an explicit empty/partial state; do not synthesize counts, a headline, a risk score, or citations that the stored records cannot support. A headline based on AI text needs a source-backed fact packet and validated JSON.
5. Stub the model to return malformed JSON, a timeout, a 5xx error, and a superficially plausible response containing unknown source IDs. Confirm bounded failure or an honest unavailable state; no successful grounded answer may be fabricated or leaked from the raw provider error.
6. Recheck authorization after any asynchronous model call and use separate rate/cache keys per business and user where required. Request replay may return a prior answer only for the same request ID and identical inputs.
7. In the UI, distinguish loading, unavailable, empty, and partial from a completed source-backed answer. The overnight activity feed, AI summary, and Ask response should agree on the selected window and updated facts.
8. For an ongoing night, advance the clock without changing stored facts: the source revision and model result should be reused. Save an in-window event: the revision and result should change. Simultaneous night and yesterday overviews for one business should not return a busy error.

Live readiness remains a separate check: a local fixture cannot prove the actual AITunnel model, production data availability, Safari rendering, or customer account access.
