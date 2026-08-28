# The records this round wrote, anchor by anchor

Every count below is what the SHIPPED recorder read off the live page and wrote into
`scripts/ci/chat-hitl-capture-index.json`. Nothing here is typed by hand: this file is
rendered from `capture-records.json`, which is the recorder's own output.

## `B4__review-card__page_gate_region__pending__dark`

| field | value |
| --- | --- |
| host | `page_gate_region` |
| kind | `artifact_review_gate` |
| state | `pending` |
| final URL | `/agents/cinatra-ai/blog-draft-writer-agent/cda1cd00-7091-47e0-bd66-5e43fb2e5fb1/review/lifecycle-review%3A73aee18a3265252fd9e0173b451271734068f86239062b8e4414c6a95c09f289` |
| screenshot | `evidence/2936-w6-captures-batch-2/cells/B4__review-card__page_gate_region__pending__dark.png` |
| sha256 | `6935ef172ed83b9f2babafc88e689f397b081968735814d97a796cd308a036bd` |
| framing / build | `window` / `development` |
| captured at | 2026-08-28T00:24:38.614Z |
| recorded by | `cinatra-lifecycle-capture-recorder@1` |

| selector | scope | expect | observed | painted |
| --- | --- | --- | --- | --- |
| `[data-lifecycle-card-host="page_gate_region"]` | frame | present | 2 | 2 |
| `[data-lifecycle-card="artifact_review_gate"]` | frame | present | 1 | 1 |
| `[data-conformance-id="review-decision-bar"]` | root (within `[data-lifecycle-card="artifact_review_gate"]`) | present | 1 | 1 |
| `[data-lifecycle-card-host="page_gate_region"]` | root (within `[data-lifecycle-card="artifact_review_gate"]`) | present | 1 | 1 |

The card instance the record pins:

```json
{
 "selector": "[data-lifecycle-card=\"artifact_review_gate\"]",
 "matched": 1,
 "index": 0,
 "id": null,
 "attributes": {
  "class": "flex w-full flex-col gap-3",
  "data-lifecycle-card": "artifact_review_gate",
  "data-lifecycle-card-state": "pending",
  "data-lifecycle-card-host": "page_gate_region",
  "data-conformance-id": "review-gate-card"
 }
}
```

## `B3__review-card__run_card__decided__conversation__dark`

| field | value |
| --- | --- |
| host | `run_card` |
| kind | `artifact_review_gate` |
| state | `decided` |
| final URL | `/chat/cinatra-ai/cinatra-assistant/9b2418eb-372e-487c-afa9-cc3436cbb050` |
| screenshot | `evidence/2936-w6-captures-batch-2/cells/B3__review-card__run_card__decided__conversation__dark.png` |
| sha256 | `360dda2e5aa2a10de9cbf2570a5eca34df57e4081dd134a736a7c441406e5afa` |
| framing / build | `window` / `development` |
| captured at | 2026-08-28T01:21:06.628Z |
| recorded by | `cinatra-lifecycle-capture-recorder@1` |

| selector | scope | expect | observed | painted |
| --- | --- | --- | --- | --- |
| `[data-lifecycle-card-host="run_card"]` | frame | present | 1 | 1 |
| `[data-lifecycle-card="artifact_review_gate"]` | frame | present | 1 | 1 |
| `[data-lifecycle-card-state]` | root (within `[data-lifecycle-card="artifact_review_gate"]`) | present | 1 | 1 |
| `[data-lifecycle-card-host="run_card"]` | root (within `[data-lifecycle-card="artifact_review_gate"]`) | present | 1 | 1 |
| `[data-conformance-id="review-decision-bar"]` | root (within `[data-lifecycle-card="artifact_review_gate"]`) | absent | 0 | 0 |

The card instance the record pins:

```json
{
 "selector": "[data-lifecycle-card=\"artifact_review_gate\"]",
 "matched": 1,
 "index": 0,
 "id": null,
 "attributes": {
  "class": "flex w-full flex-col gap-3",
  "data-lifecycle-card": "artifact_review_gate",
  "data-lifecycle-card-state": "settled",
  "data-lifecycle-card-host": "run_card",
  "data-conformance-id": "review-gate-card"
 }
}
```

## `B2__review-card__run_card__decided__light`

| field | value |
| --- | --- |
| host | `run_card` |
| kind | `artifact_review_gate` |
| state | `decided` |
| final URL | `/agents/cinatra-ai/blog-draft-writer-agent/c00920ac-4631-460a-946d-9821c3df7f80` |
| screenshot | `evidence/2936-w6-captures-batch-2/cells/B2__review-card__run_card__decided__light.png` |
| sha256 | `ca1ab0ad847769202ed4bfca3e93003500e92a85bd2318082879f73aefa99073` |
| framing / build | `window` / `development` |
| captured at | 2026-08-28T01:21:44.278Z |
| recorded by | `cinatra-lifecycle-capture-recorder@1` |

| selector | scope | expect | observed | painted |
| --- | --- | --- | --- | --- |
| `[data-lifecycle-card-host="run_card"]` | frame | present | 2 | 2 |
| `[data-lifecycle-card="artifact_review_gate"]` | frame | present | 1 | 1 |
| `[data-lifecycle-card-state]` | root (within `[data-lifecycle-card="artifact_review_gate"]`) | present | 1 | 1 |
| `[data-lifecycle-card-host="run_card"]` | root (within `[data-lifecycle-card="artifact_review_gate"]`) | present | 1 | 1 |
| `[data-conformance-id="review-decision-bar"]` | root (within `[data-lifecycle-card="artifact_review_gate"]`) | absent | 0 | 0 |

The card instance the record pins:

```json
{
 "selector": "[data-lifecycle-card=\"artifact_review_gate\"]",
 "matched": 1,
 "index": 0,
 "id": null,
 "attributes": {
  "class": "flex w-full flex-col gap-3",
  "data-lifecycle-card": "artifact_review_gate",
  "data-lifecycle-card-state": "settled",
  "data-lifecycle-card-host": "run_card",
  "data-conformance-id": "review-gate-card"
 }
}
```

## `B2__review-card__run_card__decided__dark`

| field | value |
| --- | --- |
| host | `run_card` |
| kind | `artifact_review_gate` |
| state | `decided` |
| final URL | `/agents/cinatra-ai/blog-draft-writer-agent/c00920ac-4631-460a-946d-9821c3df7f80` |
| screenshot | `evidence/2936-w6-captures-batch-2/cells/B2__review-card__run_card__decided__dark.png` |
| sha256 | `d480bd567a34116986ac31139989217d486b0edae5e66f1a5e4f18a15cdc9d0a` |
| framing / build | `window` / `development` |
| captured at | 2026-08-28T01:21:57.665Z |
| recorded by | `cinatra-lifecycle-capture-recorder@1` |

| selector | scope | expect | observed | painted |
| --- | --- | --- | --- | --- |
| `[data-lifecycle-card-host="run_card"]` | frame | present | 2 | 2 |
| `[data-lifecycle-card="artifact_review_gate"]` | frame | present | 1 | 1 |
| `[data-lifecycle-card-state]` | root (within `[data-lifecycle-card="artifact_review_gate"]`) | present | 1 | 1 |
| `[data-lifecycle-card-host="run_card"]` | root (within `[data-lifecycle-card="artifact_review_gate"]`) | present | 1 | 1 |
| `[data-conformance-id="review-decision-bar"]` | root (within `[data-lifecycle-card="artifact_review_gate"]`) | absent | 0 | 0 |

The card instance the record pins:

```json
{
 "selector": "[data-lifecycle-card=\"artifact_review_gate\"]",
 "matched": 1,
 "index": 0,
 "id": null,
 "attributes": {
  "class": "flex w-full flex-col gap-3",
  "data-lifecycle-card": "artifact_review_gate",
  "data-lifecycle-card-state": "settled",
  "data-lifecycle-card-host": "run_card",
  "data-conformance-id": "review-gate-card"
 }
}
```

