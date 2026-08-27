# RUN-READBACK — the rows behind the pictures (cinatra#2934 W5c)

Everything below is read out of the instance's own database after the fact. Every run, every gate,
every window row and every install row was written by the app itself, through its own screens.

## Every run this leg created

| run | agent | status at the end | created |
|---|---|---|---|
| `e915e59b-4447-44dd-b777-3ceeaeacb423` | Email Outreach Agent (1) | `pending_approval` — parked at step 2, `@cinatra-ai/email-outreach-agent:list-picker` | `2026-08-27 18:16:47Z` |
| `e0e17603-17b4-4c93-ad3b-9c60eaa84aca` | Blog Draft Writer Agent (1) | `pending_trigger` | `2026-08-27 18:18:01Z` |
| `1c8eb619-91c8-4c54-a372-5ecb490c120b` | Blog Draft Writer Agent (2) | `pending_approval` | `2026-08-27 18:29:03Z` |
| `25866caa-97f8-43e9-924b-0dc46e5b655b` | Blog Draft Writer Agent (3) | `failed` — `WayFlow task failed` | `2026-08-27 18:34:39Z` |

**Which run carries which capture.** `25866caa…` carries the three run-page readings and the schedule
reading. `e915e59b…` carries the draft, the fill and the attachment readings on the step-by-step
screen. `e0e17603…` and `1c8eb619…` carry **no** capture: `e0e17603…` is the first run of the leg, on
which the road was found working before a picture was framed, and `1c8eb619…` is a discarded
measurement whose turns were all served without a toolbox — both are listed rather than deleted, and
neither is graded.

## The run page — run `25866caa-97f8-43e9-924b-0dc46e5b655b`

The gate: `agent_run_hitl_gates` one row, `x_renderer = @cinatra-ai/agent-builder:schema-field-fallback`,
`input_schema` = `{"type":"object","title":"idea","required":["title"],"properties":{"title":{"type":"string"},"outline":{"type":"array",…},"summary":{"type":"string"}},"x-multiline":true,"x-placeholder":"What should this post be about?","x-object-text-property":"title"}`.

The window rows, in order — `role` · what the row carries:

1. `user` — `make the idea "A weekly publishing rhythm beats a burst of posts" and leave everything else as it is`
2. `assistant` — `The assistant could not answer just now — please try again.` (the turn was served
   without its toolbox; the SAME message was sent again, and the retry is stamped in `timeline.jsonl`)
3. `user` — the same message again
4. `assistant` — **a fill**, `values: {"title":"A weekly publishing rhythm beats a burst of posts"}`
5. `assistant` — `Placed in the fields on the person's screen. Nothing was submitted — they press the button.`
6. `user` — `what is this field for?`
7. `assistant` — the answer, naming the step's own inputs. **No fill row.**
8. `user` — `set the idea to "Why cadence beats bursts for blog reach" and send it`
9. `assistant` — **a fill**, `values: {"title":"Why cadence beats bursts for blog reach"}`
10. `assistant` — `Submitted.`

DOM readback across all three readings: `field-idea` `""` before and `""` after rows 4–5 and 6–7. The
run's status is `pending_approval` across the first two readings and `pending_trigger` after row 10.
`input_params` stayed `{}` throughout; the gate's `gate_values` stayed `{}`. The assistant pressed the
screen's own button on exactly one message — the one that asked for it in so many words.

## The step-by-step screen — run `e915e59b-4447-44dd-b777-3ceeaeacb423`

The gate at the time of the fill: `x_renderer = @cinatra-ai/email-outreach-agent:setup-form`,
`gate_values = {"stepNumber": 1}`, `input_schema.properties` = `offeringCompanyWebsite`, `callToAction`,
`senderName` — the three fields the screen draws.

- **The draft.** `please set the call to action to` was typed and not sent. The browser's own storage
  held it under `cinatra_hitl_assist_<templateId>_@cinatra-ai/email-outreach-agent:setup-form`; after a
  real reload the field still held it, character for character. The run's store gained no row.
- **The fill.** One `user` row with the person's sentence, then an `assistant` fill row with
  `values: {"offeringCompanyWebsite":"https://example.test","callToAction":"Book a 20-minute demo"}`,
  then `Placed in the fields on the person's screen. Nothing was submitted — they press the button.`
  DOM before → after: `offeringCompanyWebsite` `""` → `https://example.test`, `callToAction` `""` →
  `Book a 20-minute demo`, `senderName` `""` → `""`. Run `pending_approval` → `pending_approval`;
  `gate_values` still `{"stepNumber": 1}`; `input_params` still `{}`.
- **The attachment.** The person's own row carries
  `attachments:[{"artifactId":"46fe5d30-…","representationRevisionId":"7dd7f986-…","digest":"fc229281fecb9de12d4847a9b0f861ef1a509c010a2a1636036dd549aca871bc","mime":"text/plain","originKind":"upload","filename":"campaign-brief.txt","title":"campaign-brief.txt","size":130}]`.
  The same message's fill row carries `{"senderName":"Rita Owner"}`; the next row is `Submitted.`
  **What actually reached the waiting agent** is in the app's own runtime line for the resumed task:
  `history_last=[{"role":"user","parts":[{"kind":"text","text":"{\"text\":\"{\\\"stepNumber\\\":1,\\\"senderName\\\":\\\"Rita Owner\\\"}\",\"attachments\":[{…\"filename\":\"campaign-brief.txt\",\"size\":130…}]}"}]…]`
  — the screen's own values with this message's fill over them, and the file with them. A second gate
  row then materialized: `@cinatra-ai/email-outreach-agent:list-picker`, `{"stepNumber": 2}`, at
  `2026-08-27 18:52:40Z`.
- **A fill from an earlier message re-applied after a reload.** On the freshly loaded page the three
  fields read `""`; the turn wrote no fill; after it the fields read `https://example.test` and
  `Book a 20-minute demo`. The rows prove the turn placed nothing, so the values came from the run's
  earlier stored fill.

## The schedule screen — run `25866caa-97f8-43e9-924b-0dc46e5b655b`

`user` row: `schedule this for later — tomorrow at 09:00 in the Europe/Berlin timezone`. `assistant`
row: `This screen can't schedule the run. It only has these fields: | title | Blog idea/title | |
summary | Draft summary | | outline | Draft outline | Use the schedule controls on the run screen to
set August 28, 2026 at 09:00 Europe/Berlin.` **No fill row.** `scheduledAt` `""` before and after.

## What the review leg would have needed, and what stopped it

`cinatra.artifact_review_gates` holds **0** rows. Run `25866caa…` was carried by the PERSON's own
presses through its setup gate and its context gate and then failed inside the draft step:
`agent_runs.error = 'WayFlow task failed'`, and the runtime's own line is
`RuntimeError: error executing POST request to …/api/llm-bridge: 500, {"error":"Internal server error","detail":"The AI provider could not reach this instance's public MCP server … (HTTP 424 Failed Dependency), so the agent run was stopped."}`.

## Provider evidence, and its limits

`cinatra.usage_events` on this instance, at the end of the leg:

| provider | model | calls | input tokens | output tokens |
|---|---|---|---|---|
| openai | `gpt-5.5-2026-04-23` | 40 | 29,585 | 3,855 |
| openai | `gpt-5.5` | 13 | 277,854 | 3,600 |

The instance's own screens: **35** `POST /api/mcp 200` callbacks from the provider's own servers over
the public origin, **3** `llm-bridge-run-select` lines from the agent runtime, **0** scripted-runtime
lines, **0** `NO_LLM_PROVIDER` refusals. Against those: **3** `424 (Failed Dependency)` tool-list
failures and **9** `refusing to run the turn without Cinatra tools` refusals — the flapping ingress.

**The limit, stated rather than implied**: a zero on a screen is the absence of that particular line
and nothing more. The provider connection was configured through the app's own `/setup/model` form, so
the credential is in no file, no argument and no log here; the instance holds a sealed
`openai_connection` row, which is what was read back.

## Direct-SQL lane writes, disclosed

**None.** No run, gate, park, record, review task, membership row or install row was written by hand.
The people were created through the app's own sign-up, the membership through the app's own invite and
accept, the instance namespace through `/setup/name`, the provider through `/setup/model`, the public
origin through the development configuration screen's tunnel tab, and the six agent packages through
the product's own Upload Extension screen (`installed_extension` rows read back `status=active`,
`owner_level=organization`). Every database statement in this leg is a `select`.
