# capture records — cinatra#2931 (W4)

Head under proof: **`f20bb3ff6372fe3d6882f490a9289512a21a95f1`** for **W7**,
re-taken on this head; **`d0db4293d72b4554bf1c4b00fc7d5363c82375b3`** for **W3**,
**W5** and **W9**, and **`1c3649503d511942538c626d4ebc964e50e1302c`** for **W0**
and **W1**, whose files are carried over **byte-identical** (their sha256 values
below are unchanged from those commits, recomputed from the files in the tree).
Runtime: Next.js dev on `http://localhost:3000`; the agent runtime container on
`:3010`; a plain static server on a second origin for the third-party page of W7.
Provider: **real** — `CINATRA_TEST_LLM_PROVIDER` unset. The provider key lives in
the instance database, sealed there through the app's own provider form; it was
never written to a file, never passed as an argument and never printed.

**Direct SQL disclosure.** The only statements issued by hand against the instance
database this round were `SELECT`s — every row below is a readback. No run, gate,
artifact, representation, resource, audit or usage row was inserted, updated or
deleted by hand. Every state change came from a control pressed in a browser.

## The pinned agent

| reading | value |
|---|---|
| checked-out package `HEAD` | `03a27f524d59f90f635ee98c1b5900c4bc9f7f6e` |
| package version on disk | `0.1.4` |
| boot scan | `[cinatra:extensions:agent] @cinatra-ai/blog-draft-writer-agent 0.1.4 upserted` (the leading v of the printed token is dropped for the repository's version-token rule) |
| the agent runtime the runs reached | `/.health` → `{"status":"ok","agents":29,"failed":0,"failed_agents":[]}` |

## The runs re-taken on this head

```
agent_runs
  id            88634469-a0d1-47be-94a4-473cbb25bf75   (pending — W3, W5)
  status        completed
  human_present t
  created_at    2026-08-27 00:24:05.632287+00
  completed_at  2026-08-27 00:27:43.719+00

  id            ef14a5dd-1d1a-4a1f-8762-d55b55e985c0   (decided — W9)
  status        completed
  human_present t
  created_at    2026-08-27 00:39:59.017318+00
  completed_at  2026-08-27 00:51:48.217+00
```

The runs behind the three standing cells are unchanged and are recorded in the
commit those files came from: `579d0473-4b5d-40b9-9d79-8126560bbf06` (W0, W1) and
`01437642-8900-4c12-9cfc-c9a5db44ca24` (W7).

**One failed run, disclosed.** `49e4f31b-f87c-4b35-a2a9-36858614fbf2` is `failed`
in `agent_runs` — a first attempt at the pending run, whose dispatch had no agent
runtime to reach (`[wayflow] dispatch failed … TypeError: fetch failed`) because
this instance's own `dev:stop` had stopped that container. The runtime was
restarted before either pictured run was driven. No picture shows it.

## The review gates

```
artifact_review_gates
  id             534ca557-f45e-4ff0-9d7a-468cb0e1ef27
  run_id         88634469-a0d1-47be-94a4-473cbb25bf75
  status         pending
  disposition    (null)
  resolved_by    (null)
  resolved_at    (null)
  created_at     2026-08-27 00:28:00.20752+00
  review_task_id lifecycle-review:79a42743b9fb8fd23e66a698507030f335494d4ab380d9b455472dd7cb40c1db
  pinned_targets [{"artifactId":"bafb9bd6-abb4-4801-a3fa-78f78a358549",
                   "representationRevisionId":"5b1be384-0a70-4d9c-9f5b-0db82d398db9"}]

  id             f079f282-7bf8-4105-ba01-db115dc89326
  run_id         ef14a5dd-1d1a-4a1f-8762-d55b55e985c0
  status         resolved
  disposition    approve
  resolved_by    2660f48b-6a11-423a-afdd-a148139bf86d   (the signed-in reviewer)
  resolved_at    2026-08-27 00:54:24.54582+00
  created_at     2026-08-27 00:51:51.253535+00
  review_task_id lifecycle-review:77e016c0ed698491d3901b47f545259ae17fbdcd505db60e44c6330e8e77cbfd
  pinned_targets [{"artifactId":"e98f02e5-cb3a-40c1-8a52-b47bccd205a3",
                   "representationRevisionId":"43e75a37-3bc8-4322-9da7-8a01ec30a49c"}]
```

**Each gate is minted after its run has already terminated** —
`00:27:43.719` → `00:28:00.208` (16.5 s) and `00:51:48.217` → `00:51:51.254`
(3.0 s). Named in the README, not fixed here.

**The pending gate was re-read after the decided run's Approve** and was still
`pending`, `disposition` null: neither re-taken cell is staged from a state the
other changed.

## The run and gate behind W7, on this head

Every row below is a `SELECT` readback. Nothing here was inserted, updated or
deleted by hand; the run was driven entirely by presses in a browser.

```
agent_runs
  id            4dfd78f9-4d4e-43a5-8d9e-9f334908efd3   (pending — W7 light and dark)
  status        completed
  human_present t
  created_at    2026-08-27 02:20:02.97961+00
  completed_at  2026-08-27 02:23:11.486+00

artifact_review_gates
  id             fb69f4b6-c086-4e51-abdb-8531776a8005
  run_id         4dfd78f9-4d4e-43a5-8d9e-9f334908efd3
  status         pending
  disposition    (null)
  resolved_by    (null)
  resolved_at    (null)
  created_at     2026-08-27 02:23:34.325868+00
  review_task_id lifecycle-review:b15d3da1fe8138a431b30a6aa87548e3498b9247567afd8c0fac592559f26f74
  pinned_targets [{"artifactId":"de418b67-807f-4975-bc6a-b600c5412a6f",
                   "representationRevisionId":"d41e0d95-d1e4-48f2-b626-9a1620e7f850"}]

representation
  id                d41e0d95-d1e4-48f2-b626-9a1620e7f850   (the pinned revision)
  artifact_id       de418b67-807f-4975-bc6a-b600c5412a6f
  revision          1
  form              file
  resource_id       810ab2f8-3bee-499f-8d6a-94d90d26e940
  created_by_run_id 4dfd78f9-4d4e-43a5-8d9e-9f334908efd3
  created_at        2026-08-27 02:23:11.225533+00

resource
  id            810ab2f8-3bee-499f-8d6a-94d90d26e940
  kind          blob
  mime          text/markdown
  size_bytes    6086
  substance_key blob:9ca5ffd0e41e7b45661736791333a9529f29ceb3cc1a7ef967963e21c3185b2f
```

**This gate is minted after its run terminates**, like the others in this
directory: `02:23:11.486` → `02:23:34.326`, **22.8 s**. Named, not fixed here.

**The reviewed work is prose.** The blob was read off disk and hashed:
`sha256 9ca5ffd0e41e7b45661736791333a9529f29ceb3cc1a7ef967963e21c3185b2f`, 6 086
bytes, first byte `#`, and **zero** occurrences of `"content":` — no JSON envelope
in the target either W7 frame shows.

**The gate was still `pending` after both frames.** It was re-read from the row
after the second capture: `status = pending`, `disposition` null, `resolved_by`
null. Neither frame is staged from a state the other changed.

## The decision the browser wrote

```
artifact_review_audit
  id                          51b718dc-9e43-464f-a241-ec2c5055c3bc
  gate_id                     f079f282-7bf8-4105-ba01-db115dc89326
  run_id                      ef14a5dd-1d1a-4a1f-8762-d55b55e985c0
  artifact_id                 e98f02e5-cb3a-40c1-8a52-b47bccd205a3
  representation_revision_id  43e75a37-3bc8-4322-9da7-8a01ec30a49c
  disposition                 approve
  renderer_kind               first-party
  renderer_package            (null)
  renderer_digest             (null)
  created_at                  2026-08-27 00:54:24.54582+00
```

Approve was pressed in the browser at `00:54:23.451`, over a rationale typed into
the card's own field. The audit row and the gate's `resolved_at` carry the same
stamp, `00:54:24.54582+00`.

## The reviewed work

```
objects
  bafb9bd6-abb4-4801-a3fa-78f78a358549  @cinatra-ai/blog-post-artifact:post
                                        organization  2026-08-27 00:27:43.331755+00
  e98f02e5-cb3a-40c1-8a52-b47bccd205a3  @cinatra-ai/blog-post-artifact:post
                                        organization  2026-08-27 00:51:47.911208+00

representation
  5b1be384-0a70-4d9c-9f5b-0db82d398db9  artifact bafb9bd6-…  revision 1  form file
      resource 8d54bb47-73cd-475f-8e7a-aadd67599fad
      created_by_run_id 88634469-…      2026-08-27 00:27:43.331755+00
  43e75a37-3bc8-4322-9da7-8a01ec30a49c  artifact e98f02e5-…  revision 1  form file
      resource ace23d46-7efb-472a-91ac-37ea9fa41626
      created_by_run_id ef14a5dd-…      2026-08-27 00:51:47.911208+00

resource
  8d54bb47-73cd-475f-8e7a-aadd67599fad  blob  text/markdown  6 086 bytes
  ace23d46-7efb-472a-91ac-37ea9fa41626  blob  text/markdown  5 734 bytes

artifact_blobs (local-disk)
  sha256 00f42c92d1663dbcb067e16543feb126c0ba48d40eb70ecca5946fc48e004699  6 086
  sha256 e003f30c647e4d984701415d1742c030dc77789efc5e5484f7ad3465aacc6516  5 734
```

`mime = text/markdown` is what makes these the acceptance's *markdown draft*, and
what the card's text rung resolves on. Read from the stored bytes themselves: the
first begins `## Why the ritual drifts once the dashboard is automatic`, the second
`## The cost a recurring meeting hides`, and **each contains zero occurrences of
`"content":`** — no JSON envelope reached any target in this set.

## The usage ledger — the real model, both runs

```
usage_events
  2026-08-27 00:27:40.589768+00  llm  openai  gpt-5.5-2026-04-23  generate
      blog-draft-writer-agent   38 744 in / 1 683 out   (the pending run)
  2026-08-27 00:51:45.804991+00  llm  openai  gpt-5.5-2026-04-23  generate
      blog-draft-writer-agent   38 717 in / 1 701 out   (the decided run)
```

Each run also shows one `chat` stream (the turn that dispatched it) and the
`artifact-matcher` calls that follow the draft. No stub provider appears anywhere;
`CINATRA_TEST_LLM_PROVIDER` was unset for the whole round.

## The usage ledger for the W7 run — the real model

Every row a `SELECT` readback from `usage_events`, for the window the W7 run
occupied. `CINATRA_TEST_LLM_PROVIDER` was unset; no scripted provider appears.

```
occurred_at (UTC)          source provider model               operation agent_label              in     out
2026-08-27 02:20:12.396+00 llm    openai   gpt-5.5             stream    chat                     22 885   122
2026-08-27 02:23:09.388+00 llm    openai   gpt-5.5-2026-04-23  generate  blog-draft-writer-agent  38 736 1 592
2026-08-27 02:23:36.397+00 llm    openai   gpt-5.5-2026-04-23  generate  artifact-matcher          1 884    88
2026-08-27 02:23:41.108+00 llm    openai   gpt-5.5-2026-04-23  generate  artifact-matcher          1 910   181
2026-08-27 02:23:44.597+00 llm    openai   gpt-5.5-2026-04-23  generate  artifact-matcher          1 926   102
2026-08-27 02:23:47.452+00 llm    openai   gpt-5.5-2026-04-23  generate  artifact-matcher          1 975    93
2026-08-27 02:23:50.247+00 llm    openai   gpt-5.5-2026-04-23  generate  artifact-matcher          2 016    86
2026-08-27 02:23:53.300+00 llm    openai   gpt-5.5-2026-04-23  generate  artifact-matcher          1 991   113
2026-08-27 02:23:56.465+00 llm    openai   gpt-5.5-2026-04-23  generate  artifact-matcher          1 967   105
2026-08-27 02:24:00.461+00 llm    openai   gpt-5.5-2026-04-23  generate  artifact-matcher          2 004   126
2026-08-27 02:24:03.439+00 llm    openai   gpt-5.5-2026-04-23  generate  artifact-matcher          1 943    88
2026-08-27 02:24:06.233+00 llm    openai   gpt-5.5-2026-04-23  generate  artifact-matcher          1 995   102
```

The draft-writing row carries `requested_provider = openai` and
`effective_provider = openai`.

## The slot, as the page itself recorded it (W0, W1 — the standing cells)

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

Both W7 frames — re-taken on `f20bb3ff6372fe3d6882f490a9289512a21a95f1` — were
taken in a fresh browser context with an **empty** cookie jar; the reader signed in
through the frame's own hosted-PKCE popup, on a host page served from
`http://127.0.0.1:8088` by a plain static server, a different origin **and a
different site** from the app on `http://localhost:3000`.

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

Viewport 1440×900, `deviceScaleFactor: 2` → 2880×1800 pixels each. The two rows
marked **re-take** were shot on `f20bb3ff6372fe3d6882f490a9289512a21a95f1` and are
the only two files this commit replaces; the other ten are the files already in
the tree, **unchanged byte for byte** — each sha256 below was recomputed from the
file in the tree and matches the value recorded when that file was taken, and each
of those ten git blob ids is identical to the one at
`f20bb3ff6372fe3d6882f490a9289512a21a95f1`.

| file | sha256 | bytes |
|---|---|---|
| `captures/W0__placeholder__chat_thread__working__light.png` | `20a79cfb0e554af0d7441f7587487aa478c2e4cc8ce2c147c48c5c991fb4abf4` | 363 852 |
| `captures/W0__placeholder__chat_thread__working__dark.png` | `38d368768dad138e0b3b22d3c29730cf60ce326fd243c10f27b183fea3e4268c` | 339 355 |
| `captures/W1__review-card__chat_thread__pending__light.png` | `949b1332c9ae2fce007a09ca40df2878c992341e257e71b2b64bc31ade9dbec1` | 367 024 |
| `captures/W1__review-card__chat_thread__pending__dark.png` | `69ea12575b17332b1df0264df9faeb76a2c67610aef5bab625c139207f7e6856` | 361 362 |
| `captures/W3__review-card__run_page__pending__light.png` | `5fbf568b2d6037eaedfc894853117af8a2c3a74349b7dd71ab7ce14456a7c586` | 303 091 |
| `captures/W3__review-card__run_page__pending__dark.png` | `367476221003d54c165475ff16ef619bbca4b601ccef73fefe98fbe326b678a5` | 291 093 |
| `captures/W5__review-card__review_page__pending__light.png` | `d5298628add1b5b98b87e03737c2cf0a4a06a1232f78e36d9c136cfba704fd61` | 416 388 |
| `captures/W5__review-card__review_page__pending__dark.png` | `31a6f05b3bc5f514398f76f42abbe73bf1bd16f6c437b3aff3bfe17fdb9d7141` | 412 720 |
| **re-take** `captures/W7__review-card__site_widget__pending__light.png` | `361a1bc3e6a94dc578e4db2db8883c49e82467f8a9a170271ad4cf0fb8d18034` | 213 057 |
| **re-take** `captures/W7__review-card__site_widget__pending__dark.png` | `92783e14c6afffe3e5314bdb09b6d6dc2310f00026babef3d08f452b0ce4090e` | 210 785 |
| `captures/W9__review-card__review_page__decided__light.png` | `5834500d99d75d676206a71a218097395374f51047c69b21dd225e9b651ca0b3` | 153 325 |
| `captures/W9__review-card__review_page__decided__dark.png` | `c64ae2b26d29c62195a26ed52f07a22c9debdc6732a5ff7d05970c47cfd0ce6f` | 152 520 |

## The shutters, and what was true at each

Every entry was re-counted immediately after its shutter; `after` records that
re-count. The cells re-taken on `d0db4293d72b` also assert `location.pathname` at
the shutter, so no frame can be mistaken for a neighbouring route; the two W7
frames instead assert the **pinned revision printed on the card**, which is what
distinguishes this run's card from the other reviews pending on this instance. The
W7 shutter times are the moment each PNG was written.

```
--- re-taken on d0db4293d72b, 2026-08-27 (UTC) ---
W3 light  00:36:33   path=/agents/cinatra-ai/blog-draft-writer-agent/88634469-…
                     rail="Step 1 | Review"   promptWindow=false
                     cards=1 islands=1 iframes=1 approve/reject/comment=1/1/1
                     island body=1 empty=0 targets=1 rendered=true rawsource=true
                     noRenderer=false floor=0 preview=0 download=0
W3 dark   00:36:47   the same readings, theme=dark
W5 light  00:40:08   path=/agents/…/88634469-…/review/lifecycle-review%3A79a42743…
                     rail="1 | Schedule | 2 | Review"   promptWindow=true
                     cards=1 islands=1 iframes=1 approve/reject/comment=1/1/1
                     island rendered=true rawsource=true  floor=0 preview=0 download=0
W5 dark   00:40:22   the same readings, theme=dark
W9 light  00:54:32   path=/agents/…/ef14a5dd-…/review/lifecycle-review%3A77e016c0…
                     rail="1 | Schedule | 2 | Review"  settled-rail-rows=0
                     cards=1 approve=0 reject=0 comment=0 resolved=true
W9 dark   00:54:44   the same readings, theme=dark

--- standing, unchanged (their own commits) ---
W0 light  16:49:33.505  slot=working ph=1 cards=0 approve=0            after: true
W0 dark   16:49:46.028  slot=working ph=1 cards=0 approve=0            after: true
W1 light  16:50:04.945  slot=review  ph=0 cards=1 approve=1 island=1   after: true
W1 dark   16:50:20.590  slot=review  ph=0 cards=1 approve=1 island=1   after: true

--- re-taken on f20bb3ff6372, 2026-08-27 (UTC) ---
W7 light  02:30:52   host page http://127.0.0.1:8088 — a different origin AND site
                     cards=1 islands=1 signin-controls=0 approve/reject/comment=1/1/1
                     reviewRequested=true rationale=true signInPrompt=false
                     island body=1 empty=0 targets=1 rendered=true
                     noRenderer=false floor=0 preview=0 download=0
                     pinned revision printed on the card: d41e0d95-d1e…
                     card top inside the frame = 296.375 (the framing offset)
W7 dark   02:32:29   the same readings, theme=dark
                     chip outline rgb(37,47,63) on ground rgb(13,24,42)   contrast 24
                     meta ink rgb(144,161,185)   Approve fill rgb(226,232,240)

Approve was pressed on the decided run at 00:54:23.451; the gate row settled at
00:54:24.54582 and both W9 frames were taken after that.
```

## The rail, read live on this head

The two rails the README's W3 and W9 cells distinguish, read from their own
anchors on this head, for the runs pictured:

```
run page  /agents/…/88634469-…            (the pending run — W3's route)
    [data-conformance-id="run-step-rail"]  →  "Step 1 | Review"
    entry 1  kind=step  status=completed  "Step 1"
             colour rgb(21,33,58)  weight 400  ground rgba(0,0,0,0)
    entry 2  kind=gate  status=pending    "Review"
             colour rgb(21,33,58)  weight 400  ground rgba(0,0,0,0)

run page  /agents/…/ef14a5dd-…            (the decided run)
    entry 2  kind=gate  status=resolved   "ReviewAPPROVE"

trigger   /agents/…/ef14a5dd-…/trigger    (the setup rail of cinatra#2970/#2975)
    row  schedule        selected=true   settled=false  action=open-schedule-step
    row  recommendation  reached=false   settled=false  aria-disabled=true
                         action=recommendation-step-unavailable
    row  review          reached=true    settled=true   action=open-review-step
                         indicator text EMPTY  → the completed circle in place of
                         the numeral, the title unhighlighted

review    /agents/…/ef14a5dd-…/review/…   (the decided gate — W9's route)
    [data-review-run-steps]                →  "2 | Review"
    [data-run-surface-rail-settled="true"] →  0 elements
```

## The island's address and colour, read live on this head (W3's route)

The card composes the island address from the palette class of the document **it**
is mounted in. Read from the parent DOM while pressing the app's own theme control:

```
root class ... cinatra   island src /lifecycle/review-island  params [ref, scheme]  scheme=light
    island ground rgb(247, 247, 243)   ink rgb(21, 33, 58)
root class ... dark      island src /lifecycle/review-island  params [ref, scheme]  scheme=dark
    island ground lab(3.87463 0.500388 -12.2712)   ink lab(98.1434 -0.369519 -1.05966)
```

The palette named on the address tracks the host document's palette class exactly,
and the island's ground and ink move with it. On this first-party route the address
carries **no** credential parameter — the parameters are `ref` and `scheme` and
nothing else; the credentialed arm is the third-party application's. No credential
value is recorded here, or anywhere in this directory.

## The island's colour in the third-party application (W7 — re-taken on this head)

These readings belong to **W7**, re-taken on
`f20bb3ff6372fe3d6882f490a9289512a21a95f1`. Each pixel value below was sampled
**from the committed PNG itself** at device scale 2 — the chip's own border rows
against the panel ground taken just outside the pill — not from a re-render. The
run-page rows are the first-party comparison, read on this same head from the same
pending run, and are **not** a measurement of the W3 files in this commit.

```
                                          panel ground      outline pixel on the
                                                            chip's border rows
third-party application, dark  (W7, now)  rgb(13,24,42)     rgb(37,47,63)   pill DRAWN   contrast 24
third-party application, dark  (SUPERSEDED) rgb(13,24,42)   rgb(14,25,44)   pill absent  contrast  2
run page, dark            (comparison)    rgb(13,24,42)     rgb(37,47,63)   pill drawn   contrast 24
third-party application, light (W7, now)  rgb(255,255,255)  rgb(222,224,227) pill drawn  contrast 33
```

**The two hosts measure the same colour on the same ground in dark.** Both values
are what compositing predicts from the tokens: the dark hairline is
`rgba(255,255,255,0.1)` and `0.1×255 + 0.9×(13,24,42) = (37,47,63)`; the light
hairline is `rgba(21,33,58,0.14)` and over white gives `(222,224,227)`. The
superseded frame's `rgb(14,25,44)` is that same **light** hairline composited over
the **dark** panel — which is the ground to two levels, and is why it read as no
outline at all.

Two more readings from the same alias layer, sampled the same way:

```
                                          third-party app, dark   run page, dark
header meta line ink (text-muted-foreground)  rgb(144,161,185)     rgb(144,161,185)
Approve fill (--primary)                      rgb(226,232,240)     rgb(226,232,240)
Approve fill, SUPERSEDED frame                rgb(54,78,129)       —
```

`rgb(144,161,185)` is the dark palette's `--muted` (`#90a1b9`); in light the same
line measures `rgb(90,100,119)`, the light palette's `--muted` (`#5a6477`).

The computed styles read out of the same mounted documents agree with the pixels:

```
                                    third-party application, dark   run page, dark
--border   at the chip              #ffffff1a                       #ffffff1a
--muted-foreground at the meta line #90a1b9                         #90a1b9
chip border-top-color               rgba(255, 255, 255, 0.1)        rgba(255, 255, 255, 0.1)
meta color                          rgb(144, 161, 185)              rgb(144, 161, 185)
panel background-color              lab(8.11015 0.0567511 -14.1465) lab(8.11015 0.0567511 -14.1465)
--border   at the DOCUMENT ROOT     #15213a24                       #ffffff1a
--muted-foreground at the ROOT      #5a6477                         #90a1b9
document root carries the palette   no                              yes ("… dark")
```

The last three rows are the mechanism, visible as a reading: inside the widget the
island's own document root still resolves the **light** alias layer, because a page
cannot write its own document root and the palette class is carried on a wrapper
below it. What changed on this head is that the wrapper now re-declares that layer,
so every element under it — the chip, the meta line, the Approve button — resolves
dark, while the root, which nothing paints from, is left as it was. On the run page
the palette class sits on the root itself, so root and chip agree; that host's
readings are **unchanged** by this commit, which is what allows the first-party
cells to be carried forward byte-identical.
