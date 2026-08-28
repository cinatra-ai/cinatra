# RUN-READBACK — every run this leg created, and what the database says about it

All rows read with `select` only. **No run, gate, park, record or review task was written by hand at
any point in this leg**, and the drivers carry no `insert`/`update` statement of any kind.

## The runs

| run | agent | what it is here | final row |
|---|---|---|---|
| `a5613ebb-d11c-4b75-a462-ebe399961bc5` | Blog Draft Writer Agent | the schedule reading and the armed-trigger tab | `status=armed`; `input_params={"idea": {"title": "Why cadence beats bursts for blog reach"}}` |
| `fc9f58d7-4de8-480a-901e-244f2a178a16` | Blog Draft Writer Agent | the run page's three readings (the kept captures) | `status=pending_trigger`; `input_params={"idea": {"title": "Why cadence beats bursts for blog reach"}}` |
| `b61089bd-b850-4e77-a757-da3dff059aa9` | Blog Draft Writer Agent | the first review-run attempt; in no picture | `status=failed`, `error=WayFlow task failed`; its artifact produced review gate `b3f16977` (`pending`, unused) |
| `aced3514-2bee-4126-be19-a4ec2d0e7170` | Blog Draft Writer Agent | the review page's two readings | `status=failed`, `error=WayFlow task failed`; artifact produced, review gate `40533412` |
| `lifecycle-repair-run:f312794a-d5b8-4c71-90af-e6737a50eebe` | Blog Draft Writer Agent | the repair the request for changes put in flight | `status=pending_approval`, parked on setup field `idea`; no page renders for it |
| `d88ddadc-5300-46e5-b42d-27c39f62153d` | Email Outreach Agent | the step-by-step readings | `status=pending_approval` at step 2 |

## The run page (`fc9f58d7`)

The gate this run parked on is the object-valued case the run-page defect lived in:

```
field_name = "idea"
input_schema = {"type": "object", "title": "idea", "required": ["title"],
                "properties": {"title": {...}, "outline": {...}, "summary": {...}},
                "x-multiline": true, "x-placeholder": "What should this post be about?",
                "x-object-text-property": "title"}
```

Six window rows for three messages, in order — a fill for the first, an answer, an answer for the
second, a fill and `Submitted.` for the third:

| # | reading | field before → after | run row | store |
|---|---|---|---|---|
| 1 | `make the idea "…" and leave everything else as it is` | `field-idea` `""` → `A weekly publishing rhythm beats a burst of posts` | `pending_approval` → `pending_approval` | one fill row for that message; `input_params` still `{}` |
| 2 | `what is this field for?` | unchanged | `pending_approval` → `pending_approval` | no fill row |
| 3 | `set the idea to "Why cadence beats bursts for blog reach" and send it` | the screen re-read into the scheduler form | `pending_approval` → `pending_trigger` | a fill row then `Submitted.`; `input_params={"idea": {"title": "Why cadence beats bursts for blog reach"}}` |

Every turn was served on its first attempt: `toolboxMissing: false`, `platformCouldNotAnswer: false`.

## The schedule screen (`a5613ebb`)

| before | after |
|---|---|
| `scheduledAt` `""`, run `pending_trigger`, `agent_run_triggers` empty | `scheduledAt` `2026-08-28T09:00`, run `pending_trigger`, `agent_run_triggers` **still empty** |

The answer above the box: `Placed in the fields on the person's screen. Nothing was submitted — they
press the button.`

## The armed trigger (`a5613ebb`)

After the PERSON pressed the form's own button:

```
agent_run_triggers: trigger_type=scheduled  scheduled_at=2026-08-29 07:00:00+00
                    timezone=Europe/Berlin  released_at=NULL
agent_runs.status = armed
```

No fill was attempted on the armed tab and none is claimed.

## The review page (`aced3514`, gate `40533412`)

```
gate 40533412  before: status=pending   disposition=NULL   resolved_at=NULL
               after the QUESTION:      status=pending   disposition=NULL
                                        artifact_review_dispositions = 0 rows
                                        lifecycle_repair             = 0 rows
                                        decision bar ["Comment","Reject","Approve"], rationale ""
               after the REQUEST:       status=resolved  disposition=changes_requested
                                        resolved_at=2026-08-28 00:27:23.082771+00

lifecycle_repair f312794a  status=dispatched  attempt=1  route=producer_repair
                           successor_gate_id=NULL
                           findings=[{"id": "prompt-window",
                                      "message": "tighten the opening paragraph"}]
```

`findings[0].message` is character-for-character the sentence the person typed.

The repair run's own row carries the whole request:

```
lifecycle-repair-run:f312794a-…  status=pending_approval
input_params.lifecycleRepairRequest = {kind: lifecycle_repair_request, repairId: f312794a…,
  gateId: 40533412…, attempt: 1, baseTarget: {artifactId: ad936445…, representationRevisionId: 079eae33…},
  findings: [{id: prompt-window, message: "tighten the opening paragraph"}],
  continuationMode: async_effects_gated, originatingRunBy: 9d081292…}
```

and its HITL gate's `field_name` is `idea` with those same values stored — which is the park the app's
own log names, and the reason no successor gate exists.

## The step-by-step screen (`d88ddadc`)

Six window rows for two messages:

```
1 user      set the offering company website to "https://example.test" and the call to action to
            "Book a 20-minute demo", and leave the sender name as it is
2 assistant fill = {"callToAction": "Book a 20-minute demo",
                    "offeringCompanyWebsite": "https://example.test"}
3 assistant Placed in the fields on the person's screen. Nothing was submitted — they press the button.
4 user      set the sender name to "Rita Owner" and send it
            attachments = [{"filename": "campaign-brief.txt", "mime": "text/plain", "size": 133,
                            "digest": "576038005379a871f562e47022857a40c30371a389a38d872d0accc9a4816d11",
                            "artifactId": "9229c4fd-…", "originKind": "upload"}]
5 assistant fill = {"senderName": "Rita Owner"}
6 assistant Submitted.
```

Field readback, before → after row 3: `field-offeringCompanyWebsite` `""` → `https://example.test`,
`callToAction` `""` → `Book a 20-minute demo`, `field-senderName` `""` → `""`. The gate's stored values
stayed `{"stepNumber": 1}` and `input_params` stayed `{}` — nothing was submitted.

After row 6 a SECOND gate row materialized, `{"stepNumber": 2}` at `2026-08-28 00:50:14.126038+00`, and
the app's own runtime log carries what actually reached the waiting agent:

```
[wayflow-interrupt] run=d88ddadc-… history_last=[{"role":"user","parts":[{"kind":"text","text":
  "{\"text\":\"{\\\"stepNumber\\\":1,\\\"senderName\\\":\\\"Rita Owner\\\"}\",\"attachments\":[{
   \"artifactId\":\"9229c4fd-…\",\"digest\":\"576038005379a871…\",\"mime\":\"text/plain\",
   \"title\":\"campaign-brief.txt\"…}]}"}]}]
```

The draft reading wrote no row at all: `please set the call to action to` was typed, the page was
reloaded, and the half sentence came back out of the field's own persistence key
`cinatra_hitl_assist_<templateId>_@cinatra-ai/email-outreach-agent:setup-form`.

## Provider evidence, and its limits

`cinatra.usage_events` on this instance:

| provider | model | calls | input tokens | output tokens |
|---|---|---|---|---|
| `openai` | `gpt-5.5-2026-04-23` | 30 | 120,665 | 5,587 |
| `openai` | `gpt-5.5` | 12 | 281,095 | 2,945 |

The instance's own server log for this leg: **51** `POST /api/mcp 200` callbacks from the provider's own
servers over the public origin · **3** `llm-bridge-run-select` lines from the agent runtime · **0**
scripted-runtime lines · **0** `NO_LLM_PROVIDER` refusals · **0** turns refused for a missing toolbox
· **1** `424 Failed Dependency`, named above with its cause and its fix.

**The limit, said rather than implied**: a zero on that list is the absence of that particular line and
nothing more. `CINATRA_TEST_LLM_PROVIDER` is set in nothing this leg started, and the capture library
refuses to run at all where it can see it. Every pictured turn was served on its first attempt, so the
retry road — which is decided by the SERVER'S OWN LOG for that turn's own window, never by whether the
answer was the one wanted — was never taken.
