# capture records — cinatra#2931 (W4), 2026-08-26

Head under proof: **`011da4d6133a16e81a3f79a9ce0dcbb9b6fba8a0`** for **W3** and
**W7**, re-taken on this head; **`1c3649503d511942538c626d4ebc964e50e1302c`** for
**W0**, **W1**, **W5** and **W9**, whose files are carried over **byte-identical**
(their sha256 values below are unchanged from that commit).
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

  id           01437642-8900-4c12-9cfc-c9a5db44ca24   (pending, re-take — W3, W7)
  status       completed
  template_id  3ac23e05-c031-43a8-8596-e502ea21bdd2
  created_at   2026-08-26 21:56:40.743289+00
  completed_at 2026-08-26 22:20:48.581+00
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

  id             21f9c749-3ba6-4fd1-9506-9406af5a271c        (the re-take)
  run_id         01437642-8900-4c12-9cfc-c9a5db44ca24
  status         pending
  disposition    (null)
  resolved_by    (null)
  resolved_at    (null)
  created_at     2026-08-26 22:35:26.49634+00
  review_task_id lifecycle-review:c8114bc82275b69353cb694efbc9f26000d0f6896a49ad1595ee23c2de386e97
  pinned_targets [{"artifactId":"601fb949-b082-4c58-bbff-29dcce67b756",
                   "representationRevisionId":"85de01bf-7113-40cb-8666-8ae74896d7da"}]

artifact_produced_outbox                       (why the gate took 14 min 38 s)
  event_id                   c8114bc82275b69353cb694efbc9f26000d0f6896a49ad1595ee23c2de386e97
  producer_run_id            01437642-8900-4c12-9cfc-c9a5db44ca24
  artifact_id                601fb949-b082-4c58-bbff-29dcce67b756
  representation_revision_id 85de01bf-7113-40cb-8666-8ae74896d7da
  event_kind                 artifact_produced
  status                     processed
  created_at                 2026-08-26 22:20:48.13639+00
  processed_at               2026-08-26 22:35:28.077474+00
```

The event sat `pending` because the review-orchestration loop lost its queue lock
during a slow first boot and stopped rescheduling itself in that process. Restarting
the app re-registered the loops; the first scan logged `scanned=1 gatesCreated=1`.
Nothing was inserted by hand to make the gate appear.

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

representation                       (the re-take run's target — W3, W7)
  id                85de01bf-7113-40cb-8666-8ae74896d7da
  artifact_id       601fb949-b082-4c58-bbff-29dcce67b756
  revision          1
  form              file
  created_by_run_id 01437642-8900-4c12-9cfc-c9a5db44ca24
  created_at        2026-08-26 22:20:48.13639+00

artifact_blobs
  sha256      5b4ae32f84ef09b6583e9ef2bcdfcb7f8eb21cfcecbfaa5b1a26a4d5fff6dd7b
  size_bytes  19104
  mime        text/markdown
  created_at  2026-08-26 22:20:47.644942+00
  first bytes "## Where the hours actually go"
  count of `"content":` in the blob   0
  markdown headings in the blob       4
```

The blob was read back from disk at its own content address: the file at the
storage key hashes to the `sha256` above, is 19 104 bytes, begins
`## Where the hours actually go`, and contains **zero** occurrences of
`"content":`. No JSON envelope reaches the card in this set either.

## The usage ledger — the real model, both runs

```
usage_events   (occurred_at, provider, model, operation, agent_label, in/out tokens)
  2026-08-26 16:46:16.979+00  openai  gpt-5.5             stream    chat                     23302 / 169
  2026-08-26 16:49:28.147+00  openai  gpt-5.5-2026-04-23  generate  blog-draft-writer-agent  38762 / 1816
  2026-08-26 16:30:37.743+00  openai  gpt-5.5             stream    chat                     23678 / 274
  2026-08-26 16:31:30.652+00  openai  gpt-5.5-2026-04-23  generate  blog-draft-writer-agent  38844 / 1732
  2026-08-26 16:31:52.707+00  openai  gpt-5.5-2026-04-23  generate  artifact-matcher          1693 / 93
  2026-08-26 16:31:58.666+00  openai  gpt-5.5-2026-04-23  generate  artifact-matcher          1719 / 179

the re-take run (W3, W7)
  2026-08-26 21:56:50.389+00  openai  gpt-5.5             stream    chat                     23247 / 137
  2026-08-26 22:20:45.477+00  openai  gpt-5.5-2026-04-23  generate  blog-draft-writer-agent  38763 / 4568
  2026-08-26 22:20:58.191+00  openai  gpt-5.5-2026-04-23  generate  artifact-matcher          4462 / 107
  2026-08-26 22:21:04.181+00  openai  gpt-5.5-2026-04-23  generate  artifact-matcher          4488 / 309
```

`effective_provider` on the draft row reads `openai`. The whole-tree pin check was
re-run on this head before a picture was taken: **112** extension checkouts MATCH
their lock `resolvedSha`, **0** mismatch, **0** missing. The boot scan on this
instance read `@cinatra-ai/blog-draft-writer-agent 0.1.4 skipped — already up to
date` (the leading letter of the printed token is dropped for the repository's
version-token rule) — the registry row was already at that version from the earlier
round, and `agent_templates.package_version` still reads `0.1.4`, `status
published`.

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

Viewport 1440×900, `deviceScaleFactor: 2` → 2880×1800 pixels each. The four rows
marked **re-take** were shot on `011da4d6133a16e81a3f79a9ce0dcbb9b6fba8a0`; the
other eight are the files committed at `1c3649503d511942538c626d4ebc964e50e1302c`,
**unchanged byte for byte** — each sha256 below was recomputed from the file in the
tree and matches the value recorded then.

| file | sha256 | bytes |
|---|---|---|
| `captures/W0__placeholder__chat_thread__working__light.png` | `20a79cfb0e554af0d7441f7587487aa478c2e4cc8ce2c147c48c5c991fb4abf4` | 363 852 |
| `captures/W0__placeholder__chat_thread__working__dark.png` | `38d368768dad138e0b3b22d3c29730cf60ce326fd243c10f27b183fea3e4268c` | 339 355 |
| `captures/W1__review-card__chat_thread__pending__light.png` | `949b1332c9ae2fce007a09ca40df2878c992341e257e71b2b64bc31ade9dbec1` | 367 024 |
| `captures/W1__review-card__chat_thread__pending__dark.png` | `69ea12575b17332b1df0264df9faeb76a2c67610aef5bab625c139207f7e6856` | 361 362 |
| **re-take** `captures/W3__review-card__run_page__pending__light.png` | `5055a6aec844906e370e222fbbcbf1498a800719630cd895ec4714039317d50c` | 303 384 |
| **re-take** `captures/W3__review-card__run_page__pending__dark.png` | `a7efd95649707ff0a9950fbd71258d2161ab393ee06e49bf9e4348c3002abc52` | 299 783 |
| `captures/W5__review-card__review_page__pending__light.png` | `5043a26216cf84cad32b2ddd8a3c902d693c30a04343f25aeca6c562e5245127` | 410 819 |
| `captures/W5__review-card__review_page__pending__dark.png` | `adc54073b9a7ac10b2845aaf498ef184811005e2fe4be982e5e1206d90e0b4f8` | 407 338 |
| **re-take** `captures/W7__review-card__site_widget__pending__light.png` | `2e1d0d54674b5a7642fb552563e0a03f4626c5506175783368d867f88fce6a7e` | 198 449 |
| **re-take** `captures/W7__review-card__site_widget__pending__dark.png` | `03a11fe63a1aea4d4f8948cb94f6a07ec942b90460a6e4930e2f2462c047562b` | 194 432 |
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
W3 light  22:45:23      cards=1 islands=1 iframes=1 approve/reject/comment=1/1/1
                        island body=1 empty=0 targets=1 rendered=true
                        promptWindow=false noRenderer=false floor=0 preview=0 download=0
W3 dark   22:45:37      the same readings, theme=dark
W5 light  16:53:00      cards=1 approve=1 reject=1 comment=1 island rendered+rawsource
W5 dark   16:53:14      cards=1 approve=1 reject=1 comment=1 island rendered+rawsource
W7 light  22:54:30      cards=1 islands=1 signin-controls=0 approve/reject/comment=1/1/1
                        island body=1 empty=0 targets=1 rendered=true
                        signInPrompt=false noRenderer=false floor=0 preview=0 download=0
W7 dark   23:04:17      the same readings, theme=dark
W9 light  16:57:31      cards=1 approve=0 reject=0 comment=0 resolved=true
W9 dark   16:57:43      cards=1 approve=0 reject=0 comment=0 resolved=true

Approve was pressed on the second run at 16:57:22.415; the gate row settled at
16:57:23.200555 and both W9 frames were taken after that. The two W7 frames are
separate mounts of the third-party page — the embed mints a fresh conversation per
context, so each theme was mounted with the theme already set and asked for this
run's review in its own turn.
```

## The island's address, read live on this head (W3's route)

The card composes the island address from the palette class of the document **it**
is mounted in. Read from the parent DOM while pressing the app's own theme control,
three times in a row:

```
root class ... cinatra    island src /lifecycle/review-island  params [ref, scheme]  scheme=light
root class ... dark       island src /lifecycle/review-island  params [ref, scheme]  scheme=dark
root class ... cinatra    island src /lifecycle/review-island  params [ref, scheme]  scheme=light
```

The palette named on the address tracks the host document's palette class exactly,
and moves when the reader changes it. On this first-party route the address carries
**no** credential parameter; the credentialed arm is the third-party application's.
No credential value is recorded here, or anywhere in this directory.

## The island's colour, measured in pixels

Sampled from the committed captures themselves — the island's ground, and the rows
the target chip's pill outline runs through.

```
                                        island ground     brightest pixel on the
                                                          chip's border rows
run page, dark            (W3)          rgb(13,24,42)     rgb(37,47,63)   pill drawn
run page, dark, mounted dark            rgb(13,24,42)     rgb(37,47,63)   pill drawn
third-party application, dark  (W7)     rgb(13,24,42)     rgb(14,25,44)   pill ABSENT
run page, light           (W3)          near-white        pill drawn
third-party application, light (W7)     near-white        pill drawn
```

The island's ground is the same value on both hosts in dark — the defect the earlier
W7 dark frame showed (a white panel inside a dark widget) is gone. The one reading
that still differs between hosts is the chip's pill outline, absent in the
third-party application in dark; it is named in the README's W7 cell rather than
left to be found. The "mounted dark" row is a separate load, taken with the app
already dark before the run page opened, so the pill is not a product of the repaint
path.
