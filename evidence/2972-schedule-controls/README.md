# The pictures cinatra#2972 / PR #2978 owed

Eighteen pictures, nine readings, light and dark for every one. Each schedule was
STATED in the shipped chat composer, drawn as a card by the model's own answer,
CONFIRMED on the card, and then left to come due on its own clock. Nothing was
inserted, seeded or released by hand, and no clock was moved.

What the provider evidence here does and does not carry is set out under
"What these records do NOT establish" below, and in full in `RUN-READBACK.md`.
The short form: nothing in this directory identifies which model answered which
turn.

## What is here

```
captures/             the eighteen full-window pictures, uncropped
capture-records.json  one record per picture: the anchors counted off the live
                      page, the sha256 of the file on disk, the run id, the
                      database rows the cell is gated on, and the ledger window
                      for the round
page-controls.json    the Run-now count read off EVERY pictured surface, plus the
                      run page's two geometric readings
readback/timeline.json      the round's steps: an observation clock and the
                            database columns read at each one
readback/db-readback.json   the lane's runs and trigger rows at the close
RUN-READBACK.md       the timeline in prose, and every limit
PLAN-WALK.md          the two plan sentences verbatim, and requires/shows/verdict
drivers/              everything that was run, in order
```

## The nine readings

| cell | reading |
|---|---|
| `F1` | a one-off, after it fired, in the conversation — read-only, no floor |
| `F2` | the same fired one-off on the run page's Schedule step |
| `G1` | a recurring schedule, after its first fire, in the conversation — the same rows, Save changes |
| `G2` | the same on the run page — Save changes AND Cancel schedule, the prompt window under the scheduler |
| `K1` | a row changed on a fired recurring schedule and saved — shot BEFORE the next tick |
| `K2` | the NEXT real tick, fired at the saved time |
| `J1` | after Cancel schedule, on the run page — non-editable, no floor |
| `J2` | the same stop, read in the conversation |
| `S9d-C3` | configured and not run, on the run page — the canonical cell this slice makes stale, re-shot |

## The recurrence this lane could state, and why

The product's recurrence vocabulary starts at **daily**
(`packages/agents/src/trigger-recurrence.ts`: `daily | weekly | monthly |
quarterly | yearly`), and the card's own rows offer hours `00`–`23` with minutes
on a five-minute grid (`schedule-proposal-card.tsx`). There is no minutes-level
recurrence to state, so the smallest schedule a person can truthfully express
through the product's own surfaces is **daily at HH:MM**.

That would have made two of the owed readings a day's wait if the change under
test were the HOUR. It is not. The MINUTE is on the card's own grid inside one
hour, so the round arms the schedule at one boundary and moves it with the card's
own Save changes to the next — twice:

- once to prove the change is HONOURED (`K1` → the tick at the saved minute → `K2`);
- once to give the STOP a due instant of its own inside the round: the schedule
  is re-armed to a third boundary, Cancel schedule is pressed while that instant
  is still ahead, and the round then WAITS PAST IT and reads the row back
  (`J1`, `J2`, and step `T7`).

Nothing was waited out artificially and no clock was moved.

## The one index cell this slice replaces

`scripts/ci/chat-hitl-capture-index.json` carries ten schedule-card records. This
branch changes the reading of exactly ONE of them:

- **`S9d-C3__schedule-card__run_card__decided`** (and its `__dark` twin) — the run
  page's Schedule step for a configured, not-yet-run schedule. The committed
  picture shows **Run now**, a control this slice removes, and no prompt window,
  which this slice adds. Both records are spliced to pictures re-shot on this
  branch of the same reading.

- **`S9d-C6…__after-fire`** is deliberately LEFT ALONE. It is the fired one-off in
  the conversation, and that reading is unchanged by this slice — read-only rows,
  no floor, before and after. `F1` here is a fresh record of the same reading on
  this branch; it does not replace C6, and C6's bytes are untouched.

`drivers/02-assemble-and-splice.mjs` NAMES the two cells in the tool itself and
refuses to run if it is handed any other set, then verifies the written file
three ways: exactly those two records changed, every other record is
byte-identical to the one it replaced, and the record count is unchanged. It
aborts rather than writes if any of the four fails.

## The chain, and the direct-SQL disclosure

The instance was brought up through its own surfaces: the first account, the
instance name and the LLM provider were all created by driving the app's own
setup wizard, and the public origin was set on the app's own
`/configuration/development` tunnel tab. **No row of this lane's database was
written by hand.** The only SQL any driver here runs is `select` — the drivers
poll the release job's stamps and read the rows back, and that is all.

The walk RETRIES a turn the runtime refuses. The runtime probes the public MCP
ingress before every turn and refuses the turn when the probe misses its budget;
a refused turn draws no card and creates no run, so the sentence is stated again
in a fresh conversation and the count is recorded as
`turnsRefusedOrUnanswered` in `readback/timeline.json`.

## What these records do NOT establish

Stated here rather than left to be discovered, because each one is a real
boundary of this evidence:

1. **Which model answered which turn — and that the fired run reached a model at
   all.** The shipped usage ledger records the provider and model of every call
   but carries no turn or thread id, so the ledger window on each record is
   TEMPORALLY ALIGNED with the round's turns and is not a per-request
   attribution: it says three calls were made inside the window, not that call
   *n* answered turn *n*. What the window does establish is that no call this
   round made was served by the scripted runtime, which writes its own model id
   and has no row in it. The negative screens on every record are screens: a hit
   proves a stood-in leg, a zero is the absence of that one line. And the run the
   schedule fired never reached the agent runtime at all (limit 3 below), so its
   model execution is not proved here either.
2. **Which run a tick cloned, from the database alone.** `agent_runs.parent_run_id`
   is not set by the recurring clone path, so no column links a child to its
   schedule. The parentage each record carries is the release job's OWN log line,
   `recurring tick — created new run <child> from <parent>`, and the SQL
   candidates are recorded beside it under a different name as corroboration.
3. **That a scheduled agent produces output.** The WayFlow agent runtime is not
   deployed on this capture host, so every run these schedules produced was
   created, gated and enqueued by the app and then failed its own execution. Every
   cell here photographs the SCHEDULER; none claims the agent's result.
   `RUN-READBACK.md` carries the exact error and what it does and does not touch.

## How it was run

```
drivers/00-lane.mjs                 shared: sign-in, the read-only database queries, the
                                    release job's parentage lines, the ledger window, and the
                                    provider-evidence reader every shutter is gated on
drivers/01-walk.mjs                 the whole walk in one pass, in the order the plan describes:
                                    arm -> wait for the fires IN THE DATABASE -> shoot; Save
                                    changes and the tick that honours it; then the re-arm,
                                    Cancel schedule, and the due instant that passes with
                                    nothing behind it
drivers/02-assemble-and-splice.mjs  lays out the records, writes the sidecar, splices the index
drivers/03-readback.mjs             the closing database and provider-evidence read
```

Each driver takes its lane's origin, database URL, template id and account from
the environment. A committed plan carrying a host, a port or a session is a leak
and a plan the next operator cannot run.
