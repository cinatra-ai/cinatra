# cinatra#2865 — the §I input hierarchy, on the live app AND in the embedded widget

Re-shot on the REBASED tree, on top of the merged section-V redraw (#2866), the
S9m widget-transcript ratchet (#2878), the S9i slot identity (#2879) and the
S9h evidence machinery (#2822). The previous B-series is deleted, not amended:
it was taken on a pre-redraw tree and one of its cells proved nothing.

**This round completes the set.** The `/chat` cells (I1–I3) were delivered by the
previous round. The widget pair (I4 light / I5 dark) — the §I hierarchy INSIDE
the embedded cross-site column — was WITHHELD by that round, and is delivered
here. The correction that made it possible is written out in full below, because
the previous round's stated reason for withholding was **wrong**, not merely
cautious.

## The runtime, said first

`node scripts/dev-server.mjs` (Next.js 16.2.10, Turbopack),
`CINATRA_RUNTIME_MODE=development`, `NODE_ENV != production`,
`CINATRA_TEST_LLM_PROVIDER=scripted`, on a **dedicated lane database** on the
verify Postgres and the verify Redis, loopback-only, with the branch's own
extension tree. Placeholder-only environment: **no model credential exists on
this host, and none is used**. It is **not** a production-equivalent build; the
reason is recorded and not re-derived (`evidence/2573-s7-conformance/README.md`).

**Two substitutions, both named rather than hidden:**

1. **The model layer.** On I1–I3 the assistant sentence is written rather than
   generated. On I4/I5 the turn is typed into the widget's own composer and the
   **deterministic scripted provider** decides which read-only primitive answers
   "Is there a review gate waiting for my approval?"; everything after that
   decision — the OBO token, the transport, the closed kind-keyed widget tool
   policy, the S1 authorization ladder, `buildLifecycleViewEnvelope` — is the
   shipped path. The provider **cannot** put a card on screen: a string it
   composes carries no dispatch provenance and `recognizeLifecycleViewEnvelope`
   refuses it. The **real** self-MCP dispatch mints the envelope, which is the
   only thing that can mint one.
2. **The setup wizard.** The `secrets` step wants a live Nango and the `ai` step
   wants a model credential; neither exists here, so the app's own documented,
   prod-unreachable browser-e2e switch `CINATRA_E2E_SETUP_BYPASS=true` is set.
   It bypasses the wizard gate ONLY. It is not on any path these pictures claim.

## The correction — why the widget pair was withheld, and why that was wrong

The previous round wrote that "the embedded column would not authenticate on
this lane" and that "this lane has no registered OAuth client for that ceremony".
That diagnosis was wrong. The symptom it saw was real — the frame sat at
`data-phase="signin"` and pressing its own `[data-embed-signin]` opened a hosted
PKCE popup that died — but the cause was not a missing ceremony. **The lane had
never provisioned the widget**: no `instances[]` row, no connect-site. Nothing
was broken; nothing had been created.

`drivers/seed-widget-site.test.ts` creates both, through the **two SHIPPED
writers the CMS OAuth exchange itself calls** —
`writeConnectorConfigToDatabase("wordpress", { instances: [...] })` and
`upsertConnectSiteAndMintCredential(...)` — and then asserts the binding the
frame will actually be judged by:

```
deriveFrameBinding: {"ok":true, ...}
```

That assertion is the one the previous round never made, and it is what
distinguishes "unprovisioned" from "unavailable". With those two rows written,
the SAME popup completes, the frame mints its own `cwu_`, and the column draws.
Nothing was injected into the browser context: the frame ran its own sign-in.

The recipe is not this round's invention — it is
`evidence/2754-island-wire/README.md` and that round's
`drivers/02-seed-widget-site.mts`, followed rather than reinvented.

## The origin pair — what makes I4/I5 mean anything

| Surface | Origin |
|---|---|
| the Cinatra app | one loopback host (`localhost`, lane port) |
| the page the widget is embedded in | the OTHER loopback host (`127.0.0.1`, a different lane port) |

Those are different origins **and different sites**. `localhost` and `127.0.0.1`
are not the same registrable domain, so the app's `SameSite=Lax` session cookie
cannot ride the embed. A host page on `localhost:<another port>` would be a
different ORIGIN but the SAME SITE, the cookie would ride, and the picture would
look **identical while proving nothing**. Both origins reach the recorder and
the host page from the **environment**; no port is written anywhere in this
directory.

**And it is measured, not asserted.** The popup is a top-level window on the app
origin, so a real session cookie exists in the browser when both pictures are
taken:

```
[{"name":"better-auth.session_token","domain":"localhost","sameSite":"Lax","httpOnly":true}]
```

and the embed document still went out with **no cookie**, while the two
lifecycle resolves that produced the card each carried `cookie: absent` and
`x-cinatra-widget-user-token: present (cwu_)`. Every wire entry is in
`capture-results.json`, present/absent only, never by value.

## The seeding path — all shipped writers

Per gate: `materializeBlogPostBodyArtifact` → the `artifact_produced_outbox` row
→ `sweepReviewOrchestration`, which minted the `artifact_review_gates` row
(`gatesCreated: 1`, `status: "pending"`); then the shipped
`runSuggestionProducerLane` derived **three** suggestions from the artifact's own
bytes through the shipped readers and froze them with
`writeGateSuggestionSnapshot` (`status: "written"`, gate-bound). On I1–I3 the
card reached the transcript through `POST /api/assistants/threads` carrying only
the shipped envelope `{viewType, schemaVersion, ref}`. On I4/I5 **no card was
placed at all**: the widget's own turn pulled it.

**The lane database's boot-created `Default` organization must be deleted.** With
two organization rows the blog materializer refuses outright and the produce step
dies. It was deleted before the walk. A per-lane DATABASE (not merely a per-lane
schema) is required: the auth tables live in `public`, which every schema on the
same database shares, so a schema-only lane inherits every other lane's orgs and
trips the single-tenant refusal.

## Cells DELIVERED

I1/I2 at viewport 1228×1400, `deviceScaleFactor: 2`, framed on the `/chat`
**conversation column**; I3 on the **card root**. I4/I5 at the same device scale,
framed on the **conversation column INSIDE the embed frame** — the element that
carries both `[data-conversation-list]` and the composer — scrolled to the foot
of the transcript so both inputs are in shot. Uncropped; identical framing across
each light/dark pair.

The recorder takes the **picture first and counts second**, so a record's counts
can only ever be at-or-after what the picture shows.

| Cell | Pixels | What is VISIBLY on screen |
|---|---|---|
| `I1__review-card__chat_thread__pending` | 1944×2672 | **LIGHT, `/chat`.** One frame holding both inputs. At the foot, the composer: a **boxed, rounded field with a visible edge, a `+` attach affordance and a circular send button**, placeholder "Type a message…". Above it, inside the card, `DECISION RATIONALE (optional on approve, expected on reject)` over "Add a note for the run and the audit trail…" sitting on **a single dashed baseline** — no box, no fill, no send affordance — with `Comment` / `Reject` / `Approve` beneath. The weight difference is the point. Measured on the same frame: the note field's `border-bottom-style: dashed`, `border-top-width: 0px`, `box-shadow: none`. |
| `I2__review-card__chat_thread__pending__dark` | 1944×2672 | **DARK, `/chat`** (the record carries the read-back `htmlClass`, computed `color-scheme` and body background as proof the picture is actually dark). The same two inputs, the same weight difference: the composer keeps its box, its raised ground and its send button; the note field is still a single dashed baseline on a **transparent** ground (`rgba(0, 0, 0, 0)`). |
| `I3__review-card__chat_thread__pending__composer-bound` | 1472×2454 | The composer-binding row in its **BOUND** state, framed on the card root: a pressed pill **"▣ Replying to this review"** with, to its right, "Your next chat message becomes a comment on this review. Press again to chat normally." Counted on the same frame: `review-composer-bound` 1, `review-composer-unbound` 0 — one open review binds the chat box with no press, exactly as §I says. |
| `I4__review-card__site_widget__pending` | 1440×2360 | **LIGHT, INSIDE THE EMBEDDED CROSS-SITE WIDGET COLUMN.** A real held review card — target `Connector rollout note`, the island at its `Floor · structured data` tier, three before/after suggestion chips, `3 of 3 suggestions accepted — they ride this decision.` — and, in the SAME frame, both inputs. The card's subordinate note field: `DECISION RATIONALE (optional on approve, expected on reject)` over "Add a note for the run and the audit trail…" on **a single dashed baseline**, no box, no send affordance, with `Comment` / `Reject` / `Approve` beneath. At the foot of the column, the widget's OWN primary composer: the **boxed, rounded field with a visible edge, the `+` attach affordance and the circular send button**, placeholder "Type a message…". Measured on the same frame — note: `border-bottom-style: dashed`, `border-top-width: 0px`, `box-shadow: none`; composer: `border-style: solid`, `border-width: 1px`, and a real elevation shadow. |
| `I5__review-card__site_widget__pending__dark` | 1440×2360 | **DARK, the same embedded cross-site column.** The record carries the theme read-back measured INSIDE the embed frame — `htmlClass` ends `dark`, computed `color-scheme: dark`, body background `lab(1.76974 1.32743 -9.28855)` — so the picture is proven dark rather than asserted. The same two inputs and the same weight difference: the composer keeps its box, its **raised** ground (`lab(8.11015 0.0567511 -14.1465)`) and its send button; the note field is a single dashed baseline on a **transparent** ground (`rgba(0, 0, 0, 0)`). |

**The pair is framed identically, and that is measured too.** In both I4 and I5
the note field's box is `654×44` at `y=975` and the composer's is `688×50` at
`y=1118`, in the same 1180-tall frame — the same two elements, the same places,
the same picture size (1440×2360). Only the theme differs.

**No recommendation card is in any of these five frames** —
`[data-lifecycle-card="recommendation_hold"]` 0 and `[data-skill-action]` 0 on
every one, counted and recorded. The previous round's failure (a recommendation
card showing its retired heading/pills face) therefore cannot recur here: the
face is **absent**, not merely believed-current. Nothing in this directory
claims the new per-chip display-name faces; the cells that own that claim are
`evidence/2841-v-redraw`'s V-series.

## Cells NOT delivered

| Cell | Why |
|---|---|
| the widget column with the composer **BOUND** to the review (the widget twin of I3) | **Not photographed.** `review-composer-bound` and `review-composer-unbound` both counted **0** in the embed frame on I4 and I5 — the binding row the `/chat` column draws is not on screen in the widget column on this commit. Rather than press something to force a row whose absence is itself the observation, the counts are recorded and no picture is claimed. |
| the **settled / disabled** note field | **Not photographed.** The decision bar's `settled` reading is LOCAL, and the card's own authoritative re-resolve — which the decision itself triggers — replaces the whole card almost immediately. Rather than photograph a sub-second state and name it a steady one, it is left unclaimed. |

## Findings the pictures force

1. **The light-mode note field computes `background: rgb(255, 255, 255)`, not
   `transparent`, on BOTH surfaces** — `/chat` (I1) and the widget (I4) — while
   both dark cells compute `rgba(0, 0, 0, 0)`. Visually the §I requirement holds
   in all four: the card's own ground is white there, so nothing reads as a
   competing filled box. But the light value is the base control's fill winning
   over `bg-transparent`, not the transparent ground the §I prose describes. It
   is the same defect in both hosts, which makes it a property of the shared
   treatment rather than of one surface. Recorded rather than rounded off.
2. **The artifact preview degrades to the generic read-only view** on this lane
   ("review target unavailable — slot 'detail', reason 'no-semantic-renderer'"):
   `@cinatra-ai/blog-post-artifact` declares no renderer, so the ladder resolves
   to its floor. It is visible in every frame. It bears on nothing §I claims —
   the card, its suggestions, its decision floor and both inputs are real — but
   it is on screen, so it is stated.
3. **The widget column draws no composer-binding row.** See "Cells NOT
   delivered": both binding markers counted 0 in the embed frame, on both cells.
   §I's "one open review binds the chat box with no press" is photographed on
   `/chat` (I3) and is **not** demonstrated in the widget by this round.

## Gates, run on this tree, with real exits

| Gate | Exit | What it said |
|---|---|---|
| `scripts/ci/chat-hitl-evidence-gate.mjs` | **0** | ENFORCING. Two **grandfathered** `evidence/unbound-cell` findings (`C1__review-card__chat_thread__pending`, `C2__review-card__chat_thread__decided` — acceptance-manifest rows citing captures no index record answers). |
| `scripts/audit/chat-hitl-acceptance-gate.mjs` | **1** | One anchor-contract violation: the digest recorded in `scripts/audit/chat-hitl-anchor-contract.json` is stale. |

**Both are PRE-EXISTING and neither is touched by this round.** Run on a pristine
checkout of this branch's parent commit, the CI gate exits **0** with the same
two grandfathered findings, and the audit gate exits **1** with byte-identical
digests (recorded `87260ce6…`, recomputed `cea4e5c4…`). The stale anchor digest
is the §V drift already on `main` from the merged section-V redraw; re-ratifying
it is that slice's work, not this one's, and it is stated here separately rather
than absorbed into this round's result.

## Records and index

`capture-records.json` carries the five cells in the shape
`scripts/ci/lib/capture-record-contract.mjs` validates; I4 and I5 were each run
through that validator before being written and each came back **`record/ok`**.
The same five are registered in the canonical index
`scripts/ci/chat-hitl-capture-index.json` (schemaVersion 1, recorder
`cinatra-lifecycle-capture-recorder@1`), whose every recorded digest was
re-verified against the bytes on disk.

The cells are prefixed **I**, not B: `B3` / `B4` in the canonical index are
cinatra#2852's chat_thread cells, and a second, different `B3` / `B4` in the same
namespace is exactly the mislabel that index exists to refuse. `C1`–`C3` in the
index are cinatra#2754's `site_widget` cells; `I4`/`I5` are new names and collide
with nothing — cells bind by full name.

## Layout

- `captures/` — the PNGs, full resolution, uncropped.
- `capture-records.json` — the records, mirrored into the canonical index.
- `capture-results.json` — the machine record, including the measured computed
  styles, the geometry, the theme read-backs and the wire behind the table above.
- `drivers/` — `walk.config.ts` + `walk.test.ts` (produce → gate → suggest → ref),
  `lane-setup.mjs` / `seed-chat-thread.mjs` (the `/chat` cells), and for the
  widget pair `seed-widget-site.test.ts` + `seed-widget-site.config.ts` (the two
  shipped writers and the `deriveFrameBinding` assertion), `host-page.html` (the
  third-party page, which takes every origin from its query string and admits
  loopback only) and `capture-section-i-widget.mjs` (the recorder, whose framing
  and counting rules are written at the top of the file).

No credential, token, password or host identity appears in any file here, and no
lane port is written in this directory: every origin reaches the drivers from the
environment.

Assisted-by: Claude Code (claude-opus-5)
