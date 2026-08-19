# cinatra#2852 — the suggestion chips and their before/after panels, on the live app

Head under proof: `daca498d2` (PR #2863), plus this evidence commit.

The pictures were taken at `9d0a91107`. The one commit between that and the head
this evidence sits on (`daca498d2`, "the chip-surface integration case follows the
ratified pair contract") touches a single test file and no product code, so the
rendered surface in `captures/` is the surface this head draws. Said here rather
than quietly re-pinned.

## The runtime, said first

`pnpm dev` (Next.js 16.2.10, Turbopack), `CINATRA_RUNTIME_MODE=development`,
`NODE_ENV != production`, on a dedicated lane database on the verify Postgres
(port 5634) and the verify Redis (port 6579), loopback-only, with the branch's
own extension tree (114 packages). **No model credential exists on this host**,
and none is used — no cell here needs a model turn.

It is **not** a production-equivalent build. The reason is recorded and not
re-derived: `evidence/2573-s7-conformance/README.md` (second round) measured that
`next start` bakes `NODE_ENV=production` into the server bundle, which the
shipped `assertScriptedProviderNotProduction` and `lifecycleSeedEnvVerdict`
fences read, so a production build and a model-backed dispatch are mutually
exclusive. This round did not need a dispatch (see below), so the only thing the
dev runtime stands in for is the build mode.

## What is real, and what is stood in for

**Real.** The gate: `materializeBlogPostBodyArtifact` → `createSemanticArtifact`
→ the `artifact_produced_outbox` row → the running app's own boot-seeded
review-orchestration drain, which minted the `artifact_review_gates` row. The
suggestions: the shipped `runSuggestionProducerLane` derived them with the shipped
deterministic producer and froze them through the shipped
`writeGateSuggestionSnapshot` (`status: "written"`, 3 suggestions, gate-bound and
hash-verified). The chips on screen are what
`POST /api/lifecycle-views/resolve` answered for that reader and that ref, drawn
by the shipped `ReviewGateCard`. Every dismissal was made by pressing the chip.

**Stood in for — two things, named exactly.**

1. **The chat thread's assistant turn.** The transcript was persisted through
   `POST /api/assistants/threads`, the app's own first-class thread route (the
   one the `/chat` client writes with, and the one
   `tests/e2e/agents-run/chat-render-parity-target.ts` seeds through). The data
   part carries the shipped envelope and nothing else,
   `{ viewType, schemaVersion, ref }`, minted by `encodeLifecycleGateRef` against
   the real gate; the card re-resolves its own state server-side from it. What is
   written by hand is the assistant's sentence — the model layer.

2. **The projector**, and this one deserves the detail because it is the
   difference between a real pair and a staged one.
   `runSuggestionProducerLane` takes an injectable `SuggestionProjector` and its
   own comment calls the default "deliberately modest … a type-aware projector
   that flattens a document's real content is a drop-in that changes nothing
   else." This lane supplies that drop-in — it reads the artifact's own row and
   its own bytes back through the shipped readers (`readBlogPostBodyArtifactBytes`)
   and flattens the document into `artifact.title` + `artifact.sections.<i>.text`
   — because **the shipped default projector cannot produce a suggestion at all
   on a current schema**, and this round measured that rather than assuming it:

   ```
   WALK DEFAULT_PROJECTOR_CONTROL {"includedFields":{"representation.revision":"1",
     "representation.form":"file"},"authzDecision":"authorized","suggestionCount":0}
   ```

   `representation.revision` is an integer stringified and `representation.form`
   is CHECK-constrained to `{file, connectorRef, dashboard}` — every value it can
   disclose is already its own canonical form, so R1 never fires and the auto-gate
   hook always refuses with `empty-snapshot`. The suggestions here are still the
   producer's own: it was shown the artifact's real bytes and derived the pairs
   from them.

   The seeded body is ordinary prose carrying two ordinary defects — per-line
   trailing whitespace and a section wrapped in surrounding whitespace. Nothing
   about the suggestion text is authored: `before` is the disclosed slice, `after`
   is `canonicalFieldValue(before)`.

## Cells DELIVERED

| Cell | What the DOM asserted |
|---|---|
| `B1__review-card__page_gate_region__pending` | The row in its arrival state on the review page's gate region: `suggestion-chips` = 1, **3** `suggestion-accepted`, **0** `suggestion-dismissed`, and **3** `suggestion-before-after` panels — each with its own `[data-suggestion-panel="before"]` and `[data-suggestion-panel="after"]` (3 and 3). Every chip carries `[data-action="dismiss-suggestion -> dismissed"]`, i.e. one control whose next press dismisses. Zero page errors. |
| `B2__review-card__page_gate_region__pending` | The SAME row after the middle chip was pressed once: **2** accepted, **1** dismissed, and still **3** before/after panels — the dismissed suggestion keeps its panel. The dismissed block is drawn muted with a dashed edge and **no strike-through**; its control flips to `[data-action="accept-suggestion -> accepted"]` (1), and the two others keep the dismiss action (2). The footer reads "2 of 3 suggestions accepted — they ride this decision. A reject records them as not taken." |
| `B3__review-card__chat_thread__pending` | The same card and the same three suggestions in a real chat transcript: `[data-conversation-list]` = 1, `data-lifecycle-card-host="chat_thread"`, 3 accepted, 0 dismissed, 3 panels. Zero page errors. |
| `B4__review-card__chat_thread__pending` | The chat-hosted row with one chip dismissed: 2 accepted, 1 dismissed, 3 panels — the same two drawn states on the second host, from the one renderer. |

`capture-results.json` is the machine record beside the pixels; `capture-records.json`
carries the same cells in the shape `scripts/ci/lib/capture-record-contract.mjs`
validates, each with the contract's own verdict on it. The two `chat_thread`
records are registered in `scripts/ci/chat-hitl-capture-index.json`, the file
`scripts/ci/chat-hitl-evidence-gate.mjs` reads.

## Cells NOT delivered

| Cell | Why |
|---|---|
| the RECORDED partition on a settled card (`recorded` chip mode, including the `unrecorded` reading) | **Not attempted in this round.** It needs a terminal decision carrying a partition, which is S6b's path (#2571) rather than #2852's drawing, and this lane's brief is the two LIVE states. The `recorded` and `unrecorded` readings are covered by the branch's own card suite. Recorded here rather than implied by the four cells above. |
| a `remove` or `add` suggestion with no panel (the "absence draws nothing" arm) | **Not produced.** R2 (`remove`) is disarmed under partial disclosure and this projector names `excludedFields`, and R3 (`add`) needs a collection member missing a sibling key, which the flattened body has none of. The arm is unit-covered; no picture is claimed for it. |

## A finding on the capture-record contract itself

`scripts/ci/lib/capture-record-contract.mjs` maps `page_gate_region` to the
`review_page` URL class `/^\/agents\/reviews/`. That path is the org's open-review
QUEUE (`src/app/agents/reviews/page.tsx`), which mounts no lifecycle card; the
surface that declares `host="page_gate_region"` is
`/agents/<vendor>/<package>/<runId>/review/<taskId>`. No truthful
`page_gate_region` record can satisfy the class as written. B1/B2 are kept in
`capture-records.json` with the contract's verdict printed on them rather than
edited to pass, and are not registered in the canonical index. Worth its own
issue against #2821.

## Layout

- `captures/` — the PNGs, full resolution, uncropped, framed on the card root
  (`[data-conformance-id="review-gate-card"]`), viewport width 1228 at
  `deviceScaleFactor: 2`.
- `capture-records.json` / `capture-results.json` — the records and the machine record.
- `drivers/` — the harness exactly as run: `lane-setup.mjs`, `walk.test.ts` +
  `walk.config.ts` (produce → gate → suggest → ref, plus the default-projector
  control), `seed-chat-thread.mjs`, `capture.mjs` (the recorder, whose counting
  rules are written at the top of the file).

No credential, token, password or host identity appears in any file here. The
sealed gate refs are addressing handles and are not committed.

Assisted-by: Claude Code (claude-opus-5)
