# cinatra#2790 (S9f) — the skills-recommendation card on its two new hosts

Head under proof: `f2e4fe15d06e799b73218edcdf37954ed4e22b2c` (PR #2890), plus this
evidence commit.

## The headline, first

The **review-page** mount works and is photographed: the card draws **held**,
**above** the review gate card, with one chip per skill and natural display
names — light and dark.

The **widget** mount **does not draw on the running app at this head**, and the
reason is not the card. Every broker read the widget makes is answered with a
**307 to `/sign-in`** before the route handler runs, because the two routes this
branch adds were never added to the app's cookieless-reachable path list. The
card is therefore not photographed on the widget, and no cell here claims it is.
The measurement, the wire and the one-line cause are in
[“The widget mount is blocked”](#the-widget-mount-is-blocked) below.

## The runtime, said first

`node scripts/dev-server.mjs` (Next.js 16.2.10, Turbopack),
`CINATRA_RUNTIME_MODE=development`, `NODE_ENV != production`,
`CINATRA_TEST_LLM_PROVIDER=scripted`, on a **dedicated lane database** on the
verify Postgres (port 5634) and the verify Redis (port 6579), loopback-only,
with the branch's own extension tree (114 packages) and a raised
`CINATRA_BOOT_READY_TIMEOUT_MS`. **Placeholder-only environment: no model
credential of any kind exists on this host**, and none is used.

`CINATRA_E2E_SETUP_BYPASS=true` is set, and stated because it is set: the lane
database is a clone of an already-provisioned instance, so the setup wizard has
nothing to run and the bypass keeps boot from demanding services this lane does
not have. It changes no surface photographed here.

It is **not** a production-equivalent build, for the reason
`evidence/2573-s7-conformance/README.md` measured and this round does not
re-derive: `next start` bakes `NODE_ENV=production` into the server bundle,
which the shipped `assertScriptedProviderNotProduction` fence reads, so a
production build and a scripted dispatch are mutually exclusive.

Every record is labelled `dev-runtime`. Card cells are shot at
`deviceScaleFactor: 2`, uncropped, full resolution; `pageErrors` was empty on
every review-page cell.

## The origin pair

| Surface | Origin |
|---|---|
| the Cinatra app | the `localhost` **name**, on the lane's app port |
| the page the widget is embedded in | the IPv4 **loopback address**, on a second port |

Different origins **and different sites**: the loopback NAME and the loopback
ADDRESS are not the same registrable domain, which is the whole point of driving
the widget from a loopback-address host page rather than a second port on the
name. Both
origins are read from the environment by the recorder; neither is written into
any committed file, and `finalUrl` on a widget record is the served path only.

## The seeding path — all shipped writers

1. Owner + organization through the shipped Better Auth routes
   (`drivers/01-lane-setup.mjs`, the shape `evidence/2841-v-redraw` used).
2. Four skills assigned to `@cinatra-ai/blog-draft-writer-agent` at
   `organization` ownership through the shipped writer
   `upsertCustomSkillAssignment`; `getAssignedSkillIdsForAgent` reads all four
   back (`walk.test.ts` step `ASSIGN`).
3. Two `pending_input`, human-present runs on that template, each parked through
   **`maybeHoldRunForRecommendation`** — the one seam the interactive run trigger
   uses. Both answered `{held: true, reason: "core default fires
   recommendation"}` and left a `lifecycle_continuation_park` row with
   `checkpoint=recommendation`, `status=parked` (step `HOLD`).
4. For the review-page run only: the artifact through the shipped
   `materializeBlogPostBodyArtifact`, then the gate through the shipped
   `sweepReviewOrchestration()` — `gatesCreated: 1`, one `artifact_review_gates`
   row, status `pending` (steps `PRODUCE`, `GATE`).
5. The widget instance and its connect-site through the two SHIPPED writers the
   CMS OAuth exchange itself calls — `writeConnectorConfigToDatabase` and
   `upsertConnectSiteAndMintCredential` — and `deriveFrameBinding` asserted to
   close before anything was driven (step `WIDGET`, `{"ok":true}`).
6. Everything on screen after that is the shipped path. The chip labels are the
   owning extension's manifest `cinatra.displayName`, resolved server-side by the
   scorer; nothing is re-derived in the recorder.

**The run intent was chosen, not the scores.** The prompt is the one
`evidence/2841-v-redraw` measured — *"Draft a blog post from the attached
resource that classifies the brand voice and tone guide, and keep the editorial
writing rules."* — which puts three of the four assigned skills over the
recommend threshold and leaves `web-research` under it. All four still get a
chip; the fourth is the shipped force-add candidate.

### Lane repairs and lane data, stated

1. **The cloned fixture's `agent_templates.org_id`** pointed at an organization
   row that does not exist in this database, so every reader outside it is
   refused `cross_org`. Repointed to this lane's organization
   (`drivers/01-lane-setup.mjs`). Lane data, never code: it changes who may open
   the run, never what the card draws. Same repair `evidence/2841-v-redraw`
   recorded.
2. **The RBAC fixture's second `Default` organization** was present in the clone
   and was removed, as the environment law requires. The platform then recreated
   it — `ensureDefaultOrganizationRow` forces a `slug="default"` organization and
   makes a platform admin its owner — and put the browser session in it, which
   left the lane's assignments in a different organization and the card drawing
   *"No candidate skills."* The lane was therefore aligned to the platform's own
   answer rather than fighting it: the single remaining organization was renamed
   to `Default` / `default`, so the row the bootstrap resolves and the row the
   lane's data lives in are the same row. **Exactly one organization exists in
   this database.** This is the corrected reading; the first review-page pass,
   taken before it, is superseded and not committed.
3. **The cloned database's `public.jwks` row** was encrypted under the source
   lane's `BETTER_AUTH_SECRET` and could not be decrypted under this lane's, so
   the hosted widget sign-in returned 500. The row was deleted and Better Auth
   minted a fresh key — the remedy the error itself names.

## The widget mount is blocked

**What was driven.** A fresh browser context with an empty cookie jar, the host
page on the loopback-IP origin, the embed frame's **own hosted-PKCE sign-in**
run inside the frame, then the turn typed into **the widget's own composer**. The
deterministic provider named the run and the transcript slot rendered. All real.

**What the column drew** (`captures/DIAG__site-widget-column__card-absent.png`):
the turn, the provider's reply, and the run slot carrying *“Could not load agent
run … — please try again.”* **No recommendation card at all.**

**Measured on that screen**, with the same selectors a present card would be
measured with:

| Selector | Scope | Count |
|---|---|---|
| `.cw-frame` | page | 1 |
| `[data-embed-assistant][data-phase="active"]` | frame | 1 |
| `[data-conversation-list]` | frame | 1 |
| `[data-lifecycle-card-host="site_widget"]` | frame | **0** |
| `[data-lifecycle-card="recommendation_hold"]` | frame | **0** |
| `[data-skill-action="confirm"\|"adjust"\|"skip"]` | root | **0 / 0 / 0** |

**Why.** Every broker read left the frame correctly formed — `logs/widget-wire.json`
records five POSTs to the resolve route, each `cookie: absent`,
`x-cinatra-widget-user-token: present (cwu_)`, widget origin and assistant headers
present — and every one came back **307**, not 401 and not 200.

The cause is reproducible in one command and is not the card:

```
POST /api/lifecycle-views/recommendation-hold          -> 307  /sign-in?next=…
POST /api/lifecycle-views/recommendation-hold/decide   -> 307  /sign-in?next=…
POST /api/lifecycle-views/resolve                      -> 401
POST /api/lifecycle-views/decide                       -> 401
```

The two shipped siblings reach their handlers and refuse properly; the two routes
this branch adds never reach theirs. `src/lib/auth-route-guard.ts` carries an
**exact-path** list of the routes that must be reachable without a session
cookie, and `/api/lifecycle-views/resolve`, `/api/lifecycle-views/decide`,
`/api/lifecycle-views/capture` and `/api/chat/pending-tool-calls` are all on it
with a paragraph each explaining that the widget branch holds no cookie. The two
new recommendation-hold routes are **not** on it. `guardAppRoute` therefore
redirects them before the handler runs.

**The handler itself is fine.** With a session cookie present — so the guard
passes — both routes answer **401**, which is exactly the branch's own stated
contract (“no session fallback — a missing or rejected credential is a 401”). The
only thing standing between this branch and a drawn widget card is the guard-list
entry.

**Why the failure is invisible.** `readHoldStateThroughBroker` cannot parse a
state out of sign-in HTML, returns `null`, the card renders nothing, and the
bounded retry ends. No error is drawn — precisely the failure mode the existing
guard-list comments were written to warn about.

**Not fixed here, deliberately.** Adding paths to the auth route guard widens a
security surface, carries its own pinned test
(`src/lib/__tests__/auth-route-guard-public-paths.test.ts`) and belongs in the
slice with its own review — not folded into an evidence commit to make this
lane's own pictures work.

**Separately observed, and pre-existing:** the inline run panel's own seed
`GET /api/agents/runs/<id>` is also 307'd cookieless, which is why the run slot
shows *“Could not load agent run”*. That is the cookie-bound panel the branch's
own comment says “carries nothing at all” on a credential surface; it is not
introduced by S9f and is not diagnosed further here.

## Cells DELIVERED

Card cells are framed on the card root
`[data-lifecycle-card="recommendation_hold"]`. **`R1` and `R3` share one clip
rectangle** — `{x:376, y:191, w:1048, h:68}` CSS px, measured once on the light
pass — because shooting the locator twice gave widths differing by 2 CSS px (a
scrollbar difference), which is not identical framing.

| Cell | Pixels | What is VISIBLY on screen |
|---|---|---|
| `R1__recommendation-card__page_gate_region__held` | 2096×136 | The held card on the run review page. **Four chips — `Blog Post Matcher Skill`, `Blog Writing Skill`, `Brand Voice Matcher Skill`, `Web Research Skill`**, each the owning extension's manifest `displayName`, never a slug and never a package id — each in its own pill with **its own `Confirm` `Adjust` `Skip`** to the right of its name. No heading plate, no subtitle, no `Skills (n/m)` selector, no card-level submit. |
| `R2__recommendation-card__page_gate_region__held__above-gate` | 2880×3540 | The same card **in its page**, uncropped and full-length: `AGENT RUN / Review`, the chip row at the top of the gate region, and **beneath it** the review gate card — `Review requested`, `Awaiting your decision`, the target panel for `Connector rollout note`, `Expand`, `DECISION RATIONALE`, `Comment` `Reject` `Approve`. |
| `R3__recommendation-card__page_gate_region__held__dark` | 2096×136 | The same card, same run, same clip rectangle, in `dark`. |

Measured on every one of the three, and carried in each record's `assertions`:

- `[data-lifecycle-card="recommendation_hold"]` (frame) = **1**
- `[data-lifecycle-card-host="page_gate_region"]` (frame) = **2** — the
  recommendation card root and the review gate card root, both mounts of that
  host, which is the parity claim
- `[data-lifecycle-card="artifact_review_gate"]` (frame) = **1**
- `[data-skill-action="confirm"]` / `="adjust"` / `="skip"` (root) = **4 / 4 / 4**
- `[data-recommendation-chip]` (root) = **4**, all `data-chip-mark="undecided"`
- `[data-lifecycle-card-state]` (root) = **1**, value `held`

The card root carries, on all three:
`data-run-recommendation-chip-row`, `data-conformance-id="run-chip-row"`,
`data-lifecycle-card="recommendation_hold"`, `data-lifecycle-card-state="held"`,
`data-lifecycle-card-host="page_gate_region"`, `data-variant="inline"`,
`data-can-decide="true"`.

The **order** is measured, not eyeballed, on all three:
`{cardTop: 191, gateTop: 275, cardAboveGate: true, domOrder: "card-then-gate"}`.

## The grading

Against design §V (the ratified redraw the card renders, quoted verbatim in
`packages/agents/src/run-recommendation-chip-row.tsx`) and against the plan's
§6.1 / §6.4 / §9 host language.

| # | What is claimed | Requires | Shows | Verdict |
|---|---|---|---|---|
| 1 | §V *“one chip per skill, each carrying its own Confirm, Adjust and Skip”* | ≥1 chip, each with its own three affordances | R1/R2/R3: 4 chips × 3 = 12 buttons, per chip | **PASS** |
| 2 | §V *“The row is the whole card … no heading plate above it and no row-level submit beneath it”* | no heading, no card-level submit inside the root | R1/R3: the root is the row; nothing above or below it | **PASS** |
| 3 | §V settled chips name the skill, not an id | manifest `displayName` on every chip | the four names above, held | **PASS** |
| 4 | Plan §6.3 item 4 — *“No mount on the review page”* is closed | the card present on the review route under `page_gate_region` | `[data-lifecycle-card-host="page_gate_region"]`=2, card root=1 | **PASS** |
| 5 | Plan §6.4 — *“the same row appears … on the review page”*, **above** the gate | the card ABOVE the review gate card | `cardAboveGate: true`, `domOrder: card-then-gate`, visible in R2 | **PASS** |
| 6 | Plan §9 — review page *“keyed by the run”* | one card for the run, not per gate | card root=1 with gate=1 on the same screen | **PASS** |
| 7 | Plan §9 — review page *“mostly seen in its decided form”* | a decided reading on this host | **not shot** — the run is genuinely held; see below | **NOT DELIVERED** |
| 8 | Both palettes resolve | the same card in light and dark, identical framing | R1/R3, one shared clip rectangle | **PASS** |
| 9 | Plan §6.3 item 3 — *“the card is withheld from the widget”* is closed | the card drawn on `site_widget` | **0** card roots on the widget; every broker read 307'd | **FAIL — the branch does not deliver this on the running app** |

## Cells NOT delivered

| Cell | Why |
|---|---|
| the card **held** in the embedded widget column, light and dark | **Blocked by the branch**, not by this lane. The two routes S9f adds are missing from the auth route guard's cookieless list, so every widget read is 307'd to `/sign-in` before the handler runs. Measured, photographed as a diagnostic, and diagnosed above. Re-shootable in one pass once the guard entry lands. |
| the **settled** reading on the widget, driven through the broker decide route | Same cause. The decide route 307s under the same conditions, so no decision could be driven from the widget at all. The chip-by-chip drive and the settled shot are already written into `drivers/03-capture-widget.mjs` and will run unchanged. |
| a **decided** reading on the review page (plan §9's “mostly seen”) | Would need the hold decided first. Deciding it on the review page is possible — that host is a cookie surface and works — but it would consume the only held run on that host, and the cell this round was asked for is the **held** one. Named rather than implied. |
| the card in the **chat** conversation | Not on this branch. It depends on the conversation-origin hold S9b (#2786) builds, exactly as the PR body says. |

## Registration in the capture index

**Nothing was appended to `scripts/ci/chat-hitl-capture-index.json`, and that is
the contract working rather than a lapse.**

All three review-page records were run through the shipped validator
(`scripts/ci/lib/capture-record-contract.mjs`). Each comes back with **exactly
one** violation, `record/url-class-mismatch`, and no other: the contract's
`review_page` URL class is `/^\/agents\/reviews/`, while the shipped gate-region
route is `/agents/<vendor>/<package>/<runId>/review/<taskId>`. Every anchor, both
counts arms, the host claim, the kind claim, the state claim, the screenshot and
its digest all pass.

That is the same defect the index's own comment already records for the
`page_gate_region` records from #2862 (A1) and #2863 (B1, B2) — *“THE
page_gate_region RECORDS ARE DELIBERATELY ELSEWHERE, not missing … a defect in
the class, not in the pictures.”* These three join them: they live in this lane's
`capture-records.json`, in the shape the contract validates, with
`recordedBy: "cinatra-lifecycle-capture-recorder@1"` and digests that match the
bytes on disk. Appending them to the index would make the index invalid and turn
a green gate red for a defect in the class.

The diagnostic is not a cell and is not registered anywhere: its name carries no
host token, so the contract classes it `record/unclassifiable-cell` — which is
correct, because it claims no card.

## Gates — real exits

Both were run at this tree, and both were re-run with this lane's directory moved
aside. **The output is byte-identical either way**, so nothing below is caused by
this commit and nothing pre-existing is absorbed into it.

| Gate | Exit | Findings |
|---|---|---|
| `scripts/ci/chat-hitl-evidence-gate.mjs` | **0** | 2 findings, both `grandfathered evidence/unbound-cell`, both pre-existing: `C1__review-card__chat_thread__pending` and `C2__review-card__chat_thread__decided`, cited by the acceptance manifest from `evidence/2573-s7-visuals-lane`. |
| `scripts/audit/chat-hitl-acceptance-gate.mjs` | **1** | 4 capture-index violations, all pre-existing, all the same two `chat_thread` cells above cited by manifest rows 1 and 15. These are the four the PR body already names as reproducing on main. |

Full output: `logs/gate-chat-hitl-evidence.txt`,
`logs/gate-chat-hitl-acceptance.txt`.

## Layout

- `captures/` — the PNGs, full resolution, uncropped.
- `capture-records.json` — the four records in the shape
  `scripts/ci/lib/capture-record-contract.mjs` validates.
- `capture-results.json` — the machine record beside the pixels: counts, the
  root's own `data-*` attributes, the per-chip DOM read-out, the measured order,
  the card text, the wire and the cookie jar.
- `logs/` — the two capture runs verbatim (`*.txt`; `*.log` is gitignored), the widget's broker wire
  (present/absent only, never a value), the seeded ids, and both gate outputs.
- `drivers/` — the harness exactly as run: `01-lane-setup.mjs`, `walk.config.ts` +
  `walk.test.ts` (assign → seed → hold → produce → gate → widget → readback),
  `host-page.html` (the third-party page), `03-capture-widget.mjs` and
  `04-capture-review-page.mjs`, whose counting rules are written at the top of
  each file.

No credential, token, password or host identity appears in any file here. Every
origin the recorders use is read from the environment.

Assisted-by: Claude Code (claude-opus-5)
