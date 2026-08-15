# cinatra#2573 S7 — the visual round on **a lane host**, on the DEV runtime

Captured 2026-08-13 on a lane host (`<lane-host>`) against
`preview/2573-visuals` @ **`579819c25edd79b724d30836cb2d9c8f87ad1f72`**
(= `origin/main` + `origin/2573-d1` + `origin/2573-d2`, all three verified as
ancestors of that head).

## The runtime, said first, because it is the whole reason this round exists

This round runs on the **DEV runtime** — `pnpm dev` (Next.js 16.2.10, Turbopack),
`CINATRA_RUNTIME_MODE=development`, `NODE_ENV != production`,
`CINATRA_TEST_LLM_PROVIDER=scripted`, `CINATRA_TURBOPACK_DEV_FS_CACHE=0`.

**It is not a production build, and it cannot be.** The primary-host round
established why, and this round takes that finding as its starting point rather
than re-running it:

- `assertScriptedProviderNotProduction` (`packages/llm/src/scripted-test-provider.ts`)
  throws unless `CINATRA_RUNTIME_MODE === "development"` **and**
  `NODE_ENV !== "production"`.
- `lifecycleSeedEnvVerdict` FENCE 1a (`src/lib/test-support/lifecycle-seed-fence.ts`)
  answers `404 production-build` on `NODE_ENV === "production"` before it reads
  any other gate.

`next start` sets `NODE_ENV=production` and Next inlines that into the server
bundle at build time, so **a production-equivalent build and an LLM-backed
dispatch are mutually exclusive by construction on this branch**. Every cell
below that needs a dispatch is therefore a DEV-runtime cell, and each row says so.
What is *not* stood in for: the surfaces, the stores, the decision module, the
access ladder and the audit trail are all the shipped ones. The only stand-in
anywhere is the **model layer**.

## What is real and what is a fixture

- **Real:** every review gate photographed here was written by the shipped
  writers in the earlier S8d/S8f proof rounds and still lives in this instance's
  database. Every decision, comment and confirm below was made by pressing or
  typing on the shipped surface. Every routing claim is checked against
  `cinatra.artifact_review_audit`, the app's own audit trail.
- **One DB-level fixture, stated exactly.** The recommendation hold parks only
  when the request-aware scorer returns a candidate, and candidates are bounded
  to the agent's already-assigned deliverable set. On this instance
  `cinatra.agent_assigned_skills` was **empty**, and no first-party agent-level
  assignment control ships on this branch. One row was inserted, in the shape the
  shipped store writes (`position` starts at 1, `created_by` is the actor):

  ```sql
  INSERT INTO cinatra.agent_assigned_skills (agent_package_name, skill_id, "position", created_by)
  VALUES ('@cinatra-ai/blog-draft-writer-agent', '@cinatra-ai/chat:blog-content', 1,
          'c3c8e333-6f94-4ca5-9334-963b9bce75e0');
  ```

  A first attempt with `@cinatra-ai/blog-writing-skill:blog-writing` was
  **withheld by the shipped revalidation** — the server logged
  `withheld … '@cinatra-ai/blog-writing-skill:blog-writing:not-installed'` — and
  that row was deleted. The hold below therefore parks through the REAL scorer
  over a REAL assignable skill; the fixture supplies the assignment a settings
  screen would have written, and nothing else.
- **One dev-only seed call**, for the run_card cell only: the app's own
  capability-gated `POST /api/development/lifecycle-seed`
  (`fixture: "repairVerification"`), which holds no SQL and drives only shipped
  writers. It emitted a real gate + repair + verification record on the run named
  in `C3`.

## Cells DELIVERED

### A — the run-detail screen (#2710, D-1)

| Cell | What the DOM asserted |
|---|---|
| `A1__run-detail__held-at-recommendation-checkpoint.png` | A run **held** at the run-start recommendation checkpoint, created through the screen's own "new run" control. `run-chip-row` present, `recommendationChipRows: 1`, the offered chip is `@cinatra-ai/chat:blog-content`, `decidedSummaryOccurrences: 0`, zero page errors. The run row is `status=pending_input` with a `recommendation` park in `cinatra.lifecycle_continuation_park`. This is also the AC-15 cell `recommendation-hold__run_card__held`: `RecommendationHoldCard` is THE renderer of `recommendation_hold`, mounted by the agentic panel inside `LifecycleCardSurfaceProvider host="run_card"`. |
| `A2__run-detail__decided-summary-exactly-once.png` | The SAME run after the human pressed Confirm, **re-read from the server** so the count is a render fact and not a client patch: `recommendationChipRows: 0`, `decidedSummaryOccurrences: **1**` (`data-run-recommendation-decision="confirmed"`), and the text "Skills confirmed (1)" appears **once**. Zero page errors. |

### B — the composer binding in `/chat` (#2711, D-2)

| Cell | What the DOM asserted |
|---|---|
| `B1__chat__composer-binding-row-above-the-decision-floor.png` | One marked review gate open. `review-composer-focus` sits **above** `review-decision-bar`; the control reads "Replying to this review" with `aria-pressed="true"`, and the release is named in the row: "Your next chat message becomes a comment on this review. Press again to chat normally." `composerBound: 1`, host `chat_thread`, state `pending`. |
| `B2__chat__comment-typed-while-bound-lands-on-the-gate.png` | An ordinary chat message typed while bound. The thread answers "Comment added to the review. It is still open." and the app's own audit trail gained **exactly one** row: `afad9aca-2a9c-45d5-a98c-10c76b0a8f6c comment`. It went to the card's comment path, not to the model. |
| `B3__chat__two-open-gates-no-focus-the-pick-a-card-refusal.png` | **TWO** marked gates open in one thread, none chosen. `composerAmbiguous: 2` — both cards say "More than one review is waiting. Choose the one you want to reply to — chat messages are not routed until you do." The refusal is said BEFORE anything is typed. |
| `B3b__chat__the-ambiguous-send-is-refused-and-goes-nowhere.png` | A message sent in that state is refused out loud and reaches nothing: the audit trail is **byte-identical across the send**. |
| `B4a__chat__explicit-focus-binds-that-card-only.png` | "Reply from the chat box" pressed on the second card: `composerBound: 1`, `composerUnbound: 1` — that card alone claims the composer. |
| `B4__chat__the-comment-routes-to-the-focused-card-only.png` | The comment typed next produced **one** new audit row, on **one** gate id: `5a12bc51-df20-48d7-bd82-0ceca844b534 comment`. |
| `B4b__chat__moving-the-focus-moves-where-the-comment-lands.png` | The focus moved to the first card and the next message produced one new row on a **different** gate id: `94492f62-b0a8-4a3e-9a64-e5dbe7600f15 comment`. This is also the proof that the two cards are two **distinct** reviews, not one gate drawn twice. |
| `B5a__chat__released-the-composer-is-a-chat-box-again.png` | The bound control pressed again: `composerBound: 0`, `composerUnbound: 2` — every open card says "Chat messages are not going to this review." |
| `B5__chat__after-release-the-next-message-is-an-ordinary-chat-turn.png` | The next message was answered as an ordinary chat turn and reached **no** review: the audit trail is unchanged across the send. |

### C — the AC-15 conformance cells

| Cell | What the DOM asserted |
|---|---|
| `C1__review-card__chat_thread__pending.png` | `artifact_review_gate` on the **chat_thread** surface, `data-lifecycle-card-state="pending"`, with `review-target-island`, `review-decision-bar` and the composer row. |
| `C2__review-card__chat_thread__decided.png` | The SAME chat-hosted card after the reader approved it on the card's own floor: `data-lifecycle-card-state="settled"`, `composerFocusRows: 0` — the binding row is gone with the decision. |

## Cell NOT delivered, and the exact predicate that gates it

| Cell | What actually happened |
|---|---|
| `C3__review-card__run_card__live-run.png` | **NOT delivered.** The `run_card` host IS declared and drawn, and a real review gate IS now bound to this run — the run's own step rail draws it ("Review CHANGES_REQUESTED", "Core analysis DRIFTED"), seeded through the shipped writers. The card still does not mount, and this round can name why exactly: `AgenticRunPanel` gates the `run_card` `ReviewGateCard` on `isPendingApproval && effectiveHitlContext?.xRenderer === ARTIFACT_REVIEW_REDIRECT_RENDERER_ID && reviewGateCardRef`. That interrupt context is **live orchestration state, not a row** — it needs a run that actually pauses at the artifact-review checkpoint, i.e. a real LLM-backed execution. No credential may reach a lane host, so it is out of reach here. This supersedes both earlier answers ("the panel never mounted" / "no gate is bound to the run"): the panel mounts, the gate is bound, and the missing thing is the run's own pause. |

## About the visible ref in B3–B5

The typed message that mints the second card names a **sealed lifecycle gate
ref**, and that token is visible in those PNGs. It is an addressing handle, not a
credential: `artifact_review_gate_render` decodes it and re-runs the whole access
ladder server-side on every call, and answers the fixed "not available to you" to
anyone who may not read it — the shipped comment says it plainly, "naming a ref
grants nothing". It is redacted in `capture-results.json` anyway. No credential,
no token and no password appears in any artifact here; the seed capability was
scanned for across every file and appears in none.

`capture-results.json` is the machine record beside the pixels: per cell the
final URL, every `data-conformance-id`, every `data-lifecycle-card-state` /
`-host`, the composer-row counts, the audit-trail deltas and any page errors.
A screenshot is never the only evidence.

Assisted-by: Claude Code (claude-opus-5)
