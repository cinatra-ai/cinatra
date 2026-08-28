# W6 part 2b, batch 2 — the review moment on the real surface

Epic #2926, issue #2936. Plan (B) section 6, Conformance: *"Every screen this plan touches is
captured on the real surface and graded against the ratified drawing"*.

**Batch 1 is PR #3043.** Its run died before any artifact review: *"failed to load the run
package's artifact bindings: 404 Not Found … no such package available"* — the run package had
never been published to the instance's own registry. **This round publishes it FIRST and proves
the publish with a registry readback** (`drivers/01-publish-run-packages.mjs`,
`registry-publish.json`, and the table in `RUN-READBACK.md`), and both of its runs materialise
their artifact and open their review.

**Two real runs**, started from the app's own chat with a real model provider and the real public
MCP toolbox, created by the app's own dispatch, driven only by pressing what the screens
themselves draw. The second run exists for a stated reason: run one's only gate was spent on the
change request this round had to make to look for the audit reading, and an APPROVED gate cannot
be taken from a gate already resolved `changes_requested`.

Run one `cda1cd00-7091-47e0-bd66-5e43fb2e5fb1`; run two `c00920ac-4631-460a-946d-9821c3df7f80`.
Every number is read back in `RUN-READBACK.md`; the order of events is in `TIMELINE.md`; every
anchor count is in `capture-records.md`.

**One picture in this batch was wrong and has been re-shot.** The file filed as the dark sibling
of the run-progress placeholder was a LIGHT capture, and the P1 verdict below said "PASS, light
and dark" over it. The cause was the round's own driver emulating the OPERATING SYSTEM's colour
scheme, which this app does not read; it is named in full under **P1**, both files are measured
there, and the picture was **re-shot from a fresh real run** with the palette switched on the
app's own control. That re-shoot stood the lane up again from nothing on the same head — its own
throwaway database, its own registry publish, its own provider setup through the app's own step —
because the round's lane was dropped when it ended, so its runs are **run three** and **run
four** and its readbacks are their own (`reshoot-dark-placeholder.json`,
`drivers/09-reshoot-the-dark-placeholder.mjs`). Nothing else in this batch was re-shot, and the
index, the census and the anchor digest are untouched.

## What this batch found

**1 — The review reaches the conversation, but not on the host the drawing names.** Cards §IX:
*"Every card appears on every host, and it is the same card wherever it appears"*, with `Review`
reading **Yes** under `Chat thread`. Measured in the conversation the run was started from, after
Approve: there IS a settled review card in the assistant's turn, with its target panel, its
revision pin and its outcome — and its host declaration is **`run_card`**, not `chat_thread`.
The shipped recorder was driven for the `chat_thread` cell and REFUSED it, in its own words:

> `record "B3__review-card__chat_thread__decided__dark": host "chat_thread" requires`
> `[data-lifecycle-card-host="chat_thread"] PRESENT (root-scoped); the record observed 0`

That refusal is the finding, and it is not worked around: the picture this round files instead
(**B3**) is an honest record of the card that IS there — `run_card`, on a `/chat` path, which
`HOST_URL_CLASS` in `scripts/ci/lib/capture-record-contract.mjs` already admits for exactly this
case ("the conversation's own reading of that host"). The `chat_thread` census cell is left
where it stood rather than answered by a picture of a differently-hosted card.

**2 — The change request resolves the gate and the repair never comes back.** app-artifact-review
§VI: *"On submit, the gate resolves changes-requested and a repair goes in flight — the run takes
the reviewer's note and works the target again — and the corrected version returns as a fresh
review in the same run: a new review gate entry on the rail, beneath the one just resolved."*
Measured, end to end:

- the request was typed into the review page's own prompt window and sent with its own control;
- the base gate resolved `changes_requested` at 00:43:01.066Z — **that half holds**;
- `cinatra.lifecycle_repair` took a row: `route=producer_repair`, `status=dispatched`,
  `attempt=1`, `successor_gate_id=null`, carrying the reviewer's note as its one finding —
  **the repair did go in flight**;
- 50 s later the repair run `lifecycle-repair-run:531ca79f-…` (`parent_run_id` = run one,
  `source_type=lifecycle_repair`, `human_present=null`) went to `pending_approval` on the AGENT'S
  OWN SETUP FIELD `idea` — it re-asks the question the original run was set up with instead of
  working the target from the note;
- **and the screen it is parked on cannot be reached.** Its run-detail route renders the app's
  **404 — Page not found** panel (`SetupScreen` → `readAgentRunById` → `notFound()`,
  `packages/agents/src/instance-screens.tsx:697-700`), even for the reviewer who typed the
  request, who is that run's own `run_by` in that run's own `org_id`;
- so after 15 minutes: **0** successor review gates and **0** rows in
  `cinatra.artifact_verification_records`.

The corrected version does not return, and there is no surface on which a person could unblock
it. This is a defect and it is reported, not patched.

**3 — The audit reading therefore has no subject on this head, and that is a consequence of 2.**
`coreDefault` fires the `verification` checkpoint *"whenever `changes_requested` occurred"*
(`src/lib/lifecycle/lifecycle-policy.ts:280-283`) — so a changes-requested review is exactly the
route to it, and it is the route this round took. It stops at finding 2. Counted on seven live
surfaces (`unreachable-cells.json`): `[data-lifecycle-card="verification_summary"]` = **0** on
both run pages, both review pages, both conversations and the repair run's page.

**4 — The one slot, twice, photographed.** Cards §II and app-artifact-review §I both draw a
placeholder that becomes the review in the same slot. On the run page the slot is one element
carrying `data-run-review-slot`, and both readings were caught on run one: `working` with one
`review-gate-placeholder` and no gate, then `review` with one `artifact_review_gate` and no
placeholder, **18 339 ms apart**, in both themes. Run two reproduced it at **7 781 ms**.

**5 — A bring-up fact of the dev agent runtime, because it cost this round a run.** After the
runtime reloaded its agents, EVERY agent card answered `500` with
`RuntimeError: TaskManager was not properly initialized`, while the container's own `/.health`
still reported `{"status":"ok","agents":29,"failed":0}` with `last_reload_at` set. A run
dispatched into it failed with *"Failed to fetch Agent Card … : 500"*. Restarting the container
restored every card and reset `last_reload_at` to `null`. Recorded as an environment fact of the
lane's own bring-up, and named here because a health endpoint that reports `ok` while every card
is 500 is worth someone's attention.

**6 — An observation, made while typing into the review's prompt window.** The composer that
window portals in is a `contenteditable` whose accessible name reads **"Apply AI suggestion"**,
not the sentence §VI puts on this surface (*"Ask Cinatra about this review, or ask for changes to
the work…"*, which IS drawn on the page as the visible placeholder). Reported; nothing was
changed.

## THE GROUNDED OBSERVATION — where the settled recommendation row is mounted

Batch 1 photographed the settled row **inside the run-progress panel** at the HITL moment (its
A4) and **beside the rail step** at the schedule moment (its S2). Which component mounts it,
on this head:

| moment | run-detail branch | who mounts the row | where it lands |
| --- | --- | --- | --- |
| HITL / working / review (batch 1's A4, and this round's B2) | `"agentic"` | **`packages/agents/src/agentic-run-panel.tsx:1638`** (`recommendationCardNode`), rendered at **:1678** (the review/placeholder slot section) and **:1726** (the "Agentic Run Progress" section) | INSIDE the panel's own `<section>` |
| schedule (batch 1's S2) | `"trigger"` | **`packages/agents/src/instance-screens.tsx:1162`**, handed to the rail step's `surface` at **:1201** | BESIDE the rail, as that step's whole surface |

One predicate chooses between them:
`screenHostsRecommendationCard(panel) { return panel !== "agentic"; }` —
**`packages/agents/src/instance-screens.tsx:383-385`**, read at **:1070**. On the `agentic`
branch the screen mounts nothing (`recommendationCardNode` is null) and the panel draws the row;
on every other branch the screen owns it and the panel does not
(`packages/agents/src/agentic-run-panel.tsx:576`, `panelMountsRecommendationCard`).

**Does the drawing at the pin put it in one place? Yes — one place.**
app-artifact-review §II is titled *"placement only"* and says so in as many words:

> *"This section fixes **where** the chip-row lives — the trigger-gate entry at the head of the
> rail, in the same two-column run frame as every other gate, its chip-row filling the run detail
> while the rail carries the run's steps beside it."*

That is the `instance-screens.tsx` rail-step reading and only that one. Cards §IX rules on
**presence, not layout** (*"Only the frame changes — the thread, the widget's panel, the run
card's detail column, the gate region of the review page"*) and §V says only *"the row is the
whole card"*, so neither of them authorises a second placement either.

**So: the drawing draws it in ONE place; this head mounts it in TWO, and the second — inside the
run-progress panel — is not the place the drawing puts it.** Reported as a measurement. No
product code was changed by this round.

## The graded cells

Each cell: **requires** (the drawing's own words at the contract's pin,
`design@458fb7ffce6cf4ab6a2c60d3ff47198135d8ea2f`, rendered with the capture browser) / **shows**
(measured — anchors counted, values read back) / **verdict**. PASS only where every clause shows.

### B4 (a4) — `artifact_review_gate` PENDING on `page_gate_region`, dark

**Requires**, cards §IV verbatim: *"Four drawn states, and one that draws nothing."* … *"Restricted
is a card that renders: the reader sees the target and the disabled floor, with the reason on
screen. Absent is no card DOM at all."*; cards §II verbatim: *"The review card fills the
assistant's turn: the target panel naming what is under review and pinning its exact revision,
then the decision floor that governs it."*; app-artifact-review §VI verbatim: *"A single decision
bar sits at the foot of the gate, governing every target under it. It offers exactly three
affordances: Approve (primary), Reject (destructive), and Comment."*; and §I verbatim: *"a gate
step opens the gate's own surface in place — a pending review renders the review gate … right
here in the run detail, under the same rail, never as a standalone document."*

**Shows** — `[data-lifecycle-card-host="page_gate_region"]` **2** (the settled chip row above and
the gate itself), `[data-lifecycle-card="artifact_review_gate"]` **1**,
`[data-conformance-id="review-decision-bar"]` **1** inside that root,
`[data-lifecycle-card-host="page_gate_region"]` **1** inside that root; every one painted. On
screen: the two-column frame with `1 Schedule` / `2 Review` on the rail; the gate opened in the
detail beside it; `Review requested` with the `Awaiting your decision` pill; the target
`A Sustainable Weekly Publishing Rhythm for Small Teams`, `Blog Post Artifact`,
`@cinatra-ai/blog-post-artifact:post · revision 0bca75e0-acf… · pinned`, `text/markdown`, with
RENDERED and RAW SOURCE side by side; `DECISION RATIONALE (optional on approve, expected on
reject)`; and the floor `Comment` · `Reject` · `Approve`, weighted exactly as §II draws it.
Nothing is drawn as a standalone document.

**Verdict — PASS.**

### B2 (a2) — `artifact_review_gate` DECIDED on `run_card`, light and dark

**Requires** — the same §IV / §VI clauses, plus app-artifact-review §I verbatim: *"A resolved gate
stays on the rail as read-only history — its entry keeps its place and records how it was settled
(approved, rejected, changes requested), so the rail is the run's whole lifecycle at a glance, not
just its live tip."*

**Shows** — after **Approve** was pressed on the RUN PAGE's OWN decision bar (gate row:
`disposition=approve`, `resolved_by` the reviewer, `resolved_at` 01:17:24.527Z):
`[data-lifecycle-card-host="run_card"]` **1**, `[data-lifecycle-card="artifact_review_gate"]`
**1**, `[data-lifecycle-card-state]` **1** inside the root reading `settled`, and
`[data-conformance-id="review-decision-bar"]` **0** inside the root — the floor is gone and the
outcome has replaced it. On screen: the rail reads `Recommendation ✓`, `Step 1 ✓`,
`Review ✓ APPROVE` — the resolved gate keeping its place and recording how it was settled — and
the detail carries the target panel and, beneath it,
`Approved by Alex Rivera / The gate is resolved and the run has been released to continue.`
Same composition and same counts in dark.

One reading is stated rather than softened: the card's title is still `Review requested` on the
settled card. The STATUS is correctly gone (the `Awaiting your decision` pill is absent and the
outcome panel is present), so this is the card's name and not a stale status — recorded because
it is what the picture shows.

**Verdict — PASS**, light and dark.

### B3 (a3) — the settled review as the CONVERSATION draws it, dark

**Requires** — cards §IX verbatim: *"Every card appears on every host, and it is the same card
wherever it appears: the same regions, the same states, the same data on screen, and the same
actions its reader is authorized to take. Only the frame changes …"*, with §II's floor and §IV's
settled reading.

**Shows** — in the conversation the run was started from:
`[data-conversation-list]` **1**, `[data-lifecycle-card="artifact_review_gate"]` **1**,
`[data-lifecycle-card-state]` inside it reading `settled`, decision bars **0**, and the host
declaration on that root reading **`run_card`**. The card is in the assistant's turn with the
same target panel, the same revision pin and the same outcome as the run page draws, and the chat
box sits beneath it. What is **0** is `[data-lifecycle-card-host="chat_thread"]` — measured, and
the reason the shipped recorder refused the `chat_thread` cell.

**Verdict — the card reaches the conversation and is the same card: PASS on §IX's "same card,
only the frame changes". The `chat_thread` HOST DECLARATION is a FAIL: on this head the
conversation's settled review declares `run_card`, so cards §IX's `Review × Chat thread` cell has
no `chat_thread`-declared subject to photograph.**

### P1 (a8) — the run-progress placeholder on `run_card`, light and dark

**Requires**, cards §II verbatim: *"A run that will ask for a review carries, in the slot the
review card will fill, the run progress card — and while the run is working that card is a
placeholder for the review screen: the card frame, and a spinning icon … It names no status,
reports no result and draws nothing to press."* and *"When the run's output is generated, the
placeholder becomes the Review requested screen — the same slot, in the same turn. It happens on
its own: the reader neither asks for the card nor presses anything to bring it."* and *"The card
carries no link to the run page. No Open the run page link is drawn beneath it."*;
app-artifact-review §I verbatim: *"While the run works, the detail carries a placeholder … It is
replaced, in place, when the output is generated."*

**Shows** — on the run page, in both palettes, while the run worked:
`[data-run-review-slot]` = **`working`**, `[data-conformance-id="review-gate-placeholder"]` **1**,
`[data-lifecycle-card="artifact_review_gate"]` **0**. Then, on the SAME element with no press and
no navigation of the reader's: `[data-run-review-slot]` = **`review`**,
`review-gate-placeholder` **0**, `artifact_review_gate` **1**. The two readings are 18 339 ms
apart on run one (36 polled samples), 7 781 ms apart on run two (27 samples), and **6 545 ms
apart on run four**, the run the dark picture was re-shot from. The placeholder draws the frame
and the spinner and nothing else — no status word, no result, no control, and no link to the run
page.

**THE DARK PICTURE WAS RE-SHOT, AND WHY.** The file this round first filed as the dark sibling
was a LIGHT frame, and the "PASS, light and dark" this section carried was untrue for it. Both
files are measured here rather than described: mean luminance over the whole frame,
**238.5 / 255** for the light picture and — for the file that claimed to be its dark sibling —
**238.1 / 255**, against **16.6 / 255** for this batch's B2 dark. The cause is in the driver, not
in the product: `drivers/03-chat-run-to-review.mjs` opened its second context with Playwright's
`colorScheme: "dark"`, which emulates the OPERATING SYSTEM's `prefers-color-scheme` and nothing
else. This app does not read that — `src/app/providers.tsx` mounts next-themes as
`attribute="class" defaultTheme="cinatra" themes={["cinatra","dark"]}`, so the palette is a class
on `<html>` chosen by the app's OWN control (`src/components/theme-switch.tsx`, the header's
"Toggle theme" button) and an unset preference resolves to `cinatra`, the light palette, whatever
the OS says. So the emulation could never have darkened the page.

`drivers/09-reshoot-the-dark-placeholder.mjs` re-shot it from a fresh real run on the same
surface, with the palette switched **on the app's own control** before the run started (the
window is 6.5–21 s wide on this head — too short to switch inside it), and reads the theme back
three times: before the press `{"dark":false,"stored":null,"osPrefersDark":false}`, after the
press `{"dark":true,"stored":"dark","osPrefersDark":false}`, and again on the run page itself
while the placeholder was on screen (`"dark":true`). **The OS preference is `false` throughout** —
the darkness in the new picture comes from the app's control and from nothing else. The new file
measures **11.7 / 255**, and it carries no development pill.

**Verdict — PASS in both palettes**, and the SWAP is proven rather than asserted: one element,
two readings, timestamped either side.

These two pictures are **page controls, not index records**: the run-progress placeholder is not
one of the five lifecycle-card kinds, carries none of their roots, and the capture contract has
no vocabulary for it — exactly as batch 1's S1/S2 were page controls. Neither appears in
`capture-records.md`, which holds only what the shipped recorder wrote, and neither is in
`scripts/ci/chat-hitl-capture-index.json`: the index, the census and the anchor digest are
untouched by this re-shoot.

| picture | sha256 | mean luminance |
| --- | --- | --- |
| `cells/P1__run-progress-placeholder__run_card__light.png` | `fd588f6955c134ccadac5a88846802310f77621efc80ceed76caeaa0380d632c` | 238.5 / 255 |
| `cells/P1__run-progress-placeholder__run_card__dark.png` | `2948f69bf1a618208c87730a621f7fbb5b84d16495b196808f2c25517098c247` | 11.7 / 255 |

The four INDEX records' digests are in `capture-records.md`, written there by the recorder.

## The cells this batch RECORDS AS UNREACHABLE, with the code fact

No stand-ins. Each was driven and counted (`drivers/07-measure-the-unreachable-cells.mjs`,
`unreachable-cells.json`).

### a5 — `recommendation_hold` PENDING on `page_gate_region`

**Where the page mounts it.** The review page composes the hold ABOVE the gate, both inside one
`page_gate_region` provider:
`src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/page.tsx` — the
provider at **:306**, `<RecommendationHoldCard runId={runId} />` at **:327**, `<ReviewGateCard>`
at **:340**. The card is keyed by the RUN and nothing else.

**Why no run reaches it.** The page needs a review task it can open, and the hold needs to still
be held at that moment — and on this agent the two never overlap:

- `coreDefault({checkpoint:"recommendation", humanPresent:true})` returns `"fire"` and the
  recommendation is the run's FIRST gate (`src/lib/lifecycle/lifecycle-policy.ts:273-274`;
  app-artifact-review §II: *"that recommendation is the run's first gate — it sits at the trigger
  position"*), while the artifact review gate is minted by the materializer only after the run
  has produced its artifact. Measured on run one: the hold was held 00:17:32 → 00:18:16 and the
  review gate was created **00:19:54** — 98 s after the hold settled, on the same run.
- a review-page URL that names anything other than that run's own artifact-review gate is
  short-circuited BEFORE the provider (`if (surface.kind === "blocked") return …`, same file,
  **:197-203**), so no hold is drawn there at all.
- the only other run in the lineage is the repair run, and it carries `human_present = null`,
  for which the same `coreDefault` returns `"skip"` — it never holds.

**Measured:** `[data-lifecycle-card="recommendation_hold"][data-lifecycle-card-state="pending"]`
= **0** on both review pages. **RECORDED UNREACHABLE from a real run on this head.** A second run
was already in hand and does not help: the hold is keyed by the run whose review page it is, so
run two's held hold is not on run one's review page and never coexists with run two's own gate.

### a6 / a7 — `verification_summary` ADVISORY on `chat_thread`, `run_card`, `page_gate_region`

**Where the audit card draws.** `packages/agents/src/verification-summary-card.tsx` is its one
renderer ("TWO STATES DRAW, AND ONLY TWO" — `advisory` and `absent`); the review page mounts its
own deep reading behind `?view=verification`
(`…/review/[reviewTaskId]/page.tsx:124-178`, `readVerificationRecordForGate` at **:154**), and its subject is
a row of `cinatra.artifact_verification_records`.

**Which runs reach it.** `coreDefault` fires the `verification` checkpoint on a remote apply
(`destinationClass === "external_publish"`) and *"whenever `changes_requested` occurred"*
(`src/lib/lifecycle/lifecycle-policy.ts:280-283`). The blog-draft-writer agent publishes nothing
externally — its one produced artifact is `@cinatra-ai/blog-post-artifact`, a durable local
artifact — so on this agent the ONLY route is the changes-requested one, which this round drove.

**Measured:** it stops at finding 2 above. `cinatra.artifact_verification_records` = **0** rows,
and `[data-lifecycle-card="verification_summary"]` = **0** on all seven surfaces driven. **The
audit reading is RECORDED UNREACHABLE on this head**, and its blocker is named: the repair run
parks on the agent's own setup field and its screen 404s, so no repaired revision is ever
produced for an audit to compare against.

### a8's second host — the placeholder on `page_gate_region`

**Measured:** `[data-conformance-id="review-gate-placeholder"]` = **0** on both review pages.
**The code fact:** the placeholder has three mounts and all three are `run_card` surfaces —
`packages/agents/src/agentic-run-panel.tsx:1679`,
`packages/agents/src/orchestrator-stepper-panel.tsx:2115` and
`packages/agents/src/instance-screens.tsx:2152`. The review page mounts none. It could not, and
the reason is structural rather than an omission: the review route is
`/agents/<vendor>/<package>/<runId>/review/<reviewTaskId>`, and the placeholder is by definition
the reading BEFORE that `reviewTaskId` exists — so there is no URL at which to photograph it.
**RECORDED UNREACHABLE, by construction.**

## Reproducing it

```
export WALK_BASE=http://127.0.0.1:<port>
export SUPABASE_DB_URL=<the round's own database>
node scripts/apply-public-schema.mjs                         # a fresh database only
node scripts/gen-wayflow-env.mjs && docker compose --profile wayflow up -d verdaccio wayflow
node evidence/2930-w3-hitl-card/drivers/01-lane-setup.mjs
node evidence/2930-w3-hitl-card/drivers/02-instance-namespace.mjs
#   the provider step, inside the operator's secret-manager wrapper:
#   evidence/2790-s9f-host-parity/drivers/17-provider-setup-through-the-app.mjs
node evidence/2930-w3-hitl-card/drivers/03-set-public-origin.mjs
node evidence/2930-w3-hitl-card/drivers/04-join-template-org.mjs
#   RESTART the app once: the boot repair mints the canonical install rows (cinatra#2536)

#   THE STEP BATCH 1 MISSED — publish the run packages and read them back:
LANE_REGISTRY=<the lane's own dev registry> LANE_NPMRC=<a publish npmrc> \
  LANE_PACK_DIR=<a scratch dir> OUT_JSON=evidence/2936-w6-captures-batch-2/registry-publish.json \
  node evidence/2936-w6-captures-batch-2/drivers/01-publish-run-packages.mjs

npx vitest run --config evidence/2936-w6-captures-batch-2/drivers/02-assign-skills.config.ts
node evidence/2936-w6-captures-batch-2/drivers/03-chat-run-to-review.mjs   # the run + the placeholder window

export WALK_COOKIE="$(node evidence/2930-w3-hitl-card/drivers/06-mint-lane-cookie.mjs)"
export WALK_COOKIE_DOMAIN=127.0.0.1
export WALK_THREAD_URL=/chat/<vendor>/<assistant>/<threadId>
export WALK_RUN_PAGE=/agents/<vendor>/<slug>/<runId>  WALK_RUN_ID=<runId>
export WALK_REVIEW_PAGE=$WALK_RUN_PAGE/review/<encoded reviewTaskId>

W=scripts/audit/lib/chat-hitl-capture-driver.mjs
O=evidence/2936-w6-captures-batch-2/capture-records.json
P=evidence/2936-w6-captures-batch-2/capture-walk.json
node $W --walk $P --out $O --steps review-page-pending-dark
node evidence/2936-w6-captures-batch-2/drivers/04-request-changes-on-the-review.mjs
node evidence/2936-w6-captures-batch-2/drivers/05-answer-the-repair-run-and-wait-for-the-audit.mjs
#   (a SECOND run, for the approved gate)
node evidence/2936-w6-captures-batch-2/drivers/03-chat-run-to-review.mjs
node evidence/2936-w6-captures-batch-2/drivers/06-approve-on-the-run-page.mjs
node $W --walk $P --out $O --merge --steps review-runpage-decided-light,review-runpage-decided-dark
node $W --walk $P --out $O --merge --steps review-chat-decided-runcard-dark
node evidence/2936-w6-captures-batch-2/drivers/07-measure-the-unreachable-cells.mjs
RECORDS_IN=$O node evidence/2936-w6-captures-batch-2/drivers/08-register-records.mjs

#   THE DARK SIBLING OF THE PLACEHOLDER — one fresh real run, with the palette
#   switched on the app's OWN control before the run starts (see P1):
WALK_CELL_PATH=evidence/2936-w6-captures-batch-2/cells/P1__run-progress-placeholder__run_card__dark.png \
  OUT_JSON=evidence/2936-w6-captures-batch-2/reshoot-dark-placeholder.json \
  SERVER_LOG=<the dev server's own log> WALK_SENTENCE=<the person's own words> \
  node evidence/2936-w6-captures-batch-2/drivers/09-reshoot-the-dark-placeholder.mjs

node scripts/audit/chat-hitl-acceptance-gate.mjs && node scripts/ci/chat-hitl-evidence-gate.mjs
node scripts/audit/chat-hitl-one-card-gate.mjs && node scripts/audit/file-size-ratchet.mjs
```

## What batch 3 owes

- **The third-party application widget cells** — `site_widget`, which neither batch touched.
- `artifact_review_gate × chat_thread × decided` — owed to a fix, not to a batch: on this head the
  conversation's settled review declares `run_card` (finding 1).
- `recommendation_hold × page_gate_region × pending` and every `verification_summary` reading —
  owed to fixes as well, and the fixes are named above (findings 2 and 3).
- The `trigger_schedule_proposal × chat_thread` cells stay owed to batch 1's schedule-card defect,
  which this round re-measured and did not re-record (`lifecycle_card_ref` is still `null` at the
  schedule moment on both runs).
