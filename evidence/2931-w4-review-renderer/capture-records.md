# capture records — cinatra#2931 (W4)

Head under proof: **`d0db4293d72b4554bf1c4b00fc7d5363c82375b3`** for **W3**, **W5**
and **W9**, re-taken on this head; **`011da4d6133a16e81a3f79a9ce0dcbb9b6fba8a0`**
for **W7** and **`1c3649503d511942538c626d4ebc964e50e1302c`** for **W0** and
**W1**, whose files are carried over **byte-identical** (their sha256 values below
are unchanged from those commits, recomputed from the committed blobs).
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

Viewport 1440×900, `deviceScaleFactor: 2` → 2880×1800 pixels each. The six rows
marked **re-take** were shot on `d0db4293d72b4554bf1c4b00fc7d5363c82375b3`; the
other six are the files already in the tree, **unchanged byte for byte** — each
sha256 below was recomputed from the committed blob and matches the value recorded
when that file was taken.

| file | sha256 | bytes |
|---|---|---|
| `captures/W0__placeholder__chat_thread__working__light.png` | `20a79cfb0e554af0d7441f7587487aa478c2e4cc8ce2c147c48c5c991fb4abf4` | 363 852 |
| `captures/W0__placeholder__chat_thread__working__dark.png` | `38d368768dad138e0b3b22d3c29730cf60ce326fd243c10f27b183fea3e4268c` | 339 355 |
| `captures/W1__review-card__chat_thread__pending__light.png` | `949b1332c9ae2fce007a09ca40df2878c992341e257e71b2b64bc31ade9dbec1` | 367 024 |
| `captures/W1__review-card__chat_thread__pending__dark.png` | `69ea12575b17332b1df0264df9faeb76a2c67610aef5bab625c139207f7e6856` | 361 362 |
| **re-take** `captures/W3__review-card__run_page__pending__light.png` | `5fbf568b2d6037eaedfc894853117af8a2c3a74349b7dd71ab7ce14456a7c586` | 303 091 |
| **re-take** `captures/W3__review-card__run_page__pending__dark.png` | `367476221003d54c165475ff16ef619bbca4b601ccef73fefe98fbe326b678a5` | 291 093 |
| **re-take** `captures/W5__review-card__review_page__pending__light.png` | `d5298628add1b5b98b87e03737c2cf0a4a06a1232f78e36d9c136cfba704fd61` | 416 388 |
| **re-take** `captures/W5__review-card__review_page__pending__dark.png` | `31a6f05b3bc5f514398f76f42abbe73bf1bd16f6c437b3aff3bfe17fdb9d7141` | 412 720 |
| `captures/W7__review-card__site_widget__pending__light.png` | `2e1d0d54674b5a7642fb552563e0a03f4626c5506175783368d867f88fce6a7e` | 198 449 |
| `captures/W7__review-card__site_widget__pending__dark.png` | `03a11fe63a1aea4d4f8948cb94f6a07ec942b90460a6e4930e2f2462c047562b` | 194 432 |
| **re-take** `captures/W9__review-card__review_page__decided__light.png` | `5834500d99d75d676206a71a218097395374f51047c69b21dd225e9b651ca0b3` | 153 325 |
| **re-take** `captures/W9__review-card__review_page__decided__dark.png` | `c64ae2b26d29c62195a26ed52f07a22c9debdc6732a5ff7d05970c47cfd0ce6f` | 152 520 |

## The shutters, and what was true at each

Every entry was re-counted immediately after its shutter; `after` records that
re-count. The three re-taken cells also assert `location.pathname` at the shutter,
so no frame can be mistaken for a neighbouring route.

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
W7 light  22:54:30      cards=1 islands=1 signin-controls=0 approve/reject/comment=1/1/1
                        island body=1 empty=0 targets=1 rendered=true
                        signInPrompt=false noRenderer=false floor=0 preview=0 download=0
W7 dark   23:04:17      the same readings, theme=dark

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

## The island's colour in the third-party application (W7 — the standing cell)

These readings belong to **W7**, which stands unchanged in this commit; they were
sampled from that cell's own captures on the head it was taken on, and are carried
here because they are the measurement its verdict rests on. The run-page rows are
the first-party comparison those readings were taken against, and are **not** a
measurement of the W3 files in this commit — W3's island is measured live on this
head in the section above.

```
                                        island ground     brightest pixel on the
                                                          chip's border rows
run page, dark            (comparison)  rgb(13,24,42)     rgb(37,47,63)   pill drawn
run page, dark, mounted dark            rgb(13,24,42)     rgb(37,47,63)   pill drawn
third-party application, dark  (W7)     rgb(13,24,42)     rgb(14,25,44)   pill ABSENT
run page, light           (comparison)  near-white        pill drawn
third-party application, light (W7)     near-white        pill drawn
```

The island's ground is the same value on both hosts in dark — the defect the earlier
W7 dark frame showed (a white panel inside a dark widget) is gone. The one reading
that still differs between hosts is the chip's pill outline, absent in the
third-party application in dark; it is named in the README's W7 cell rather than
left to be found. The "mounted dark" row is a separate load, taken with the app
already dark before the run page opened, so the pill is not a product of the repaint
path.
