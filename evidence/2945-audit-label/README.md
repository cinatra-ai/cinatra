# cinatra#2945 — the six cells whose pixels still read the old label, re-shot

`#2945` renamed the audit lane's display strings: the audit card heading, the
suggestion chips heading, the run-page rail entry and the advisory body now read
**Audit**. Six already-committed cells were photographed before that landed, so
their pixels still read the old word while the branch they sit on draws the new
one. This directory is the round that re-shot them, and it holds nothing else:
the pictures themselves are replaced in the two directories that own them, and
their records are replaced in place in the canonical index.

| Cell | Owned by | What changed in the pixels |
|---|---|---|
| `B1` / `B2` | `evidence/2852-before-after` | the suggestion chips heading |
| `B3` / `B4` | `evidence/2852-before-after` | the same heading, on the transcript host |
| `G5` | `evidence/2791-s9g-conformance` | the audit card heading, the rail entry and the advisory body |
| `G6` | `evidence/2791-s9g-conformance` | the same three, on the review page |

## The path each picture was taken on

**Two real runs, one browser, and no hand-written state.** Every row in the
database that these pictures show was written by a shipped writer, and every
decision in them was taken by pressing or typing in the browser.

### The review that opens with suggestions — B1 / B2 / B3 / B4

1. `materializeBlogPostBodyArtifact` writes a real artifact under a real run,
   which puts a row in `artifact_produced_outbox`.
2. The running app's own boot-seeded review-orchestration drain mints the
   `artifact_review_gates` row and its review task. (The walk's own
   `sweepReviewOrchestration` call found the gate already minted and reported
   `gatesCreated: 0` — the app got there first, which is the more real of the two.)
3. `runSuggestionProducerLane` derives **three** §VIII suggestions from the
   artifact's own bytes through the shipped readers and freezes them with
   `writeGateSuggestionSnapshot` (`status: "written"`, `suggestionCount: 3`).
4. The review page for that gate is opened in a browser (**B1**), and the middle
   chip is dismissed by a press on the card's own control (**B2**).
5. For the transcript host the browser opens `/chat`, **types** *"Show me the
   review that is waiting on me."* into the app's own composer and presses
   Enter. The turn runs on the development runtime's scripted model bridge,
   which calls the SHIPPED read-only lifecycle pull primitives —
   `artifact_review_gates_list`, then `artifact_review_gate_render` — under this
   session's own chat credential. The card that comes back is the app answering
   a real turn (**B3**), and the middle chip is then dismissed by a press
   (**B4**, its own second turn in its own thread).

**The projector**, said plainly because it is the one seam worth reading.
`runSuggestionProducerLane` takes an injectable `SuggestionProjector` and its own
comment calls the default *"deliberately modest … a type-aware projector that
flattens a document's real content is a drop-in that changes nothing else"*.
This lane supplies that drop-in, reading the artifact's own row and its own bytes
back through the shipped readers — because the SHIPPED default projector cannot
produce a suggestion at all on a current schema. That is measured here, not
assumed:

```
WALK DEFAULT_PROJECTOR_CONTROL {"includedFields":{"representation.revision":"1",
  "representation.form":"file"},"authzDecision":"authorized","suggestionCount":0}
```

Nothing about the suggestion text is authored: `before` is the disclosed slice,
`after` is `canonicalFieldValue(before)`.

### The run whose audit lane writes its advisory — G5 / G6

On a **second** real run, and again through shipped writers only:

| Step | What ran | What came back |
|---|---|---|
| PRODUCE | `materializeBlogPostBodyArtifact` | a real artifact under the run |
| GATE | `sweepReviewOrchestration` | `gatesCreated: 1`, `status: "pending"` |
| — | `enforceReviewRunAccess(run, actor, "read")` and `…, "approveHitl")` | both `ok` — measured before the terminal decision, never assumed |
| CHANGES | `recordChangesRequested` | the gate resolves `changes_requested` and the repair opens |
| PRODUCE | `materializeBlogPostBodyArtifact` (the repaired body) | the successor revision |
| REPAIR | `submitRepairResponse` | successor gate pinned; **its own trigger** wrote `artifact_verification_records` (`outcome: "drifted"`) and ran the **audit lane**, which attached the advisory comment |

The advisory is the lane's own, read straight back out of the store:

```
{"id":"8f5dc045…","author_id":"core-analysis-lane","author_kind":"service",
 "body_head":"Audit of 3 disclosed field(s).\n• 3 disclosed field(s) carry content.\n[provenance] lane=core-analysis-lane …"}
```

This walk writes neither the verification record nor the advisory. It drives the
pipeline that writes them, and reads both back through the shipped read port.

**What is stood in for, exactly: the model layer, and only on the chat cells.**
The scripted bridge decides WHICH tool the turn calls. Everything after that —
the transport's delegated-chat policy, the primitive's own authorization, the
opaque ref, the card's server-side resolve on mount, the access ladder — is the
shipped path. No transcript is written into the store by this lane, and no run,
gate, suggestion, verification record or advisory is written by hand anywhere in
this round.

## The runtime, said first

`pnpm dev` (Next.js with Turbopack), `CINATRA_RUNTIME_MODE=development`,
`NODE_ENV != production`, `CINATRA_TEST_LLM_PROVIDER=scripted`, on a dedicated
lane database and lane Redis on loopback, with the branch's own extension tree.
**Placeholder-only environment: no model credential exists on this host, and none
is used.** It is not a production-equivalent build, and the reason is not
re-derived here — it is the fence finding recorded in
`evidence/2573-s7-conformance/README.md`: the scripted-provider fence and the
lifecycle-seed fence make a production build and a model-backed turn mutually
exclusive by construction. Every record carries `build: "development"` and
`runtime: "dev-runtime"`.

The setup wizard's `secrets` and `ai` steps want a live connector service and a
model credential; neither exists here, so the app's own documented,
prod-unreachable browser-e2e switch `CINATRA_E2E_SETUP_BYPASS=true` is set. It
bypasses the wizard gate **only**, and it is on the path of nothing these
pictures claim.

## How a record is made

`drivers/capture.mjs` drives a real browser and writes each record through the
**shipped observer** (`observeCapture`) over the **shipped Playwright port**
(`playwrightPage`). It supplies which page to open, which host the cell claims
and which kind and state it photographs; **every URL, frame and count in a record
is read off the page by the observer**, never handed to it. The observer
measures, shoots, and measures again, and refuses a cell whose screen moved
between the two. Every cell was validated at the **audit tier** — the stricter of
the two — before it was written, and all six came back clean.

Two things this file does to the record after the observer wrote it, both stated
because a reader should not have to find them: the ORIGIN is removed from
`finalUrl` (the contract takes a repo-style path, every committed record carries
one, and the origin is the one thing on the page that names the machine it ran
on), and `runtime` is set to `dev-runtime`. Nothing else is touched, and the
validation runs on what is written.

**The pictures are FULL-PAGE browser frames, uncropped, at device scale 2.** The
B cells' predecessors were framed on the card root; these are the whole window,
which is why their pixel sizes changed.

## Grading — requires / shows / verdict

Every row was graded by **opening the picture and reading it**.

| Cell | Requires | Shows | Verdict |
|---|---|---|---|
| `B1__review-card__page_gate_region__pending` | §VIII's block on the review page's gate region, its heading reading **AUDIT · SUGGESTIONS**, three accepted chips each with its own `NOW → SUGGESTED` pair, and the count line in the decision floor | `AUDIT · SUGGESTIONS` over three accepted blocks (`artifact · sections · 0/1/2 · text`, each `REPLACE`); "Press a suggestion to dismiss it…" closes the block; the floor reads *"3 of 3 suggestions accepted — they ride this decision. A reject records them as not taken."* above `DECISION RATIONALE` and `Comment / Reject / Approve` | **PASS** |
| `B2__review-card__page_gate_region__pending` | the SAME row after one press: the middle chip drawn dismissed — muted, dashed edge, revert glyph, no strike-through — still carrying its panel, and the floor line following it | exactly that; chip 2 dashed with the revert glyph and its `NOW → SUGGESTED` pair intact, 2 accepted / 1 dismissed / 3 panels, floor reading *"2 of 3 suggestions accepted…"* | **PASS** |
| `B3__review-card__chat_thread__pending` | the same card and the same heading in a REAL transcript reached by typing, with the conversation list and the card declaring `chat_thread` | a real thread: the typed sentence, the assistant's reply, the tool row, then the card — `AUDIT · SUGGESTIONS`, three accepted pairs, the target island's read-only view, the floor and the one composer at the foot | **PASS** |
| `B4__review-card__chat_thread__pending` | the transcript-hosted row with one chip dismissed | a second real turn in its own thread: chip 2 dashed and muted with its panel kept, *"2 of 3 suggestions accepted…"*, the **Replying to this review** binding row above the floor | **PASS** |
| `G5__audit-card__run_card__advisory` | §VII's card on the run screen: the heading reading **Audit**, the outcome pill, the revision pins, the marked before/after row and the advisory panel | `Audit` with **Out-of-scope drift**; the sentence that explains it; the pins `103a2bd2… → 847d5279…`; one row, `representation.resource`, marked `OUT OF SCOPE`, before struck through; `ADVISORY COMMENTS` carrying its `SERVICE` author kind and the body **"Audit of 3 disclosed field(s)."** with its provenance line. The run rail's own entry reads **Audit DRIFTED** | **PASS** |
| `G6__audit-card__page_gate_region__advisory` | the same renderer in the review page's verification region | the identical heading, pill, sentence, pins, marked row and advisory body, unframed in the page column under `AGENT RUN · Review` | **PASS** |

**What is on screen and is not this round's subject, so it is stated rather than
left for a reader to find:** the artifact preview degrades to the generic
read-only view — *"review target unavailable — slot 'detail', reason
'no-semantic-renderer'"* — because `@cinatra-ai/blog-post-artifact` declares no
renderer, so the ladder resolves to its floor. Visible in all four B cells. It
bears on nothing they claim; the card, its suggestions, its floor and its
decision path are all real. The same reading is recorded in
`evidence/2791-s9g-conformance/README.md` as its third finding.

## What this round changes outside this directory

- `evidence/2852-before-after/captures/` — B1–B4 replaced, and the README rows
  and hashes with them.
- `evidence/2791-s9g-conformance/captures/` — G5 and G6 replaced, likewise.
- `scripts/ci/chat-hitl-capture-index.json` — the six records **replaced in
  place** by the records this round's recorder wrote. The other 42 are untouched
  and the file still carries 48.
- A `TIMELINE.md` in each of the two directories, carrying the store's own
  timestamps beside the pictures.

No assertion in any record is hand-written, and no picture is cropped.

## A residual this round found and did not fix

The six cells were named for this round. Opening the neighbours turned up three
more that carry the old word in their pixels for the same reason: `G1`, `G2` and
`G3` in `evidence/2791-s9g-conformance` are review-gate cells whose gate carries
suggestions, so they draw §VIII's block heading, and it still reads
`CORE ANALYSIS · SUGGESTIONS`. They are outside this round's scope and are left
alone — re-shooting cells nobody asked for would put pictures in the tree that no
brief graded. The rest of the index was NOT swept for the same reading, and this
round claims nothing about it.

## Files

```
README.md            this file
capture-results.json what the recorder and the page port measured, cell by cell
drivers/
  lane-setup.mjs           the lane's own account, through the shipped auth routes
  collapse-to-one-org.mjs  the lane joins the instance's existing organization
  walk.config.ts           the config the walk runs under
  walk.test.ts             PRODUCE / GATE / SUGGEST / REF / CHANGES+REPAIR / READBACK — shipped writers only
  capture.mjs              the browser round: open or type, press, measure, shoot
  merge-index.mjs          replaces the six records in the canonical index, in place
```

No credential, token, password or host identity appears in any file here. The
sealed gate refs are addressing handles and are not committed.
