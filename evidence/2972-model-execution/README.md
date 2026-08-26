# cinatra#2972, item 1 — the model-execution half

PR #2978 closed acceptance items 2–6 of cinatra#2972 with real-clock pictures, and
left one half of item 1 open: every fired run in that proof was created, gated and
enqueued by the app, but none of them reached the agent runtime, so no fired run
was ever executed by a model.

This directory is that half. With the agent runtime up, a **recurring** schedule was
armed on a real agent through the app's own schedule form, left alone, and one tick
was allowed to come due on its own clock. The tick cloned a child run, the child run
reached the runtime, the runtime called back into the app's model bridge, a real
provider answered, and the child run finished `completed` with the model's own text
in its record.

Nothing was inserted, seeded or released by hand, no clock was moved, and the only
SQL any step ran is `select`.

## The agent, and why it

**`@cinatra-ai/planner-agent` — "Agent Planner".**

- It is one of the agents that ships installed and runnable on a fresh instance, so
  no marketplace step stands between the schedule and the run.
- It is **mounted on the agent runtime**: the runtime's loader mounts it at
  `agents/cinatra-ai/planner-agent/`, and the app resolves its A2A URL there — so a
  fired run of it executes ON the runtime, not in-app.
- Its flow is a **single LLM step**: the one working node of
  `cinatra/oas.json` is an `ApiNode` that POSTs to the app's own
  `/api/llm-bridge`. Its `findings` output therefore IS model-produced text, not a
  deterministic computation.
- It needs **no connector** and **no sub-agent** (`connector_dependencies` and
  `agent_dependencies` are both empty), and every hidden input carries a default, so
  the whole run is expressible from one visible field.

The simplest LLM-only leaf agents in the catalogue (the blog-idea generator and its
siblings) are **opt-in** and not installed on a fresh instance; the run-start gate
refuses them until they are installed, and the idea generator additionally needs a
sub-agent that is not installed either. `author-agent` IS installed, and a fired run
of it is included below as a defect: its OAS declares a hidden input with no default,
which the app never supplies, so the runtime refuses the conversation.

## The round

| moment | UTC |
|---|---|
| recurring schedule armed on the agent's schedule form | `01:33:24Z` |
| trigger row written (`recurring`, `40 1 * * *`, UTC) | `01:33:25Z` |
| tick came due, release job cloned a child run | `01:40:00Z` |
| the round's single model call, per the app's usage ledger | `01:40:16Z` |
| child run `completed` | `01:40:17Z` |
| schedule cancelled through the UI | `01:44:09Z` |

## The pictures

Twelve files, six readings, light and dark for every one. Full browser window,
1440×900 at device scale 2, uncropped.

| cell | reading |
|---|---|
| `P1` | the agent's schedule tab with the recurring schedule armed |
| `P2` | the run list with the fired child run |
| `P3` | the child run's page after it completed |
| `P4` | the schedule tab after the tick |
| `P5` | the schedule tab after Cancel |
| `chat-answer` | one chat exchange on this instance, answered by the real model |

## requires / shows / verdict

**`P1` — the agent's schedule tab, recurring armed**
- *requires* (item 1, "real run on a real model, pictured"): the schedule this leg
  fires from is a RECURRING schedule, armed through the shipped surface.
- *shows*: the Trigger tab of `Agent Planner (1)` — Type `recurring`, Schedule
  `At 01:40 AM`, Timezone `UTC`, one control (`Cancel trigger`). Zero
  `release-trigger-now` controls on the surface.
- *verdict*: **PASS**.

**`P2` — the run list with the fired child**
- *requires*: the tick produced a child run that the product itself lists.
- *shows*: "5 latest agent runs" — top row `Agent Planner / Agent Planner /
  completed / 1 mins ago`, with the parent `Agent Planner (1) / armed / 9 mins ago`
  directly beneath it.
- *verdict*: **PASS with a limit** — the list carries no run id, so the row is bound
  to the child by its name, status and minute; the ids are bound in the readback
  below and in the release job's own log line.

**`P3` — the child run's page**
- *requires* (item 1): the fired run's **model-produced output**, visible.
- *shows*: `Agent Planner (2)`, status `completed`, and a completion card reading
  "Run complete — This run finished. Its output is in the run transcript below."
  **There is no transcript below it, and nothing else on the page carries the
  output.** The left rail's `Step 1` entry is present and checked; clicking it
  changes nothing in the detail column.
- *verdict*: **DEFECT.** The run really did produce model text (quoted below, read
  from its own record), but the run page does not show it and points the reader at a
  transcript that is not there. For an agent with no human-in-the-loop steps the
  panel branch renders the step-less "Agentic Run Progress" section, the transcript
  the copy promises is the (empty) message list, and the runtime's response — which
  lands in the run's step results — has no renderer on this surface.

**`P4` — the schedule tab after the tick**
- *requires*: the trigger's next-fire moment after the tick.
- *shows*: the same three rows as `P1` — Type `recurring`, Schedule `At 01:40 AM`,
  Timezone `UTC` — and `Cancel trigger`. No last-fired stamp, no next-fire instant.
- *verdict*: **DEFECT (reading not available on the surface).** The row itself moved
  (`last_fired_at 01:40:00.337Z`, and the next occurrence of `40 1 * * *` UTC is
  `2026-08-27T01:40:00Z`), but the tab states only the recurrence, so a person cannot
  read either the last fire or the next one from it.

**`P5` — after Cancel**
- *requires* (item 3): pressed, Cancel stops the recurring schedule.
- *shows*: the Trigger tab is gone; the page falls back to the first-step schedule
  form at its defaults ("Run right after setup" selected, Recurring at its `weekly
  09:00` default).
- *verdict*: **PASS on the effect, DEFECT against item 3's wording.** The schedule
  is genuinely stopped — the trigger row is deleted and the run is `stopped`, so
  nothing fires again — but this surface DELETES the trigger and re-offers an empty
  form rather than leaving a stopped, non-editable scheduler. Item 3's sentence
  ("It never deletes the schedule or pauses the run") is about the schedule CARD that
  #2978 changed; the agent page's persistent Trigger tab still carries the old
  behaviour and still labels the control "Cancel trigger", not "Cancel schedule".

**`chat-answer` — the instance answers on a real model**
- *requires* (the leg's precondition): the provider configured through the app's own
  setup form actually answers.
- *shows*: one exchange in the shipped composer — "Reply with one short sentence:
  what is a recurring schedule good for?" answered by Cinatra with "A recurring
  schedule is good for automatically running the same task on a regular cadence."
- *verdict*: **PASS**.

## The rows, read back

Trigger row (the parent's schedule):

```
run_id             28d78d2b-69a1-484b-ac49-5d1eaabb419f
trigger_type       recurring
cron_expression    40 1 * * *
timezone           UTC
enabled            t
last_fired_at      2026-08-26 01:40:00.337+00
stopped_at         (null)
job_scheduler_id   present
created_at         2026-08-26 01:33:25.21+00
updated_at         2026-08-26 01:40:00.337+00
```

The child the tick created, and its own (immediate) trigger:

```
id                 a696717d-814f-4369-8d8c-65f31ae37130
status             completed
template_id        2c35373d-5650-4ddb-b127-a26a47250abb   (same template as the parent)
a2a_task_id        bb364fda-0ed9-4747-8bc4-d188affc02c7
created_at         2026-08-26 01:40:00.363347+00
completed_at       2026-08-26 01:40:17.534+00
error              (null)
title              Agent Planner (2)

trigger for that run: trigger_type immediate, released_at 2026-08-26 01:40:00.274+00
```

**Linkage.** No column links a child to the schedule that produced it —
`agent_runs.parent_run_id` is null on the clone. What names the parent is the release
job's own line, written at the moment it cloned:

```
[trigger-release] recurring tick — created new run a696717d-814f-4369-8d8c-65f31ae37130 from 28d78d2b-69a1-484b-ac49-5d1eaabb419f
```

and the runtime hand-off for the same run:

```
[wayflow] run=a696717d-814f-4369-8d8c-65f31ae37130 task=bb364fda-0ed9-4747-8bc4-d188affc02c7 state=completed
```

The database side corroborates it: the child is the only run of that template created
inside the tick's second, and its trigger is `immediate` (the shape the release job
arms a clone with) while the parent's is `recurring`.

## The output the model produced

The child run's step result is a single `wayflow_response` carrying the agent's
`findings` for the OAS body that was set as the run's input (a "Weekly Support
Digest" flow). Verbatim:

- `explicit_control_flow` / suggestion — "Add explicit control_flow_connections for
  start → summarise → human review → send → end so reachability and execution order
  are unambiguous." (`$.control_flow_connections`)
- `add_post_summary_hitl_gate` / suggestion — "Place an InputMessageNode after the
  summarise step and before send so the human reviews the generated digest rather
  than approving before content exists." (`$.nodes`)
- `gate_send_side_effect` / suggestion — "Because the flow sends the digest to a
  team, add an approvalPolicy/HITL gate immediately before the send side-effect."
  (`$.approvalPolicy`)
- `define_referenced_components` / suggestion — "Include $referenced_components
  defining the summarise, send, start, and end nodes so node choice can be reviewed
  and the flow is portable." (`$.$referenced_components`)

Those sentences are about the flow that was actually handed in — they are not
templated text.

## That a real model served it

The app's own usage ledger holds exactly one call inside the tick's window:

```
provider  model                 calls  first_at                      last_at
openai    gpt-5.5-2026-04-23    1      2026-08-26 01:40:16.532+00    2026-08-26 01:40:16.532+00
```

one second before the child run completed. The provider key was typed into the app's
own setup form and never written to a file on the machine that ran the app; the
scripted test provider was removed from the app's environment before boot and is
absent from the app process, so no stood-in runtime could have answered.

## The second defect this round found

A fired child of `@cinatra-ai/author-agent` — the other installed LLM-only agent —
reached the runtime and was refused before the model:

```
Cannot start conversation because of missing inputs "packageSlug"
(StringProperty(name='packageSlug', description='', default_value=<empty>))
in inputs: {'spec': ..., 'agent_run_id': ...}
```

`author-agent`'s OAS declares `agent_run_id` and `packageSlug` with **no default**;
the app marks both `x-hidden` on the form and supplies only `agent_run_id`. So the
agent is installed and offered, its schedule arms and fires, and every fired run dies
at the runtime's input check. Its sibling reviewer agents all give those two inputs a
default and are unaffected.

## What this does NOT establish

1. **That the model call and the child run are bound by an id.** The usage ledger
   carries no run or turn id, so the single row above is correlated to the child by
   TIME (inside the tick's window, one second before completion) and by the fact that
   nothing else was running. It is not a per-request attribution.
2. **That the run page ever shows model output.** It does not — see `P3`. What is
   proved is that the model produced text and that the text is in the run's record.
3. **Anything about the schedule CARD.** This leg exercises the agent page's schedule
   form and its persistent Trigger tab. The card surfaces that #2978 changed were
   already pictured on that PR.

---

# The one-off leg (2026-08-26) — acceptance item 1, word for word

Item 1 reads: **"Chat card and run-page step, one-off fired: read-only, no controls
(real run on a real model, pictured)."** The recurring leg above proves the model
execution; it pictures the agent page's schedule tab. This leg is item 1's own two
surfaces — the **chat card** and the **run page's Schedule step** — after a **one-off**
came due on its own clock, with the run it fired finishing on a real provider.

Nothing was inserted, seeded or released by hand. No clock was moved. The only SQL any
step ran is `select`. Every action below happened in the shipped UI.

## The round

| moment | UTC |
|---|---|
| the schedule stated in the chat composer; the assistant drew its scheduling card | `03:58:32Z` |
| **Confirm** pressed on the card — trigger row written, `scheduled`, `2026-08-26 04:15:00Z`, UTC | `03:59:09Z` |
| `C1` shot — the card armed, before the fire | `03:59:10Z` |
| **the one-off fired on its own clock** — `released_at` | `04:15:00.112Z` |
| the fired run asked for its one visible input on the run page; the input was typed and **Continue** pressed | `04:15:43Z` |
| the round's single model call, per the app's usage ledger | `04:16:06.508Z` |
| the run finished `completed` | `04:16:06.943Z` |
| `R2`, `R1`, `C2` shot | `04:16:16Z` – `04:17:49Z` |

## The pictures

`captures-one-off/`. Eight files, four readings, light and dark for every one. Full
window, 1440×900 at device scale 2 (2880×1800), uncropped.

| cell | reading |
|---|---|
| `C1` | the chat card, one-off armed, **before** the fire |
| `C2` | the chat card, the same card, **after** the fire |
| `R1` | the run page's Schedule step, after the fire |
| `R2` | the run page's own reading of the finished run |

## requires / shows / verdict

**`C1` — the chat card, armed, before the fire**
- *requires* (the leg's control): the card this leg fires from is a ONE-OFF armed by the
  person's own Confirm on the card in the conversation — so that `C2`'s freeze is a
  change of state and not the card's resting look.
- *shows*: the assistant's answer "Scheduling card shown. I found **Agent Planner** and
  proposed a one-time run for **August 26, 2026 at 04:15 UTC**. Confirm or adjust the
  schedule on the card in this conversation. I did **not** run the agent now.", and
  below it the card: `Run right after setup` / **`Schedule for later` selected** /
  `Recurring`, `Run at 08/26/2026, 04:15 AM`, `Timezone UTC`, `Estimated run duration
  Unavailable.`, and one control on the floor — **Save changes**. Measured on the whole
  screen: all three mode rows enabled, both schedule inputs enabled, `Save changes` 1,
  `Cancel schedule` 0, **`release-trigger-now` 0**.
- *verdict*: **PASS**, light and dark.

**`C2` — the chat card after the one-off fired**
- *requires* (item 1): "Chat card … one-off fired: read-only, no controls."
- *shows*: the same card in the same conversation, the same rows — `Schedule for later`
  still the chosen row, `Run at 08/26/2026, 04:15 AM`, `Timezone UTC` — both inputs now
  greyed, all three mode rows greyed, and **no floor at all**: the `Save changes` that
  stood in `C1` is gone and nothing replaced it. Measured: mode rows 3/3 disabled,
  inputs 2/2 disabled, `Save changes` 0, `Confirm` 0, `Cancel schedule` 0,
  `Cancel trigger` 0, **`release-trigger-now` 0**.
- *verdict*: **PASS**, light and dark.

**`R1` — the run page's Schedule step after the one-off fired**
- *requires* (item 1): "… and run-page step, one-off fired: read-only, no controls."
- *shows*: `Agent Planner (2)`, the `Setup` tab, the rail rows `1 Schedule` (selected)
  and `Step 1` (checked), and the schedule form drawn **to the right of the rail**:
  `Schedule for later` chosen, `Run at 08/26/2026, 04:15 AM` and `Timezone UTC` greyed,
  all three mode rows greyed, **no floor** — no `Save changes`, no `Cancel schedule` —
  and the prompt window ("Ask Cinatra to suggest edits to the fields above…") sitting
  **below** the scheduler card. Measured: mode rows 3/3 disabled, inputs 2/2 disabled,
  every floor control 0, **`release-trigger-now` 0**.
- *verdict*: **PASS**, light and dark.

**`R2` — the run page's own reading of the finished run**
- *requires* (item 1): "real run on a real model" — the run the one-off fired reached a
  real provider and finished, and the run page says so.
- *shows*: `Agentic Run Progress` with the badge **`completed`**, and the card
  "**Run complete** — This run finished. Its output is in the run transcript below."
  with **Start new run**. **There is no transcript below it**, and nothing else on the
  page carries the model's text; the rail's `Step 1` is checked and opens nothing.
- *verdict*: **PASS on the completion reading, DEFECT on the output reading** — the same
  already-stated defect as `P3` above (the completion copy promises a transcript the
  surface does not render). The run really did produce the model text quoted below; the
  product does not show it. Not re-filed here — it is the `P3` finding, seen again on a
  one-off.

## The rows, read back

The trigger row (the one-off the card armed):

```
run_id             43ddf2b2-681b-4b85-b7c1-ec3c5c82950b
trigger_type       scheduled          (the one-off kind; `recurring` is the other)
scheduled_at       2026-08-26 04:15:00+00
cron_expression    (empty)
timezone           UTC
enabled            t
released_at        2026-08-26 04:15:00.112+00      <- the fire
last_fired_at      (null)             <- a one-off stamps `released_at`, not this
stopped_at         (null)
job_scheduler_id   present
created_at         2026-08-26 03:59:09.62+00
updated_at         2026-08-26 04:15:00.112+00
```

The run it fired:

```
id                 43ddf2b2-681b-4b85-b7c1-ec3c5c82950b
title              Agent Planner (2)
status             completed
template_id        2c35373d-5650-4ddb-b127-a26a47250abb
a2a_task_id        e1bc7ea1-9e97-4913-ae85-8be2f5c30c01
created_at         2026-08-26 03:59:09.674567+00
completed_at       2026-08-26 04:16:06.943+00
error              (null)
```

The app's usage ledger, from the fire onwards — exactly one call:

```
provider  model                 calls  first_at                      last_at
openai    gpt-5.5-2026-04-23    1      2026-08-26 04:16:06.507982+00  2026-08-26 04:16:06.507982+00
```

0.4 s before the run completed.

**This one is bound by an id, not only by time.** Unlike the recurring leg, the run and
the runtime turn are the same record: the run's `a2a_task_id` is the task id in its own
step result, and the payload the runtime received carries
`"cinatra_run_id": "43ddf2b2-681b-4b85-b7c1-ec3c5c82950b"`. The usage-ledger row is
still correlated to the run by TIME (0.4 s before completion, nothing else running) —
`usage_events` carries no run id, so that half is unchanged.

## What the model produced

The run's step result is one `wayflow_response` carrying the agent's `findings` for the
OAS body the run was given (the same "Weekly Support Digest" flow as the recurring leg).
Verbatim:

- `missing_control_flow_connections` — "Add explicit control_flow_connections for
  start → summarise → human review → send → end so execution order and reachability are
  unambiguous."
- `missing_hitl_review_gate` — "Insert an InputMessageNode after the summarise step and
  before send so the human reviews the actual generated digest before delivery."
- `side_effect_needs_gate` — "Declare an approvalPolicy or equivalent confirmation gate
  around the send step because sending the digest to the team is a write/side-effect
  action."
- `define_referenced_components` — "Include $referenced_components for start, summarise,
  send, and end so node types are explicit and the LLM-summary versus delivery node
  choices can be reviewed."

Those sentences are about the flow that was actually handed in; the wording differs from
the recurring leg's four findings on the same body, which is what a model answer looks
like and what a canned one does not.

## Two things this leg found

1. **A schedule armed from the chat card creates a run with NO inputs, and the product
   asks for them only AFTER the fire.** The proposal tool takes an agent and a schedule
   and nothing else, so the run is written with `input_params {}`; the run page shows a
   single `Schedule` step and no configuration step while the schedule is pending. When
   the one-off came due, the run went to `pending_approval` and the run page drew
   `Awaiting input` with the agent's one visible field (`Oas JSON`, labelled
   *(optional)* although the agent's OAS gives it no default). Typing it and pressing
   **Continue** let the run reach the runtime and finish. So a scheduled run of this
   agent does not complete unattended: **it fires on time and then waits for a person**.
   That is what "one-off fired" looks like for an agent with a required input, and it is
   worth a decision — the fire is punctual, the execution is not autonomous.
2. **The run page's completion copy still promises a transcript that is not there** —
   the `P3` defect above, unchanged on the one-off road.

## What this leg does NOT establish

1. **That the usage-ledger row is per-request attributable to this run.** It is bound by
   time, as above.
2. **That the run page ever shows model output.** It does not — see `R2`.
3. **Anything about a recurring schedule.** That is the leg above, and #2978's own
   pictures.
