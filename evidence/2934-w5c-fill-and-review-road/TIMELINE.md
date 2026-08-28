# TIMELINE — cinatra#2934 W5c picture leg, re-taken in the turn's own context (UTC, 2026-08-28)

The driver's own clock, line by line, is in [`timeline.jsonl`](timeline.jsonl). This is the shape of it.

| when | what |
|---|---|
| 07:20–07:26 | The lane database is created empty on the verify Postgres and the app's own `setup:dev` builds its schema (exit 0). The app is booted from this checkout; its own extension pass installs the in-tree fleet, and the two agents this leg uses — Blog Draft Writer Agent and Email Outreach Agent — are installed by the platform's own boot, not by hand. |
| 07:27 | The instance administrator is created through the app's own sign-up — the endpoint the setup form posts to — and the run owner the same way. Neither is given a platform role beyond the organization the administrator owns. **The instance namespace is typed into `/setup/name`**, the screen that owns it, and the form's own gate is waited for rather than a stopwatch. |
| 07:28–07:29 | **The provider is committed through the app's own `/setup/model` form**, driven from the operator's own machine against the instance's public origin. The key is read from the environment the vault wrapper provides and never printed, logged or written to disk; the form's own field reports 167 characters and the wizard ends on `Setup complete`. |
| 07:30 | **The public origin is stored through the app's own development configuration screen** and read back off the re-rendered field: `""` → the instance's own public origin, `matches: true`. The run owner is invited and accepts through the app's own membership road. |
| 07:31 | Four runs are started by the person from the agents' own start pages. Nothing is written to the database: each run id is taken off the app's own wire. |
| 07:33–07:36 | **The light run-page trio and the light schedule reading**, run `44915a33`, all four frames taken in the context that sent the turn: fill, question, submit-on-ask, schedule fill. Every turn served on attempt 1 with its toolbox present. |
| 07:37–07:41 | The dark run-page fill and question readings on run `a6f9ac69`. Its submit-asking turn came back `This message is not allowed to operate that control. Nothing was done.` — recorded, and the dark submit and schedule frames re-taken on a fresh run rather than retried into a prettier picture. |
| 07:43–07:46 | **The dark submit-on-ask and schedule readings**, run `a3faf470`. The run moved `pending_approval` → `pending_trigger` and the scheduler form filled to `2026-08-29T09:00`. |
| 07:48–07:53 | A first step-by-step pass on run `ce498762`. Its attachment reading asked the assistant to READ the brief and was answered, honestly, that this window exposes the file's metadata and not its text; its submit-asking turn was refused authority. Both recorded in the README; neither is pictured. |
| 07:58–08:02 | **The route probe**, run `52e7165a`: the paperclip, then a message that asked for the send. The run's rows read fill → `Submitted.` and a second gate row appears — and the browser lands on `/not-authorized`, in the DRIVING context, which is what the graded review's last failing frame actually was. |
| 08:05–08:06 | **The light step-by-step fill reading**, run `9cd8283f`, taken in the turn's own context. |
| 08:07–08:08 | **The diagnosis**, run `d46a8013`: one fill, the DOM read and the frame taken in the same instant, then the same context reloads and is read and photographed again. |
| 08:13–08:16 | **The attachment readings**, runs `84d7beb6` (light) and `eafd85cc` (dark): the window's own paperclip uploads the brief (the app's own upload answers `201`), the message fills two fields, nothing is submitted, and the step stays in view. |
| 08:18 | Every filed frame measured out of its own bytes: sha256, size, and mean luminance, decoded by the same engine that took it. |

## What the instance's own log says about this leg

- **73** `POST /api/mcp 200` callbacks from the provider's own servers over the instance's public origin.
- **0** scripted-runtime lines. `CINATRA_TEST_LLM_PROVIDER` is set in nothing this leg started — it is
  absent from the instance's env file and unset in every shell that ran a driver, and the capture
  library refuses to run at all where it can see it.
- **0** `NO_LLM_PROVIDER` refusals, **0** `424 Failed Dependency` responses and **0** MCP
  tool-enumeration failures, so the cold-start retry road was never taken: every pictured turn was
  served on its FIRST attempt with its toolbox present.
- `cinatra.usage_events` on this instance: `openai` `gpt-5.5-2026-04-23` — **64** calls, 47 416 in /
  6 225 out; `openai` `gpt-5.5` — **22** calls, 495 689 in / 6 234 out.

**The limit, said rather than implied**: a zero on that list is the absence of that particular line
and nothing more.
