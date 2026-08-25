# cinatra#2790 (S9f) — the skills-recommendation card on its two new hosts

Head under proof: `f4388183be46fbf63ceebeb58e72232bd2eb18d0` (PR #2890 — the
branch head this round drove, which carries `aa29034f2` and the merges after
it), plus this evidence commit.

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

**And this round the run RAN.** The last round could walk that order right up to
the agent's own work and no further: the model call answered `503
NO_LLM_PROVIDER`, so the artifact the review gate opens on had to be written by
the shipped materializer standing in for the step. That was the one thing on
this page that was stood in for, and it is stood in for no longer. The WayFlow
runtime is up, a real model provider resolves, **the step executed and wrote its
own output** — 5 695 bytes of markdown, `Connector Rollout Note` — and **the
shipped sweeper opened the review on it by itself**. `R1`–`R4` were re-shot in
place on that run; `R1` and `R3` have since been retired (below).

**Beside the pictures there is now a clock.** `TIMELINE.md` and `timeline.json`
carry the whole sequence with the exact database column or log line every
timestamp was read from, because the pictures prove *what is drawn and where*
and cannot prove *in which order it happened*. Together they answer the
maintainer's question: the chips were decided at `17:03:10`, the step that used
them ran at `17:04:20`, the artifact it wrote landed at `17:04:21`, the review
gate was opened on that artifact at `17:04:46`, and the photographs were taken
at `17:30`.

## The runtime, said first

`node scripts/dev-server.mjs` (Next.js 16.2.10, Turbopack),
`CINATRA_RUNTIME_MODE=development`, `NODE_ENV != production`, on a **dedicated
lane database** on the verify Postgres (5634) and the verify Redis (6579),
loopback-only, with the branch's own extension tree and a raised
`CINATRA_BOOT_READY_TIMEOUT_MS`. The lane tree is an APFS clone of the repository
pinned to the head above, with per-package installs carried across; every symlink
in it was measured to be worktree-local, and the one that was not (an absolute
link into the source checkout) was rewritten before anything was driven.

**Two things changed in the runtime for this round, and they are the reason the
run below produces its own output.**

1. **The WayFlow runtime is UP.** Brought up from `docker-compose.yml`'s
   `wayflow` profile with `scripts/gen-wayflow-env.mjs`, after minting a
   `CINATRA_CONTEXT_ATTEST_KEY` into the lane `.env.local` the way
   `scripts/setup.sh` does (the loader refuses to start without it). Its own
   health probe — the one the compose healthcheck and the app use — answered:

   ```
   GET /.health -> 200 {"status":"ok","agents":29,"failed":0,"failed_agents":[],"last_reload_at":null}
   ```

2. **A REAL MODEL PROVIDER is configured, on this machine only.** The previous
   round stopped exactly here: the agent's model call to `POST /api/llm-bridge`
   answered `503 NO_LLM_PROVIDER`, because the bridge resolves a real provider
   adapter and the scripted test provider never reaches adapter resolution. So
   `CINATRA_TEST_LLM_PROVIDER` is **unset** for this round and a real provider
   connection was seeded instead, through the shipped writer
   (`writeOpenAIConnection`), which **seals the credential at rest**. The
   credential reached that one seeding process through its environment and
   nowhere else: it is in no file in this repository, in no log, in no record
   here, and it was never given to the WayFlow container — the generated
   `docker/wayflow/.wayflow.env` carries three keys and the model key is not one
   of them, because the agent calls back through the host's bridge rather than
   holding a key itself. **What this evidence states about it is one fact and
   only one: the bridge answered `200`** (`logs/run-execution-readback.json`,
   `TIMELINE.md` row 8).

`CINATRA_E2E_SETUP_BYPASS=true` is set, and stated because it is set: the lane
database is a clone of an already-provisioned instance, so the setup wizard has
nothing to run and the bypass keeps boot from demanding services this lane does
not have. It changes no surface photographed here.

It is **not** a production-equivalent build: this is the dev server, so the
surfaces are the dev build of the same components. That was already true of every
earlier round in this lane; what is no longer true is the reason the earlier
rounds gave for it (a scripted provider that cannot coexist with a production
bundle), because this round runs no scripted provider at all.

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
2b. The model provider connection through the shipped writer
   `writeOpenAIConnection`, which seals the credential at rest
   (`walk.test.ts` step `PROVIDER`). Its read-back is a BOOLEAN by construction:
   the step reports `storeResolvesAKey`, the default model and whether a
   validation stamp exists, and nothing else.
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
4. **The instance identity** (`cinatra.metadata` row `instance_identity`) did not
   travel with the clone, and without it the artifact-binding loader refuses
   every materialization. It was provisioned through the SHIPPED `/setup/name`
   wizard step in a browser (`drivers/02-provision-instance-identity.mjs`), not
   written by hand — see *Three lane gaps* below.
5. **The lane registry.** That wizard step self-registers against the local
   registry a dev install runs, and the binding loader reads the agent package's
   manifest from it, so the lane brought up the compose file's own Verdaccio and
   published the branch's `@cinatra-ai/blog-draft-writer-agent@0.1.2` into it —
   the version the template row already pins.
6. **The provider connection** (`cinatra.metadata` row `openai_connection`),
   written once through the shipped sealing writer so the agent's model call can
   resolve an adapter. Lane data. The credential itself is discussed once, in
   *The runtime*, and never appears here.

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

## The REAL SEQUENCE — walked all the way through, this time

The review-page cells are read off a run this lane **drove**, in this order,
through the shipped surfaces (`drivers/05-run-page-real-sequence.mjs`, verbatim
in `logs/real-sequence.txt`). **Every step below ran. Nothing on this page is
stood in for any more.**

| # | Step | Driven how | Measured outcome |
|---|---|---|---|
| 1 | **Start, person-present** | `/agents/<vendor>/<package>/new` — the run-start the Agents card's Run link lands on (`createAndTriggerRunCore`, `humanPresent: true`) | the run was created and **parked at the recommendation hold**: card root `data-lifecycle-card-state="held"`, `data-lifecycle-card-host="run_card"`, `data-can-decide="true"`, four chips × `Confirm` `Adjust` `Skip` |
| 2 | **Decide, chip by chip** | four real presses on the card's **own** per-chip controls in the browser — `confirm`, `adjust` → *“Keep it in this run”*, `skip`, `confirm` — never a row-level submit | the row released itself on the fourth press and settled **in place** on the run page: state `decided`, `data-run-recommendation-settled="true"`, **0/0/0** affordances |
| 3 | **The run's own input** | the `Idea` field the run then asked for, and **Continue** | the run left the hold and reached its trigger step |
| 4 | **The trigger form** | *“Run right after setup”*, then **Continue** | the run dispatched |
| 5 | **The dispatch, accepted by the runtime** | the shipped executor → the WayFlow container | `POST /agents/cinatra-ai/blog-draft-writer-agent/ 200 OK` in the runtime's own log; the flow's first step ran and parked on its **own** context-slot gate |
| 6 | **The run's own in-flight gate** | one press of that gate's own `Continue` in the browser — nothing that could touch a recommendation (the row carries no control by then) | the flow resumed inside the runtime |
| 7 | **THE STEP EXECUTED** | the agent's model call, out through `POST /api/llm-bridge` and back | **the bridge answered `200`** (18.1 s), then the runtime reported `state=completed` |
| 8 | **THE RUN WROTE ITS OWN OUTPUT** | the shipped materialization path, on what the step returned | `cinatra.representation` row with `created_by_run_id` = this run — *Connector Rollout Note*, `@cinatra-ai/blog-post-artifact:post`, `text/markdown`, **5 695 bytes**; `artifact_produced_outbox` row, `emitter=createSemanticArtifact`, `origin_kind=agent_produced` |
| 9 | **The review gate** | the shipped sweeper's own loop, unprompted | `[lifecycle-review-orchestration] scanned=1 gatesCreated=1 noGate=0 notClassifiable=0 failed=0` — one `artifact_review_gates` row, `status=pending`, with its review task id |

**Read the order, with the source of every timestamp, in `TIMELINE.md` and
`timeline.json` beside this file.** They are the second half of this evidence and
they answer a question the pictures cannot.

**Durable rows** (`logs/run-execution-readback.json`, read from the database,
never off the screen):

| Row | Value |
|---|---|
| `lifecycle_continuation_park` | `checkpoint=recommendation`, `status=` **`released`** |
| `run_selected_skill_revisions` | `blog-post-matcher` → `recommended_confirmed` |
| | `blog-writing` → **`user_adjusted`** |
| | `web-research` → `recommended_confirmed` |
| `run_rejected_recommendations` | **empty, and that is correct** — that table records a *recommended* skill that was not kept, and the skipped chip (`brand-voice-matcher`) was never recommended for this run. See the note on scoring below. |
| `agent_runs` | `status=` **`completed`**, `error` empty |
| `cinatra.representation` | `created_by_run_id` = this run, `created_at` `17:04:21.865797` |
| `artifact_review_gates` | `status=pending`, opened `17:04:46.914590` |

**All four chips are force-add candidates, and the record says so.** A run
started this way is created with empty `input_params` — the person types the
run's input at step 3, after the recommendation — so nothing scores over the
recommend threshold and every chip carries `data-forced`. The chip row offers
all four anyway, which is the shipped force-add behaviour; the widget round drove
a pre-seeded prompt and therefore saw three recommended and one forced. Neither
reading is dressed up as the other.

### What the previous round could not do, and what closed it

The previous round on this branch got as far as the dispatch and then stopped
dead at the model call:

> `503 {"error":"The configured default LLM provider \"openai\" is not available","code":"NO_LLM_PROVIDER",…}`

No model, no output, no artifact, no gate, and therefore no review page produced
by a real run — the artifact its gate opened on had to be written by the shipped
materializer standing in for the step. **That stand-in is gone.** The maintainer
authorised a real model key for this proof on this machine, the provider
connection was seeded through the shipped sealing writer, and the same call now
answers `200`. What the run produced, it produced itself.

### Three lane gaps this round had to close first, all stated

None of them is a defect of this branch; all three are consequences of driving a
CLONED lane database rather than a freshly installed instance, and each was found
by a run failing on it rather than by guesswork.

1. **The `instance_identity` metadata row did not travel with the clone.**
   Without it the artifact-binding loader refuses every materialization
   (`INSTANCE_NAMESPACE_NOT_CONFIGURED`) — which is discovered only AFTER the
   model has already answered. It was provisioned the way the product provisions
   it: the shipped `/setup/name` wizard step, filled and submitted in a browser
   (`drivers/02-provision-instance-identity.mjs`, verbatim in
   `logs/provision-identity.txt`). Nothing was written into `cinatra.metadata` by
   hand.
2. **The lane registry was empty.** That wizard step self-registers against the
   local registry a dev install runs, so the lane's Verdaccio was brought up from
   the same compose file; and the binding loader reads the agent package's
   manifest from that registry, so the branch's own
   `@cinatra-ai/blog-draft-writer-agent@0.1.2` was published into it from the
   worktree — the same package version the template row already pins.
3. **A pre-check now exists so neither of those costs a model call to find
   again.** `walk.test.ts` gained a `BINDINGS` step that runs the SHIPPED
   `loadRunDerivationContext` with no dispatch at all; it answered
   `{"producesRefs":[{"extension":"@cinatra-ai/blog-post-artifact"}],"hasBindings":true}`
   before the run below was driven. Writing it exposed a second thing worth
   stating: the harness's own `@/lib/database` mock used to answer **every**
   metadata read with the caller's fallback, which made the first version of that
   pre-check report the instance identity as missing while the row was in fact
   present. The mock now delegates to the real metadata store.

## Cells DELIVERED — the review page (the decided form)

> **`R1` and `R3` ARE RETIRED, and the two images with them** (the S9d
> merge-forward, PR #2890). Both declared `framing: "card-root"` — a close-up of
> the card with the page cropped away — and the ratified framing vocabulary is
> `window` or `page` and nothing else, because the maintainer asked for the
> surrounding after seeing exactly such close-ups. Nothing is owed for them: the
> SAME reading of the SAME run is recorded at page framing by `R2` and `R4`. The
> two rows below are kept as the record of what was retired and why; their
> pictures are gone, because a picture kept beside a retired record is the next
> round's false evidence. **Their RECORDS are gone as of this commit too** —
> removed from `capture-records.json` and `capture-results.json`, which until now
> still carried the hashes of two files this tree does not hold. The two rows
> below, and every grading row further down that cites `R1`/`R3`, are kept as the
> retired reading and are not offered as live evidence.


| Cell | Pixels | What is VISIBLY on screen |
|---|---|---|
| `R1__recommendation-card__page_gate_region__decided` | 2096×52 | The settled row on its own root: **`Blog Post Matcher Skill ✓ CONFIRMED`**, **`Blog Writing Skill ⇄ ADJUSTED`**, **`Web Research Skill ✓ CONFIRMED`** — one chip per kept skill, each naming the owning extension's manifest `displayName` and its own outcome. **Nothing to press.** |
| `R2__recommendation-card__page_gate_region__decided__above-gate` | 2880×3540 | The same row **in its page**, uncropped: `AGENT RUN / Review`, the run's step rail, the settled row at the top of the gate region, and **beneath it the review gate card still open** — *“Review requested / Awaiting your decision”*, the pinned target, and the decision floor `Comment` · `Reject` · `Approve`. **The target panel names what THIS RUN produced**: *Connector Rollout Note*, `Blog Post Artifact`, `@cinatra-ai/blog-post-artifact:post · revision 65128429-95e… · text/markdown · updated 2026-08-22T17:04:21.865Z` — the same revision id `cinatra.representation.created_by_run_id` binds to this run. |
| `R3__recommendation-card__page_gate_region__decided__dark` | 2096×52 | The same row, same run, same clip rectangle, in `dark`. |
| `R4__recommendation-card__page_gate_region__decided__above-gate__dark` | 2880×3540 | The same page framing as `R2`, same run, in `dark`. |

`R1` and `R3` shared one clip rectangle — `{x:376, y:191, w:1048, h:26}` CSS px —
measured once on the light pass, because shooting the locator twice gives widths
that differ by a scrollbar. `R2` and `R4` are the same full-page framing at the
same viewport. The order is measured, not eyeballed:
`{cardTop: 191, gateTop: 233, cardAboveGate: true, domOrder: "card-then-gate"}`.

**The gate card's target is a LAZY island, and the recorder now waits for it.**
The target panel is an `<iframe>` (`/lifecycle/review-island`) that paints its own
placeholder bars until it resolves — measured on this lane at roughly forty
seconds, where the gate card itself lands in under twenty. A first pass of this
round shot on the gate card alone and produced a page whose target was a row of
grey bars, which reads as *“the run produced nothing”* — the opposite of what
happened. The recorder waits for the island's own text now and records
`reviewTargetResolved` on every cell; the two records this directory still
holds, `R2` and `R4`, both carry `true`.

### What the pictures prove, and what the timeline proves

**The pictures** (`R2` and `R4`; `R1`/`R3` proved the same reading before they
were retired) prove **placement and reading**: on the review page,
under `page_gate_region`, the recommendation row is drawn **above** the review
gate card (`cardTop 191 < gateTop 233`, `domOrder: card-then-gate`) and it is
drawn **decided** — one settled chip per kept skill, each naming its own outcome,
with **zero** decision affordances and no `data-can-decide`, while everything
pressable on the page sits in the gate card beneath it. They cannot prove
*when* any of that happened; a photograph has no clock.

**The timeline** (`TIMELINE.md` / `timeline.json`) proves the ORDER, from
database columns and runtime log lines rather than from the screen: the chip
decisions were written at `17:03:10`, the step that used those skills executed at
`17:04:20`, the artifact that step wrote landed at `17:04:21`, the sweeper opened
the review gate on it at `17:04:46`, and the pictures were taken at `17:30`. So
the decided row was **decided before the step ran**, and the step **ran before
the review existed** — which is the claim the objection asked for and the one no
screenshot on its own can carry. The timeline also names the one column it does
**not** trust and why: `agent_runs.created_at` reads identical to `completed_at`
on this run, so the run's creation is anchored on
`lifecycle_continuation_park.created_at` and on the artifact and gate rows.

**What the PIXELS say, not the DOM.** Every one of the four cells was read back
with the platform's own text recognizer straight off the PNG committed at the
time (`logs/pixel-readout.txt`; the `R1` and `R3` PNGs it also read have since
been retired). It returns, in reading order on `R2`: the three
settled chips, then *“Review requested”* / *“Awaiting your decision”*, then the
target panel, then `Comment` / `Reject` / `Approve`. No `Confirm`, no `Adjust`,
no `Skip` appears anywhere in the row's pixels — which is the same claim the
DOM's **0/0/0** affordance count makes, made a second way.

Measured on all four cells when they were shot, and carried in the `assertions`
of the two records this directory still holds — `R2` and `R4`:

| Anchor | Scope | Count |
|---|---|---|
| `[data-lifecycle-card-host="page_gate_region"]` | frame | **2** (the row and the gate card) |
| `[data-lifecycle-card="recommendation_hold"]` | frame | **1** |
| `[data-lifecycle-card="artifact_review_gate"]` | frame | **1** |
| `[data-conformance-id="review-gate-card"]` | frame | **1** |
| `[data-conformance-id="review-decision-bar"]` | frame | **1** |
| `[data-recommendation-chip]` | root | **3** |
| `[data-skill-action="confirm"]` / `"adjust"` / `"skip"` | root | **0 / 0 / 0** |

The card root carries, on both surviving records: `data-lifecycle-card-state="decided"`,
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
| 11 | Plan §6.3 item 4 — *“No mount on the review page.”* is closed | the card present on the review route under `page_gate_region` | `R2`/`R4`: `[data-lifecycle-card-host="page_gate_region"]`=2 (row + gate), card root=1 | **PASS** |
| 12 | Plan §6.4 item 6 — *“The same row appears on the run page, ahead of the steps it would authorize, and on the review page…”*, **above** the gate | the row ABOVE the review gate card | `cardAboveGate: true`, `cardTop 191 < gateTop 233`, `domOrder: card-then-gate`; visible in `R2`/`R4` and in the pixel read-out | **PASS** |
| 13 | Plan §6.4 item 6 — *“…where it is mostly seen in its decided form.”* | a **decided** reading on the review page, produced by a real decision rather than staged | `R2`/`R4`: root `data-lifecycle-card-state="decided"`, `data-run-recommendation-settled="true"`; the decision itself was four presses on the run page (`logs/real-sequence.txt`), and the park read back `released` | **PASS** — this row read **NOT DELIVERED** on the previous evidence commit |
| 14 | Plan §6.4 designed item 4 — *“the card settles in place showing what you chose”* | each kept skill's own outcome named on its own chip | `R2`/`R4`, in each record's own `chips` read-out: `Confirmed` / `Adjusted` / `Confirmed`, matching `run_selected_skill_revisions` (`recommended_confirmed` / `user_adjusted` / `recommended_confirmed`) row for row | **PASS** |
| 15 | The row on the review page is a **record**, not a control | **zero** decision affordances inside the card root, and no `data-can-decide` | `R2`/`R4`: `[data-skill-action]` confirm/adjust/skip = **0 / 0 / 0**; no `data-can-decide` attribute; the recognizer finds no `Confirm`/`Adjust`/`Skip` in the pixels | **PASS** |
| 16 | The review card **beneath** is the decision still open | the gate card present and pending, with its decision floor | `R2`/`R4`: gate `state: "pending"`, `[data-conformance-id="review-decision-bar"]`=1, buttons `Comment` · `Reject` · `Approve`, drawn beneath the settled row | **PASS** |
| 17 | Both palettes resolve on the review page | the same page framing in light and dark | `R2` and `R4`, both `framing: "page"`, `themeClass` ending `cinatra` and `dark` respectively; the retired `R1`/`R3` carried a second, card-root framing that this row no longer rests on | **PASS** |
| 18 | The run's own **production** leg | the run produces, itself, the artifact its gate opens on | the WayFlow runtime up and healthy (`/.health` → `200`, `status: ok`, 29 agents); the dispatch accepted (`POST /agents/cinatra-ai/blog-draft-writer-agent/ 200 OK`); **the model call answered `200`** at `POST /api/llm-bridge`; the step reported `completed`; a `cinatra.representation` row with `created_by_run_id` = this run carrying 5 695 bytes of `text/markdown`; an `artifact_produced_outbox` row with `emitter=createSemanticArtifact`, `origin_kind=agent_produced`. **No materializer stood in for anything.** | **PASS** — this row read **NOT DELIVERED** on the previous evidence commit |
| 19 | The **order**: the recommendation is decided BEFORE the step that uses it, and the step runs BEFORE the review exists | timestamps read from the database and the runtime log, not from a screen, each citing its source | `TIMELINE.md` / `timeline.json`: decisions `17:03:10.434846` (`run_selected_skill_revisions.selected_at`) → step `17:04:20.800435` (runtime status payload) → artifact `17:04:21.865797` (`representation.created_at`, `created_by_run_id` = this run) → gate `17:04:46.914590` (`artifact_review_gates.created_at`; sweeper line `scanned=1 gatesCreated=1`) → pictures `17:30:21` (`recordedAt`). The one column NOT trusted is named with its reason. | **PASS** — new row |
| 20 | The gate card's **target** is the thing this run made | the target panel naming the run's own artifact and its revision | `R2`/`R4`: *Connector Rollout Note*, `Blog Post Artifact`, `revision 65128429-95e…`, `text/markdown`, `updated 2026-08-22T17:04:21.865Z` — the same revision id the durable row binds to this run; `reviewTargetResolved: true` on both surviving records | **PASS** — new row |

Rows 13–20 are the ones that changed. Row 18 is this round's: it read **NOT
DELIVERED** on the previous evidence commit, against the same requirement,
unsoftened — the run now walks its own production leg instead of having one
written for it. Rows 19 and 20 are new, and they exist because the maintainer's
question was about TIME and about WHAT, which no picture answers on its own. Row
13 is the earlier objection's resolution stated as a verdict. It read **NOT DELIVERED** on the previous evidence commit,
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
view and still draws its header, the artifact's title, its pinned revision line
and its whole decision floor, which is what these cells are graded on. It is
stated because it is in the pictures — and note that the header it draws is the
title the RUN's own step wrote (*Connector Rollout Note*), so the fallback is
about the renderer, never about whether the output exists.

**Also on the review page, and also pre-existing:** in `R4` the target island
renders in the LIGHT palette inside the dark page. The island is a separate
document in an `<iframe>`, and the theme class the page's own control writes on
`<html>` does not propagate into it. That is an island theme-propagation gap, not
anything S9f touches; it is stated because it is visible in the dark cell. It
does not affect what these cells are graded on — the row, its placement and the
gate's decision floor all resolve dark correctly around it.

## Registration in the capture index

**All twenty-one of this lane's cells are registered** in
`scripts/ci/chat-hitl-capture-index.json` — the seven widget cells and, since the
merge-forward that brought `main`'s corrected `review_page` URL class onto this
branch, the review-page cells too, together with the chat, rework and `R6` cells
the later rounds added. `R1` and `R3` are not among them: they were retired with
their pictures by the S9d merge-forward `c6fbe5a9`, and their records left
`capture-records.json` and `capture-results.json` with this commit.
`capture-records.json` now holds **nine** records; the four
`capture-records*.json` files in this directory hold **23 entries covering 21
distinct cells** — `R6` light and dark are recorded identically in both
`capture-records-r6.json` and `capture-records-rework.json`. Every one of those
21 cells resolves to a record in the index, and every lane record in the index
resolves back to a cell in these files. `validateCaptureIndex` over the whole
file: **75 records, 0 violations.**

That URL class is the reason the four `R` cells were held out of the index on the
first evidence commit in this lane, and it is worth keeping the history straight
rather than quietly dropping it: the contract then read `review_page` as
`/^\/agents\/reviews/`, while the shipped gate-region route is
`/agents/<vendor>/<package>/<runId>/review/<taskId>`, so registering them would
have turned a green gate red for a defect this branch does not own. `main` fixed
the class; the merge landed it here; the records went in.

**This round refreshed the digests, and only two of them moved.** `R2` and `R4`
changed, because the page shows a different run and its target panel now names
the artifact that run produced. `R1` and `R3` were **byte-identical to the
previous round's files** — the card root carries no run id, so the same three
chips with the same three marks in the same clip rectangle hashed the same. Their
PROVENANCE changed completely all the same: the row they showed was left behind
by a run that executed and produced its own output, where the previous round's
was left behind by a run that failed at its model call. Pixels cannot tell those
apart. `logs/run-execution-readback.json` and `TIMELINE.md` can, which is why the
digests were stated as unchanged rather than left to look like fresh evidence.
Both cells have since been retired, and their records no longer sit in
`capture-records.json`.

## Gates — real exits

Both were run at this tree, and both were re-run with this lane contributing
nothing at all, so no pre-existing finding is absorbed into this commit and none
is caused by it.

| Gate | Exit | Findings |
|---|---|---|
| `scripts/ci/chat-hitl-evidence-gate.mjs` | **0** | **none** — `no findings.` |
| `scripts/audit/chat-hitl-acceptance-gate.mjs` | **0** | **none** — *“manifest honest — 16 rows (10 MAPPED, 4 BUILT, 2 MISSING); every named proof exists in the tree. Capture index host-anchored — 75 record(s). Anchor contract ratified at the manifest's design pin.”* |

**The isolation was measured, not asserted.** Each gate was re-run with this
lane's `evidence/` directory moved aside **and** this lane's twenty-one indexed
records removed from `scripts/ci/chat-hitl-capture-index.json` (75 → 54), so the
run saw a repo with this lane's evidence and index records removed. Both control runs also exit **0**
with **no findings**; the only difference in the output is the record count the
acceptance gate prints. Both runs are appended verbatim to the same log files:
`logs/gate-chat-hitl-evidence.txt`, `logs/gate-chat-hitl-acceptance.txt`.

**These readings changed since the previous evidence commit, and not because
anything here was softened.** That commit reported two `grandfathered
evidence/unbound-cell` findings and four capture-index violations, all
pre-existing and all pointing at the same pair of `chat_thread` cells. #2903
retired that pair with evidence and has since merged into this branch, so the
findings they caused are gone from both gates. This round measured that rather
than inheriting the old text.

## Layout

- `PLAN-WALK.md` — every presented cell, with the exact plan sentences that
  govern its surface and state, quoted character-for-character.
- `captures/` — the PNGs, full resolution, uncropped.
- `TIMELINE.md` + `timeline.json` — the order the run actually happened in, each
  row citing the database column or the log line its timestamp was read from,
  and naming the one column that is deliberately NOT trusted.
- `capture-records.json` — every record in the shape
  `scripts/ci/lib/capture-record-contract.mjs` validates; all nine are in the
  canonical index, which validates clean (75 records, 0 violations).
- `capture-results.json` — the machine record beside the pixels: counts, the
  root's own `data-*` attributes, the per-chip DOM read-out, the card text, the
  wire, the decide outcome, `settleFacts`, the cookie jar, and the whole
  run-page real sequence (`runPageRealSequence`) with the run page's own text
  scrubbed of origins and of the lane account's name.
- `logs/` — the capture runs verbatim (`*.txt`), the real sequence
  (`real-sequence.txt`), the instance-identity provisioning
  (`provision-identity.txt`), what the recognizer reads off the committed pixels
  (`pixel-readout.txt`), the run's durable rows including what its step produced
  (`run-execution-readback.json`), the widget's broker wire (present/absent only,
  never a value), the seeded ids, and both gate outputs.
- `drivers/` — the harness exactly as run: `01-lane-setup.mjs`,
  `02-provision-instance-identity.mjs`, `walk.config.ts` + `walk.test.ts`
  (assign → provider → seed → hold → bindings → gate → widget → readback),
  `host-page.html` (the third-party page), `03-capture-widget.mjs`,
  `04-capture-review-page.mjs` and `05-run-page-real-sequence.mjs`, whose
  counting rules and refusals are written at the top of each file. The `PRODUCE`
  step — the materializer stand-in — is retired: it is kept in the file, unrun,
  so the earlier rounds in this lane's history stay reproducible.

No credential, token, password or host identity appears in any file here. Every
origin the recorders use is read from the environment. The model credential this
round used reached exactly one process, through its environment, from the vault;
the only thing said about it anywhere in this directory is that the bridge
answered `200`.

Assisted-by: Claude Code (claude-opus-5)

---

# The CHAT round — one run, one conversation, whole windows (2026-08-23)

## The two objections, answered in order

**1. "The whole chat should always be visible in the screenshots, not just a
close-up of the skill recommendation pills."** Every cell in this round is the
**FULL BROWSER WINDOW** at `1440×1700` CSS px, `deviceScaleFactor: 2` — no
`fullPage` stitch and no clip rectangle anywhere in the recorder. The window was
sized to the conversation rather than the conversation cropped to a default
window, and each record carries the viewport it was shot at plus the transcript's
own measured geometry (`listTop`, `listBottom`, `listFullyInViewport`). **All six
chat cells record `listFullyInViewport: true`**: the person's own turn, the
reply, the card, the run panel and the composer are in one frame.

**2. "The re-shoot does not show the skills recommendation card before the agent
creates output, only afterwards."** This round photographs it **before**, and
proves the "before" with the database rather than with prose. At the instant the
`S1` cells were taken, this run's `cinatra.representation`,
`cinatra.artifact_produced_outbox` and `cinatra.artifact_review_gates` row counts
were **0, 0 and 0** — the counts are carried on each `S1` record as `dbAt` and
the driver **throws** rather than shooting if any of them is non-zero. So the
card is on screen, held, with all twelve of its per-chip controls live, and the
run has produced nothing at all.

## The host is the CHAT

Not the widget and not the run page: `chat_thread`, the conversation itself. The
run is started the way a person starts one from a conversation — one typed turn
into `/chat`'s own composer. The server-side hard pre-router dispatches it, the
chat-origin hold parks it before anything is queued, and the transcript draws the
§V card at the `agent_run` producing slot. The reply beside it is the server's
own sentence: *“The run paused for a decision on the recommended skills.”*

## The order, in one run

Read `TIMELINE.md`'s CHAT section: every timestamp there is a database column or
a runtime log line, named. In short — hold parked `10:25:01`; the withdrawn S1 was shot at
`10:25:19` with zero output rows; four chips decided one at a time in the chat,
written `10:25:29`; hold released `10:25:29`; the withdrawn S2 was shot at
`10:25:57`; the
step's model call answered `200` through the bridge and the flow completed
`10:26:01`; the artifact the step wrote landed `10:26:02`; the shipped sweeper
opened the review on it `10:26:12`; **S3 shot at `10:26:44`**, **S4 at
`10:27:09`**.

## Cells WITHDRAWN — the two chat cells this round re-shoots

`S1__recommendation-card__chat_thread__held`,
`S1__recommendation-card__chat_thread__held__dark`,
`S2__recommendation-card__chat_thread__decided` and
`S2__recommendation-card__chat_thread__decided__dark` are **withdrawn**: their
records are deleted from `scripts/ci/chat-hitl-capture-index.json` and from this
directory, and the four pictures are deleted with them. They show what the code
did before this round, and the plan rules both readings out:

> An agentic run progress card is not visible while the recommended skills can be
> selected, because they are being chosen before the agent actually runs.

> The agentic run progress card appears once the skills are decided; no skill
> inside it can be selected.

The held cells drew the run progress card beside the chip row, and the decided
cells drew a `Skills (4)` button row inside it that listed four pressable skills,
the skipped one among them. What replaces them is the OWED set below.

## Cells OWED — the new proof set

One real run, a full browser window per cell, light and dark, every cell
recorder-measured (nothing here is hand-written, and no record is filed until the
recorder files it). `PLAN-WALK.md` carries each cell's plan sentences, the ratified
drawing it is graded against, and its `requires / shows / verdict` line — every
verdict reads `owed (capture pending)` until the pictures exist.

| Cell owed | Surface | What it must show |
|---|---|---|
| `S1__recommendation-card__chat_thread__held` (+ `__dark`) | the conversation | The reply with the chip row and nothing else a started run would bring: one chip per skill with its own `Confirm` `Adjust` `Skip`, no heading plate, no row-level submit, and **no agentic run progress card in the turn** (the recorder counts `[data-inline-run-card]` and must record **0**). |
| `S2__recommendation-card__chat_thread__decided` (+ `__dark`) | the conversation | The same slot after every chip is decided: the settled chips in place with nothing left to press, and the run progress card **below** them — with **no skills button row inside it** (the recorder counts `[data-inline-run-card]` = **1** and `[data-hitl-skill-picker]` = **0**). |
| `R5__recommendation-card__run_card__held` (+ `__dark`) | the run page | The same run held, on the run surface: the step rail on the left and the recommendation read in the run detail on the right, under that same rail. |
| `R6__recommendation-card__run_card__decided` (+ `__dark`) | the run page | The same run after the decision: the settled chips in place and the run's own progress in the run detail, with **no skills button row inside the card**. |

The run-page pair is numbered `R5`/`R6` because `R1`-`R4` in this directory were
taken by the review-page cells (`R2` and `R4` presented; `R1` and `R3` retired); each name carries its host token, which is what
says which surface it is.

## Cells DELIVERED — the chat sequence

| Cell | Pixels | What is VISIBLY on screen |
|---|---|---|
| `S3__review-card__chat_thread__pending` | 2880×3400 | The same conversation, all four turns in one window: the decided row still above, the run panel reading **`completed` / “Run complete”**, the person's second turn *“Is there anything waiting on me for review?”*, and beneath it **the review card on `chat_thread`** — *“Review requested / Awaiting your decision”*, the target the run's own step wrote (`CINATRA_UAT_OK: scripted title`, `Blog Post Artifact`, `@cinatra-ai/blog-post-artifact:post · revision 798dc74f-cf0… · text/markdown · updated 2026-08-23T10:26:02.616Z`), the composer-binding row, the rationale field and the decision floor `Comment` · `Reject` · `Approve`. |
| `S3__review-card__chat_thread__pending__dark` | 2880×3400 | The same window, dark palette. |
| `S4__recommendation-card__page_gate_region__decided` | 2880×3400 | The **review page for the same run**, whole window: `AGENT RUN / Review`, the step rail `1 Review`, the **decided row above** the review gate card, and the gate still open on the same artifact and the same revision, with `Comment` · `Reject` · `Approve`. Nothing pressable in the row (**0/0/0**). |
| `S4__recommendation-card__page_gate_region__decided__dark` | 2880×3400 | The same page framing, dark palette. |

Every cell was **reloaded before it was photographed**, so each picture is the
durable state of that conversation — what the next reader sees — rather than a
component that happened to be in the right state.

## How the review reaches the conversation, stated

The plan states the shipped rule (§4.1 *“Where it appears today”*): the run draws
the review card inline **only for a review it reached through its own
execution**, because the card's reference travels with the run's own review
interrupt. This review was opened by the **sweeper** after the run had already
finished, so it carries no such reference and the run panel says *“Run complete”*
instead — **measured on this lane, not assumed**: a first pass of this round shot
`S3` without asking and photographed a conversation with no review card in it,
and that cell was discarded.

The plan names the affordance that does bring it in, in the same section (§4.1
step 1): *“You can also ask the assistant ('anything waiting on me?'), and it
pulls up the longest-waiting open reviews you are allowed to see, as cards”*. So
the person asks — a real second turn, typed into the same composer, in the same
conversation, under the decided row. The tool layer on that turn is **real**: the
provider decides only WHICH primitive to call, the dispatcher carries this
session's own chat bearer, and the `serverLabel` that lets a card mint rides only
what the dispatcher actually returned — so a card on screen can only have been
minted by the producer.

## The runtime, and what is NOT stood in for

`node scripts/dev-server.mjs`, `CINATRA_RUNTIME_MODE=development`,
`NODE_ENV != production`, `CINATRA_E2E_SETUP_BYPASS=true`, on a **dedicated lane
database** on the verify Postgres (5634) and the verify Redis (6579),
loopback-only, with the WayFlow runtime brought up from this repository's own
compose file. **There is no model credential on this host and none in this
directory**: `CINATRA_TEST_LLM_PROVIDER=scripted` serves the agent's own model
call through `POST /api/llm-bridge` (cinatra#2917), which is why the artifact the
run produced is titled with that provider's own sentinel — `CINATRA_UAT_OK:
scripted title`. That sentinel is not a blemish on the evidence; it is the
evidence that the output came from the step's own model call rather than from
anything staged.

Nothing about the card, the hold, the decision, the release, the dispatch, the
materialization, the sweeper or either review surface is stood in for. Every
press is a real press on the shipped control.

## Two findings this round produced, and three lane repairs

**Finding 1 — the scripted provider cannot serve a chat-started run end to end.**
`runAssistantTurn` resolves a bound provider adapter *before* it reaches the hard
pre-router, so a chat turn cannot start an agent run on an instance with no
provider configured — **even though that turn consults no model at all** (the
pre-router dispatches server-side and returns before `stream()`). Measured: with
no connection the turn answers *“The configured default LLM provider "openai" is
not available …”* and no run is created. But `resolveConfiguredLlmRuntime()`
reaches the scripted runtime only as its LAST RESORT — *“an install WITH a
configured provider never reaches this line”* — so the presence placeholder the
chat turn needs is exactly what makes the agent's own model call go to the real
OpenAI endpoint and answer **401**. Measured on this lane before the window
below existed.

*How this round handled it, in the open.* The lane holds a provider **presence
placeholder** — a published non-key, `sk-not-a-real-key-s9f-chat-sequence`,
written through the shipped sealing writer — only until the run has parked, and
the driver then removes it through the shipped `clearOpenAIConnection` at
`10:25:23`, before any model call exists. It is **timeline row 3**, not a quiet
edit. Nothing photographed before that point depended on it and nothing after it
did.

**Finding 2 — the scripted bridge cannot answer an artifact-producing agent that
asks for its JSON in prose.** `runScriptedBridgeCompletion` answers *in the
declared type shape* when the request carries an `output_schema`, and answers the
plain sentinel when it does not. **No agent in the extension tree sends one**:
all three artifact producers ask for their JSON object in the system prompt
instead, so the bridge's reply is not parseable and materialization fails with
*“titleFrom output "title" did not resolve to a non-empty string”*. Measured on
this lane.

*The lane repair, stated.* This lane's copy of
`extensions/cinatra-ai/blog-draft-writer-agent/cinatra/oas.json` gained an
`output_schema` on its `/api/llm-bridge` node, **derived mechanically from that
node's own already-declared `outputs`** (`title`, `excerpt`, `content`,
`sourcesUsed`, `notes`) — nothing invented, nothing renamed. It is lane data in a
gitignored extension checkout, it is **not** part of this branch's diff, and it
changes what the model is asked to return, never the card, the hold, the sweeper,
the review card or the order any of them happen in. The loader's publish marker
was re-derived for the edited file, which is the loader's own integrity check
working as designed.

**Three lane repairs, all consequences of driving a cloned lane database rather
than a freshly installed instance:**

1. **The `instance_identity` metadata row did not travel with the clone.**
   Provisioned the way the product provisions it — the shipped `/setup/name`
   wizard step, filled and submitted in a browser
   (`drivers/02-provision-instance-identity.mjs`). Nothing written into
   `cinatra.metadata` by hand.
2. **The lane registry was empty.** The binding loader reads the run package's
   artifact bindings from the registry, so this lane brought up the compose
   file's own Verdaccio and published the branch's own
   `@cinatra-ai/blog-draft-writer-agent@0.1.2` plus the three artifact extensions
   it binds into it. Measured: without them the run failed at
   `404 … no such package available`.
3. **Skill assignments are keyed by the agent's PACKAGE NAME**, not its template
   id, and by the **catalog** skill id (`@cinatra-ai/<pkg>:<slug>`), not the
   installed-package id. A first pass assigned four skills under the template
   UUID, `getAssignedSkillIdsForAgent` resolved none, and the run dispatched
   **unheld** — a green walk proving the opposite of what it claims. The
   assignment step now reports what it wrote AND what the shipped reader resolves
   back, so that failure cannot recur silently.

## The column that is still not trusted, and one stale quote re-pinned

`agent_runs.created_at` reads byte-identical to `completed_at` on this run — the
defect reported as issue 2911. Its fix is on `main` and is **not** in this
branch, so the run's creation is still anchored on
`lifecycle_continuation_park.created_at`.

`PLAN-WALK.md` carried two quotes (on `W1` and `W2`) that were verbatim when they
were written and are no longer: the plan page was republished and now reads
*“Recommendation and schedule decisions … the schedule card's actions have no UI
caller anywhere”* where it used to read *“Recommendation and schedule-proposal
decisions … the proposal actions have no UI caller anywhere”*. Both quotes are
re-pinned to the page's current words; the sentence makes the same claim and the
two cells' grading is unchanged. **All 73 `PLAN>` lines across all 21 cells are
now verbatim substrings of the plan page again.**

## Honest notes on what the pictures show

- The **run panel's own `Skills (4)` list** in `S2` still names the skipped
  `brand-voice-matcher`: that list is the run panel's, not the recommendation
  row's, and this branch does not touch it. Disclosed rather than cropped.
- The review target inside both review surfaces renders the **generic read-only
  view** (*“No type renderer resolved for this artifact”*) because this lane has
  no semantic renderer bound for that artifact type. Pre-existing, outside S9f.
- On the **dark** `S4` the target island renders light inside the dark page — a
  separate iframe document the theme class does not reach. A pre-existing island
  theme gap, outside S9f, and not what these cells are graded on.

---

# The REWORK round — cinatra#2890 (2026-08-23)

## What was asked for, and what is here

> the skills question and the decided skills, each in the chat AND on the run
> page, on one real run

**Eight pictures, four states, one run.** The recommendation is photographed HELD
in the conversation and HELD on the run page while the hold is still parked and
the run has produced nothing; then every chip is decided IN THE CHAT through the
card's own per-chip controls; then the settled row is photographed in the
conversation and on the run page. Light and dark for each. Every cell is the
FULL BROWSER WINDOW at 1440x1700 CSS px, deviceScaleFactor 2 — this lane's
committed walk contract — with no crop rectangle and no `fullPage` stitch.

| Cell | Surface | State | Palette |
|---|---|---|---|
| `S1__recommendation-card__chat_thread__held` | the conversation | held | light |
| `S1__recommendation-card__chat_thread__held__dark` | the conversation | held | dark |
| `R5__recommendation-card__run_card__held` | the run page | held | light |
| `R5__recommendation-card__run_card__held__dark` | the run page | held | dark |
| `S2__recommendation-card__chat_thread__decided` | the conversation | decided | light |
| `S2__recommendation-card__chat_thread__decided__dark` | the conversation | decided | dark |
| `R6__recommendation-card__run_card__decided` | the run page | decided | light |
| `R6__recommendation-card__run_card__decided__dark` | the run page | decided | dark |

The run-page pair is numbered R5/R6 rather than R1/R2 because R1–R4 in this lane
are already the REVIEW-PAGE cells; the host token in each name (`run_card`) says
which surface it is.

**Read `PLAN-WALK.md` beside this file for the grading.** Every cell carries the
plan sentences that govern it, the drawing it is graded against, and a
`DRAWING-CHECK>` written by looking at the picture. **All eight PASS.** Two of
them — the `R6` pair — were first filed as FAILs on the settled rail entry, and
have since been RE-SHOT on the commit that fixes it, on their own real run; see
*The `R6` re-shoot* below. **Read `RUN-READBACK.md`** for who created
the run, who decided it, what model was configured, and what the run did and did
not produce, every value read out of the database.

## The withdrawn pair is replaced

The four chat cells this lane first shot were withdrawn: they showed an agentic
run progress card in the turn while the recommended skills could still be
chosen, and a skills button row inside the run card after they were decided.
Both readings are ruled out by the plan and both are fixed in the code this
branch carries. `S1` now records `[data-inline-run-card]` at **0** on the held
turn, and `S2` records `[data-hitl-skill-picker]` at **0** inside the run card
on the decided one — the absences are measured, not asserted.

## The `R6` re-shoot, and the one shortfall that stands

**`R6` was first filed as a FAIL, and it is now re-shot as a PASS.** The plan puts
the row *"at the trigger position, the top entry on the step rail"*, and the
ratified run-surface drawing says a resolved gate keeps it: *"A resolved gate stays
on the rail as read-only history — its entry keeps its place and records how it was
settled."* The withdrawn `R6` pair did not draw it: once the run left
`pending_input` the screen stopped contributing the step at all — it added one only
where the SCREEN hosts the card, and from that moment the run panel inside the run
detail hosts it instead — so the `Recommendation` row vanished and `RunSurfaceRail`
was not rendered with it.

`64c0b1412` separates the two questions the one gate was answering:
`recommendationRailEntry` decides whether the entry EXISTS and how it READS, while
the screen's own host gate keeps deciding only what SURFACE the step opens (a
settled entry opens none — the decided summary it stands for is already inside the
run panel). **`R6` is re-shot on that code, on its own real run**
(`drivers/11-r6-settled-rail-sequence.mjs`), and nothing else is re-shot: `S1`,
`S2` and `R5` are the cells recorded before, unchanged, with their records
untouched.

What the new pair measures, in both palettes: the rail's ordered rows read
`Recommendation`, `Step 1` — the settled gate entry FIRST, ahead of the run's own
work step; its circle carries a check glyph and no numeral, and the row is
`data-recommendation-step-settled="true"`, `data-recommendation-step-selected="false"`,
so the title is drawn unhighlighted; both of `RunSurfaceRail`'s instrumented
columns are present (they read absent on the withdrawn pair); the settled chips are
in the run detail with nothing inside the card that can be pressed (all three
per-chip action counts read 0 inside the card root). `PLAN-WALK.md` grades every
clause of that from the pixels.

**One shortfall stands, stated rather than glossed.** In `R5` the rail carries only
the gate row: the page's own rail is suppressed while the run has no step entries
yet, so "ahead of the steps it would authorize" is shown there as a position
without the steps it precedes. `R6` is where that reading completes — on the
decided page the rail reads `Recommendation`, `Step 1`, and the gate entry is
visibly ahead of the work step.

## What served the model, and what this environment cannot do

**The chat turn answers on the DETERMINISTIC BRIDGE.** The typed turn carries
embedded `inputParams`, which takes the hard pre-router's brace-matched fast path
and dispatches server-side without consulting a model at all. A real-model chat
turn needs a publicly reachable MCP ingress, which this environment does not
allow. The HOLD, the chips, the decision and the run are the server's own shipped
path; only the routing of that one sentence is deterministic.

**The run was created with a REAL model provider configured** — a sealed
`openai_connection` row written through the shipped `writeOpenAIConnection`
inside the operator's secret-manager `run` wrapper, `defaultModel` `gpt-5.5`.
**Its step could not COMPLETE on that provider here, and this round measured
why**: the bridge loads this instance's cinatra toolbox into the provider call,
the provider fetches that toolbox from this instance's PUBLIC MCP URL, and this
machine has none. The run before the pictured one died exactly there —
`POST /api/llm-bridge 500`, *"could not reach this instance's public MCP server …
HTTP 424 Failed Dependency"*, read out of the WayFlow runtime's own container log
into `logs/rework-bridge-readback.txt`. So the connection was removed mid-
sequence, in the open and on the clock (`TIMELINE.md` row 4), at the one moment
it was in the way of nothing already photographed, and the scripted runtime
served that one call. The step then ran and the flow reached `completed` inside
the runtime.

**No credential and nothing derived from one is in this directory.** The key
reached exactly one process, through its environment, inside the wrapper; that
step reports presence and the published model name and nothing else.

## What the pictured run did NOT do

It ended `failed`, at artifact materialization, AFTER the flow completed:
`titleFrom output "title" did not resolve to a non-empty string` for
`@cinatra-ai/blog-post-artifact`. That is downstream of every state the eight
cells show and it is a LANE fact — the scripted model's canned completion carries
no `title` for the binding to read. It is visible in `R6` itself rather than
hidden, and `RUN-READBACK.md` reads the row out of the database. The output-and-
review half of this lane's evidence is the earlier `S3`/`S4` set, which is
unchanged.

## How it was run

`node scripts/dev-server.mjs` (Next.js, Turbopack), `CINATRA_RUNTIME_MODE=development`,
on a dedicated lane database and Redis, with the WayFlow runtime up from the
repository's own compose profile and a lane-local package registry. The lane tree
is an APFS clone of the repository at this branch's head, with the dev extensions
synced PINNED to the committed lock shas (112/112) before boot. The drivers are
`drivers/08-real-provider.test.ts` (the sealed provider row) and
`drivers/09-chat-and-run-page-sequence.mjs` (the whole sequence). It is the dev
build, not a production-equivalent one, as every earlier round in this lane was.

**The `R6` re-shoot ran the same way, on a rebuilt lane of the same shape** — the
rework round's lane database no longer existed — with `drivers/10-r6-lane-setup.mjs`
(the lane's own owner, in the platform's one organization),
`drivers/08-real-provider.test.ts` again for the sealed provider row, and
`drivers/11-r6-settled-rail-sequence.mjs` for the sequence. Two lane facts that
changed a RESULT rather than only a setting are stated in `RUN-READBACK.md`: the
skill assignment is keyed by the agent's PACKAGE NAME (keyed by template id it
reads back for that id and the recommendation seam still finds no candidates, so
the run dispatches unheld), and `CINATRA_TEST_LLM_PROVIDER=scripted` is set,
without which an install with no configured provider never reaches the scripted
runtime at all (`503 NO_LLM_PROVIDER`, measured here).

## Three corrections made to this round's own artifacts, before it was filed

> These three are the HISTORY of the withdrawn `R6` pair, kept because a record
> that quietly loses its own corrections is worse than one that carries them.
> Points 1 and 2 describe records that no longer stand: the `R6` pair has since
> been re-shot on `64c0b1412` and its records replaced (see *The `R6` re-shoot*
> above, and the R6 section of `RUN-READBACK.md` / `TIMELINE.md`).

A convergence review read the records against the prose and caught three places
where this round's own writing outran its own measurements. All three are fixed
here rather than argued away, and each is named so a reader can check it.

1. **The two `R6` records asserted the settled rail entry they measure as
   absent.** The driver wrote that `note` before the shutter; the same record
   reads `railStepPresent: false`. Both notes now say what was measured, and each
   carries a `noteCorrection` field saying so. Nothing measured was touched — the
   screenshots, their digests and every assertion count are exactly as recorded —
   and the driver's own note text is fixed so a re-run writes the corrected
   wording.
2. **The frame claim was wrong.** An earlier draft said `R6` drew no two-column
   frame ("run-surface children 1"). The record says `surfacePresent: true`,
   `surfaceChildren: 2`. What is absent is the GATE frame's own instrumented
   columns; the screen's two columns are still there. Corrected in `PLAN-WALK.md`
   and above.
3. **The ordering claim was wrong.** An earlier draft said both decided pictures
   follow the step. `S2` was shot at `23:39:46`, before the step completed at
   `23:39:49`; only `R6` follows it. Corrected in `TIMELINE.md`, which now says
   which picture is on which side of the step.

Two smaller ones came out of the same review and are fixed with them: the raw
`psql` readback every microsecond timestamp is quoted from is now committed
(`logs/rework-db-readback.txt`), and `TIMELINE.md` no longer claims that *every*
one of its timestamps is a database column — the capture, press and runtime times
are process and runtime clocks, and each row now names which it is.

The `T3` row in `timeline-rework.json` and its line in `logs/rework-sequence.txt`
were written by the driver as "the step executed against the real model". That is
wrong — the provider had been removed one row earlier and the scripted runtime
served the call. The recorded artifacts are left VERBATIM rather than rewritten,
because they are the driver's own output; the correction rides beside them (a
`whatCorrection` field on the row, a marked footer on the log), and the driver's
label is fixed for any re-run.

---

# The re-shoot that removes both stood-in legs — cinatra#2790 (S9f), PR #2890, 2026-08-24

## What changed, and why it is the chain rather than the pictures

The eight cells `S1` / `S2` / `R5` / `R6` (light and dark each) are **re-shot**.
Their previous records were measured honestly, but the CHAIN that produced the
states they measure had two legs that never reached a model:

1. **The chat turn took the deterministic pre-router.** The turn named the agent
   package and carried embedded `inputParams`, so `detectExplicitDispatchPackage`
   matched, the server dispatched the run itself, and the reply in the picture was
   the platform's own synthesized dispatch line.
2. **The agent's own step was served by the scripted runtime.** The real sealed
   provider row was REMOVED mid-sequence, because this instance had no public MCP
   ingress and the provider's toolbox fetch answered `424 Failed Dependency`.

This round performs NEITHER OF THOSE TWO ACTIONS — a statement about what the
driver does, not about which runtime answered — and
`drivers/12-real-chain-sequence.mjs` is written so that what stands in each place
is checkable rather than promised, including what it does NOT settle:

- **The turn names no package token**, in either form the pre-router reads.
  `detectExplicitDispatchPackage` needs BOTH a verb and a package reference, so it
  returns null, the hard short-circuit cannot fire and the soft directive is never
  prepended, and its counters read 0. That the run was therefore started by a MODEL
  calling `agent_run` is an ARCHITECTURAL INFERENCE from that absence plus the run's
  own chat-launch carrier — not a measurement: no committed field records who
  invoked the tool, and the `/api/mcp` counter is expressly unattributed.
- **No step of this sequence clears the sealed `openai_connection` row, and it is
  read on BOTH sides of the step** — timeline rows `T1c` (before) and `T3a` (after
  the step's own model call). The earlier round removed it at `T1c`'s position;
  this one reads it there. Two point reads are what is claimed; they bracket the
  call rather than proving continuity.
- **For the AGENT'S STEP the code's own ordering is the strongest thing on offer,
  and it is an argument rather than a proof.** `resolveConfiguredLlmRuntime` — the resolver `/api/llm-bridge` takes,
  which is the seam the agent-run model call goes through — reaches the scripted
  runtime only as a LAST RESORT, *"after every real candidate failed to resolve"*,
  and its own comment states that an install WITH a configured provider never
  reaches that line. `T1c` and `T3a` read a real sealed provider back on both
  sides of the step. That is a STRONG ARGUMENT for the step and it does not depend
  on any environment read — but it is not a closed proof: those rows read the
  sealed ROW through `readOpenAIConnection` in a separate process, not
  `resolveProviderAdapter` at the instant of the call.
- **For the CHAT TURN the ordering is the other way round, and this page says so.**
  `orchestrateStreamImpl` checks the flag FIRST and returns the scripted stream
  before any provider is resolved. What the records carry for that leg is an
  ENVIRONMENT READ — `serverScriptedProviderEnv: null`, with `serverEnvReadFrom`,
  the pid read, `serverEnvHopsFromListener: 1` and `serverEnvTokensSeen: 63`. It is
  an ANCESTOR read: the Next server rewrites its argv, so the listening process
  prints no environment and the read walks one hop up. A non-null answer would be
  proof of presence and aborts the sequence; a null answer at one hop up is
  CONSISTENT with absence and is not a proof of it, because a child can be given a
  variable its parent never had. The lane started the server with the variable
  explicitly unset and every shutter agrees with that; the residual is named
  rather than closed. The driver additionally refuses to start if its OWN
  environment carries the flag — the weaker half, labelled
  `driverScriptedProviderEnv` so the two are never conflated.
- **The public origin was set through the app's OWN tunnel surface**
  (`/configuration/development?tab=tunnel`, `publicBaseUrlSource: "manual"`), the
  app was restarted so the OAuth audience allowlist follows it, and the driver
  proves the ingress answers inside the app's own 2500 ms reachability budget
  BEFORE any pictured turn (`HEAD /api/mcp` → `405` in 332 ms).

## What the counters are, and what they are not

Each record carries a `providerEvidence` block taken at the instant of its
shutter. Most of its fields are counts from the app server's own log; one field is
a separate read of the server's PROCESS CHAIN, at the nearest ancestor of the
listening process with a readable environment. Five counters are NEGATIVE SCREENS —
`preRouterShortCircuits`, `preRouterAttempts`, `scriptedRuntimeLines`,
`noProviderRefusals`, `mcpDependencyFailures` — and all five are zero on all eight
cells. A screen is worth what a screen is worth: a hit proves a problem, a zero is
the absence of that particular line. Two of them are deliberately broad, which is
the safe direction for something whose only power is to stop the shoot.

`publicMcpCallbacks` is the POSITIVE one: `POST /api/mcp` hits. The raw count is
cumulative over the whole lane session, so what carries anything is
`deltaSinceStart`, which rises **0 → 3 → 5** across the eight cells while
`bridgeRunSelects` rises **0 → 1**. The driver ABORTS a shutter if that delta has
not moved, and aborts if any screen has. Its LIMIT is stated as well: the request
log does not record which caller made the POST, and this branch's scripted
self-MCP path also posts to `/api/mcp` on the LOCAL url — so a moving delta shows
the instance's own MCP surface was exercised during the sequence, not, on its own,
who exercised it.

## And this time the run finished

`agent_runs.status = completed`, `error` empty, one `representation` (a 6232-byte
`text/markdown` blob), one processed `artifact_produced_outbox` event and one
`artifact_review_gates` row. `RUN-READBACK.md` reads all of it out of the database
and states, claim by claim, which field supports it and what that field does not
say. `TIMELINE.md` says which clock each row is on.

## The one thing this round could not drive, stated plainly

Several sequences before the recorded one ended at `pending_trigger`. When the
model hands `agent_run` no `inputParams`, the run parks on the agent's own setup
field and then on its trigger — and **neither surface on this branch draws a
control for that trigger state**, so the run never executes and `R6` has nothing
decided-and-run to photograph. `approveReviewTask` reports it honestly (*"Setup
approval rejected: run … is not pending_approval (current status:
pending_trigger)"*). The driver now fails LOUD on that state instead of
photographing a run that did not run, and the person's turn states the idea it
wants the agent to work from, which is what removes the stall. That is a property
of a real chain rather than a defect of this branch, and it is on the record.

## What is committed here that a reader may want to re-derive

The lane's own account and organization UUIDs appear in `RUN-READBACK.md` and in
`logs/realchain-sequence-state.json`, because "created by the lane's own signed-in
person" is only checkable if the row it was read from is named. They are the
identifiers of a throwaway lane database that is dropped when the lane is torn
down; no credential, no key and no private hostname is committed anywhere in this
directory, and the lane's public origin and the app server's log path appear as
placeholders because the recorder replaces them at the moment it writes.

## How it was run

`node scripts/dev-server.mjs` (Next.js, Turbopack), `CINATRA_RUNTIME_MODE=development`,
on a dedicated lane database and Redis, with the WayFlow runtime and a lane-local
package registry up from the repository's own compose profile, the dev extensions
synced pinned, and the branch's `@cinatra-ai/blog-draft-writer-agent@0.1.2` plus
`@cinatra-ai/blog-post-artifact@0.1.4` published into the lane registry. Drivers:
`drivers/10-r6-lane-setup.mjs` (the lane's own owner in the platform's one
organization), `drivers/02-provision-instance-identity.mjs` (the shipped
`/setup/name` step), `drivers/06-chat-lane-fixture.config.ts` with
`WALK_STEP=ASSIGN` (the four skill assignments, keyed by the agent's PACKAGE NAME
and read back through the shipped reader), `drivers/08-real-provider.test.ts` (the
sealed provider row, written inside the operator's secret-manager wrapper — the
credential never touches this repository), and `drivers/12-real-chain-sequence.mjs`
for the sequence itself.
