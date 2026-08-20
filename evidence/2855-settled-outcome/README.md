# cinatra#2855 — the settled review card, photographed on the live app

Head under proof: `1cd2ceae8` (PR #2862), plus this evidence commit.

## The runtime, said first

`pnpm dev` (Next.js 16.2.10, Turbopack), `CINATRA_RUNTIME_MODE=development`,
`NODE_ENV != production`, on a dedicated lane database on the verify Postgres
(port 5634) and the verify Redis (port 6579), loopback-only, with the branch's own
extension tree (114 packages). **No model credential exists on this host**, and
none is used: no cell here needs an LLM turn.

**It is NOT a production-equivalent build, and on this branch it cannot be for the
chat cells.** That finding is not new and is not re-derived here — it is recorded
at `evidence/2573-s7-conformance/README.md` (second round): `next start` sets
`NODE_ENV=production` and Next inlines it into the server bundle, so the shipped
`assertScriptedProviderNotProduction` and `lifecycleSeedEnvVerdict` fences make a
production build and a model-backed dispatch mutually exclusive. What this round
adds is that the chat cells did **not** need that dispatch at all (see below), so
the only thing the dev runtime is standing in for here is the build mode.

## What is real, and what is stood in for

**Real.** Every gate photographed here was written by the SHIPPED chain:
`materializeBlogPostBodyArtifact` → `createSemanticArtifact` → the
`artifact_produced_outbox` row → the running app's own boot-seeded
review-orchestration drain, which minted the `artifact_review_gates` row. Every
decision was made by pressing **Approve** on the shipped card's own floor, and
lands through the one decision core. The lapsed gate was resolved by the shipped
`sweepLifecycleGateMaintenance` sweep. The card is the shipped `ReviewGateCard`
on both hosts; the state on it is the answer `POST /api/lifecycle-views/resolve`
gave for that reader and that ref.

**Stood in for — one thing, named exactly.** The chat thread's assistant turn.
The card reaches `/chat` as a `DATA_PART`, and the transcript was persisted
through `POST /api/assistants/threads` — the app's OWN first-class thread
persistence route, the same one the `/chat` client writes with
(`saveChatThreadViaFetch`) and the same one
`tests/e2e/agents-run/chat-render-parity-target.ts` seeds a deterministic thread
through. The data part carries the shipped envelope and nothing else,
`{ viewType, schemaVersion, ref }`, with the ref minted by the shipped codec
(`encodeLifecycleGateRef`) against a real gate. Nothing about the gate is
asserted by the seed: the card re-resolves its own state server-side from that
ref on mount. What is written by hand is the assistant's sentence and the
decision to emit the view — i.e. the model layer.

**One clock was moved.** For the lapsed gate the row's `expires_at` was set into
the past so the shipped maintenance sweep would see it as due. Nothing else about
that row was written by this lane; the sweep itself did the resolving
(`optionalExpired: 1`, `disposition: approve`, `resolved_by: NULL`,
`fingerprint: expiry:<gateId>`).

## Cells DELIVERED

| Cell | What the DOM asserted |
|---|---|
| `A1__review-card__page_gate_region__pending` | The gate PENDING on the review page's gate region. `data-lifecycle-card-host="page_gate_region"`, `data-lifecycle-card="artifact_review_gate"`, one `review-decision-bar` inside the card root, the pinned target drawn in the island (`@cinatra-ai/blog-post-artifact:post`, its real revision, Preview/Download). Zero page errors. |
| `A3__review-card__chat_thread__pending` | The same card kind PENDING in a real chat transcript: `[data-conversation-list]` = 1, `data-lifecycle-card-host="chat_thread"`, `review-decision-bar` = 1 inside the root, plus the composer-binding row. Zero page errors. |
| `A4__review-card__chat_thread__decided` | **The #2855 target.** The SAME chat-hosted card after the reader pressed Approve on its own floor: `data-lifecycle-card-state="settled"`, `review-gate-settled` = 1, `data-review-outcome` = 1, `review-decision-bar` = **0**, and the Refresh control (`[data-action="refresh-gate -> live-gate"]`) = **0**. Verbatim: *"Approved by Lane Cap 2862 — The gate is resolved and the run has been released to continue."* |
| `A5__review-card__chat_thread__decided` | A gate that LAPSED rather than being decided. Same settled anchors, same absence of the decision bar and the Refresh, and the copy names the outcome **with no decider beside it**: *"Approved — The gate is resolved and the run has been released to continue."* This is the resolver's "a decider with no safely displayable name yields NO name at all" arm, reached because the auto-expiry path resolves with `resolved_by` NULL. |

`capture-results.json` is the machine record beside the pixels; `capture-records.json`
carries the same cells in the shape `scripts/ci/lib/capture-record-contract.mjs`
validates, each with the contract's own verdict on it. The three `chat_thread`
records are registered in `scripts/ci/chat-hitl-capture-index.json`, which is the
file `scripts/ci/chat-hitl-evidence-gate.mjs` reads.

## Cells NOT delivered — with the exact predicate, not a guess

| Cell | What actually happened |
|---|---|
| the settled card on `page_gate_region` | **NOT PHOTOGRAPHABLE on this host, and the reason is a shipped route decision.** Approve was pressed on the page's own floor on a fourth real gate; the decision's server action revalidates the route, and `loadReviewGateSurface` answers a RESOLVED gate with `kind: "blocked"` **before the card mounts**, so the route replaces the whole card with its own `ReviewGateBlocked` panel. The recorder waited for either panel and photographed what was there: `evidence/2855-settled-outcome/captures/A2__review-page-after-approve__route-blocked-panel.png`, a full-page shot with `data-lifecycle-card-host` count **0**. It is named for what it shows and carries no host token, so nothing indexes it as a settled-card cell. The settled card IS proven on `chat_thread` (A4/A5), where the card owns its own re-resolve. |
| the OUTCOME-LESS settled card (the old reading, with its Refresh) | **NOT REACHABLE against a current-schema database, and the schema is why.** `attachLifecycleSettledOutcome` drops the outcome only for a disposition outside `{approve, reject, changes_requested}`, a gate that stopped being `resolved` between the two reads, or a store throw. The live table forbids the first outright — `artifact_review_gates_disposition_check CHECK (disposition = ANY (ARRAY['approve','reject','changes_requested']))` and `artifact_review_gates_resolved_chk` together make a resolved gate with an unmapped (or absent) disposition **unrepresentable**, so every gate a shipped writer can resolve carries a mapped outcome. The other two arms are a race and a fault, and neither can be induced honestly. The arm is covered by the branch's own suites (`src/lib/lifecycle/__tests__/lifecycle-settled-outcome.test.ts`, `packages/agents/src/__tests__/review-gate-card.test.tsx`); it is recorded here as UNPHOTOGRAPHED rather than rounded up. |

## A finding on the capture-record contract itself

`scripts/ci/lib/capture-record-contract.mjs` maps `page_gate_region` to the
`review_page` URL class `/^\/agents\/reviews/`. That path is the org's open-review
QUEUE (`src/app/agents/reviews/page.tsx`), which mounts no lifecycle card at all;
the surface that DOES declare `host="page_gate_region"` is
`/agents/<vendor>/<package>/<runId>/review/<taskId>`. So no truthful
`page_gate_region` record can satisfy the class as written. A1 is kept in
`capture-records.json` with the contract's verdict printed on it rather than
edited to pass, and is not registered in the canonical index. Worth its own issue
against #2821.

## Layout

- `captures/` — the PNGs, full resolution, uncropped, framed on the card root
  (`[data-conformance-id="review-gate-card"]`), viewport width 1228 at
  `deviceScaleFactor: 2`.
- `capture-records.json` — the contract-shaped records.
- `capture-results.json` — the machine record (final URL, HTTP status, every
  anchor count, the card's own text, page errors).
- `drivers/` — the harness exactly as run: `lane-setup.mjs` (first-admin signup +
  org through the shipped Better-Auth routes), `walk.test.ts` + `walk.config.ts`
  (produce → gate → ref → lapse → readback, all through shipped writers),
  `seed-chat-thread.mjs` (the thread persistence route), `capture.mjs` (the
  recorder, whose counting rules are written at the top of the file).

No credential, token, password or host identity appears in any file here. The
sealed gate refs are addressing handles and are not committed.

Assisted-by: Claude Code (claude-opus-5)
