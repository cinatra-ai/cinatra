# cinatra#2825 (S9l) — the held card outlives the layout and the error, photographed on the live app

Head under proof: `fd7d3ea49` (PR #2877), plus this evidence commit.

## The runtime, said first

`pnpm dev` (Next.js 16.2.10, Turbopack), `CINATRA_RUNTIME_MODE=development`,
`NODE_ENV != production`, on a dedicated lane database on the verify Postgres and
the verify Redis, loopback-only, with the branch's own extension tree (114
packages). **No model credential exists on this host**, and none is used: the
turn's model layer is the shipped deterministic provider
(`CINATRA_TEST_LLM_PROVIDER=scripted`), which is fenced to an explicit
development runtime by `assertScriptedProviderNotProduction`. Every record here
carries `build: "development"` — the dev-runtime label, on the record, not in a
sentence beside it.

**It is NOT a production-equivalent build, and on this branch it cannot be for
these cells.** That finding is not new and is not re-derived here — it is
recorded at `evidence/2573-s7-conformance/README.md` (second round): `next start`
sets `NODE_ENV=production` and Next inlines it into the server bundle, so the
shipped scripted-provider fence and a production build are mutually exclusive.

## What is real, and what is stood in for

**Real — the gate.** The review gate photographed here was written by the SHIPPED
chain: `materializeBlogPostBodyArtifact` → `createSemanticArtifact` → the
`artifact_produced_outbox` row → `sweepReviewOrchestration`, which minted the
`artifact_review_gates` row (`gatesCreated: 1`). The card is the shipped
`ReviewGateCard`; the state on it is the answer `POST /api/lifecycle-views/resolve`
gave for this reader and this ref.

**Real — the transcript.** Nothing here was seeded through a persistence route.
Each cell is a conversation the driver TYPED into the shipped composer and sent
with the shipped Send button. The layout was chosen the way a person chooses it —
one @mention or two — never by setting a flag: `shouldEnterSlackModeOnSend` reads
the message. Everything after the send is the app: the runtime picked the turn's
branch, the real self-MCP answered `artifact_review_gates_list` and
`artifact_review_gate_render` under the chat surface's own delegated token, and
the producer minted the envelope the sink turned into the `DATA_PART`. The
provider cannot mint a card — an envelope it composed carries no dispatch
provenance and `recognizeLifecycleViewEnvelope` drops it — so a card on screen is
a card the real primitive answered with.

**Stood in for — two things, named exactly.**

1. **The model layer**, and only it: which tool the turn calls. That is the
   shipped deterministic provider's whole job on this path.
2. **The moment the wire stops.** The error cells need a turn that reached a card
   and then LOST ITS STREAM. On a keyless stack no turn fails that way by itself:
   the deterministic turn streams its text, calls the two real primitives and
   finishes in one breath, so there is no window a driver could win by racing it.
   So the failure is induced where a real one happens — on the wire.
   `drivers/drop-proxy.mjs` is a transparent forwarder in front of the app that,
   for a marked turn, forwards every byte up to and including the last byte of the
   frame carrying the card and then DESTROYS the socket. It never edits a frame,
   never drops one from the middle and never synthesizes one; everything the
   reader sees was written by the app. The client's own durable-log RESUME is
   failed the same way, because a resume that SUCCEEDS is a turn that did not fail
   (the shipped client then falls back to the accumulated state and renders no
   error) — measured on this stack, see the "not delivered" table below.

## Cells DELIVERED

| Cell | What the DOM asserted, and what the picture shows |
|---|---|
| `D1__review-card__chat_thread__slack-layout__held` | The held card in the TWO-MENTION (Slack) layout on a clean turn: `[data-conversation-list]` = 1, `data-lifecycle-card-host="chat_thread"` = 1 (frame and inside the card root), `data-lifecycle-card="artifact_review_gate"` = 1, `review-decision-bar` = 1 inside the pinned root, every anchor PAINTED. On screen: the Slack turn shape (author above a left-aligned bubble, the `Used 2 tools` trace), "Review requested / Awaiting your decision", the real artifact (`@cinatra-ai/blog-post-artifact:post`, revision `27b79729-c78…`, pinned), the composer-binding row, and Comment / Reject / Approve. This is the layout control the two error cells are read against. |
| `D2__review-card__chat_thread__chatgpt-layout__error-turn__held` | **The §2.3 row-2 target, ChatGPT layout.** The same anchors, on a turn whose stream really dropped: the error card (*Something went wrong · network error · Copy error details*) is drawn AND the held review card is drawn under it, with its decision bar live. On main this branch of the ladder drew the error card INSTEAD of the renderable views, so the card was gone. |
| `D3__review-card__chat_thread__slack-layout__error-turn__held` | **The §2.3 row-2 target, Slack layout — and the closest reachable reading of rows 1 and 3.** Same anchors, same drop, two-mention layout. The bubble carries NOTHING but the two cards: no prose and no ordered trace (the shipped Slack error shape is deliberately text-less and thought-group-less), so what is on screen for this turn is the error and the decision. On main the Slack error bubble was `{content: "", error}` — the card the turn was already holding went with the stream. |

Framing is identical for every cell: one viewport at `deviceScaleFactor: 2`,
uncropped, 2880 × 2240 px each. Zero page errors on all three.

`capture-records.json` carries the same three records the canonical index now
holds; `capture-results.json` is the machine record beside the pixels (final URL
path, pixel size, the transcript's own text, page errors).

## Cell NOT delivered — with the exact predicate, not a guess

| Cell | What actually happened |
|---|---|
| `review_card · slack · no-prose · clean` (the matrix's card-only clean turn) | **NOT PRODUCIBLE on a stack with no model credential, and the reason is a shipped emitter, not a missing fixture.** A card-only turn needs `content === ""` AND no thought groups AND a lifecycle item. Every shipped path that can put a review card into a conversation on this stack emits BOTH: `runScriptedChatAssistantTurn` streams its sentinel line before it calls anything (`packages/llm/src/scripted-test-provider.ts`), and the two pull primitives it then calls become a thought group (`Used 2 tools` in D1). The hard explicit-dispatch pre-router is the same shape from the other side — it sends its `tool_result` and then a `text` — so it, too, reveals on main. A prose-less tool-only turn is REAL-MODEL behaviour, and there is no model credential on this host. Two ways round it were tried on the live stack and both were measured, not assumed: cutting the wire before the text is an ERROR turn by construction (that is D3), and letting the durable-log RESUME succeed after a cut replays the WHOLE turn, text and tools included, so the resumed turn is the with-prose clean turn again. The cell is covered by the branch's own matrix (`packages/chat/src/__tests__/lifecycle-layout-survival-matrix.test.tsx`, `review_card · slack · no-prose · clean`, red on main and green here); it is recorded UNPHOTOGRAPHED rather than rounded up. |

## Layout

- `captures/` — the PNGs, full resolution, uncropped, one viewport at
  `deviceScaleFactor: 2`.
- `capture-records.json` — the three records in the shape both gates read.
- `capture-results.json` — the machine record beside the pixels.
- `drivers/` — the harness exactly as run: `lane-setup.mjs` (first-admin signup +
  org through the shipped Better-Auth routes), `walk.test.ts` + `walk.config.ts`
  (produce → gate → ref, all through shipped writers), `drop-proxy.mjs` (the
  transport drop, whose rules are written at the top of the file), `chat-drive.mjs`
  (the exploratory single-turn driver) and `capture.mjs` (the recorder run — it
  drives the turn and then hands the LIVE page to the shipped `observeCapture`,
  passing no counts, no anchors and no URL of its own).

## Gates, with their real exit codes

- `node scripts/ci/chat-hitl-evidence-gate.mjs` → **exit 0**. Two findings, both
  GRANDFATHERED and both pre-existing: the S7 lane's
  `C1__review-card__chat_thread__pending` and `C2__review-card__chat_thread__decided`
  are still unbound, for the reason the index's own prose gives.
- `node scripts/audit/chat-hitl-acceptance-gate.mjs` → **exit 1**, with the SAME
  four findings it had before this commit (those two cells, cited by two manifest
  rows each). No finding on this lane's three records: they validate at the AUDIT
  tier, which is the stricter one, because each pins a card instance.

A single organization exists on the lane instance: the lane-created duplicate was
removed so the shipped single-tenant blog-image resolver could run at all.

No credential, token, password or host identity appears in any file here. The
sealed gate refs are addressing handles and are not committed.

Assisted-by: Claude Code (claude-opus-5)
