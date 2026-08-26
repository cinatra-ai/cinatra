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
