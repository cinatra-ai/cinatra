# capture records — cinatra#2931 (W4), 2026-08-26

Head under proof: **`1c3649503d511942538c626d4ebc964e50e1302c`**.
Runtime: Next.js dev on `http://localhost:3000`; the agent runtime container on
`:3010`, reaching the app back at `http://host.docker.internal:3000`; a plain
static server on a second origin for the third-party page of W7.
Provider: **real** — `CINATRA_TEST_LLM_PROVIDER` unset. The provider key lives in
the instance database, sealed there through the app's own provider form; it was
never written to a file, never passed as an argument and never printed.

**Direct SQL disclosure.** The only statements issued by hand against the instance
database this round were `SELECT`s — every row below is a readback. No run, gate,
artifact, representation, audit or usage row was inserted, updated or deleted by
hand. Every state change came from a control pressed in a browser.

## The pinned agent

| reading | value |
|---|---|
| lock `resolvedSha` | `03a27f524d59f90f635ee98c1b5900c4bc9f7f6e` |
| checked-out package `HEAD` | `03a27f524d59f90f635ee98c1b5900c4bc9f7f6e` |
| package version on disk | `0.1.4` |
| boot scan | `[cinatra:extensions:agent] @cinatra-ai/blog-draft-writer-agent 0.1.4 upserted` (the leading v of the printed token is dropped for the repository's version-token rule) |
| `agent_templates` | `package_version 0.1.4`, `status published`, `updated_at 2026-08-26 16:14:02.276+00` |
| whole-tree pin check | 111 extension checkouts **MATCH** their lock `resolvedSha`, 0 mismatch |

## The runs

```
agent_runs
  id           579d0473-4b5d-40b9-9d79-8126560bbf06   (pending — W0, W1, W3, W5, W7)
  status       completed
  created_at   2026-08-26 16:46:05.133958+00
  completed_at 2026-08-26 16:49:29.802+00

  id           8bfc1191-eeca-4b6a-ac86-a636f476c28e   (decided — W9)
  status       completed
  created_at   2026-08-26 16:30:24.087882+00
  completed_at 2026-08-26 16:31:33.762+00
```

## The review gates

```
artifact_review_gates
  id             876c235f-bec3-4b8d-8db4-14632704829c
  run_id         579d0473-4b5d-40b9-9d79-8126560bbf06
  status         pending
  disposition    (null)
  resolved_by    (null)
  resolved_at    (null)
  created_at     2026-08-26 16:49:45.074985+00
  review_task_id lifecycle-review:826015e9463d18d8ef9605b2dc090308433c123590aca668a65bf7d6b0bbb138
  pinned_targets [{"artifactId":"caccf9b0-79c7-4c79-9110-e5ec4b6fccce",
                   "representationRevisionId":"f1fcb330-373f-4024-bbea-32dcd523be27"}]

  id             51abc733-6a53-4d66-96e5-a896e439fd0a
  run_id         8bfc1191-eeca-4b6a-ac86-a636f476c28e
  status         resolved
  disposition    approve
  resolved_by    2660f48b-6a11-423a-afdd-a148139bf86d   (the signed-in reviewer)
  resolved_at    2026-08-26 16:57:23.200555+00
  created_at     2026-08-26 16:32:02.567646+00
  review_task_id lifecycle-review:5d35715afe035c0b1b5b2ffc9898f4f1827ffe15a3f8ab0f93ee1d0957368bd4
```

## The decision the browser wrote

```
artifact_review_audit
  id                          f147412a-8cb6-4120-ba80-88e92d72fc44
  gate_id                     51abc733-6a53-4d66-96e5-a896e439fd0a
  run_id                      8bfc1191-eeca-4b6a-ac86-a636f476c28e
  artifact_id                 79948515-3c23-46f5-b83c-48b35f5c3839
  representation_revision_id  a5b82be2-432e-4962-b43f-7dd7d36dfaf1
  disposition                 approve
  renderer_kind               first-party
  renderer_package            (null)
  renderer_digest             (null)
  decision_fingerprint        ef679dddc4000de2b13a27527366390ce7f3b1503079abd0502b7fade2b6fb2b
  created_at                  2026-08-26 16:57:23.200555+00
```

## The reviewed work

```
representation                       (the pending run's target)
  id                f1fcb330-373f-4024-bbea-32dcd523be27
  artifact_id       caccf9b0-79c7-4c79-9110-e5ec4b6fccce
  revision          1
  form              file
  created_by_run_id 579d0473-4b5d-40b9-9d79-8126560bbf06
  created_at        2026-08-26 16:49:29.61437+00

artifact_blobs
  sha256      8002fa3704ccf8815d716a18fff884b36cbfe4df940277c4a881b9a7ebb08968
  size_bytes  6351
  mime        text/markdown
  created_at  2026-08-26 16:49:29.20187+00
  first bytes "## Where the hours actually go"
  count of `"content":` in the blob   0
```

## The usage ledger — the real model, both runs

```
usage_events   (occurred_at, provider, model, operation, agent_label, in/out tokens)
  2026-08-26 16:46:16.979+00  openai  gpt-5.5             stream    chat                     23302 / 169
  2026-08-26 16:49:28.147+00  openai  gpt-5.5-2026-04-23  generate  blog-draft-writer-agent  38762 / 1816
  2026-08-26 16:30:37.743+00  openai  gpt-5.5             stream    chat                     23678 / 274
  2026-08-26 16:31:30.652+00  openai  gpt-5.5-2026-04-23  generate  blog-draft-writer-agent  38844 / 1732
  2026-08-26 16:31:52.707+00  openai  gpt-5.5-2026-04-23  generate  artifact-matcher          1693 / 93
  2026-08-26 16:31:58.666+00  openai  gpt-5.5-2026-04-23  generate  artifact-matcher          1719 / 179
```

## The slot, as the page itself recorded it

`MutationObserver` on `data-run-review-slot`; neither page reloaded after the turn.

```
the conversation                      the run page
16:45:44.432  (no slot)               16:46:36.596  (no slot)
16:46:42.035  working                 16:46:42.390  working
16:46:43.382  (no slot)               16:46:44.035  (no slot)
16:49:30.322  working                 16:49:30.323  working
16:49:46.823  review, card=0          16:49:47.114  review, card=0
16:49:47.929  review, card=1          16:49:47.989  review, card=1
```

The first `working` flash is the run's own setup gate opening and closing; the
captured placeholder is the second window, which ran from `16:49:30.322` to
`16:49:46.823` — **16.5 s** — and began `520 ms` after the run row terminated.

## W7 — the wire, per capture

Both W7 frames were taken in a fresh browser context with an **empty** cookie jar;
the reader signed in through the frame's own hosted-PKCE popup.

```
lifecycle-resolve   POST /api/lifecycle-views/resolve   ×2 per capture
    cookie:                         absent
    x-cinatra-widget-user-token:    present (cwu_)
    x-cinatra-widget-origin:        the host page's own origin
island-document     GET  /lifecycle/review-island       ×1 per capture
    cookie:                         absent

cookie jar at capture time (name/attributes only; no value is recorded anywhere)
    better-auth.session_token   domain=localhost   path=/   SameSite=Lax   httpOnly=true
```

## The captures

Viewport 1440×900, `deviceScaleFactor: 2` → 2880×1800 pixels each.

| file | sha256 | bytes |
|---|---|---|
| `captures/W0__placeholder__chat_thread__working__light.png` | `20a79cfb0e554af0d7441f7587487aa478c2e4cc8ce2c147c48c5c991fb4abf4` | 363 852 |
| `captures/W0__placeholder__chat_thread__working__dark.png` | `38d368768dad138e0b3b22d3c29730cf60ce326fd243c10f27b183fea3e4268c` | 339 355 |
| `captures/W1__review-card__chat_thread__pending__light.png` | `949b1332c9ae2fce007a09ca40df2878c992341e257e71b2b64bc31ade9dbec1` | 367 024 |
| `captures/W1__review-card__chat_thread__pending__dark.png` | `69ea12575b17332b1df0264df9faeb76a2c67610aef5bab625c139207f7e6856` | 361 362 |
| `captures/W3__review-card__run_page__pending__light.png` | `5a245bb48352487bd7ac726396c37085ff3547003511fb56072b9eb99f96383b` | 327 075 |
| `captures/W3__review-card__run_page__pending__dark.png` | `155a9f75bd4fc4882a40efc3012ecb89076e90dca8525075a980b7c1499b3643` | 323 344 |
| `captures/W5__review-card__review_page__pending__light.png` | `5043a26216cf84cad32b2ddd8a3c902d693c30a04343f25aeca6c562e5245127` | 410 819 |
| `captures/W5__review-card__review_page__pending__dark.png` | `adc54073b9a7ac10b2845aaf498ef184811005e2fe4be982e5e1206d90e0b4f8` | 407 338 |
| `captures/W7__review-card__site_widget__pending__light.png` | `5f1b322044a09d25157cd1d54f679c337e8c3beddb74b22027312e55be5f7c41` | 203 315 |
| `captures/W7__review-card__site_widget__pending__dark.png` | `38b7b8188a59a2cf529bb42722d6f14f3dbd98c49f01c6a9c7dcc55f309d4cb9` | 202 617 |
| `captures/W9__review-card__review_page__decided__light.png` | `99114f8cc08d16a8994e4109de0db02f0334823868b2d3d1f9e21fc4e3c8d676` | 149 191 |
| `captures/W9__review-card__review_page__decided__dark.png` | `e51a699ddd043ff38c00ce622cb77fdce41796d854309169cd02f276423c3b57` | 147 818 |

## The shutters, and what was true at each

Every entry was re-counted immediately after its shutter; `after` records that
re-count.

```
W0 light  16:49:33.505  slot=working ph=1 cards=0 approve=0            after: true
W0 dark   16:49:46.028  slot=working ph=1 cards=0 approve=0            after: true
W1 light  16:50:04.945  slot=review  ph=0 cards=1 approve=1 island=1   after: true
W1 dark   16:50:20.590  slot=review  ph=0 cards=1 approve=1 island=1   after: true
W3 light  16:50:36.178  slot=review  ph=0 cards=1 approve=1 island=1   after: true
W3 dark   16:50:51.735  slot=review  ph=0 cards=1 approve=1 island=1   after: true
W5 light  16:53:00      cards=1 approve=1 reject=1 comment=1 island rendered+rawsource
W5 dark   16:53:14      cards=1 approve=1 reject=1 comment=1 island rendered+rawsource
W7 dark   17:37:33      cards=1 islands=1 signin-controls=0 approve=1 reject=1 comment=1
W7 light  17:39:09      cards=1 islands=1 signin-controls=0 approve=1 reject=1 comment=1
W9 light  16:57:31      cards=1 approve=0 reject=0 comment=0 resolved=true
W9 dark   16:57:43      cards=1 approve=0 reject=0 comment=0 resolved=true

Approve was pressed on the second run at 16:57:22.415; the gate row settled at
16:57:23.200555 and both W9 frames were taken after that. The two W7 frames are
separate mounts of the third-party page — the embed mints a fresh conversation per
context, so each theme was mounted with the theme already set and asked for this
run's review in its own turn.
```
