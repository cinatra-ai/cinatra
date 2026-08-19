# cinatra#2865 — the §I input hierarchy, on the live app

Head under proof: `f5f76efce` (PR #2867), **unmodified**, plus this evidence commit.

## The runtime, said first

`node scripts/dev-server.mjs` (Next.js 16.2.10, Turbopack),
`CINATRA_RUNTIME_MODE=development`, `NODE_ENV != production`, on a dedicated lane
database on the verify Postgres (port 5634) and the verify Redis (port 6579),
loopback-only, with the branch's own extension tree. Placeholder-only
environment: **no model credential exists on this host**, and none is used. It is
**not** a production-equivalent build; the reason is recorded and not re-derived
(`evidence/2573-s7-conformance/README.md`).

## The seeding path — all shipped writers

Per gate: `materializeBlogPostBodyArtifact` → the `artifact_produced_outbox` row
→ `sweepReviewOrchestration`, which minted the `artifact_review_gates` row; then
the shipped `runSuggestionProducerLane` derived three suggestions from the
artifact's own bytes through the shipped readers and froze them with
`writeGateSuggestionSnapshot` (`status: "written"`, gate-bound). The card reached
the transcript through `POST /api/assistants/threads`, the app's own first-class
thread route, carrying only the shipped envelope `{viewType, schemaVersion, ref}`
with `ref` minted by `encodeLifecycleGateRef` against the real gate — the card
re-resolves its own state server-side from it. **What is stood in for is the
model layer alone**: the assistant sentence is written rather than generated.
Same substitution, same reason, as `evidence/2852-before-after`.

The widget cell's instance + connect-site were written by the two shipped writers
(`writeConnectorConfigToDatabase`, `upsertConnectSiteAndMintCredential`) through
`evidence/2787-s9c-envelope-visual/drivers/02-seed-widget-site.mts`, unchanged.

**The lane DB's boot-created `Default` organization must be deleted, and it comes
back.** With two `auth.organization` rows the blog materializer refuses outright —
`[blog-image-materializer] found 2 auth.organization rows but asset-blog is
single-tenant` — and the produce step dies. It was deleted before the walk and
again mid-round when the boot loop recreated it.

## Cells DELIVERED

Viewport 1228 at `deviceScaleFactor: 2`. B1/B2 are framed on the **conversation
column** (`div.relative.flex.min-h-0.flex-1.flex-col` that contains both
`[data-conversation-list]` and `[data-conformance-id="chat-composer-primary"]`);
B3/B3b/B4 on the **card root** (`[data-conformance-id="review-gate-card"]`); B5 on
the embed's own conversation column, inside the embed frame.

| Cell | Pixels | What is VISIBLY on screen |
|---|---|---|
| `B1__review-card__chat_thread__pending` | 1944×2872 | **LIGHT.** The whole column: the user turn, the assistant turn, the review card, and at the foot the composer — a **boxed, rounded, raised field with a visible edge, a `+` attach affordance and a circular send button**, placeholder "Type a message…". Inside the card, the last block is `DECISION RATIONALE (optional on approve, expected on reject)` over the placeholder "Add a note for the run and the audit trail…" sitting on **a single dashed baseline** — no box, no fill, no send affordance — with `Comment` / `Reject` / `Approve` beneath. The two inputs are in one frame and the weight difference is the point. |
| `B2__review-card__chat_thread__pending-dark` | 1944×2872 | **DARK** (`<html class="dark">`, computed `color-scheme: dark`, body background read back in the record). The same two inputs: the composer keeps its box, raised ground and send button against the dark field; the note field is still a single dashed baseline with no box and no fill. |
| `B3__review-card__chat_thread__decided-note-disabled` | 1472×1652 | **LIGHT, after a terminal `Approve` pressed on the card's own floor.** The note field keeps the **same dashed rule**, faded, with no fill and no box; `Comment` / `Reject` / `Approve` are gone and in their place the settled line **"✓✓ Approved. The gate is resolved and the run has been released to continue."** Measured on the same frame: `review-rationale` present **and `:disabled`**, decision buttons 0. |
| `B3b__review-card__chat_thread__decided-blocked-after-reresolve` | 1472×618 | The same gate a moment later, on a fresh load: the card's authoritative re-resolve answers with **"This review is no longer open — The gate was already decided or the run moved on."** and a `Refresh` link. The note field is **not rendered at all** (`review-note-field-subordinate` 0). |
| `B4__review-card__chat_thread__pending-composer-bound` | 1472×1674 | The composer-binding row in its **BOUND** state, framed on the card root: a pressed pill **"▣ Replying to this review"** with, to its right, "Your next chat message becomes a comment on this review. Press again to chat normally." `review-composer-bound` 1, `review-composer-unbound` 0. |
| `B5__widget-column__site_widget__composer-primary` | 920×1520 | The **embedded** conversation column, inside `/embed/assistant` at `data-phase="active"`, loaded in a plain page on a **different loopback origin** and signed in through the shipped hosted-PKCE popup (no Cinatra cookie). It draws the **same primary composer** — `[data-conformance-id="chat-composer-primary"]` = 1 inside the frame, with the same boxed, edged, send-affordance treatment. |

## Findings the pictures force

1. **The settled note field is on screen for well under a second.** The bar's
   `settled` state is LOCAL to the decision bar, and the card's own authoritative
   re-resolve — which the decision itself triggers — replaces the whole card with
   the BLOCKED panel almost immediately. The first B3 attempt counted the settled
   anchors and then photographed the blocked panel; that mislabel is kept as
   `B3b` rather than deleted, and the recorder was changed to **take the picture
   first and count second** so a record's counts can only ever be at-or-after
   what the picture shows. §I's "disabled / settled note field" therefore exists,
   but a reader will rarely see it.
2. **`colorScheme: "dark"` alone does not flip this app** — next-themes reads its
   stored value first, so the dark cell sets the app's own `theme` key and the
   record carries the read-back (`htmlClass`, computed `color-scheme`, body
   background) as proof the picture is actually dark.
3. **The contract calls B3 out, correctly**: a `decided` capture is supposed to
   owe the ABSENCE of `[data-conformance-id="review-decision-bar"]`, and the
   settled reading keeps that container (it is where the settled notice lives).
   The verdict is printed on the record rather than the record edited to pass.

## Cells NOT delivered

None withheld. Every cell the brief named was taken.

## Layout

- `captures/` — the PNGs, full resolution, uncropped.
- `capture-records.json` / `capture-results.json` — the records (each with the
  contract's verdict) and the machine record.
- `drivers/` — `walk.config.ts` + `walk.test.ts` (produce → gate → suggest → ref,
  taken unchanged from `evidence/2852-before-after`), `lane-setup.mjs`,
  `seed-chat-thread.mjs`, `capture.mjs` (the recorder), and
  `capture-widget-column.mjs` for the widget cell. Its host page is NOT copied here:
  the round served `evidence/2787-s9c-envelope-visual/drivers/site-widget-host-page.html`
  verbatim from a plain static server on its own loopback port.

No credential, token, password or host identity appears in any file here.

Assisted-by: Claude Code (claude-opus-5)
