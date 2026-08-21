# cinatra#2790 (S9f) — the skills-recommendation card on its two new hosts

Head under proof: `291bfee0fea914008d8b75036f527fe4d5378ebc` (PR #2890), plus
this evidence commit.

## The headline, first

**The widget mount works and is photographed.** The card draws **held** inside
the embedded cross-site widget column — light and dark, one chip per skill, each
chip carrying its own Confirm / Adjust / Skip — a decision was driven from inside
the frame through the card's own broker `/decide` route, and the **settled** row
is photographed on the same host.

The previous round could not deliver those cells. It measured why, photographed
the failure and named the one-line cause: the two routes this branch adds were
missing from the app's cookieless-reachable path list, so every broker POST from
the widget was **307**'d to `/sign-in` before the route handler ran. **That defect
was found, fixed at `291bfee0f`, and every widget cell below was shot at the fixed
head.** The diagnostic that documented it is deleted, because it no longer
describes this branch. The fix's own pinned rows are in
`src/lib/__tests__/auth-route-guard-public-paths.test.ts`; measured live in this
lane, all four lifecycle routes now answer their handler's own **401** cookieless
rather than a 307.

**The review-page mount** was proven in the previous round and is unchanged here
(`R1` / `R2` / `R3`).

**One further defect was found in this round, and it is NOT fixed here.** A
decision taken in the widget is **recorded** — the selection rows are written and
the hold is released — and is then **reported to the reader as `unauthorized`**,
because the post-decision dispatch is cookie-bound. The run therefore never
starts. It is measured, photographed as a diagnostic, and set out in
[“The decision lands and the dispatch is refused”](#the-decision-lands-and-the-dispatch-is-refused).

## The runtime, said first

`node scripts/dev-server.mjs` (Next.js 16.2.10, Turbopack),
`CINATRA_RUNTIME_MODE=development`, `NODE_ENV != production`,
`CINATRA_TEST_LLM_PROVIDER=scripted`, on a **dedicated lane database** on the
verify Postgres (5634) and the verify Redis (6579), loopback-only, with the
branch's own extension tree (114 packages) and a raised
`CINATRA_BOOT_READY_TIMEOUT_MS`. **Placeholder-only environment: no model
credential of any kind exists on this host**, and none is used. The lane tree is
an APFS clone of the repository pinned to the head above, with per-package
installs carried across and its one absolute symlink rewritten worktree-local.

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
3. `pending_input`, human-present runs on that template, each parked through
   **`maybeHoldRunForRecommendation`** — the one seam the interactive run trigger
   uses. Each answered `{held: true, reason: "core default fires
   recommendation"}` and left a `lifecycle_continuation_park` row with
   `checkpoint=recommendation`, `status=parked` (step `HOLD`).
4. The widget instance and its connect-site through the two SHIPPED writers the
   CMS OAuth exchange itself calls — `writeConnectorConfigToDatabase` and
   `upsertConnectSiteAndMintCredential` — and `deriveFrameBinding` asserted to
   close before anything was driven (step `WIDGET`, `{"ok":true}`).
5. Everything on screen after that is the shipped path: the frame's own hosted
   PKCE sign-in, the turn typed into the widget's own composer, the broker read,
   the per-chip presses and the broker decision. The chip labels are the owning
   extension's manifest `cinatra.displayName`, resolved server-side by the
   scorer; nothing is re-derived in the recorder.

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
   session's active one. The cloned fixture's single organization was therefore
   renamed to `Default` / `default` BEFORE boot, so the row the bootstrap
   resolves and the row the lane's data lives in are the same row. The lane
   setup driver then created a second organization of its own (its `list` call
   runs before that adoption); it was removed, together with its one membership
   row, and the template repointed at the remaining organization. **Exactly one
   organization exists in this database.** The shipped delete route refuses
   (`ORGANIZATION_DELETION_DISABLED`), so that removal is lane data written
   directly — it changes who may open the run, never what the card draws.
2. **`agent_templates.org_id`** repointed to this lane's organization, the same
   repair `evidence/2841-v-redraw` recorded.
3. **The cloned database's `public.jwks` row** was encrypted under the source
   lane's `BETTER_AUTH_SECRET` and could not be decrypted under this lane's, so
   the hosted widget sign-in would return 500. The row was deleted and Better
   Auth minted a fresh key — the remedy the error itself names.

## The blocker the previous round measured, and its fix

The previous round recorded five cookieless broker POSTs, each answered **307**
to `/sign-in`, and named the cause: `src/lib/auth-route-guard.ts` carries an
**exact-path** list of routes reachable without a session cookie, and the two
routes this branch adds were not on it, so `guardAppRoute` redirected them before
the handler ran. `fetch` follows a 307 with method and body intact, `/sign-in`
serves GET only and refuses the POST, the transport bails on the non-OK answer,
and the card drew nothing at all.

`291bfee0f` adds both paths, each with its own entry, and adds nine pinned rows
to the guard's suite. **Measured live in this lane, cookieless:**

```
POST /api/lifecycle-views/recommendation-hold          -> 401
POST /api/lifecycle-views/recommendation-hold/decide   -> 401
POST /api/lifecycle-views/resolve                      -> 401
POST /api/lifecycle-views/decide                       -> 401
```

All four now reach their own handler and refuse properly. Nothing on this branch
307s to a sign-in page any more.

**The wire, this round** (`logs/widget-wire.json`; presence/absence only, never a
value). Five broker calls, every one `cookie: absent`,
`x-cinatra-widget-user-token: present (cwu_)`, widget origin and assistant
headers present:

| Route | Calls | Status |
|---|---|---|
| `POST /api/lifecycle-views/recommendation-hold` | 4 | **200** |
| `POST /api/lifecycle-views/recommendation-hold/decide` | 1 | **200** |

## The decision lands and the dispatch is refused

**What was driven.** Four chips, in a real browser, inside the cross-site frame:
Confirm, Adjust → *“Keep it in this run”*, Skip, Confirm. The shipped row
releases once every chip carries a mark, and that release went out as the single
broker `/decide` POST above.

**What the core recorded** — read back from the lane database, not from the
screen:

| Row | Value |
|---|---|
| `lifecycle_continuation_park` | `checkpoint=recommendation`, `status=` **`released`** |
| `run_selected_skill_revisions` | `blog-post-matcher` → `recommended_confirmed` |
| | `blog-writing` → `user_adjusted` |
| | `web-research` → `recommended_confirmed` |
| `run_rejected_recommendations` | `brand-voice-matcher` → `recommended_not_kept` |
| `agent_runs.status` | **`pending_input`** — never dispatched |

So the decision travelled end to end through the broker: the widget's own
credential, no cookie, the execute-tier selection write, the verified release.

**What the reader was told.** The route answered **200**, and the outcome inside
it was `{ok: false, error: "unauthorized"}` (`decideOutcomes` in
`capture-results.json`). The row therefore did not settle where it was decided:
it kept `data-lifecycle-card-state="held"`, every chip kept its mark and its three
affordances, and a red **`unauthorized`** line was drawn beneath the row —
photographed as `captures/DIAG__site-widget-column__decide-dispatch-refused.png`.

**Why.** `releaseAndDispatch` (`packages/agents/src/run-recommendation-core.ts`)
performs the selection write, the verified release and the resume announcement,
and then calls the dispatcher the entry handed it. The broker decide route hands
it `triggerAgentRun`, whose first act is
`requireAuthSession()` — the **ambient cookie session**. The widget branch is
cookieless by construction, so there is no session to resolve, `triggerAgentRun`
returns `{ok: false, error: "unauthorized"}`, and `releaseAndDispatch` returns
that as the whole decision's outcome. The card believes the decision failed, so
it never fires its `onDecided` re-read: no resolve call follows the decide on the
wire, which is how this was told apart from a rendering problem.

**This is a named class, made certain.** Plan §6.4 item 7 already says a
Confirm/Skip *“can also record its decision and then fail on the dispatch that
follows — the red line is not proof that nothing happened.”* On a cookie host that
is an occasional race. On the widget it is **structural and total**: every widget
decision releases its hold, chooses its skills, tells the person it was
unauthorized, and leaves the run parked forever at `pending_input`.

**Not fixed here, deliberately.** The fix belongs where the guard fix went — in a
slice with its own review — because it means giving the broker route a dispatcher
that is authorized the way the rest of that route is (from the presented `cwu_`),
which is a new authorization path, not an evidence change.

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
| `W3__recommendation-card__site_widget__settled__column` | 1244×2364 | The **settled** row in the same embedded column, composer in frame: `Blog Post Matcher Skill ✓ CONFIRMED`, `Blog Writing Skill ADJUSTED`, `Brand Voice Matcher Skill ✗ SKIPPED`, `Web Research Skill ✓ CONFIRMED`. Nothing left to press. |
| `H4__recommendation-card__site_widget__settled` | 1176×122 | The same settled row on its own root. |

**How the settled cells were obtained, stated plainly.** The row does not settle
in place, for the dispatch reason above. The decision is nevertheless durable, so
the settled reading was taken by **re-reading** it: a fresh load of the same
third-party page, the frame's own hosted sign-in run again (the frame comes back
anonymous — the host page holds no credential), a fresh turn naming the **same**
run, and the same broker read that drew the held row. Nothing was re-seeded and
nothing was re-decided. The two resolve calls behind those cells are the last two
rows of the wire table above.

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
`data-can-decide="true"` on the five held cells.

## Cells DELIVERED — the review page (previous round, unchanged)

| Cell | Pixels | What is VISIBLY on screen |
|---|---|---|
| `R1__recommendation-card__page_gate_region__held` | 2096×136 | The held card on the run review page: four chips, each the owning extension's manifest `displayName`, each with its own `Confirm` `Adjust` `Skip`. |
| `R2__recommendation-card__page_gate_region__held__above-gate` | 2880×3540 | The same card **in its page**, uncropped: `AGENT RUN / Review`, the chip row at the top of the gate region, and **beneath it** the review gate card. |
| `R3__recommendation-card__page_gate_region__held__dark` | 2096×136 | The same card, same run, same clip rectangle, in `dark`. |

`R1` and `R3` share one clip rectangle — `{x:376, y:191, w:1048, h:68}` CSS px —
because shooting the locator twice gave widths differing by 2 CSS px. The order is
measured, not eyeballed: `{cardTop: 191, gateTop: 275, cardAboveGate: true,
domOrder: "card-then-gate"}`.

## The grading

Against design §V (the ratified redraw the card renders, quoted verbatim in
`packages/agents/src/run-recommendation-chip-row.tsx`) and against the plan's
§6.1 / §6.3 / §6.4 / §9 / §10.10 host language.

| # | What is claimed | Requires | Shows | Verdict |
|---|---|---|---|---|
| 1 | §V *“one chip per skill, each carrying its own Confirm, Adjust and Skip”* | ≥1 chip, each with its own three affordances | `W1`/`H1`/`W2`/`H2`: 4 chips × 3 = 12 buttons, per chip | **PASS** |
| 2 | §V *“The row is the whole card … no heading plate above it and no row-level submit beneath it”* | no heading, no card-level submit inside the root | `H1`/`H2`: the root is the row; nothing above or below it | **PASS** |
| 3 | §V settled chips name the skill, not an id | manifest `displayName` on every chip | the four names, held and settled | **PASS** |
| 4 | Plan §6.3 item 3 / §10.10 — *“the card is withheld from the widget”* is closed | the card drawn on `site_widget`, resolved through the broker | `[data-lifecycle-card-host="site_widget"]`=1 and card root=1 on all seven cells; 4 broker reads, `cookie: absent`, 200 | **PASS** |
| 5 | Plan §6.4 — the card appears *“in the widget”*, in the reply, in the conversation the reader was already in | the card in the real transcript column with the composer | `W1`/`W2`: turn, reply, card, composer, one `.cw-frame` | **PASS** |
| 6 | §V — a chip is settled by pressing one of **its own** affordances, never the row as a unit | one chip decided, the rest still pressable | `H3`: chip 0 confirmed, chips 1–3 undecided with 3 affordances each | **PASS** |
| 7 | S9f — a decision is **carried by the widget's own credential** to the `/decide` route | a cookieless decide POST that reaches the handler and is accepted | 1 × `/decide`, `cookie: absent`, `cwu_` present, **200**; park `released`; 3 selected + 1 rejected rows written | **PASS** |
| 8 | §V — the **settled** row states each skill's own outcome with nothing to press | a decided reading on this host | `W3`/`H4`: state `decided`, 4 marked chips, **0/0/0** affordances | **PASS** |
| 9 | Both palettes resolve | the same card in light and dark, both framings | `W1`/`W2` and `H1`/`H2` | **PASS** |
| 10 | Plan §6.4 — *“the card settles in place showing what you chose, and the run card underneath advances”* | the row settling **where it was decided**, and the run advancing | the row stays `held` and draws `unauthorized`; `agent_runs.status` stays `pending_input` | **FAIL — the dispatch defect above; the settled reading is reachable only by re-reading** |
| 11 | Plan §6.3 item 4 — *“No mount on the review page”* is closed | the card present on the review route under `page_gate_region` | `R1`–`R3`: host=2 (card + gate), card root=1 | **PASS** |
| 12 | Plan §6.4 — *“the same row appears … on the review page”*, **above** the gate | the card ABOVE the review gate card | `cardAboveGate: true`, `domOrder: card-then-gate`, visible in `R2` | **PASS** |
| 13 | Plan §9 — review page *“mostly seen in its decided form”* | a decided reading on the review page | **not shot** — the review-page run is genuinely held | **NOT DELIVERED** |

## Cells NOT delivered

| Cell | Why |
|---|---|
| the row settling **in place** on the widget after its own decision | **Blocked by the branch**, not by this lane: the decision is recorded and the dispatch is refused `unauthorized`, so the card never learns it succeeded. Measured, photographed as a diagnostic and diagnosed above. The settled reading itself IS delivered (`W3`, `H4`), by re-reading. |
| a **decided** reading on the review page (plan §9's “mostly seen”) | Would need the hold decided first. Deciding it on the review page is possible — that host is a cookie surface and works — but it would consume the only held run on that host, and the cell asked for there is the **held** one. Named rather than implied. |
| the card in the **chat** conversation | Not on this branch. It depends on the conversation-origin hold S9b (#2786) builds, exactly as the PR body says. |

## Also visible, and pre-existing

Every column cell shows a grey panel reading *“Could not load agent run
f18f63df — please try again.”* That is the inline run panel
(`packages/chat/src/inline-agent-run-card.tsx`), which seeds itself with a plain
`GET /api/agents/runs/<id>` carrying no credential header. Measured cookieless in
this lane: **307 → `/sign-in`**. It is not one of the two routes this branch adds,
it is not on the guard's list, and it is not introduced by S9f — the branch's own
comment already calls that panel a cookie-bound surface that “carries nothing at
all”. It is stated because it is in the pictures, and it is not diagnosed further
here.

## Registration in the capture index

**The seven widget records ARE registered** in
`scripts/ci/chat-hitl-capture-index.json`. Each was run through the shipped
validator (`scripts/ci/lib/capture-record-contract.mjs`) first and came back with
**zero** violations — `record/ok` — because `site_widget` has a valid URL class
(`embed_assistant`), which the frame path satisfies. `validateCaptureIndex` over
the whole file after the append: **24 records, 0 violations.** The file's own
inventory paragraph was corrected to match what is now in it (it still said
“EIGHT records, from three lanes” while holding seventeen from four).

**The three review-page records are NOT registered, and that is the contract
working rather than a lapse.** Each comes back with **exactly one** violation,
`record/url-class-mismatch`, and no other: the contract's `review_page` URL class
is `/^\/agents\/reviews/`, while the shipped gate-region route is
`/agents/<vendor>/<package>/<runId>/review/<taskId>`. Every anchor, both counts
arms, the host claim, the kind claim, the state claim, the screenshot and its
digest all pass. That is the same defect the index's own comment already records
for the `page_gate_region` records from #2862 (A1) and #2863 (B1, B2). They stay
in this lane's `capture-records.json`. Appending them would make the index invalid
and turn a green gate red for a defect in the class.

The diagnostic is not a cell and is registered nowhere: its name carries no host
token, so the contract classes it `record/unclassifiable-cell` — which is correct,
because it claims no card.

## Gates — real exits

Both were run at this tree, and both were re-run with this lane's directory moved
aside, so nothing pre-existing is absorbed into this commit.

| Gate | Exit | Findings |
|---|---|---|
| `scripts/ci/chat-hitl-evidence-gate.mjs` | **0** | 2 findings, both `grandfathered evidence/unbound-cell`, **both pre-existing**: `C1__review-card__chat_thread__pending` and `C2__review-card__chat_thread__decided`, cited by the acceptance manifest from `evidence/2573-s7-visuals-lane`. |
| `scripts/audit/chat-hitl-acceptance-gate.mjs` | **1** | 4 capture-index violations, **all pre-existing**: the same two `chat_thread` cells, cited by manifest rows 1 and 15. These are the four the PR body already names as reproducing on main. |

**The isolation was measured, not asserted.** Each gate was re-run with this
lane's `evidence/` directory moved aside **and**
`scripts/ci/chat-hitl-capture-index.json` restored to `HEAD`. Both runs are
**byte-identical** to the runs above, so this commit causes none of these findings
and absorbs none of them. Its own seven records are bound rather than unbound:
`validateCaptureIndex` over the whole file reports **24 records, 0 violations**.
Full output: `logs/gate-chat-hitl-evidence.txt`,
`logs/gate-chat-hitl-acceptance.txt`.

## Layout

- `captures/` — the PNGs, full resolution, uncropped.
- `capture-records.json` — every record in the shape
  `scripts/ci/lib/capture-record-contract.mjs` validates; the seven widget ones
  are also in the canonical index.
- `capture-results.json` — the machine record beside the pixels: counts, the
  root's own `data-*` attributes, the per-chip DOM read-out, the card text, the
  wire, the decide outcome and the cookie jar.
- `logs/` — the two capture runs verbatim (`*.txt`), the widget's broker wire
  (present/absent only, never a value), the seeded ids for both rounds, and both
  gate outputs.
- `drivers/` — the harness exactly as run: `01-lane-setup.mjs`, `walk.config.ts` +
  `walk.test.ts` (assign → seed → hold → produce → gate → widget → readback),
  `host-page.html` (the third-party page), `03-capture-widget.mjs` and
  `04-capture-review-page.mjs`, whose counting rules are written at the top of
  each file.

No credential, token, password or host identity appears in any file here. Every
origin the recorders use is read from the environment.

Assisted-by: Claude Code (claude-opus-5)
