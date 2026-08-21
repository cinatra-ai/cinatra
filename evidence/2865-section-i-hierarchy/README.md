# cinatra#2865 — the §I input hierarchy, on the live app

Re-shot on the REBASED tree, on top of the merged section-V redraw (#2866), the
S9m widget-transcript ratchet (#2878), the S9i slot identity (#2879) and the
S9h evidence machinery (#2822). The previous B-series is deleted, not amended:
it was taken on a pre-redraw tree and one of its cells proved nothing.

## The runtime, said first

`node scripts/dev-server.mjs` (Next.js 16.2.10, Turbopack),
`CINATRA_RUNTIME_MODE=development`, `NODE_ENV != production`, on a **dedicated
lane database** on the verify Postgres and the verify Redis, loopback-only, with
the branch's own extension tree. Placeholder-only environment: **no model
credential exists on this host, and none is used**. It is **not** a
production-equivalent build; the reason is recorded and not re-derived
(`evidence/2573-s7-conformance/README.md`).

**Two substitutions, both named rather than hidden:**

1. **The model layer.** The assistant sentence is written rather than generated.
   Everything downstream — persistence, reconstruction, the registry dispatch,
   the authoritative server-side re-resolve, the access ladder — is the shipped
   path. Same substitution, same reason, as `evidence/2852-before-after`.
2. **The setup wizard.** The `secrets` step wants a live Nango and the `ai` step
   wants a model credential; neither exists here, so the app's own documented,
   prod-unreachable browser-e2e switch `CINATRA_E2E_SETUP_BYPASS=true` is set.
   It bypasses the wizard gate ONLY. It is not on any path these pictures claim.

## The seeding path — all shipped writers

Per gate: `materializeBlogPostBodyArtifact` → the `artifact_produced_outbox` row
→ `sweepReviewOrchestration`, which minted the `artifact_review_gates` row; then
the shipped `runSuggestionProducerLane` derived **three** suggestions from the
artifact's own bytes through the shipped readers and froze them with
`writeGateSuggestionSnapshot` (`status: "written"`, gate-bound). The card reached
the transcript through `POST /api/assistants/threads`, the app's own first-class
thread route, carrying only the shipped envelope `{viewType, schemaVersion, ref}`
with `ref` minted by `encodeLifecycleGateRef` against the real gate — the card
re-resolves its own state server-side from it.

**The lane database's boot-created `Default` organization must be deleted.** With
two organization rows the blog materializer refuses outright and the produce step
dies. It was deleted before the walk. A per-lane DATABASE (not merely a per-lane
schema) is required: the auth tables live in `public`, which every schema on the
same database shares, so a schema-only lane inherits every other lane's orgs.

## Cells DELIVERED

Viewport 1228×1400 at `deviceScaleFactor: 2`, uncropped, identical framing across
the light/dark pair. I1/I2 are framed on the **conversation column** (the element
that contains both `[data-conversation-list]` and the composer), scrolled to the
foot of the transcript so both inputs are in shot; I3 on the **card root**.

The recorder takes the **picture first and counts second**, so a record's counts
can only ever be at-or-after what the picture shows.

| Cell | Pixels | What is VISIBLY on screen |
|---|---|---|
| `I1__review-card__chat_thread__pending` | 1944×2672 | **LIGHT.** One frame holding both inputs. At the foot, the composer: a **boxed, rounded field with a visible edge, a `+` attach affordance and a circular send button**, placeholder "Type a message…". Above it, inside the card, `DECISION RATIONALE (optional on approve, expected on reject)` over "Add a note for the run and the audit trail…" sitting on **a single dashed baseline** — no box, no fill, no send affordance — with `Comment` / `Reject` / `Approve` beneath. The weight difference is the point. Measured on the same frame: the note field's `border-bottom-style: dashed`, `border-top-width: 0px`, `box-shadow: none`. |
| `I2__review-card__chat_thread__pending__dark` | 1944×2672 | **DARK** (the record carries the read-back `htmlClass`, computed `color-scheme` and body background as proof the picture is actually dark). The same two inputs, the same weight difference: the composer keeps its box, its raised ground and its send button; the note field is still a single dashed baseline on a **transparent** ground (`rgba(0, 0, 0, 0)`). |
| `I3__review-card__chat_thread__pending__composer-bound` | 1472×2454 | The composer-binding row in its **BOUND** state, framed on the card root: a pressed pill **"▣ Replying to this review"** with, to its right, "Your next chat message becomes a comment on this review. Press again to chat normally." Counted on the same frame: `review-composer-bound` 1, `review-composer-unbound` 0 — one open review binds the chat box with no press, exactly as §I says. |

**No recommendation card is in any of these frames** — `recommendation_hold` 0 and
`[data-skill-action]` 0 on every one of the three, counted and recorded. The
previous round's failure (a recommendation card showing its retired
heading/pills face) therefore cannot recur here: the face is absent, not merely
believed-current.

## Cells NOT delivered — the widget pair

**`site_widget` light and dark are NOT delivered, and nothing is filed in their
place.** The §I claim in the widget is unproven by this round.

The embedded column would not authenticate on this lane. The frame sits at
`data-phase="signin"`; pressing its own `[data-embed-signin]` opens the hosted
PKCE popup, which immediately dies on a 401 — this lane has no registered OAuth
client for that ceremony. Seeding the browser context with a first-party session
cookie does not help either: the embed's credential is its own widget token, not
the Cinatra session cookie, so the frame stays anonymous.

The honest options were: ship the empty column again, fake it, or withhold it.
The previous round shipped an **empty** widget column under a name that claimed a
composer — a cell that proved nothing. It is withheld instead. The cross-site
embedded column with a real card in it is already photographed, by the slice that
owns that ceremony: `evidence/2754-island-wire` C1 / C2 / C3 (PR #2870), which
are in the canonical index and validate.

## Findings the pictures force

1. **The light-mode note field computes `background: rgb(255, 255, 255)`, not
   `transparent`**, while the dark one computes `rgba(0, 0, 0, 0)`. Visually the
   §I requirement holds in both — the card's own ground is white there, so
   nothing reads as a competing filled box — but the light value is the base
   control's fill winning over `bg-transparent`, not the transparent ground the
   §I prose describes. Recorded rather than rounded off.
2. **The artifact preview degrades to the generic read-only view** on this lane
   ("review target unavailable — slot 'detail', reason 'no-semantic-renderer'"):
   the blog-post type renderer does not resolve here. It is visible in every
   frame. It bears on nothing §I claims — the card, its suggestions, its decision
   floor and both inputs are real — but it is on screen, so it is stated.
3. **The settled / disabled note field is not photographed.** The decision bar's
   `settled` reading is LOCAL, and the card's own authoritative re-resolve —
   which the decision itself triggers — replaces the whole card almost
   immediately. Rather than photograph a sub-second state and name it a steady
   one, it is left unclaimed.

## Layout

- `captures/` — the PNGs, full resolution, uncropped.
- `capture-records.json` — the records, mirrored into the canonical index
  (`scripts/ci/chat-hitl-capture-index.json`), schemaVersion 1, recorder
  `cinatra-lifecycle-capture-recorder@1`.
- `capture-results.json` — the machine record, including the measured computed
  styles and theme read-backs behind the table above.
- `drivers/` — `walk.config.ts` + `walk.test.ts` (produce → gate → suggest → ref)
  and `lane-setup.mjs` / `seed-chat-thread.mjs`.

The cells are prefixed **I**, not B: `B3` / `B4` in the canonical index are
cinatra#2852's chat_thread cells, and a second, different `B3` / `B4` in the same
namespace is exactly the mislabel that index exists to refuse.

No credential, token, password or host identity appears in any file here.

Assisted-by: Claude Code (claude-opus-5)
