# cinatra#2566 / PR #2612 — the S2 card battery, on a REAL minted gate

Head under proof: the rebase of `feat/chat-hitl-s2-review-gate-card` onto
`origin/main` @ `c4ba2150e` (S1 + S3 + S4 + the picker verdict all merged).
Spec pin: **design@`6c20871b4108176c1d0193f19ecd2947f6c6355f`**
(`specs/app-lifecycle-cards.html`) §II, §III, §IV, §IX.

**The prior lane's blocker is CLOSED.** It named the cause correctly — a FIXTURE
GAP, not a defect in the S3 listing path — and this lane built the missing piece:
`tests/fixtures/review-gate-agent/`, a deterministic no-LLM agent whose single
`InputMessageNode` gate declares
`metadata.cinatra.artifactReview.targetsInput`. The run executor's marked-gate
branch now has a credential-free producer.

## The gate is real, and so is everything downstream

```
[artifact-review-gate] run=ab353fb5-… task=92e207f3-… pinned review targets
  + routed to /agents/cinatra-review-fixture/marked-review-gate/ab353fb5-…/review/wayflow-92e207f3-…
```

Five gates were minted this way. Nothing is SQL-seeded except the run row and the
BullMQ job — the same bypass, with the same stated reason, that
`tests/e2e/agents-run/seed.ts` already uses. The artifacts are real uploads
through `POST /api/artifacts/upload`; the identity is a real Better Auth sign-up;
the WayFlow runtime really executes the flow and really pauses `input-required`;
`emitArtifactReviewGate` really pins the targets; and both decision transports
really release the paused run (`agent_runs.status → completed`).

## Per-item verdicts

### §II — the card in the thread, per host frame

| # | Item | Verdict | Evidence |
|---|---|---|---|
| II-1 | The card renders in the **chat thread** (host `chat_thread`) | **PASS** | 2 island frames + 4 `POST /api/lifecycle-views/resolve` in one transcript; `s2-05-chat-thread-and-run-card.png` |
| II-2 | The card renders in the **run card** (host `run_card`, the inline `AgenticRunPanel`) | **PASS** | the second island frame in the same transcript, with the 8 `/api/agents/runs/<id>` polls only the run panel issues |
| II-3 | The card renders in the **page gate region** (host `page_gate_region`) | **PASS** | `s2-02-review-page-gate-region.png`; 1 island frame, 1 floor |
| II-4 | The decision floor: Comment / Reject / Approve over the rationale field | **PASS** | `review-page-text.txt` — "DECISION RATIONALE (optional on approve, expected on reject)" then Comment, Reject, Approve |
| II-5 | Several targets, **ONE** floor | **PASS** | a 2-target gate renders 2 stacked target panels inside the island and exactly **1** Approve button on the page |

### §III — what the target shows

| # | Item | Verdict | Evidence |
|---|---|---|---|
| III-1 | Target panel names its **pinned revision** | **PASS** | `island-text.txt` — "revision c4d9d011-ae9… · pinned", "revision 40f5f009-471… · pinned" |
| III-2 | The **tier ladder** is named on the panel | **PASS (build-time tier only)** | both targets resolve `build-time · detail`. The **runtime** tier and the **metadata floor** were NOT exercised — no installed extension on this instance resolves a runtime renderer for an uploaded artifact, and every target here typed cleanly, so neither lower rung could be reached without fabricating a broken target |
| III-3 | Provenance line (package · revision · scope · mime · updated) | **PASS** | `@cinatra-ai/json-artifact:artifact · revision … · pinned · user · private · application/json · updated …` |
| III-4 | The island carries **no decision chrome** | **PASS** | no Approve / Reject / "Decision rationale" anywhere inside the frame |
| III-5 | Honest-gap lines (pinned capture pair, focused composer — drawn nowhere, not invented) | **PASS (by absence)** | neither is drawn on any host; the spec records both as undrawn |

### §IV — the reachable states

| # | State | Verdict | Evidence |
|---|---|---|---|
| IV-1 | `pending` | **PASS** | resolve → `{"state":"pending","canDecide":true,"canComment":true}` |
| IV-2 | `settled` — "This review is no longer open" + Refresh, no stale decision | **PASS** | `s2-06-settled-no-longer-open.png`; Approve buttons = 0 |
| IV-3 | `absent` (**reader**) — no card DOM | **PASS at the network layer; NOT ISOLATED in the DOM** | a non-owner org member and a non-member both get `200 {"state":"absent"}` — byte-identical to a forged ref — and the decide entry answers them the single uniform refusal. The **page-level** DOM assertion could not isolate the card: a non-owner also cannot read the THREAD that carries it, so "no card" there is over-determined |
| IV-4 | `absent` (**surface**) — no card DOM, and **no resolve at all** | **PASS** | the widget surface issues **0** `/api/lifecycle-views/resolve` and draws 0 island frames, against the reader-absence which DOES issue one. The two branches are distinguishable exactly as the PR claims, and only by the observer's own network log |
| IV-5 | `restricted` — may view, may not decide | **NOT REACHED** | run access is owner-first and an `AgentAuthPolicy` can only TIGHTEN, never grant, so a non-owner never gets run READ without approve on this instance. Covered by the shipped unit tests, not by this walk |
| IV-6 | `loading` | **NOT ISOLATED** | the skeleton is sub-frame on a warm dev server; no capture attempts to claim it |

### §IX — the presence matrix

| # | Item | Verdict | Evidence |
|---|---|---|---|
| IX-1 | Chat thread — Yes | **PASS** | above |
| IX-2 | Run card — Yes | **PASS** | above |
| IX-3 | Page gate region (the review island) — Yes | **PASS** | above |
| IX-4 | Site widget — **NO card** | **PASS** | exactly three `LifecycleCardSurfaceProvider` declarations exist in the tree (`chat_thread`, `run_card`, `page_gate_region`); `site_widget` appears only in a comment, and the widget surface renders no renderable views at all. Network-confirmed: 0 resolves |

### Decisions through BOTH transports

| # | Transport | Verdict | Evidence |
|---|---|---|---|
| T-1 | **Card** — `POST /api/lifecycle-views/decide` with the opaque ref | **PASS** | `decide-card-transport-io.txt`: approve → `{"kind":"decided","disposition":"approve","idempotent":false}`; resolve → `settled`; same-disposition retry → `idempotent:true`; a DIFFERENT disposition → `{"kind":"blocked","reason":"no-longer-pending"}`; run `f1794de0` → **completed** |
| T-2 | **Page** — the route-bound server action, clicked in a real browser | **PASS** | `s2-07/08-page-transport-*.png`: Approve on the page gate region → gate `82a3f328` `resolved/approve` → run `f16f2989` → **completed** → the card re-resolves to "This review is no longer open" |
| T-3 | A forged ref and a garbage ref are answered identically | **PASS** | both `200` with the one uniform refusal sentence; no status or body oracle |

## Findings this walk produced

1. **`Cache-Control: no-store` is NOT what the island serves.** `next.config.ts`
   sets it for `/lifecycle/review-island`, and the PR states it as fact — but the
   response carries `cache-control: no-cache, must-revalidate`. The other three
   headers from the same block DO survive (`content-security-policy:
   frame-ancestors 'self'`, `x-frame-options: SAMEORIGIN`, `referrer-policy:
   same-origin`), so the block is applied; Next's own dynamic-page cache header
   wins on that one key. Measured on the dev surface — a released-image re-check
   is owed before calling it settled, but the mechanism is not dev-specific.
2. **The run-DETAIL page of a flow agent draws no card.** `/agents/<v>/<p>/<runId>`
   renders `instance-screens.tsx` → `OrchestratorStepperPanel`, which has no
   review-gate branch at all and falls through to "Waiting for input — no renderer
   configured for this step." The card's run-card host is `AgenticRunPanel` (the
   inline card in a transcript), which is where the deleted redirect card lived —
   so this is **pre-existing, not an S2 regression** — but a reviewer who opens the
   run page sees only the step rail's "Review" link.
3. **`widgetLifecycleViewsEnabled` does not exist.** The presence-matrix comment
   names it as the capability-site gate that keeps the widget fail-closed. The
   tree contains no such symbol. The widget IS fail-closed — by never declaring a
   host — but the comment points at a guard that was never written.

## Reproducing

```sh
node scripts/ci/sync-dev-extensions.mjs --pinned   # extensions on disk
pnpm auth:migrate                                  # fresh DB only
# stage the fixture + boot the WayFlow runtime over it, then:
#   stageReviewGateFixture(repoRoot)
#   seedMarkedReviewGateRun({ userId, orgId, targets })
#   waitForMarkedReviewGate(runId)
```
See `tests/fixtures/review-gate-agent/README.md` and
`tests/e2e/agents-run/review-gate-fixture.ts`.
