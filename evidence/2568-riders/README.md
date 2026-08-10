# cinatra#2568 riders (AC-1, AC-5) + #2623 — the live walk

Head under proof: `lane/2568-riders-poll-retirement` on `origin/main` @ `fa406a0a0`
(S2 renderer merged; S4 wire merged at `6bed30a8e`).

Instance: the S2 proof stack reused verbatim — the same database, queue and port
the `#2566` battery ran on, with the committed
`tests/fixtures/review-gate-agent/` tree staged into `extensions/`. Nothing
about the fixture or the instance was re-invented; only the CODE under it
changed. The orphaned dev server the S2 lane had left on that port (ppid 1, its
lane long merged) was stopped by pid before this walk booted its own.

Identity: a fresh Better Auth sign-up through the app's own
`/api/auth/sign-up/email`, then made a member of the run's organization and a
platform admin — the same standing the fixture's own UAT account has. No
existing credential was read or reused.

## What is REAL here

Everything the riders touch. In particular:

- The review gates are the REAL gates the S2 walk minted through the WayFlow
  runtime — two runs still paused `pending_approval` on `status='pending'` rows
  in `artifact_review_gates`.
- The recommendation hold is a REAL park: a run started from the UI, held
  PRE-DISPATCH by `maybeHoldRunForRecommendation` through the real policy
  evaluation, writing a real `lifecycle_continuation_park` row
  (`e3403b3e-…`, checkpoint `recommendation`, status `parked`).
- The confirm went through the shipped `confirmRunRecommendationAction`, which
  released the park (`status='released'`) and dispatched the run
  (`pending_input` → `pending_approval`).

The one STAGED step, named plainly: three `custom_skill_assignments` rows were
inserted so the agent has candidate skills at all — the hold parks IFF the
scorer returns at least one candidate, and this instance had zero assignments.
That is configuration, the same class of staging as copying the fixture
extension into `extensions/`; it is not the thing under test. The park, the
wire, the card, the decision and the dispatch are all the shipped path.

## #2623 — the run-DETAIL page draws the review card

`/agents/cinatra-review-fixture/marked-review-gate/9968d551-…`, a run paused on
a real marked gate. Capture: `riders-01-2623-run-detail-review-card.png`.

| Assertion | Result |
|---|---|
| The generic `"no renderer configured for this step"` fallback | **ABSENT** (`false`) — this is the defect the issue filed |
| A review card renders on the page | **PRESENT** — "Review requested · Awaiting your decision" |
| The island renders the target | **1 iframe** |
| The decision floor is on the page | "DECISION RATIONALE (optional on approve, expected on reject)" + **Comment / Reject / Approve** |
| A second renderer was introduced | **NO** — the mount is the shared `ReviewGateCard`, under `LifecycleCardSurfaceProvider host="run_card"` |

## #2568 AC-1 — the 4-second poll is gone

The hold on the wire, read off the shipped SSE route for the REAL park
(`/api/agents/runs/86afc6e9-…/stream`, 6-second observation):

```
INTERRUPT  xRenderer=@cinatra-ai/lifecycle:recommendation-hold
           interaction={kind:"recommendation_hold", schemaVersion:1, ref:<154 chars>}
```

That is the typed discriminator and the opaque ref the card keys on — the
reconnect-authoritative snapshot answering on connect, exactly as S4 built it.

The network measurement, on the run-card host (`AgenticRunPanel`, confirmed
present on the page), over a **44-second** window —
`run-card-network-44s.txt`:

| Request class | Count in 44 s |
|---|---|
| Server-action POSTs to the page (where the hold-state action rides) | **4, all at mount** (log positions 79, 86, 87, 89) |
| Server-action POSTs after mount settled | **0** |
| `/api/agents/runs/<id>` status GETs (the panel's own pre-existing REST poll, untouched by this change) | **100+, continuous** |

The distinction is the point: the page stayed alive and busy for the whole
window — the run-status poll kept firing throughout — while the hold-state
action stopped after mount. A 4-second interval would have produced roughly
eleven evenly-spaced POSTs across that same window. There are none.

## #2568 AC-5 — the ONE-card mount

`RecommendationHoldCard` is the only renderer of `recommendation_hold`, mounted
under the declared `run_card` host. Structurally verified in the suite
(`recommendation-hold-card.test.tsx`):
`agentic-run-panel.tsx` and `orchestrator-stepper-panel.tsx` contain no
`<RunRecommendationChipRow` mount, no `getRunRecommendationHoldStateAction`
reference and no `setInterval(fetchState` — and the card file contains no
`setInterval` at all.

The HELD row itself was captured on the run-detail host
(`riders-02-real-hold-parked-run.png`) — "Confirm the skills for this run",
three candidate chips, Confirm / Skip — which is the SAME
`RunRecommendationChipRow` component the card composes, drawn from the same real
park. That host's mount is server-rendered (`instance-screens.tsx`) and is
deliberately unchanged by this branch.

## Honest gaps

- **The HELD state was not captured under `AgenticRunPanel` itself.** That host
  renders only for `run.status !== "pending_input"` (`instance-screens.tsx`),
  and a held run IS `pending_input` — so on the run-detail page the two never
  coexist by construction. The chat thread is the surface where a held run and
  the run card do coexist, and reaching it needs an LLM-backed chat dispatch,
  which this credential-free instance cannot do. The held rendering on that host
  is covered by the card suite (17 tests, including the fake-timer no-poll
  assertion and the wire-ref/RESUME transitions), not by this walk.
- **The decided summary drew nothing** after the confirm, correctly: the
  confirmed set was empty (no candidate was `recommended`), and with no selected
  revisions and no skip evidence the action answers `none`, so the card draws no
  DOM. That is the specified behaviour, not a missing render.
- **The `restricted` and `loading` card states** were not exercised, for the
  same reasons the S2 battery recorded.
