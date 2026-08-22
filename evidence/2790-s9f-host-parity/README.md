# cinatra#2790 (S9f) — the skills-recommendation card on its two new hosts

Head under proof: `aa29034f2a7a8f093eafd77762fa223eb65598d3` (PR #2890), plus
this evidence commit.

**Read `PLAN-WALK.md` beside this file.** It names, for every cell presented
here, the exact plan sentences that govern the surface and the state it shows,
copied character-for-character from `PLAN: Agents Lifecycle`.

## The headline, first

**The widget mount works, the decision is taken inside the frame, and the row
settles where it was decided.** The card draws **held** inside the embedded
cross-site widget column — light and dark, one chip per skill, each chip
carrying its own Confirm / Adjust / Skip. Every chip was then decided from
INSIDE the frame through the card's own controls (Confirm, Adjust → *“Keep it in
this run”*, Skip, Confirm), the release went out as a single cookieless broker
`/decide` POST, and the row **settled in place**: the SAME frame instance that
drew it held now draws the per-chip outcomes, with **no reload, no second
sign-in and no second turn**. The run underneath left `pending_input`.

Two rounds of defect precede that sentence, and both are closed:

1. **The previous round could not draw the card at all.** The two routes this
   branch adds were missing from the app's cookieless-reachable path list, so
   every broker POST from the widget was **307**'d to `/sign-in` before the route
   handler ran. Fixed at `291bfee0f`; all four lifecycle routes now answer their
   own handler's **401** cookieless rather than a redirect.
2. **The round after it drew the card, recorded the decision, and then told the
   reader `unauthorized`.** The post-decision dispatch was cookie-bound, so a
   cross-site frame had no session to resolve: the selections were written and
   the hold released, but `agent_runs.status` stayed `pending_input` and the row
   never learned it had succeeded. **That defect is fixed at the head above**,
   and the live settle below is its proof. Its diagnostic capture is deleted,
   because it no longer describes this branch.

**The review-page mount is re-shot, and the held cells it used to carry are
DELETED.** The previous round photographed the recommendation row on the review
page still **held** and still pressable. That is a state no real flow can put
there, and the objection that says so is right: the skills recommendation is
decided BEFORE the agent starts, and the review page is a surface that exists
only AFTER the run produced something — so a held row on it could only ever be
staged. The plan says the same in one sentence (§6.4 item 6): the row appears
*“on the review page, where it is mostly seen in its decided form”*.

So this round walked the real order instead, in one browser session, and
photographed what it left behind: a run **started person-present**, its
recommendation **decided chip by chip on the run page** through the card's own
controls, and then — on the review page — that same row in its **decided** form
above a review gate card that is still **awaiting its decision** (`R1`–`R4`).
Nothing on that page is pressable in the row; everything pressable is in the
gate card beneath it. The three held review-page cells and their grading are
gone, not amended.

## The runtime, said first

`node scripts/dev-server.mjs` (Next.js 16.2.10, Turbopack),
`CINATRA_RUNTIME_MODE=development`, `NODE_ENV != production`,
`CINATRA_TEST_LLM_PROVIDER=scripted`, on a **dedicated lane database** on the
verify Postgres (5634) and the verify Redis (6579), loopback-only, with the
branch's own extension tree (114 packages) and a raised
`CINATRA_BOOT_READY_TIMEOUT_MS`. **Placeholder-only environment: no model
credential of any kind exists on this host**, and none is used. The lane tree is
an APFS clone of the repository pinned to the head above, with per-package
installs carried across; every symlink in it was measured to be worktree-local.

`CINATRA_E2E_SETUP_BYPASS=true` is set, and stated because it is set: the lane
database is a clone of an already-provisioned instance, so the setup wizard has
nothing to run and the bypass keeps boot from demanding services this lane does
not have. It changes no surface photographed here.

It is **not** a production-equivalent build, for the reason
`evidence/2573-s7-conformance/README.md` measured and this round does not
re-derive: `next start` bakes `NODE_ENV=production` into the server bundle, which
the shipped `assertScriptedProviderNotProduction` fence reads, so a production
build and a scripted dispatch are mutually exclusive.

Every record is labelled `dev-runtime`. Cells are shot at `deviceScaleFactor: 2`,
uncropped, full resolution.

## The origin pair

| Surface | Origin |
|---|---|
| the Cinatra app | the `localhost` **name**, on the lane's app port |
| the page the widget is embedded in | the IPv4 **loopback address**, on a second port |

Different origins **and different sites**: the loopback NAME and the loopback
ADDRESS are not the same registrable domain, which is the whole point of driving
the widget from a loopback-address host page rather than a second port on the
name. The recorder does not merely assert it — it records the request headers of
the broker calls themselves. Both origins are read from the environment; neither
is written into any committed file, and `finalUrl` on a widget record is the
served path only (`/host-page.html`), with `frameUrl` the frame's own path.

**Measured, this round:** after the frame's hosted sign-in the browser context
holds exactly one app cookie — `better-auth.session_token`, `domain=localhost`,
`SameSite=Lax`, `httpOnly` — and **every** broker call the card made still went
out with `cookie: absent` and the widget's own `x-cinatra-widget-user-token`
present. That is the cross-site fact this host page exists to produce.

## The seeding path — all shipped writers

1. Owner + organization through the shipped Better Auth routes
   (`drivers/01-lane-setup.mjs`).
2. Four skills assigned to `@cinatra-ai/blog-draft-writer-agent` at
   `organization` ownership through the shipped writer
   `upsertCustomSkillAssignment`; `getAssignedSkillIdsForAgent` reads all four
   back (`walk.test.ts` step `ASSIGN`).
3. **The widget round only:** `pending_input`, human-present runs on that
   template, each parked through **`maybeHoldRunForRecommendation`** — the one
   seam the interactive run trigger uses. Each answered `{held: true, reason:
   "core default fires recommendation"}` and left a
   `lifecycle_continuation_park` row with `checkpoint=recommendation`,
   `status=parked` (step `HOLD`). **The review-page round seeds nothing at all:**
   its run is started from the browser at `/agents/<vendor>/<package>/new` and
   parks itself through the same seam, reached the way a person reaches it — see
   *The REAL SEQUENCE* below.
4. The widget instance and its connect-site through the two SHIPPED writers the
   CMS OAuth exchange itself calls — `writeConnectorConfigToDatabase` and
   `upsertConnectSiteAndMintCredential` — and `deriveFrameBinding` asserted to
   close before anything was driven (step `WIDGET`, `{"ok":true}`).
5. Everything on screen after that is the shipped path: the frame's own hosted
   PKCE sign-in, the turn typed into the widget's own composer, the broker read,
   the per-chip presses and the broker decision. The chip labels are the owning
   extension's manifest `cinatra.displayName`, resolved server-side by the
   scorer; nothing is re-derived in the recorder.

**Two held runs were driven, not one.** Both were seeded and parked the same
way, both were decided chip by chip inside the frame, and **both settled in
place**. The committed cells are the second run
(`logs/walk-state-widget.json`); the first is named there so a single lucky pass
cannot be mistaken for a result.

**The run intent was chosen, not the scores.** The prompt is the one
`evidence/2841-v-redraw` measured, which puts three of the four assigned skills
over the recommend threshold and leaves `web-research` under it. Measured on this
lane through the shipped seam (`walk.test.ts` step `DIAG`): `blog-post-matcher`,
`blog-writing` and `brand-voice-matcher` score `0.35` and are `recommended:true`;
`web-research` scores `0.08` and is `recommended:false`. All four still get a
chip; the fourth is the shipped force-add candidate, and the DOM confirms it
(`data-forced` on that chip alone).

### Lane repairs and lane data, stated

1. **Exactly one organization.** The platform's own
   `ensureDefaultOrganizationMembership` adopts a platform admin into the
   `slug="default"` organization on every session bootstrap and makes it the
   session's active one. The lane setup driver creates a second organization of
   its own, because its `list` call runs before that adoption. The shipped
   delete route refuses (`ORGANIZATION_DELETION_DISABLED`), so that second
   organization and its membership row were removed as lane data written
   directly, and the template repointed at the remaining one. **Exactly one
   organization exists in this database**, and it is the one the bootstrap
   resolves.
2. **`agent_templates.org_id`** repointed to this lane's organization, the same
   repair `evidence/2841-v-redraw` recorded.
3. **The cloned database's `public.jwks` row** was encrypted under the source
   lane's `BETTER_AUTH_SECRET` and could not be decrypted under this lane's, so
   the hosted widget sign-in would return 500. The row was deleted and Better
   Auth minted a fresh key — the remedy the error itself names.

## The two defects, and what closed them

### 1. The card could not be read (fixed at `291bfee0f`)

`src/lib/auth-route-guard.ts` carries an **exact-path** list of routes reachable
without a session cookie, and the two routes this branch adds were not on it, so
`guardAppRoute` redirected them before the handler ran. `291bfee0f` adds both
paths, each with its own entry, and adds nine pinned rows to the guard's suite.
**Measured live in this lane, cookieless:**

```
POST /api/lifecycle-views/recommendation-hold          -> 401
POST /api/lifecycle-views/recommendation-hold/decide   -> 401
POST /api/lifecycle-views/resolve                      -> 401
POST /api/lifecycle-views/decide                       -> 401
```

### 2. The decision could not dispatch (fixed at `aa29034f2`)

`releaseAndDispatch` (`packages/agents/src/run-recommendation-core.ts`) performs
the selection write, the verified release and the resume announcement, and then
calls the dispatcher the entry handed it. The broker decide route used to hand it
`triggerAgentRun`, whose first act is `requireAuthSession()` — the **ambient
cookie session**. A cross-site frame has none, so the dispatch answered
`{ok: false, error: "unauthorized"}`, `releaseAndDispatch` returned that as the
whole decision's outcome, the card believed the decision had failed and never
fired its `onDecided` re-read, and the run stayed parked at `pending_input`
forever.

`aa29034f2` parameterises the run-start dispatch on an already-verified
principal — `run-dispatch-core.ts`, deliberately not a `"use server"` module —
and the widget entry mints a dispatcher bound to the actor its `cwu_` just
proved, for the one run the route already bound to that widget session, in the
org the credential names. `triggerAgentRun` keeps the cookie host unchanged.

**Measured live in this lane, at that head** — the decide answered **200** with
`outcome.ok = true`, `outcome.dispatched = true`, and the card's `onDecided`
re-read followed it on the wire, which is exactly what was absent before:

| Row | Value |
|---|---|
| `lifecycle_continuation_park` | `checkpoint=recommendation`, `status=` **`released`** |
| `run_selected_skill_revisions` | `blog-post-matcher` → `recommended_confirmed` |
| | `blog-writing` → `user_adjusted` |
| | `web-research` → `recommended_confirmed` |
| `run_rejected_recommendations` | `brand-voice-matcher` → `recommended_not_kept` |
| `agent_runs.status` **before** the decision | `pending_input` |
| `agent_runs.status` **after** the decision | **`pending_approval`** — the run advanced |

**The run's status is READ BACK, never read off the screen.** The inline run
panel in this column is a cookie-bound surface that cannot load the run from a
cross-site frame (see *Also visible, and pre-existing* below), so the column does
NOT show the run's state and no cell here claims that it does. `agent_runs.status`
is queried on either side of the decision and carried on the settled cells as
`settleFacts`, together with `settledInPlace: true` and
`reloadedBeforeReading: false`.

**The wire, this round** (`logs/widget-wire.json`; presence/absence only, never a
value). Four broker calls, every one `cookie: absent`,
`x-cinatra-widget-user-token: present (cwu_)`, widget origin and assistant
headers present:

| Route | Calls | Status |
|---|---|---|
| `POST /api/lifecycle-views/recommendation-hold` | 3 | **200** |
| `POST /api/lifecycle-views/recommendation-hold/decide` | 1 | **200**, `outcome.ok=true`, `dispatched=true` |

The third resolve is the card's own post-decision re-read. Its presence is the
wire-level difference between this round and the last one, where the refusal
meant no resolve ever followed the decide.

## Cells DELIVERED — the widget

Two framings, both uncropped, both at `deviceScaleFactor: 2`:
**`W`** is the whole embedded widget shot as the `.cw-frame` element on the
third-party page, so the card is visible IN the real transcript column with the
widget's own composer in frame; **`H`** is the card root alone, so the drawing can
be graded against §V with nothing else in the picture.

| Cell | Pixels | What is VISIBLY on screen |
|---|---|---|
| `W1__recommendation-card__site_widget__held__column` | 1244×2364 | The third-party page's embedded widget: the visitor's turn, the deterministic assistant reply, **the held card with four chips — `Blog Post Matcher Skill`, `Blog Writing Skill`, `Brand Voice Matcher Skill`, `Web Research Skill`, each with its own `Confirm` `Adjust` `Skip`** — and the widget's own composer (*“Type a message…”*) at the foot of the column. |
| `H1__recommendation-card__site_widget__held` | 1176×290 | The same held card on its own root: four chips, each a pill carrying its skill's **manifest displayName** and its own three affordances. No heading plate, no subtitle, no `Skills (n/m)` selector, no card-level submit. |
| `W2__recommendation-card__site_widget__held__column__dark` | 1244×2364 | The same column, same run, in `dark`. |
| `H2__recommendation-card__site_widget__held__dark` | 1176×290 | The same card root in `dark`. |
| `H3__recommendation-card__site_widget__held__mid-decision` | 1176×290 | After **one** chip was decided by pressing its own `Confirm` in a real browser: that chip carries its confirmed tint; every other chip still shows all three affordances and is still pressable. The row is never decided as a unit. |
| `W3__recommendation-card__site_widget__settled__column` | 1244×2364 | The row **SETTLED IN PLACE** in the same embedded column, composer in frame: `Blog Post Matcher Skill ✓ CONFIRMED`, `Blog Writing Skill ADJUSTED`, `Brand Voice Matcher Skill ✗ SKIPPED`, `Web Research Skill ✓ CONFIRMED`. Nothing left to press. |
| `H4__recommendation-card__site_widget__settled` | 1176×122 | The same settled row on its own root. |

**How the settled cells were obtained, stated plainly.** They were shot **where
the decision was made**: the same page load, the same frame instance and the same
card instance that drew the held row, after its own four chips were pressed. The
recorder waits for the root's `data-lifecycle-card-state` to turn `decided` and
shoots; there is no `page.goto` between the held cells and the settled ones, and
the run's status is read back from the database on either side. The recorder
still carries the honest fallback it needed last round: if the row does NOT
settle in place, it records a diagnostic and every settled cell it then takes
declares `reloadedBeforeReading: true` rather than claiming a settle. On this
round that branch did not run.

**Four of the seven PNGs are byte-identical to the previous round's, and that is
stated rather than left to look like untouched evidence.** `H1`, `H2`, `H3` and
`H4` frame the card root alone, and the card root carries no run id, so the same
drawing hashes the same. `H4` in particular is byte-identical while its
**provenance changed completely** — it was a re-read after a fresh load, and it
is now a live in-place settle. Pixels cannot tell those apart; the record and the
log can, which is why `settleFacts` sits on the cell and the whole capture run is
committed verbatim in `logs/widget-capture.txt`. The three `W` cells changed,
because the column shows the turn text and this round names a different run.

Measured on every one of the seven widget cells, and carried in each record's
`assertions`:

- `.cw-frame` (page) = **1**
- `[data-embed-assistant][data-phase="active"]` (frame) = **1**
- `[data-conversation-list]` (frame) = **1**
- `[data-lifecycle-card-host="site_widget"]` (frame) = **1**
- `[data-lifecycle-card="recommendation_hold"]` (frame) = **1**
- `[data-recommendation-chip]` (root) = **4**
- `[data-lifecycle-card-state]` (root) = **1**

and, per state:

| Cells | `[data-skill-action]` confirm / adjust / skip (root) | `data-lifecycle-card-state` |
|---|---|---|
| `W1` `H1` `W2` `H2` `H3` | **4 / 4 / 4** | `held` |
| `W3` `H4` | **0 / 0 / 0** | `decided` |

The card root carries, on all seven: `data-run-recommendation-chip-row`,
`data-conformance-id="run-chip-row"`,
`data-lifecycle-card="recommendation_hold"`,
`data-lifecycle-card-host="site_widget"`, `data-variant="inline"`; plus
`data-can-decide="true"` on the five held cells and no `data-can-decide` at all
on the two settled ones.

## The REAL SEQUENCE, and the one leg it could not walk

The review-page cells are read off a run this lane **drove**, in this order,
through the shipped surfaces (`drivers/05-run-page-real-sequence.mjs`, verbatim
in `logs/real-sequence.txt`):

| # | Step | Driven how | Measured outcome |
|---|---|---|---|
| 1 | **Start, person-present** | `/agents/<vendor>/<package>/new` — the run-start the Agents card's Run link lands on (`createAndTriggerRunCore`, `humanPresent: true`) | the run was created and **parked at the recommendation hold**: card root `data-lifecycle-card-state="held"`, `data-lifecycle-card-host="run_card"`, `data-can-decide="true"`, four chips × `Confirm` `Adjust` `Skip` |
| 2 | **Decide, chip by chip** | four real presses on the card's **own** per-chip controls in the browser — `confirm`, `adjust` → *“Keep it in this run”*, `skip`, `confirm` — never a row-level submit | the row released itself on the fourth press and settled **in place** on the run page: state `decided`, `data-run-recommendation-settled="true"`, **0/0/0** affordances |
| 3 | **The run's own input** | the `Idea` field the run then asked for, and **Continue** | the run left the hold and reached its trigger step |
| 4 | **The trigger form** | *“Run right after setup”*, then **Continue** | the run dispatched |
| 5 | **The run's production leg** | the shipped executor | **it could not run here** — see below |
| 6 | **The review gate** | `sweepReviewOrchestration()`, the shipped sweeper | `scanned: 1, gatesCreated: 1` — one `artifact_review_gates` row, `status=pending`, with its review task id |

**Durable rows after step 2** (`logs/run-execution-readback.json`, read from the
database, never off the screen):

| Row | Value |
|---|---|
| `lifecycle_continuation_park` | `checkpoint=recommendation`, `status=` **`released`** |
| `run_selected_skill_revisions` | `blog-post-matcher` → `recommended_confirmed` |
| | `blog-writing` → **`user_adjusted`** |
| | `web-research` → `recommended_confirmed` |
| `run_rejected_recommendations` | **empty, and that is correct** — that table records a *recommended* skill that was not kept, and the skipped chip (`brand-voice-matcher`) was never recommended for this run. See the note on scoring below. |

**All four chips are force-add candidates, and the record says so.** A run
started this way is created with empty `input_params` — the person types the
run's input at step 3, after the recommendation — so nothing scores over the
recommend threshold and every chip carries `data-forced`. The chip row offers
all four anyway, which is the shipped force-add behaviour; the previous
(widget) round drove a pre-seeded prompt and therefore saw three recommended and
one forced. Neither reading is dressed up as the other.

### The one leg the run could not walk, named exactly

**Step 5 failed, and this is its verbatim error** (`logs/run-execution-readback.json`,
with only the runtime ORIGIN redacted):

> Could not reach the agent runtime at `<the local WayFlow runtime origin>`/agents/cinatra-ai/blog-draft-writer-agent/ — fetch failed (ECONNREFUSED).

That is not a lane accident that a longer wait would fix. **Every** agent run's
execution dispatches to the WayFlow runtime — `packages/agents/src/execution.ts`
composes the agent's URL through `resolveWayflowUrl(template.packageName)` and
there is no in-core execution branch beside it — and this lane runs no WayFlow
container. And bringing one up would not close it either: the flow this agent is
(`extensions/cinatra-ai/blog-draft-writer-agent/cinatra/oas.json` — *“Stateless
LLM-only leaf agent … pure LLM generation”*) calls back through
`/api/llm-bridge`, which resolves a **real** provider adapter
(`resolveProviderAdapter`), and the scripted seam does not reach adapter
resolution at all: `isScriptedTestProviderEnabled()` only short-circuits
`hasConfiguredLlmRuntime()` and `describeLlmRuntimeUnavailability()`
(`packages/llm/src/registry.ts:426`, `:458`). This host holds no model
credential of any kind. The plan records the same limit in its own words at
§11.4: *“the deterministic provider is not wired into adapter resolution”*.

**So exactly one thing on this page is stood in for, and it is this one.** The
artifact the review gate is opened on was written by the SHIPPED materializer
the host uses to persist this agent's output —
`materializeBlogPostBodyArtifact({ …, createdByRunId: <this run> })`, the walk's
`PRODUCE` step — instead of by the run's own model-backed leg. Everything either
side of it is the real path: the hold, the four presses, the release, the
selection rows, the sweeper, the gate, the review page and its two cards.

**What is NOT stood in for, and matters most:** the decided form on the review
page is not a state anybody put there. It is the state the row was left in by a
decision taken **on the run page, before the run started**, exactly as the plan
orders it. The recorder refuses to shoot anything else — it fails closed if the
row reads anything but `decided`, or if a single decision affordance survives
inside the card root.

## Cells DELIVERED — the review page (the decided form)

| Cell | Pixels | What is VISIBLY on screen |
|---|---|---|
| `R1__recommendation-card__page_gate_region__decided` | 2096×52 | The settled row on its own root: **`Blog Post Matcher Skill ✓ CONFIRMED`**, **`Blog Writing Skill ⇄ ADJUSTED`**, **`Web Research Skill ✓ CONFIRMED`** — one chip per kept skill, each naming the owning extension's manifest `displayName` and its own outcome. **Nothing to press.** |
| `R2__recommendation-card__page_gate_region__decided__above-gate` | 2880×3540 | The same row **in its page**, uncropped: `AGENT RUN / Review`, the run's step rail, the settled row at the top of the gate region, and **beneath it the review gate card still open** — *“Review requested / Awaiting your decision”*, the pinned target, and the decision floor `Comment` · `Reject` · `Approve`. |
| `R3__recommendation-card__page_gate_region__decided__dark` | 2096×52 | The same row, same run, same clip rectangle, in `dark`. |
| `R4__recommendation-card__page_gate_region__decided__above-gate__dark` | 2880×3540 | The same page framing as `R2`, same run, in `dark`. |

`R1` and `R3` share one clip rectangle — `{x:376, y:191, w:1048, h:26}` CSS px —
measured once on the light pass, because shooting the locator twice gives widths
that differ by a scrollbar. `R2` and `R4` are the same full-page framing at the
same viewport. The order is measured, not eyeballed:
`{cardTop: 191, gateTop: 233, cardAboveGate: true, domOrder: "card-then-gate"}`.

**What the PIXELS say, not the DOM.** Every one of the four cells was read back
with the platform's own text recognizer straight off the committed PNG
(`logs/pixel-readout.txt`). It returns, in reading order on `R2`: the three
settled chips, then *“Review requested”* / *“Awaiting your decision”*, then the
target panel, then `Comment` / `Reject` / `Approve`. No `Confirm`, no `Adjust`,
no `Skip` appears anywhere in the row's pixels — which is the same claim the
DOM's **0/0/0** affordance count makes, made a second way.

Measured on all four cells, and carried in each record's `assertions`:

| Anchor | Scope | Count |
|---|---|---|
| `[data-lifecycle-card-host="page_gate_region"]` | frame | **2** (the row and the gate card) |
| `[data-lifecycle-card="recommendation_hold"]` | frame | **1** |
| `[data-lifecycle-card="artifact_review_gate"]` | frame | **1** |
| `[data-conformance-id="review-gate-card"]` | frame | **1** |
| `[data-conformance-id="review-decision-bar"]` | frame | **1** |
| `[data-recommendation-chip]` | root | **3** |
| `[data-skill-action="confirm"]` / `"adjust"` / `"skip"` | root | **0 / 0 / 0** |

The card root carries, on all four: `data-lifecycle-card-state="decided"`,
`data-run-recommendation-settled="true"`,
`data-run-recommendation-decision="confirmed"`,
`data-lifecycle-card-host="page_gate_region"` — and **no** `data-can-decide`.
The gate card beneath reads `state: "pending"`, `decisionBar: true`,
`decisionButtons: ["Comment","Reject","Approve"]`.

## The grading

Against design §V (the ratified redraw the card renders, quoted verbatim in
`packages/agents/src/run-recommendation-chip-row.tsx`) and against the plan's
§6.1 / §6.3 / §6.4 / §9 / §10.10 host language.

| # | What is claimed | Requires | Shows | Verdict |
|---|---|---|---|---|
| 1 | §V *“one chip per skill, each carrying its own Confirm, Adjust and Skip”* | ≥1 chip, each with its own three affordances | `W1`/`H1`/`W2`/`H2`: 4 chips × 3 = 12 buttons, per chip | **PASS** |
| 2 | §V *“The row is the whole card … no heading plate above it and no row-level submit beneath it”* | no heading, no card-level submit inside the root | `H1`/`H2`: the root is the row; nothing above or below it | **PASS** |
| 3 | §V settled chips name the skill, not an id | manifest `displayName` on every chip | the four names, held and settled | **PASS** |
| 4 | Plan §6.3 item 3 / §10.10 — *“the card is withheld from the widget”* is closed | the card drawn on `site_widget`, resolved through the broker | `[data-lifecycle-card-host="site_widget"]`=1 and card root=1 on all seven cells; 3 broker reads, `cookie: absent`, 200 | **PASS** |
| 5 | Plan §6.4 — the card appears *“in the widget”*, in the reply, in the conversation the reader was already in | the card in the real transcript column with the composer | `W1`/`W2`: turn, reply, card, composer, one `.cw-frame` | **PASS** |
| 6 | §V — a chip is settled by pressing one of **its own** affordances, never the row as a unit | one chip decided, the rest still pressable | `H3`: chip 0 confirmed, chips 1–3 undecided with 3 affordances each | **PASS** |
| 7 | S9f — a decision is **carried by the widget's own credential** to the `/decide` route | a cookieless decide POST that reaches the handler and is accepted | 1 × `/decide`, `cookie: absent`, `cwu_` present, **200**, `outcome.ok=true`; park `released`; 3 selected + 1 rejected rows written | **PASS** |
| 8 | §V — the **settled** row states each skill's own outcome with nothing to press | a decided reading on this host | `W3`/`H4`: state `decided`, 4 marked chips, **0/0/0** affordances | **PASS** |
| 9 | Both palettes resolve | the same card in light and dark, both framings | `W1`/`W2` and `H1`/`H2` | **PASS** |
| 10 | Plan §6.4 — *“the card settles in place showing what you chose, and the run card underneath advances”* | the row settling **where it was decided**, and the run advancing | `W3`/`H4` shot on the same frame instance with no reload (`settledInPlace: true`, `reloadedBeforeReading: false`); `agent_runs.status` `pending_input` → **`pending_approval`** | **PASS** |
| 11 | Plan §6.3 item 4 — *“No mount on the review page.”* is closed | the card present on the review route under `page_gate_region` | `R1`–`R4`: `[data-lifecycle-card-host="page_gate_region"]`=2 (row + gate), card root=1 | **PASS** |
| 12 | Plan §6.4 item 6 — *“The same row appears on the run page, ahead of the steps it would authorize, and on the review page…”*, **above** the gate | the row ABOVE the review gate card | `cardAboveGate: true`, `cardTop 191 < gateTop 233`, `domOrder: card-then-gate`; visible in `R2`/`R4` and in the pixel read-out | **PASS** |
| 13 | Plan §6.4 item 6 — *“…where it is mostly seen in its decided form.”* | a **decided** reading on the review page, produced by a real decision rather than staged | `R1`–`R4`: root `data-lifecycle-card-state="decided"`, `data-run-recommendation-settled="true"`; the decision itself was four presses on the run page (`logs/real-sequence.txt`), and the park read back `released` | **PASS** — this row read **NOT DELIVERED** on the previous evidence commit |
| 14 | Plan §6.4 designed item 4 — *“the card settles in place showing what you chose”* | each kept skill's own outcome named on its own chip | `R1`/`R3`: `Confirmed` / `Adjusted` / `Confirmed`, matching `run_selected_skill_revisions` (`recommended_confirmed` / `user_adjusted` / `recommended_confirmed`) row for row | **PASS** |
| 15 | The row on the review page is a **record**, not a control | **zero** decision affordances inside the card root, and no `data-can-decide` | `R1`–`R4`: `[data-skill-action]` confirm/adjust/skip = **0 / 0 / 0**; no `data-can-decide` attribute; the recognizer finds no `Confirm`/`Adjust`/`Skip` in the pixels | **PASS** |
| 16 | The review card **beneath** is the decision still open | the gate card present and pending, with its decision floor | `R2`/`R4`: gate `state: "pending"`, `[data-conformance-id="review-decision-bar"]`=1, buttons `Comment` · `Reject` · `Approve`, drawn beneath the settled row | **PASS** |
| 17 | Both palettes resolve on the review page | the same two framings in light and dark | `R1`/`R3` (one shared clip) and `R2`/`R4` (one page framing) | **PASS** |
| 18 | The run's own **production** leg | the run produces the artifact its gate opens on | **NOT DELIVERED** — the run dispatched and answered `ECONNREFUSED` at the WayFlow runtime; the artifact was written by the shipped materializer bound to that run instead. Stated in full above; the ONE stand-in on this page. | **NOT DELIVERED** |

Rows 13–18 are the ones that changed, and row 13 is the objection's resolution
stated as a verdict. It read **NOT DELIVERED** on the previous evidence commit,
where the review-page cells showed a **held**, still-pressable row. That reading
was **staged and unreachable**: no real flow produces it, because the
recommendation is decided before the run starts and the review page exists only
after the run produced something. The decided form is the surface's real state,
and it was reached by walking the real order rather than by softening anything —
the recorder now **fails closed** on a row that is not `decided` and on any
surviving affordance, which is a stricter bar than the round it replaces, not a
looser one.

Row 10 also changed earlier in this lane's history. It read **FAIL** on the
round before last, against the same requirement, on the round that measured the
dispatch defect. Nothing in that requirement was softened either: the same
driver waits for the same `decided` state on the same root with no reload in
between, and the run status is read from the database rather than the screen.

The **run card underneath** the row is a separate surface from the run itself,
and it is not the thing this cell photographs advancing — see the pre-existing
panel note below. What is measured here is the run: it left `pending_input`.

## Cells NOT delivered

| Cell | Why |
|---|---|
| a **held** reading on the review page | **Deliberately deleted, not owed.** The previous round carried one (`R1`–`R3`, held). It is a state no real flow produces — the recommendation is decided before the run starts, and the review page opens only after the run produced something — so it could only have been staged. The cells and their grading are gone. |
| a run that produced its **own** output | The run's production leg dispatches to the WayFlow runtime, which this lane does not run, and the flow is LLM-only while the scripted seam never reaches adapter resolution and this host holds no model credential. Measured, verbatim, in `logs/run-execution-readback.json`; grading row 18. |
| the card in the **chat** conversation | Not on this branch. It depends on the conversation-origin hold S9b (#2786) builds, exactly as the PR body says. |

## Also visible, and pre-existing

Every column cell shows a grey panel reading *“Could not load agent run
9c4879ee — please try again.”* That is the inline run panel
(`packages/chat/src/inline-agent-run-card.tsx`), which seeds itself with a plain
`GET /api/agents/runs/<id>` carrying no credential header. Measured cookieless in
this lane: **307 → `/sign-in`**. It is not one of the two routes this branch adds,
it is not on the guard's list, and it is not introduced by S9f — the branch's own
comment already calls that panel a cookie-bound surface that “carries nothing at
all”. It is stated because it is in the pictures, and it is why the run's advance
is read from the database rather than claimed off the column.

**On the review page**, the target panel inside the gate card reads *“review
target unavailable — slot "detail", reason "no-semantic-renderer"”* and *“No
type renderer resolved for this artifact — showing the generic read-only view.”*
That is the artifact type's own detail-renderer resolution on this lane, not
anything S9f touches: the gate card falls back to its shipped generic read-only
view and still draws its header, its pinned revision line and its whole decision
floor, which is what these cells are graded on. It is stated because it is in
the pictures.

## Registration in the capture index

**The seven widget records ARE registered** in
`scripts/ci/chat-hitl-capture-index.json`. Each was run through the shipped
validator (`scripts/ci/lib/capture-record-contract.mjs`) first and came back with
**zero** violations — `record/ok` — because `site_widget` has a valid URL class
(`embed_assistant`), which the frame path satisfies. `validateCaptureIndex` over
the whole file after this round's replacement: **24 records, 0 violations.** The
file's own inventory paragraph for this lane was rewritten to say what the cells
now show — the row settling in place rather than being read back — and its
mention of a diagnostic was removed with the diagnostic.

**The four review-page records are NOT registered on THIS branch, and that is
the contract working rather than a lapse.** Each comes back with **exactly one**
violation against the contract as this branch carries it,
`record/url-class-mismatch`, and no other: here `review_page` is
`/^\/agents\/reviews/`, while the shipped gate-region route is
`/agents/<vendor>/<package>/<runId>/review/<taskId>`. Every anchor, both counts
arms, the host claim, the kind claim, the **state** claim, the screenshot and its
digest all pass.

**That class is already FIXED on `main`**, where it reads
`/^\/agents\/[^/]+\/[^/]+\/[^/?#]+\/review\/[^/?#]+/`. Re-validated against
`origin/main`'s copy of the same contract, all **eleven** of this lane's records
— the four review-page ones included — come back `record/ok`, **0 violations**.
So the registration rides the merge-forward, exactly as it did for the
`page_gate_region` records from #2862 (A1) and #2863 (B1, B2): appending them to
the index on THIS branch would make the index invalid under the contract this
branch validates with, and turn a green gate red for a defect the branch does not
own. They stay in this lane's `capture-records.json`. The index's own inventory
paragraph for this lane is updated to name them as `R1`–`R4` in their decided
form.

## Gates — real exits

Both were run at this tree, and both were re-run with this lane contributing
nothing at all, so no pre-existing finding is absorbed into this commit.

| Gate | Exit | Findings |
|---|---|---|
| `scripts/ci/chat-hitl-evidence-gate.mjs` | **0** | 2 findings, both `grandfathered evidence/unbound-cell`, **both pre-existing**: `C1__review-card__chat_thread__pending` and `C2__review-card__chat_thread__decided`, cited by the acceptance manifest from `evidence/2573-s7-visuals-lane`. |
| `scripts/audit/chat-hitl-acceptance-gate.mjs` | **1** | 4 capture-index violations, **all pre-existing**: the same two `chat_thread` cells, cited by manifest rows 1 and 15. These are the four the PR body already names as reproducing on main. |

**The isolation was measured, not asserted.** Each gate was re-run with this
lane's `evidence/` directory moved aside **and** this lane's seven indexed
records removed from `scripts/ci/chat-hitl-capture-index.json`, so the run saw a
repo this lane had never touched. Both runs are **byte-identical** to the runs
above, and both isolation runs are appended verbatim to the same log files. This
commit therefore causes none of these findings and absorbs none of them; its own
seven indexed records are bound rather than unbound. Full output:
`logs/gate-chat-hitl-evidence.txt`, `logs/gate-chat-hitl-acceptance.txt`.

## Layout

- `PLAN-WALK.md` — every presented cell, with the exact plan sentences that
  govern its surface and state, quoted character-for-character.
- `captures/` — the PNGs, full resolution, uncropped.
- `capture-records.json` — every record in the shape
  `scripts/ci/lib/capture-record-contract.mjs` validates; the seven widget ones
  are also in the canonical index, and the four review-page ones validate clean
  against `origin/main`'s copy of the same contract.
- `capture-results.json` — the machine record beside the pixels: counts, the
  root's own `data-*` attributes, the per-chip DOM read-out, the card text, the
  wire, the decide outcome, `settleFacts`, the cookie jar, and the whole
  run-page real sequence (`runPageRealSequence`) with the run page's own text
  scrubbed of origins and of the lane account's name.
- `logs/` — the capture runs verbatim (`*.txt`), the real sequence
  (`real-sequence.txt`), what the recognizer reads off the committed pixels
  (`pixel-readout.txt`), the run's durable rows and its own verbatim execution
  error (`run-execution-readback.json`), the widget's broker wire
  (present/absent only, never a value), the seeded ids, and both gate outputs.
- `drivers/` — the harness exactly as run: `01-lane-setup.mjs`, `walk.config.ts` +
  `walk.test.ts` (assign → seed → hold → produce → gate → widget → readback),
  `host-page.html` (the third-party page), `03-capture-widget.mjs`,
  `04-capture-review-page.mjs` and `05-run-page-real-sequence.mjs`, whose
  counting rules and refusals are written at the top of each file.

No credential, token, password or host identity appears in any file here. Every
origin the recorders use is read from the environment.

Assisted-by: Claude Code (claude-opus-5)
