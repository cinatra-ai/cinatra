# cinatra#2970 (PR #2975) — C7, the setup run page of a run that has not started

> **These pictures pre-date the rail-label fix, and they are kept for what they
> caught.** They were shot on `04e83f5b`, where every rail row drew its numeral
> above an EMPTY title. The fix landed in `f8b53416` on this branch. The owed
> re-shoot is **round 6 of the #2939 proof set**, `evidence/2788-s9d-rework/` —
> C7 re-shot on the two-column surface with the rail naming its steps, plus C9,
> C10 and C11 for acceptance items 2 and 3. Nothing in this folder was re-taken:
> a picture of a defect is worth keeping as the record of the defect.


Head under proof: the PR branch head this lane drove, plus this evidence commit.

**Read `PLAN-WALK.md` beside this file.** It names, for every cell here, the exact
plan sentences that govern the screen, copied character-for-character from
`PLAN: Agents Lifecycle (A)`, and says what the picture answers — including where
it does not answer.

## The headline, first

**The ruling holds, and the pictures prove it.** On a run that has not started,
the setup run page draws the two-column run surface: three rows on the rail, the
schedule step OPEN with its scheduling form in the right-hand column, and the two
steps the run has not reached — the skills recommendation and the review — muted.
Both muted rows were then PRESSED. Nothing happened: the scheduler stayed open and
the detail column's DOM came back **byte-identical** (the same SHA-256 digest before
and after). The two pictures are not byte-identical, and the record says exactly why
rather than waving at it: 13 pixels differ, all of them inside the product wordmark
in the sidebar header (bounding box x 84–169, y 66–79 in device pixels), and
**0 of them are inside the run surface** — the recorder writes down where the run
surface is in the picture and the diff counts against that rectangle
(`clickProof.pixelDiff`).

**And the pictures caught a defect the suites cannot see.** The rail does not NAME
its steps. Read on.

## What the pictures caught

The ratified drawing (design `app-artifact-review.html` §I, the drawing this issue
is measured against) says: *"a step rail down the left **names** the run's ordered
steps"*. On this head the rail draws each row's numeral and an **empty title**:

```
<span data-conformance-id="run-surface-rail-indicator" …>1</span><span class="text-sm font-medium text-foreground"></span>
```

— taken from the server-rendered HTML of the page in the pictures. Each row's whole
text content is `"1"`, `"2"`, `"3"` (`controls.rows[].text` in
`capture-records.json`).

**Why it happens, grounded:** `run-surface-rail.tsx` is a `"use client"` module, and
`instance-screens.tsx` — a server component — imports the label constant
`RUN_SURFACE_RAIL_LABELS` from it. Under React Server Components every export of a
client module reaches a server component as a client REFERENCE, not as its value, so
the labels the screen passes are not the strings the module declares. The row
component itself is fine: the same component draws `1 Recommendation` with its name
when a CLIENT parent hands it the label (`schedule-rail-step.tsx`, also a client
module — the schedule row on the trigger tab of a scheduled run renders its title),
and the rendered suite `setup-run-surface-rail.test.tsx` asserts `"1Schedule"` /
`"2Recommendation"` and passes, because a test environment is not an RSC boundary.
That is exactly why this is a picture's finding and not a suite's.

**It is NOT fixed here.** This lane shoots the owed cell; it does not change the
change under review. The consequence for the issue is stated where it belongs: on
the pull request, and in the pull request's own `Part of #2970` line, which stays
`Part of` for this reason.

## Why the pictured run is not the scheduled one

The brief for this cell described a one-off *"Schedule for later"* run
(`pending_trigger`) as the natural case. The instance answers differently, and the
difference is worth writing down: **once a schedule is confirmed, the run owns a
persistent trigger row, and the run page then draws the Trigger tab rather than the
setup rail** (`showPersistentTab && trigger` in `instance-screens.tsx`). A run whose
schedule is armed is therefore never on the screen this issue changes.

The setup run page is the screen a run is on **before** its schedule is armed. So
the pictured run is a run that reached exactly that point through the app's own
paths: asked for in the app's own chat with the real provider, created by the app's
own dispatch, and moved to `pending_trigger` — "setup finished, awaiting the user's
trigger choice" — by answering the run's own setup step on the run page. It has no
trigger row and has never executed. `RUN-READBACK.md` carries every timestamp with
the database column it was read from.

The scheduled run the brief describes was ALSO driven, on the same instance, in the
same session: stated in the chat, the schedule proposal card drawn in the reply,
**Confirm** pressed on the card, and the run armed with a one-off trigger about an
hour ahead. It is section 2 of `RUN-READBACK.md`, and it is the provider evidence
for this lane.

## The runtime, said first

`node scripts/dev-server.mjs` (Next.js, Turbopack), `CINATRA_RUNTIME_MODE=development`,
`NODE_ENV != production`, on a **dedicated lane database** on the local verify
Postgres and Redis, loopback-only, with this branch's own extension tree. The lane
tree is a clone of the repository pinned to the head above, with the workspace
packages carried across; every symlink in it was measured to be worktree-local
before anything was driven.

It is **not** a production-equivalent build: this is the dev server, so the surfaces
are the dev build of the same components. Every record is labelled `dev-runtime`.
Cells are shot at `deviceScaleFactor: 2`, uncropped, at the full window.

**A REAL MODEL PROVIDER, configured through the app's own form.** The instance's
provider was set up on `/setup/model` — the app's own setup step — by a driver that
read the credential from its process environment and typed it into the form, so the
app sealed the connection itself (`drivers/03-provider-setup.mjs`). The credential
is in no file here, in no argument, in no log and in no record.
`CINATRA_TEST_LLM_PROVIDER` is set in nothing this lane starts, and the app server's
process chain was read for it one hop above the listening process and did not carry
it (`serverScriptedProviderEnv: null`). What that reading is worth is stated where it
is made: a non-null answer would be PROOF the flag is present, and a null answer is
consistent with absence without proving it in the listening process itself. What is
positively established is the other side: `cinatra.usage_events` records the calls
the instance actually made — provider `openai`, model `gpt-5.5` (`RUN-READBACK.md`
§3) — and the transcript of the setup run that configured it is
`logs/03-provider-setup.txt`.

**The public origin was set through the app's own UI** at
`/configuration/development?tab=tunnel` — origin only, never by hand-editing the
database — and read back through the app's own `/api/mcp-settings`
(`drivers/04-set-public-origin.mjs`). The app's own health endpoint answered `200`
on both the loopback and the public origin before any pictured turn.

## The one fallback in this lane, named

The model's hosted MCP connector fetches this instance's tool list over the public
origin. On the FIRST turn of a cold OAuth path that fetch answers `424`, the app
logs `MCP tool enumeration failed (424) — retrying stream without MCP tool (dev)`,
and that turn runs without Cinatra tools; the NEXT turn resolves the list and works.
The server's own lines for that are copied verbatim into
`logs/mcp-tool-list-424.txt` — the observation is the log's, not this file's.

This lane does not hide that and does not stand anything in for it. Each measured
sequence sends **one warm-up turn first**, and the negative screens are read from the
log offset taken AFTER the warm-up was answered — so the screens answer for the
measured sequence (all five read `0`), while the `session` counts beside them still
carry the whole server session, warm-up included, and are not zero. The decisive leg
is the real one either way: the schedule proposal card in the reply was rendered by
the instance's own `schedule_proposal_render` MCP tool, called by the model through
the public toolbox.

## The direct-SQL lane writes, disclosed — there are two

Both are account provisioning for a throwaway lane account on a database that is
dropped when the lane ends. Neither touches a run, a trigger, a gate, a record or
any row a photographed screen reads.

1. **`UPDATE public."user" SET role='admin'`** (`drivers/01-lane-setup.mjs`) — the
   lane account is made an administrator, because the setup and configuration
   screens this lane has to walk (`/setup/model`, `/configuration/development`) are
   admin-gated.
2. **`INSERT INTO public.member`** (`drivers/02-join-template-org.mjs`) — the lane
   account joins the organization the instance's own boot stamped every agent
   template with. A run proposal is refused outright for a template outside the
   caller's active organization, so without it no product path can be walked at all.

Nothing else in this lane writes to the database. The whole set is what
`grep -rniE "insert into|update |delete from" drivers/` returns: exactly those two
statements and nothing else. (The narrower seeding grep —
`insert into|SEEDED_|seedGate|seedTurn|update .* set status` — returns only the
`INSERT`; it is quoted here as the seeding screen it is, not as the write
inventory, which is the list above.)

## The cells

| cell | what it shows |
|---|---|
| `C7__setup-run-page__light.png` | the setup run page, light: rail left (1 open, 2 and 3 muted), the scheduling form open on the right, no run progress |
| `C7__setup-run-page__dark.png` | the same page, dark |
| `C7-click__setup-run-page__light.png` | the same page immediately after BOTH muted rows were pressed |

`capture-records.json` carries, per cell: the SHA-256 of the image, its pixel size,
the theme the page actually resolved to, the run id, the DB readback at the shutter,
and the **page-controls sidecar** — every rail row's tag, key, text, selected mark,
reached mark, `aria-disabled`, `data-action`, whether it carries the native
`disabled`, and its tab index — plus the detail column's own controls, so what is in
the right-hand column is read off the DOM rather than inferred from the picture:
`detailColumnButtons` lists the form's own controls in order (`Run right after
setup`, `Europe/Berlin`, the recurrence controls, …), and `runSurfaceRect` records
where the run surface sits in the picture, which is what makes the pixel comparison
above a measurement. Two counts beside it read 0
and are named for exactly what they count rather than for what a reader might hope
they mean: `scheduleRailStepAnchors` (`ScheduleRailStep`'s row anchors — a different
mount from the form this page draws) and `detailColumnNativeRadioInputs` (the option
rows are buttons, not native radios).

**These are not records of the canonical lifecycle-card index, and `capture-walk.json`
says why.** Every record in `scripts/ci/chat-hitl-capture-index.json` asserts
`[data-lifecycle-card-host="<host>"]` (`requiredAssertionsFor`,
`scripts/ci/lib/capture-record-contract.mjs`). This screen draws no lifecycle card at
all — `lifecycleCardHosts: 0`, which is half of what the cell proves — so an index
record for it could only be made by inventing an anchor. The canonical index is
**unchanged by this lane**: it carries no `C7` cell (it never did), and no record in
it was rewritten.

## The presses, and why they are forced

The two rows under proof carry `aria-disabled="true"`, and Playwright's own
actionability treats that as not-enabled: an ordinary click would wait forever and
never deliver the press. A row that is never pressed proves nothing about what
pressing it does. So the press is delivered as a real mouse click on the row the
page draws (`{ force: true }`), and what the page does with it is then measured —
the DOM digest of the detail column before and after, the selected step before and
after, and the two pictures.

## Reproducing it

```
export WALK_BASE=http://127.0.0.1:<port>
export SUPABASE_DB_URL=<the lane database>
node evidence/2970-setup-rail/drivers/08-chat-run-parked.mjs     # the run, from the chat
node evidence/2970-setup-rail/drivers/09-answer-setup-step.mjs   # its own setup step, answered
node evidence/2970-setup-rail/drivers/06-capture-c7.mjs          # the three cells
python3 evidence/2970-setup-rail/drivers/10-pixel-diff.py        # the pictures, compared
```

The drivers hold no credential and no origin: every one of them reads what it needs
from the environment of the lane driving it.
