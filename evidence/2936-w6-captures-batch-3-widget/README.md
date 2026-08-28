# W6 part 2b, batch 3 — the third-party application

Epic #2926, issue #2936. Plan (B) §6, Conformance: *"Every screen this plan
touches is captured on the real surface and graded against the ratified
drawing"*, and §6's acceptance clause this batch exists for:

> *"A run at a moment shows its card on every host … in the chat and inside a
> third-party application with no assistant tool call in the transcript, and the
> card is still there after a reload on every host, carried by the turn's durable
> content"*

Batch 1 is PR #3043 (the touched screens on the app's own pages) and batch 2 is
PR #3045 (the review moment, with the run package published first). **Neither
touched `site_widget`.** This batch does, from a page served by another site.

**One real run** — `01b55935-2a9c-47ce-85cc-b677eef9df56` — started by a sentence
typed into the WIDGET's own composer, with four organization-owned skills
assigned, a real model provider and the real public MCP toolbox, created by the
app's own dispatch. **Six index records**, every one written by the shipped
recorder. Every other cell this batch was asked for was DRIVEN and could not be
reached; each is recorded with its code fact in `unreachable-cells.json`, and
none of them is answered by a stand-in.

## The origin pair, because it is what makes any of this mean anything

| surface | origin |
| --- | --- |
| the Cinatra app | `http://localhost:3000` |
| the page the widget is embedded in | `http://127.0.0.1:5591` |

Different origins **and different sites**, so the app's `SameSite=Lax` session
cookie cannot ride the frame. Measured, not asserted: the cookie jar at capture
time reads
`[{"name":"better-auth.session_token","domain":"localhost","sameSite":"Lax","httpOnly":true}]`
— a real session exists in that browser — and the widget frame authenticates
itself with its own hosted PKCE sign-in, which it runs in a second window. The
host page holds no credential; it speaks only the embed bridge protocol.

## What this batch found

### 1 — A run's review gate never reaches the widget it was started from, and two rules meet to make sure of it

This is the batch's principal finding, and it lands directly on §6's clause
above. Measured end to end:

- run `096e5a56-d42b-46fc-9dd4-8e3da018998b` was started from the widget's own
  composer, answered its own setup screen and its mid-run selection inside the
  widget, produced its artifact and **completed**;
- its artifact review gate `53781825-e912-4aaa-8275-4337f90efe85` went
  **`pending`** at 06:39:00.346Z and has never resolved;
- the widget column drew **0** review cards on the live page across **900 s** of
  polling, and **0** again after the third-party page was reloaded and the widget
  signed itself in a second time;
- `[data-run-review-slot]` = **0** across 260 polled samples, so there is no slot
  for a placeholder either.

**The code fact, and it is two rules meeting.**

`packages/agents/src/agentic-run-panel.tsx:1620` reads

> `const widgetHostedPanel = ambientLifecycleHost === "site_widget";`

and that flag closes **both** readings of the run card's review slot — the
completed-run gate at `:1625`
(`status === "completed" && !widgetHostedPanel ? reviewSlot.ref : null`) and the
still-working placeholder at `:1633`
(`(reviewMayStillOpen && !widgetHostedPanel)`). So on this host the run card
draws neither the gate nor the placeholder.

And the injected part is withheld from the very same turn.
`src/lib/lifecycle/lifecycle-run-outbox.ts`'s `injectionForTurn` returns `null`
when `part.viewType === RUN_CARD_CARRIED_VIEW_TYPE && turnCarriesRunCardFor(content, entry.runId)`
— one review card per gate per turn (cinatra#2997) — *"on the ground that the run
card already shows the gate"*, in the module's own words:

> *"A turn that draws the run card for this run is therefore already showing this
> run's gate, and injecting the part beside it would put the same question in the
> same turn twice"*

The two rules are each right on their own. Together, on `site_widget`, the
injection is suppressed **because the run card would show the gate**, and the run
card is explicitly told **not to show it**. The gate keeps neither delivery.

The screen a person is left with is in `P3` and `P4`: the widget's run panel
reads *"Run complete — This run finished. Its output could not be loaded here —
reload the page to try again."* The reload does not help, and this round did it.

**Reported, not patched.** Every cell that depends on a review card being drawn
here — the pending and decided review, the run-progress placeholder, the typed
comment settling a bound card, and the audit reading behind them — is recorded
unreachable with this same fact.

### 2 — The widget's own conversation cannot state a schedule

A schedule stated in the widget's own conversation, twice, on two fresh
conversations, is answered **"Not available to you."** — the fixed refusal
`schedule_proposal_render` returns when `resolveProposer()` yields null
(`src/lib/lifecycle/schedule-proposal-mcp.ts`).

The primitive **is** in the widget allowlist (`schedule_proposal_render` is
listed in `packages/mcp-server/src/delegated-widget-tool-policy.ts`, whose own
note says *"PARITY IS THE POINT"*), and two of `resolveProposer`'s three
conditions were satisfied by the SAME widget session minutes earlier: `readFramePerson()`
in `src/lib/lifecycle/named-agent-start-mcp.ts:227-236` reads exactly the same
`delegation` / `ctx.userId` / `ctx.orgId` triple and admitted this session's run
start. By elimination the failing condition is
`delegated.lifecycleRead !== true` at `schedule-proposal-mcp.ts:161-163` — the
`lcr` grant — although the session's stored scope column does contain
`lifecycle.read`. The elimination is stated as an elimination; the round did not
instrument the running server to confirm which side of the grant is missing.

So `trigger_schedule_proposal × site_widget` has no reachable subject on this
head, in either state.

### 3 — cinatra#3044, re-measured on this host, and deliberately not re-attempted

Three of this round's runs reached `lifecycle_moment = schedule` with
`lifecycle_card_kind = trigger_schedule_proposal` and **`lifecycle_card_ref = null`**,
and the widget column drew no schedule card and no Confirm at all (`P2`, light
and dark). It is batch 1's defect on a third host. **A run started inside a
third-party application cannot be released from inside it**, which is why this
round released one on the app's own run page — disclosed, and the only act it
took outside the widget.

`P2__schedule-moment-in-the-widget__site_widget__light.png` shows run
`096e5a56-d42b-46fc-9dd4-8e3da018998b` (thread `w6b3-northwind-sweep`): its row
read `lifecycle_moment=schedule` / `lifecycle_card_kind=trigger_schedule_proposal`
/ `lifecycle_card_ref=null` at that moment (TIMELINE 06:14), while the widget
panel's own status badge in the picture still reads **"Awaiting input"** — the
panel had not refreshed. No schedule card and no Confirm were drawn. `W13` /
`W14` show the same absence, on run `01b55935-2a9c-47ce-85cc-b677eef9df56`,
after a reload, badge **"pending trigger"**.

`P2…light.png` is **not** byte-identical to `W3`: P2 is 289,246 bytes
(sha256 `753595d9…`), `W3__recommendation-card__site_widget__settled__light.png`
is 275,726 bytes (sha256 `24228047…`), and they are different runs — W3 shows
run `01b55935…` in thread `w6b3-northwind-quarterly`. `page-controls.json`'s own
`byteIdenticalGroups` lists only the `S1` pair and `[P1, P3]`; P2/W3 is not
among them.

### 4 — A cell the contract calls unphotographable is drawn, and the recorder refuses it

`scripts/ci/lib/capture-record-contract.mjs` declares `agent_hitl_screen`
composition-only on `site_widget`, because

> *"a widget conversation cannot start a run that reaches `pending_approval`:
> `agent_run` is not in the delegated widget allowlist … and the content-editor
> launch claims no present human"*

cinatra#2996's `agent_named_start` gives the widget's own assistant exactly that
start. **Five** of this round's runs reached `pending_approval` from the widget,
and the widget drew the card each time:
`[{"kind":"agent_hitl_screen","host":"site_widget","state":"asking"}]`, with its
fields region and its own submit (`S0`, `S1`).

The claim was put to the shipped recorder and **refused twice**, in its own
words, both quoted in `refusals.json`: by `validateWalkPlan` at plan time, and by
`observeWalkCell` on the live page. A plan the shipped validator refuses is not a
plan, so the claim is not in `capture-walk.json` and the picture is filed as a
page control. The census cell is left exactly where it stood.

### 5 — Two bring-up facts, because each cost this round an hour

**A carried-over `.next` cache silently unrouted `/api/auth`.** On the first boot
the app served every page and answered **404, with the app's own not-found page**,
to every `/api/auth/*` request — `sign-up`, `sign-in`, `get-session` alike — so no
account could be created at all. `src/app/api/auth/[...all]/route.ts` is present
and unmodified. Removing `.next` and restarting fixed it in one boot; Next 16
defaults `turbopackFileSystemCacheForDev` to true and `next.config.ts` only
disables it under an env flag. A dev cache that can drop a whole route subtree
while every page still renders is worth someone's attention.

**The dev server's own origin is `localhost`, whatever loopback spelling the
browser used.** With the widget frame loaded on `http://127.0.0.1:3000`, its own
`POST /api/widget-auth/frame/init` was refused `401 not_same_origin` on every
attempt, so the frame could never sign in and the widget could never be used at
all. `isSameOriginFrameRequest` (`src/lib/widget-frame-auth.ts`) compares the
`Origin` header to `new URL(request.url).origin`, and measured with three
explicit `Origin` values against the same running server, **only
`http://localhost:3000` passes** — `next dev` is spawned with no `--hostname`
(`scripts/dev-server.mjs`), so it reports `localhost` as its own origin even for a
request that arrived on the other loopback spelling. The round moved the app to
`localhost:3000` and the third-party page to `127.0.0.1:5591`, which is also the
pairing that keeps the two on different sites.

### 6 — What the widget's own conversation says when a typed message asks it to act

Two sentences, two answers, both read back out of the stored turn:

| typed into the widget's own box | the answer, word for word |
| --- | --- |
| *"Approve the review for me."* | **"This message is not allowed to operate that control. Nothing was done."** |
| *"Approve the review and then reject it as well."* | **"I can't both approve and reject the same review. Please choose approve or reject."** |

The first is §XI's *"the platform states the refusal and the answer in the turn
carries that sentence"*, in the case §XI names first — **nothing bound**, which on
this host is the only case there is, because the host draws no review card to
bind. The second is §X's *"a second press asked for in the same message is
refused in the answer, and the reader sends again"*, on a host §X has never been
measured on. Nothing settled on either.

**An honest limit on the picture.** `P5` shows the message leaving the widget's
own box and the run panel beneath it; the answer had not painted when the shutter
opened, and the widget's restored transcript does not re-draw the earlier
answers. The sentences above are quoted from the stored turns, which is where
they are authoritative — the picture is not evidence for them and is not offered
as such.

## The graded cells

Each cell: **requires** (the ratified drawing at the contract's pin, rendered
with the capture browser — `drivers/00-render-the-drawing.mjs`, which prints
each numbered section's own text; the sections themselves are not copied into
this repository, only the clauses each cell is graded against) /
**shows** (measured — anchors counted by the shipped recorder, values read back
from the database, luminance measured) / **verdict**. PASS only where every
clause shows.

### W1 / W2 — `recommendation_hold` HELD on `site_widget`, light and dark

**Requires**, §V verbatim: *"Where the assistant proposes the skills it means to
use, the turn carries a chip-row: one chip per skill, each carrying its own
Confirm, Adjust and Skip, so the reader shapes the run one skill at a time before
it runs."* and *"The row is the whole card. There is no heading plate above it and
no row-level submit beneath it — nothing states the question a second time, and
nothing decides every skill at once."* With §IX verbatim: *"Every card appears on
every host, and it is the same card wherever it appears … Only the frame changes
— the thread, the widget's panel, the run card's detail column, the gate region
of the review page."*

**Shows** — in the third-party page's own window, uncropped: `.cw-frame` **1**
(page-scoped), `[data-embed-assistant][data-phase="active"]` **1**,
`[data-conversation-list]` **1**, `[data-lifecycle-card-host="site_widget"]` **1**,
`[data-lifecycle-card="recommendation_hold"]` **1**, and inside that root
`confirm` **4** / `adjust` **4** / `skip` **4**, all painted, with the host
declaration **1** inside the root. Four chips, one per assigned skill, each
carrying its own three affordances; no heading plate and no row-level submit. The
page's own chrome — its heading, its paragraph, its bridge log — is in the frame
around the widget, so whose page this is can be read off the picture.

**Verdict — PASS, light and dark.**

### W3 / W4 — the same row SETTLED, light and dark

**Requires** — §V's settled reading verbatim: *"SETTLED — ONE CHIP PER SKILL, EACH
SHOWING WHAT IT RECORDED"*, *"The settled row is still the whole card: each chip
states its own outcome in place. Nothing is summarised above it, and there is
nothing left to press."*

**Shows** — after each chip was decided on its OWN control inside the widget
(confirm, adjust → *Keep it in this run*, skip, confirm): the card root **1**,
`[data-lifecycle-card-state]` **1** inside it reading **`decided`**, and
`confirm` / `adjust` / `skip` **0** each inside the root. On screen the four
chips read **CONFIRMED · ADJUSTED · SKIPPED · CONFIRMED**. The run recorded
**three** selected skill revisions (`recommended_confirmed`, `user_adjusted`,
`recommended_confirmed`) — the skipped chip is drawn although it is not carried,
which is the same reading batch 1 recorded on the other hosts. The park went
`parked` 08:12:57.635Z → **`released` 08:13:39.566Z**, and the row settled **in
place**: same page load, same frame, same card instance.

**Verdict — PASS, light and dark.**

### W13 / W14 — the settled row after a reload, light and dark

**Requires** — the same §V settled clause, with plan (B) §6 verbatim: *"the card
is still there after a reload on every host, carried by the turn's durable
content"*.

**Shows** — the third-party page was reloaded and the widget ran its hosted
sign-in again from nothing. Before the reload the column carried the card; after
it, the card is there with the same four outcomes, the same `decided` state and
the same zero per-chip controls. **The half that does not hold is the stated
mechanism**: **0** stored turns carry a `recommendation_hold` part (or any of the
five kinds), so what survives the reload is projected from the run's own row.

**Verdict — PASS on the clause's outcome; the "carried by the turn's durable
content" mechanism is measured false on this host, as batch 1 and batch 2
measured it false on theirs.**

## The palette, and how a dark claim is measured here

The widget follows the app's own palette: next-themes is mounted
`attribute="class"` with the themes `cinatra` / `dark` (`src/app/providers.tsx`),
so the palette is a class the app's own control writes for the app ORIGIN, and
the embed frame is a document on that origin. Every dark frame in this round was
made by **pressing the app's own Toggle theme control** in an app tab of the same
browser and then polling the FRAME until it reported the class itself. The
browser context was opened with the **light** operating-system preference
emulated (`colorScheme: "light"`, `drivers/04-widget-run-sequence.mjs:72` and
`capture-walk.json`'s own `contexts.widget.colorScheme`) — the dark palette
never came from emulating a different OS preference, only from the app's own
control — and it reads `osPrefersDark: false` on every record, light and dark
alike.

**Two luminances are stated for every picture, and the second is the one the
claim is about.** The widget sits inside a third-party page with its own light
styling, so a whole-frame mean reads that page as much as the widget:

| record | whole frame | the widget's own region |
| --- | --- | --- |
| `W1` light | 240.3 | **237.9** |
| `W2` dark | 153.8 | **16.7** |
| `W3` light | 239.8 | **236.6** |
| `W4` dark | 155.7 | **22.0** |
| `W13` light | 239.9 | **237.0** |
| `W14` dark | 153.9 | **17.1** |

Every dark file measures under 25/255 inside the widget; the whole-frame number
is above 128 for exactly the reason stated, and it is reported rather than
trimmed away by cropping the picture to the card.

## The recorder, and where it could not be driven

**The shipped `--walk` CLI cannot bring a widget to any of these states, and this
round measured that rather than assuming it.** The walk's chained frame selector
DOES reach inside the embed frame and DOES press the frame's own **Sign in** —
that much was driven and worked. What follows it cannot be: the hosted PKCE
sign-in opens a SECOND WINDOW, which the closed action vocabulary has no action
for, and the credential it returns *"lands in the ref and nowhere else"*
(`src/app/embed/assistant/embed-assistant-client.tsx`), so no fresh context can
carry one in either. The probe timed out waiting for
`[data-embed-assistant][data-phase="active"]` after the press. **That is a
limitation, not a refusal** — the CLI was not told no by anything, it ran out of
vocabulary for a second window — and it is the third and last of the round's own
blocked-path events. The other two ARE recorder refusals, both against the
`agent_hitl_screen` claim on `site_widget` and both quoted in `refusals.json` /
`run-state.json`: `validateWalkPlan` at plan time, and `observeWalkCell` on the
live page (finding 4). So this round's own count is **two refusals and one
limitation** — never three refusals.

So `drivers/04-widget-run-sequence.mjs` drives the browser — including that second
window — and **every record is written by the shipped recorder on that live
page**: the shipped `playwrightPage` adapter and the shipped `observeWalkCell`,
`validateCaptureRecord` (audit tier) and `mergeWalkRecords`. The claims come from
the committed `capture-walk.json`, which the shipped `validateWalkPlan` accepts
with zero violations. Nothing about a record is supplied by this round except the
claim it makes; every count, url, digest and attribute in it is read off the live
screen.

## The census ratchet, and the digest

```
recommendation_hold | site_widget | pending   5 -> 7
recommendation_hold | site_widget | decided   2 -> 6
                                      total 105 -> 111
```

Moved by exactly this round's six records, with the reason written onto the
ratchet in `scripts/ci/__tests__/capture-record-contract.test.mjs`. **No other
cell moved**, and the two that a reader would expect to — the review gate and the
schedule proposal on this host — are owed to the fixes named above, not to a
batch.

**The anchor digest is UNCHANGED**: `recorded == recomputed ==
fa31fa2f1e73b545ba42e923636af4e4ac6025d623b6c5fdcc68d32342994d46`, before and
after. No digest input is touched.

## Reproducing it

```
export WALK_BASE=http://localhost:3000            # the app's OWN request origin
export SUPABASE_DB_URL=<the round's own database>
node scripts/apply-public-schema.mjs
node scripts/ci/sync-dev-extensions.mjs --pinned
node scripts/gen-wayflow-env.mjs && docker compose --profile wayflow up -d verdaccio wayflow
npm run dev                                        # with NO carried-over .next

node evidence/2930-w3-hitl-card/drivers/01-lane-setup.mjs
node evidence/2930-w3-hitl-card/drivers/02-instance-namespace.mjs
#   the provider step, inside the operator's secret-manager wrapper:
#   evidence/2790-s9f-host-parity/drivers/17-provider-setup-through-the-app.mjs
node evidence/2930-w3-hitl-card/drivers/03-set-public-origin.mjs
node evidence/2930-w3-hitl-card/drivers/04-join-template-org.mjs

LANE_REGISTRY=<the lane's own dev registry> LANE_NPMRC=<a publish npmrc> \
  LANE_PACK_DIR=<a scratch dir> \
  OUT_JSON=evidence/2936-w6-captures-batch-3-widget/registry-publish.json \
  node evidence/2936-w6-captures-batch-2/drivers/01-publish-run-packages.mjs

#   the skill ids are the CATALOG's — `<package>:<skill>`, never the bare package
WALK_SKILL_IDS='@cinatra-ai/blog-idea-authoring-skill:blog-idea-authoring,…' \
  npx vitest run --config evidence/2936-w6-captures-batch-3-widget/drivers/02-assign-skills.config.ts

HOST_PAGE_HOST=127.0.0.1 HOST_CALLBACK_OUT=<a scratch file> \
  node evidence/2936-w6-captures-batch-3-widget/drivers/01-serve-host-page.mjs &
WIDGET_ORIGIN=http://127.0.0.1:5591 WIDGET_INSTANCE_ID=<an instance id> \
  npx vitest run --config evidence/2936-w6-captures-batch-3-widget/drivers/02-register-widget-instance.config.ts
WIDGET_ORIGIN=http://127.0.0.1:5591 HOST_CALLBACK_OUT=<the same scratch file> \
  OUT_JSON=evidence/2936-w6-captures-batch-3-widget/connect-site.json \
  node evidence/2936-w6-captures-batch-3-widget/drivers/03-connect-the-site-through-the-consent-screen.mjs

#   WARM THE INGRESS FIRST — the app probes it with HEAD and a cold funnel
#   answers in 14.8 s against a 2.5 s budget.
curl -sI <the lane's public origin>/api/mcp

HOST_PAGE_URL='http://127.0.0.1:5591/?cinatra=http%3A%2F%2Flocalhost%3A3000&assistant=wordpress&instanceId=<the instance id>' \
  WIDGET_THREAD_ID=<a conversation id> STOP_AFTER_HOLD=1 \
  node evidence/2936-w6-captures-batch-3-widget/drivers/04-widget-run-sequence.mjs run1,reload

REPO_ROOT=$PWD node evidence/2936-w6-captures-batch-3-widget/drivers/05-measure-the-page-controls.mjs
RECORDS_IN=evidence/2936-w6-captures-batch-3-widget/capture-records.json \
  node evidence/2936-w6-captures-batch-3-widget/drivers/06-register-records.mjs

node scripts/ci/chat-hitl-evidence-gate.mjs && node scripts/audit/chat-hitl-acceptance-gate.mjs
node scripts/audit/chat-hitl-one-card-gate.mjs && node scripts/audit/file-size-ratchet.mjs
```

## What remains owed, and to which fix

- **`artifact_review_gate × site_widget`, both states** — owed to finding 1. Two
  shipped rules meet on this host and the gate keeps neither delivery.
- **the run-progress placeholder on `site_widget`** — the same fix.
- **the typed comment settling a bound review on `site_widget`** (§X) — the same
  fix; there is no card to bind until it lands.
- **`trigger_schedule_proposal × site_widget`, both states** — owed to finding 2.
- **the run-carried schedule card on `site_widget`** — owed to cinatra#3044,
  re-measured here on a third host.
- **`verification_summary × site_widget`** — owed behind finding 1 and
  cinatra#2951.
- **`agent_hitl_screen × site_widget`** — owed to a decision, not a fix: the card
  is drawn and the vocabulary refuses it (finding 4).

Evidence only — no product code changed.
