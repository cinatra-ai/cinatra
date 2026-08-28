# W6 part 2b, batch 1 — the touched screens, captured on the real surface

Epic #2926, issue #2936. Plan (B) section 6, Conformance: *"Every screen this plan touches is
captured on the real surface and graded against the ratified drawing"*.

**Twelve pictures of ONE REAL RUN**, started from the app's own chat with a real model provider and
the real public MCP toolbox, created by the app's own dispatch, and driven only by pressing what the
screens themselves draw. Eight are records of the canonical capture index, written by the SHIPPED
recorder; four are page controls, which are deliberately NOT index records because the screens they
photograph draw no lifecycle card at all — and that absence is the finding.

Run `e8729686-57f8-4b5b-9437-f5bf5be8ab63`. Every number below is read back in `RUN-READBACK.md`;
the order of events is in `TIMELINE.md`; every anchor count is in `capture-records.md`.

## What this batch found

**The headline clause does not hold on this head.** Plan (B) section 6, The runner:

> "a run a person starts from a conversation reaches the schedule moment with its card in that
> conversation, never a silent wait"

The run reached the schedule moment — `status=pending_trigger`, `lifecycle_moment=schedule`,
`lifecycle_card_kind=trigger_schedule_proposal` — and **nothing was drawn in the conversation**. The
wait was five minutes of polling with no message sent and no "show me" tool asked for. Measured:

- `lifecycle_card_ref` on the run's own row at that moment is **`null`** — the row names the kind and
  names no card;
- **0** turns anywhere in the store carry a `trigger_schedule_proposal` part;
- **0** `[data-lifecycle-card="trigger_schedule_proposal"]` roots and **0**
  `[data-action="confirm-schedule-proposal"]` controls on the conversation, in both themes (S1);
- **0** of either on the run page too (S2) — there the schedule is drawn as the run surface's own
  scheduling step, not as a card.

This is a plan (B) section 6 DEFECT and it is reported, not patched. The code fact it lands on is the
outbox's own note in `src/lib/lifecycle/lifecycle-run-outbox.ts`, which names the residual in so many
words: *"NOT DURABLE YET. This drains in the coordinator's own call, so a moment that opens BEFORE
the launching turn has persisted its dispatch pointer finds no turn and the card is not injected — it
arrives only if a 'show me' tool asks for it."* The measurement adds the sharper half: at the
schedule moment the run row carries **no card reference at all**, so there is nothing for a later
reader to resolve either.

**A second, narrower finding rides with it.** The recommendation card and the setup screen DO reach
the conversation and DO survive a reload — every one of the eight index records below was taken
after a fresh navigation. But **0** stored turns carry a `recommendation_hold` or an
`agent_hitl_screen` part either. So on this head the reload survival is carried by the projection
from the run's own row, **not** by "the turn's durable content" that section 6 names. The clause's
outcome holds for those two kinds; its stated mechanism does not.

**A bring-up finding, because it blocked the round for an hour and it is a product inconsistency.**
On a first-boot instance an opt-in (`resolution: "guardedOptional"`) bundled agent cannot be started
and cannot be installed:

- the chat refuses it — *"Agent is not installed: @cinatra-ai/blog-draft-writer-agent — it ships with
  Cinatra but is opt-in. Install it from the marketplace before running it."*
  (`packages/agents/src/runtime-install-gate.ts`, which reads `installed_extension`);
- the `/agents` page says *"No human-in-the-loop agents installed … Browse marketplace"*;
- and the storefront card for that exact package shows **"Installed"** with no install control at
  all, because `extensions-marketplace-screen.tsx` builds its install map out of
  `readActiveExtensionTemplates` — the TEMPLATE table — while the run gate reads the canonical one.

Three surfaces, three different answers, and no reachable install. What unblocked it was the app's
OWN boot repair (cinatra#2536): a SECOND boot re-imports each on-disk agent at the same version,
finds the canonical record absent and mints it. The two packages then read back `active`.

## The graded cells

Each cell: **requires** (the drawing's own words at the contract's pin,
`design@458fb7ffce6cf4ab6a2c60d3ff47198135d8ea2f specs/app-lifecycle-cards.html`) / **shows**
(measured — anchors counted, values read back) / **verdict**. PASS only where every clause shows.

### A1 — the recommendation hold, pending, in the conversation (light and dark)

**Requires**, section V verbatim: *"Where the assistant proposes the skills it means to use, the turn
carries a chip-row: one chip per skill, each carrying its own Confirm, Adjust and Skip, so the reader
shapes the run one skill at a time before it runs."* and *"The row is the whole card. There is no
heading plate above it and no row-level submit beneath it — nothing states the question a second
time, and nothing decides every skill at once."*

**Shows** — `[data-conversation-list]` 1, `[data-lifecycle-card-host="chat_thread"]` 1,
`[data-lifecycle-card="recommendation_hold"]` 1, and inside that root
`[data-skill-action="confirm"]` 4, `[data-skill-action="adjust"]` 4, `[data-skill-action="skip"]` 4 —
four chips, each with its own three affordances, under the platform's own dispatch sentence. Buttons
that are not per-chip inside the card: **0** (no row-level submit, no heading plate). Same
composition and same counts in dark.

**Verdict — PASS**, light and dark.

### A2 — the same pending hold on the run page (light and dark)

**Requires** — the same section V clause, on the host the parity ratchet records for this kind.

**Shows** — `[data-lifecycle-card-host="run_card"]` 1,
`[data-lifecycle-card="recommendation_hold"]` 1, the same three per-chip affordances × 4 inside the
root, drawn in the run surface's own recommendation step. **Verdict — PASS**, light and dark.

### A3 — the settled row in the conversation (light and dark) — cinatra#3018's fix

**Requires**, section V's settled example verbatim: *"Settled — one chip per skill, each showing what
it recorded"* and *"The settled row is still the whole card: each chip states its own outcome in
place. Nothing is summarised above it, and there is nothing left to press."*

**Shows** — after Confirm / Adjust / Confirm / Skip were pressed on the four chips' OWN affordances:
`[data-lifecycle-card-state]` inside the root reads `decided`; the per-chip controls are gone
(`confirm` 0, `adjust` 0, `skip` 0); and the row draws **four** chips, one per skill, each stating
its own outcome — `Blog Writing Skill CONFIRMED`, `Blog Idea Authoring Skill ADJUSTED`,
`Blog Post Matcher Skill CONFIRMED`, `Brand Voice Matcher Skill SKIPPED`, the skipped one in its own
muted treatment. The run recorded **three** selected skill revisions, so the fourth is drawn although
it is not carried — which is exactly the reading #3018 added.

**Verdict — PASS**, light and dark.

### A4 — the settled row on the run page (light and dark)

**Requires** — the same settled clause, on `run_card`.

**Shows** — `[data-lifecycle-card-host="run_card"]` 1, state `decided`, zero per-chip controls, the
same four outcomes in the run surface's rail. **Verdict — PASS**, light and dark.

### S1 — the schedule moment in the conversation (light and dark) — the DEFECT

**Requires** — plan (B) section 6 verbatim: *"a run a person starts from a conversation reaches the
schedule moment with its card in that conversation, never a silent wait"*; and section VI: *"The card
is the scheduling step, in the turn — and it is the only thing drawn."* with the table's first
reading, *"First shown — nothing exists yet | editable | Confirm"*.

**Shows** — with the run's own row at `lifecycle_moment=schedule` and
`lifecycle_card_kind=trigger_schedule_proposal`: `[data-lifecycle-card="trigger_schedule_proposal"]`
**0**, `[data-action="confirm-schedule-proposal"]` **0**, and the only lifecycle card on the screen
is the already-settled `recommendation_hold`. The conversation shows the person nothing about the
schedule.

**Verdict — FAIL.** The clause is not met on this head.

### S2 — the schedule moment on the run page (light and dark)

**Requires**, section VI verbatim: *"the question When should this run? over the three option rows,
the chosen row taking the indigo edge and tint and owning its fields, and the estimated duration
beneath"* and *"One card, five readings, and never a second card."*

**Shows** — the run surface draws `When should this run?` over `Run right after setup` (selected,
indigo edge and tint), `Schedule for later` with `Run at` + `Timezone`, and `Recurring` with its
repeat, day, time and timezone fields, `Estimated run duration` beneath, and one `Continue`. So the
FORM is drawn faithfully. But `[data-lifecycle-card="trigger_schedule_proposal"]` is **0** and
`[data-action="confirm-schedule-proposal"]` is **0**: on this surface the schedule is the run's own
scheduling step, not a lifecycle card, so the `trigger_schedule_proposal` × `run_card` cell has no
subject here either.

**Verdict — PASS on section VI's form; the card cell is RECORDED UNREACHABLE on this surface**, with
the code fact above.

## The cells this batch does NOT close

- `trigger_schedule_proposal` × `chat_thread`, pending / decided / after-reload — **no subject on
  this head**: the card never arrives. Owed to the fix, not to batch 2.
- `recommendation_hold` × `page_gate_region`, pending — needs a review task to exist while the hold
  is still held; on this run the hold is decided long before any review page exists.
- `artifact_review_gate` × `run_card` decided, × `chat_thread` decided, × `page_gate_region` pending,
  and the `verification_summary` readings — **the run failed before any artifact review**:
  *"failed to load the run package's artifact bindings: 404 Not Found … no such package available"*.
  The run package was never published to the instance's own registry. **Batch 2 owes all of these**,
  and owes the registry publish first.

## The one disclosed lane write

Four organization-owned skill assignments through the SHIPPED writer `upsertCustomSkillAssignment`
(`drivers/01-assign-skills.test.ts`), so the hold had four candidates to draw a chip for; read back
through the shipped reader. Two further provisioning writes are the sibling rounds' own and are
disclosed in `TIMELINE.md`: the lane account is made an administrator, and it joins the organization
the instance's own boot stamped every agent template with.

`grep -rniE "insert into|SEEDED_|seedGate|seedTurn|update .* set status" drivers/` over this round's
drivers is EMPTY. **No run, gate, park, record or review task was inserted, and no status was written
by hand.** `CINATRA_TEST_LLM_PROVIDER` was unset throughout.

## Reproducing it

```
export WALK_BASE=http://127.0.0.1:<port>
export SUPABASE_DB_URL=<the round's own database>
node scripts/apply-public-schema.mjs                         # a fresh database only
node scripts/gen-wayflow-env.mjs && docker compose --profile wayflow up -d verdaccio wayflow
node evidence/2930-w3-hitl-card/drivers/01-lane-setup.mjs
node evidence/2930-w3-hitl-card/drivers/02-instance-namespace.mjs
#   the wizard's Secrets step, and the provider step inside the credential wrapper:
#   evidence/2790-s9f-host-parity/drivers/17-provider-setup-through-the-app.mjs
node evidence/2930-w3-hitl-card/drivers/03-set-public-origin.mjs
node evidence/2930-w3-hitl-card/drivers/04-join-template-org.mjs
#   RESTART the app once: the boot repair mints the canonical install rows (see the findings)
npx vitest run --config evidence/2936-w6-captures/drivers/01-assign-skills.config.ts
node evidence/2936-w6-captures/drivers/02-chat-run-to-schedule.mjs

export WALK_COOKIE="$(node evidence/2930-w3-hitl-card/drivers/06-mint-lane-cookie.mjs)"
export WALK_COOKIE_DOMAIN=127.0.0.1
export WALK_THREAD_URL=/chat/<vendor>/<assistant>/<threadId>
export WALK_RUN_PAGE=/agents/<vendor>/<slug>/<runId>  WALK_RUN_ID=<runId>

W=scripts/audit/lib/chat-hitl-capture-driver.mjs
O=evidence/2936-w6-captures/capture-records.json
P=evidence/2936-w6-captures/capture-walk.json
node $W --walk $P --out $O --steps rec-pending-light,rec-pending-dark
node $W --walk $P --out $O --steps rec-pending-runpage-light,rec-pending-runpage-dark
node evidence/2936-w6-captures/drivers/04-decide-the-hold-on-the-card.mjs
node $W --walk $P --out $O --steps rec-settled-chat-light,rec-settled-chat-dark,rec-settled-runpage-light,rec-settled-runpage-dark
node evidence/2936-w6-captures/drivers/05-answer-setup-and-wait-for-the-schedule-card.mjs
node evidence/2936-w6-captures/drivers/06-page-controls.mjs evidence/2936-w6-captures/page-controls-plan.json
node evidence/2936-w6-captures/drivers/10-run-readback.mjs
RECORDS_IN=$O node evidence/2936-w6-captures/drivers/09-register-records.mjs
node scripts/audit/chat-hitl-acceptance-gate.mjs && node scripts/ci/chat-hitl-evidence-gate.mjs
node scripts/audit/chat-hitl-one-card-gate.mjs && node scripts/audit/file-size-ratchet.mjs
```
