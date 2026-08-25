# RUN READBACK — cinatra#2972 / PR #2978

**No row of this lane's database was written by hand.** Each schedule was STATED
in the shipped chat composer, CONFIRMED on the card, CHANGED on the card and
STOPPED with the card's own control; each fire was performed by the shipped
release job on the wall clock. The only SQL any driver here runs is `select`.

**Two clocks, named apart.** In `readback/timeline.json` every step carries
`observedAt` — the driver's own clock at the moment it made the read — and a `db`
block. The times quoted in this document are DATABASE columns unless the line
says "observed".

**And `db` is a MIXED evidence block, not a row of columns.** Per step it holds:
the database rows read at that instant (`trigger`, `run`, `childCandidates` —
every field of those IS a column); values parsed out of the app server's own log
(`clonesNamedByTheReleaseJob`); values this driver DERIVED (`dueAt`,
`dueInstantStillAhead`, the `cronBefore` / `lastFiredBeforeStop` snapshots carried
over from an earlier read, and the counts); and the provider-evidence block. Each
is named for what it is; nothing in it should be read as a column unless it came
out of one of the row objects.

## The three schedules

| run | kind | trigger row created (`created_at`) | what the person stated | the row it produced |
|---|---|---|---|---|
| `8ee96e64-4dc6-494e-b47c-a4d8e6dc1391` | one-off | 15:53:32.670Z | run once at 2026-08-25T15:58 UTC | `scheduled`, `scheduled_at 15:58:00.000Z`, tz UTC |
| `e3d3661f-3789-437c-a4b2-71e366047acc` | recurring | 15:54:12.530Z | every day at 16:05 UTC | `recurring`, cron `5 16 * * *`, tz UTC |
| `433ab1ee-2707-4054-af41-8592d91294ab` | one-off | 16:27:12.275Z | run once at 2026-08-26T09:00 UTC | `scheduled`, `scheduled_at 2026-08-26T09:00:00.000Z`, never fired |

All times UTC, 2026-08-25.

## The timeline, as the database holds it

```
15:53:32.670  T0  the one-off armed by Confirm      scheduled_at 15:58:00.000Z   released_at NULL
15:54:12.530  T0  the recurring armed by Confirm    cron 5 16 * * *   last_fired_at NULL   stopped_at NULL

15:58:00.056  T1  THE ONE-OFF FIRED — released_at 15:58:00.056Z
                  (56 ms after the instant the person stated; last_fired_at and stopped_at
                   stay NULL, which is what a one-off's row looks like)
                  -> cells F1, F2

16:05:00.254  T2  THE RECURRING SCHEDULE FIRED, tick 1 — last_fired_at 16:05:00.254Z
                  the release job's own line names what it cloned:
                    "recurring tick — created new run 0f29f278… from e3d3661f…"
                  child run 0f29f278-9452-4cec-a5e7-b9d5a8d8b416 created_at 16:05:00.268Z
                  the schedule-defining run stays `armed` — a tick does not re-release its own run
                  -> cells G1, G2

16:06:24.744  T3  SAVE CHANGES on the fired card — the MINUTE moved on the rows
                  cron 5 16 * * *  ->  15 16 * * *
                  last_fired_at unchanged (16:05:00.254Z), enabled true, stopped_at NULL
                  -> cell K1  (shot BEFORE the next tick)

16:15:00.217  T4  THE NEXT TICK FIRED AT THE SAVED TIME — last_fired_at 16:15:00.217Z
                    "recurring tick — created new run 309be637… from e3d3661f…"
                  child run 309be637-f31d-4760-a0e1-66bf1833352c created_at 16:15:00.2xxZ
                  two fires, ten minutes apart, at the two times the card carried
                  -> cell K2

16:15:52.620  T5  RE-ARMED to cron 25 16 * * * with the card's own Save changes,
                  so the stop has a DUE INSTANT INSIDE THIS ROUND: 16:25:00.000Z

16:16:09.197  T6  CANCEL SCHEDULE — stopped_at 16:16:09.197Z, enabled false,
                  job_scheduler_id STILL PRESENT, run status still `armed`
                  (pressed while 16:25:00Z was still ahead)
                  -> cells J1, J2

16:25:00.000  T7  THE DUE INSTANT CAME AND WENT
16:26:35 obs      last_fired_at STILL 16:15:00.217Z  ·  clones still exactly two
                  (0f29f278…, 309be637…)  ·  child candidates 2 -> 2
                  the round waited past the instant and read the row back

16:27:12.275  T8  a one-off armed for tomorrow 09:00 UTC — configured, and not run
                  -> the re-shot S9d-C3 pair
```

## What each owed item reads back as

**(1) A one-off that fired.** `released_at 2026-08-25T15:58:00.056Z` against a
`scheduled_at` of `15:58:00.000Z`. F1 and F2 were driven only after that column
was non-null: the fire is a database fact, not a selector.

**(2) A recurring schedule that fired once.** `last_fired_at
2026-08-25T16:05:00.254Z`, and the release job's own log line names the run it
cloned. **On parentage:** `agent_runs.parent_run_id` is NOT set by the recurring
clone path, so no database column links a child to its schedule. The parentage
each record carries is that log line — `recurring tick — created new run <child>
from <parent>` — written by the shipped job at the moment it clones. The SQL
result is recorded beside it as `childCandidates`, under a different name, and is
corroboration rather than proof: it selects immediate-triggered runs of the same
template in the window, which is what separates a clone from the lane's own
`scheduled` one-off but would also admit any other immediate dispatch.

**(3) A saved change, and the real tick that honoured it.** Cron `5 16 * * *`
fired at `16:05:00.254Z`; Save changes moved it to `15 16 * * *` at
`16:06:24.744Z`; the NEXT tick fired at `16:15:00.217Z` — at the saved minute,
not the armed one — and the release job cloned a second run. Two fires, ten
minutes apart, at the two times the card carried. **Not partial.**

**(4) Cancel schedule, and a due instant that passed with nothing behind it.**
`stopped_at 2026-08-25T16:16:09.197Z`, `enabled false`, `job_scheduler_id` STILL
PRESENT — the plan's "it never deletes the schedule" — and the run's own `status`
still `armed`: not paused.

And the stop was tested against a real deadline rather than a gap. The daily
recurrence puts an untouched schedule's next tick a day out, so before the stop
the schedule was RE-ARMED with the card's own Save changes to `25 16 * * *` —
`16:25:00Z`, ten minutes ahead — Cancel schedule was pressed while that instant
was still in the future, and the round then WAITED PAST IT. Read back afterwards:
`last_fired_at` still `16:15:00.217Z`, the release job's clone lines still exactly
two, the child candidates still two. The schedule's own next due instant came and
went and nothing fired.

**(5) Run now.** `page-controls.json` records
`document.querySelectorAll('[data-action="release-trigger-now"]').length` on
EVERY pictured surface — eighteen surfaces, every one `0` — and the assembler
aborts rather than writes if any row is not.

## The provider, and what these records can and cannot say

The shipped usage ledger, WINDOWED TO THIS ROUND (`ROUND_STARTED_AT` onwards)
rather than to the whole database:

```
provider  model     calls  first_at                  last_at
openai    gpt-5.5   3      2026-08-25T15:53:25.464Z  2026-08-25T16:27:04.848Z
```

Three calls, and no other provider or model row in the window. The round stated
three schedules, so the count is TEMPORALLY ALIGNED with the three turns —
**and that is an alignment, not an attribution.** `usage_events` carries no turn
or thread id, so a row inside the window is a call this lane made during the
round; it is not provably the call behind one particular turn, and no field in
this directory makes that link. What the window DOES establish is that no call
this round made was served by the scripted runtime, which writes its own model id
and has no row here. Each capture record carries the same window as
`usageSinceRoundStart`, read at its own shutter.

The app server's own log, read at the close of the round:

```
preRouterShortCircuits   0     the deterministic chat dispatch never short-circuited a turn
preRouterAttempts        0     and never attempted to
scriptedRuntimeLines     0     no line naming the scripted provider/runtime
noProviderRefusals       0     the bridge never refused for want of a provider
mcpDependencyFailures    0     no 424 on the provider's toolbox fetch
publicMcpCallbacks       >0    POST /api/mcp — the public ingress served MCP calls
triggerReleaseLines      >0    the release job's own lines
serverScriptedProviderEnv  null      read from the process table, 1 hop above the listener
serverEnvReadFrom      process-table
```

(The exact counts are on every record and in `readback/db-readback.json`.)

READ THE NEGATIVE SCREENS FOR WHAT THEY ARE. Each names a line the server writes
when a leg goes wrong, so a hit proves a stood-in leg and a zero is the absence
of that one line — nothing more. `serverScriptedProviderEnv` is asymmetric in the
same way: a non-null answer would prove the flag is present, and every shutter
aborts on it; a null answer read one hop above a listener that rewrote its argv is
CONSISTENT with absence and is not a proof of it. `CINATRA_TEST_LLM_PROVIDER` is
absent from this lane's env file and from every driver process, and EVERY shutter
re-reads all of the above and refuses to fire if any screen is non-zero.

`bridgeRunSelects` is 0, and that is expected here rather than a gap: it counts
the AGENT's own step reaching the model bridge under its run token, and no agent
step ran — see the limit below. The model calls the pictured chain depends on are
the schedule-stating CHAT turns, and the three ledger rows above are the calls
made while those turns were being answered.

**Turns the runtime refused:** `turnsRefusedOrUnanswered: 0` for this round. The
runtime probes the public MCP ingress before every turn and REFUSES the turn when
the probe misses its budget (`checkPublicMcpReachability`); a refused turn draws
no card and creates no run, so the walk states the sentence again in a fresh
conversation and counts it. It did not need to this round.

## The one limit, named

**The WayFlow agent runtime is not deployed on this capture host.** Every run
these schedules produced — the one-off itself and both recurring children — was
created, gated and enqueued by the app and then FAILED its own execution with
`Could not reach the agent runtime at …:3010 — fetch failed (ECONNREFUSED)`.

That is a fact about the AGENT's execution, not about the schedule. Every schedule
fact above — `released_at`, `last_fired_at`, `stopped_at`, the cron rewrites, the
cloned runs and their creation times — is written by the shipped release job and
read back out of the database, and every cell photographs the SCHEDULER.

**What it costs, said plainly.** The issue's acceptance item 1 asks for the fired
readings "on a real run on a real model". The MODEL leg of the pictured chain is
real — the schedule was stated to the configured provider and the card is the
model's own answer — but the run the schedule fired did not reach the agent
runtime, so it never produced a result. That half is NOT proved here, and this
slice does not claim it: the PR keeps `Part of #2972` rather than `Closes`, and a
lane with the runtime deployed owes the remainder.
