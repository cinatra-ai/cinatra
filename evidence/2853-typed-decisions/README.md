# cinatra#2853 — the prompt window acts on the active card

Head under proof: `4db1fef7f` (PR #2869), plus this evidence commit.

## The claim, in one line

A signed-in person can **state a decision in words** and the bound card takes
it — under the same authorization, through the card's own closure — while words
that are *not* the card's verb stated whole are still not a decision.

## Nothing was pressed

No `Approve`, no `Reject`, no `Comment` button is clicked anywhere in this round.
Every outcome below was produced by typing a sentence into the chat composer and
pressing Enter. The **only** control pressed at all is the card's own
`Reply from the chat box` toggle in **D4**, and it is pressed to *give the
binding back* before typing — which is that cell's whole point.

## The runtime, said first

`node scripts/dev-server.mjs` (Next.js dev, Turbopack),
`CINATRA_RUNTIME_MODE=development`, `NODE_ENV != production`,
`CINATRA_TEST_LLM_PROVIDER=scripted`, on a dedicated lane database on the verify
Postgres (5634) and the verify Redis (6579), loopback-only, with the branch's own
extension tree (114 packages). **No model credential exists on this host.**
Viewport **1228 at `deviceScaleFactor: 2`**, every picture **framed on the
conversation column** (`[data-conversation-list]`).

## What is real, and what is stood in for

**Real.** Every gate: `materializeBlogPostBodyArtifact` → `createSemanticArtifact`
→ the `artifact_produced_outbox` row → `sweepReviewOrchestration()` → the
`artifact_review_gates` row, each created **pending**, one per thread. The
restricted reader: a second real account created through the shipped Better Auth
sign-up and signed in through the shipped sign-in route. Every decision: the
card's own closure, reached by `interpretComposerMessage` → `composerRouting`, so
a typed decision posts what a pressed one posts.

**Stood in for — two things, named exactly.**

1. **The assistant turn that carries the card.** Persisted through
   `POST /api/assistants/threads`, the app's own first-class thread route (the
   one the `/chat` client writes with). The data part is the shipped envelope and
   nothing else, `{ viewType, schemaVersion, ref }`, with `ref` minted by
   `encodeLifecycleGateRef` against a real gate. What is written by hand is the
   assistant's sentence — the model layer.
2. **One row: org membership.** The restricted reader's `public.member` row is
   inserted directly (`drivers/02-second-reader.mjs` says so at the top). That is
   membership plumbing. The thing actually under proof — that the reader may read
   the run and not act on it — is the **run's own `auth_policy`**, written as a
   column of the run insert in `walk.test.ts`, which is exactly the shape the
   Permissions tab persists.

**One gate per thread, on purpose.** `resolveComposerTarget` binds the composer
implicitly only when exactly one card is eligible; with two open, every typed
message becomes a `refuse-ambiguous` refusal — a different cell from these.

## Cells DELIVERED

| Cell | Pixels | What is VISIBLY on screen |
|---|---|---|
| `D1__review-card__chat_thread__decided` | 1536×1202 | The transcript: `Show me the review that is waiting on me.` → `Here is the review.` → the settled panel **`Approved by 2853 Typed-Decision Owner`** / "The gate is resolved and the run has been released to continue." Then the reader's own typed line **`approve it`**, and the answer `Approved. The gate is resolved and the run has been released to continue.` The card carries the **outcome and its decider** — the merged #2862 reading. |
| `D2__review-card__chat_thread__decided` | 1536×1202 | A SECOND gate, same shape: the typed line **`reject: the numbers are stale`** and the settled panel **`Rejected by 2853 Typed-Decision Owner`** / "The gate is resolved and the reviewed work has been turned back", with the answer `Rejected. …`. |
| `D3__review-card__chat_thread__restricted` | 1536×2342 | The restricted reader's thread. The card is drawn in its `restricted` state and carries the floor's own disabled line on screen: **"You do not have approve access on the run, so a terminal decision is disabled."** Below it the typed **`approve it`** — and the model layer's provider error, because on this reader the message never reached the card at all (see below). The card is **unmoved**: still `Review requested / Awaiting your decision`. |
| `D4__review-card__chat_thread__pending` | 1536×2392 | The binding **given back**: the card's focus row reads `Reply from the chat box` / **"Chat messages are not going to this review."** The typed **`looks good to me`** is then an ordinary chat turn — proved by *what answered it*: the LLM provider error, a place only a model-routed turn can reach. The card is **still pending**, decision floor intact (`Comment` `Reject` `Approve`), gate row untouched. |
| `D5__review-card__chat_thread__decided` | 1536×1202 | The SAME words with the composer **still bound** — and the outcome a reader has to know about: `looks good to me` is **not** read as a decision (no approve is recorded anywhere), it takes the card's **comment** path, and on a single-target automatic gate that path is itself terminal: **`Changes requested by 2853 Typed-Decision Owner`**. Pre-existing #2566 behaviour, photographed because the negative control only means something beside it. |

Zero page errors on all five.

## The rows agree with the pictures

Each record carries `observedTransition` — the card's state attribute before and
after, the gate ROW before and after, and what the server recorded:

| Cell | card before → after | gate row before → after | `disposition` |
|---|---|---|---|
| D1 | `pending` → `settled` | `pending` → `resolved` | `approve` |
| D2 | `pending` → `settled` | `pending` → `resolved` | `reject` |
| D3 | `restricted` → `restricted` | `pending` → `pending` | — |
| D4 | `pending` → `pending` | `pending` → `pending` | — |
| D5 | `pending` → `settled` | `pending` → `resolved` | `changes_requested` |

## Where D2's rationale actually lives — measured, not assumed

It is **not** on the gate row and **not** on the settled card, which says only
`Rejected by <name>`. It travels in the shipped resume envelope:

```
artifact_review_resume_outbox.response_text
  → {"review":{"decision":"rejected","comment":"the numbers are stale", …}}
```

D2's record quotes that field. So the honest answer to "capture the rationale
wherever the app shows it" is: **the app does not show it** — it records it, and
this is where. Worth its own issue if the settled card is meant to surface it.

## D3 — what the brief asked for, and what is actually reachable

The brief asked for the floor's disabled line **returned in the transcript** as
the answer to the typed message. That did not happen, and the reason is a
property of the branch rather than of this lane, so it is written down:

- `composerEligible` in `review-gate-card.tsx` requires **`state.canComment`**.
  A reader who cannot comment registers nothing, so the composer never binds and
  a typed message falls through to ordinary chat routing — which is exactly what
  D3 photographs.
- `composerDecide`'s refusal fires only when **`canDecide === false`**.
- So the typed-decision refusal is reachable **only** for a reader with
  `canDecide:false, canComment:true`.
- `policyAllows` maps **both** `approveHitl` and `respondToHitl` to
  `runExecuteVisibility`, so no run policy can split them.
- At the role layer, the only role granting `run.respondToHitl` without
  `run.approveHitl` is `customer` — a project-scoped grant. Any reader who can
  resolve a review actor context at all is an org `member`, and roles UNION, so
  `member`'s `run.approveHitl` is always present beside it.

**Conclusion, stated as a finding rather than a gap in the round:** on this stack
the branch's typed-decision refusal line cannot be produced by any live reader.
It is exercised by the branch's own unit tests
(`packages/agents/src/__tests__/review-gate-card.test.tsx`) and by no reachable
person. Constructing one would have meant inventing a grant path the app does not
ship — which would have been a staged picture, not evidence.

D3 as delivered still carries the two things that can be honestly claimed: the
floor's own disabled line **is** on screen, and the card is **unmoved** by the
typed decision.

## Cells NOT delivered

| Cell | Why |
|---|---|
| the typed-decision **refusal line as the transcript's answer** | **Unreachable on this stack** — the full derivation is above. Not approximated, not staged. |
| `refuse-ambiguous` — two open cards, a typed decision refused | **Not attempted in this round.** It needs two eligible cards in one thread, which is a different seeding shape from the one-card-per-thread rule every cell here depends on, and the brief named four cells rather than five. The refusal copy itself is `ambiguousComposerRefusal`, unit-covered on this branch. |
| a typed decision on a kind **other than** `artifact_review_gate` | **No such card exists yet.** The branch generalises the store to any `LifecycleCardKind`, but `artifact_review_gate` is the only kind that publishes `ComposerCardActions` today, so there is nothing else to photograph. |

## A note on the pictures

The dev runtime's `<nextjs-portal>` overlay is removed before every shot (it is
dev-server furniture that swallows pointer events and covers the surface;
removing it changes no application behaviour). In **D4** a small dark circular
dev indicator survives at the right edge of the island region because it is
painted inside the island's own frame rather than the page's. It obscures
nothing load-bearing and is left rather than retouched.

## Records and index

`capture-records.json` carries the five cells in the shape
`scripts/ci/lib/capture-record-contract.mjs` validates; each was run through that
validator before it was written and each came back `record/ok`.

**They are deliberately NOT registered in `scripts/ci/chat-hitl-capture-index.json`.**
Two other branches already write that file in this wave — cinatra#2852 (PR #2863)
adds two `chat_thread` records and cinatra#2754 (PR #2870) adds three
`site_widget` records — and a third concurrent writer would turn an append into a
three-way conflict for no gate benefit: none of these cell names is cited by
`scripts/audit/chat-hitl-acceptance-manifest.json`, so the gate binds nothing to
them either way. The records are contract-valid and ready to register once that
file has one writer again.

## Layout

- `captures/` — the five PNGs, full resolution, uncropped, framed on the column.
- `capture-records.json` / `capture-results.json` — the records and the machine record.
- `logs/` — `capture.txt` (the run, verbatim, including every before/after
  reading), `walk-state.json` (the seeded ids, with each sealed gate ref replaced
  by its length), `threads.json` (which thread answers which cell).
- `drivers/` — the harness exactly as run: `01-signup.mjs`,
  `02-second-reader.mjs`, `walk.test.ts` + `walk.config.ts` (produce → gate →
  ref, five slots, one of them policy-restricted), `03-seed-threads.mjs`,
  `04-capture-typed.mjs` (the recorder, whose counting rules are written at the
  top of the file).

No credential, token, password or host identity appears in any file here. The
sealed gate refs are addressing handles and are not committed.

Assisted-by: Claude Code (claude-opus-5)
