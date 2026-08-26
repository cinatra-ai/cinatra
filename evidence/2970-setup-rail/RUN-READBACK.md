# RUN READBACK — the runs the pictures are of, read out of the database

Every timestamp below is a DATABASE column, named where it is read from. Nothing
in this lane inserts a run, a trigger, a gate or a record: the rows are the app's
own, created by its own dispatch out of the two sequences below.

## 1. The run in the pictures

- **run id** `3ad285c7-a7e0-44af-baba-e44dd4794ee2`
- **status at the shutter** `pending_trigger` — read back at each of the three
  shutters (`dbAt.read_at` per record: 2026-08-25T10:59:20.763Z, 2026-08-25T10:59:25.988Z, 2026-08-25T10:59:31.863Z)
- **`agent_runs.created_at`** `2026-08-25T10:03:54.552Z`
- **`agent_runs.started_at`** NULL — the run has never executed
- **`agent_run_triggers`** none for this run: `trigger_type`, `scheduled_at`, `timezone`,
  `released_at` all read NULL in the records' own `dbAt` block, because no trigger row exists
- **`artifact_review_gates` for this run** 0 — which is why the review row reads
  "not reached"
- **run page** `/agents/cinatra-ai/blog-draft-writer-agent/3ad285c7-a7e0-44af-baba-e44dd4794ee2/trigger`

**How it came to exist, in order.**

1. `2026-08-25T10:03:41.120Z` — a warm-up turn was sent in the app's own chat and answered
   (driver `08-chat-run-parked.mjs`; the warm-up is disclosed in README.md).
2. `2026-08-25T10:03:41.666Z` — the person asked, in their own words:
   *"Please run the Blog Draft Writer Agent for me now."*
3. `2026-08-25T10:03:55.692Z` — the app's own dispatch created the run
   (`3ad285c7-a7e0-44af-baba-e44dd4794ee2`), status `pending_approval`.
4. `2026-08-25T10:18:24.347Z` — the person answered the run's own setup step on the run page
   (driver `09-answer-setup-step.mjs`) and pressed **Continue**.
5. The app moved the run to `pending_trigger` — "setup finished, awaiting the user's
   trigger choice" (`run-actions.ts`) — with no trigger row. That is the state the setup
   run page is drawn for, and the state the pictures are of.

## 2. The schedule chain — the same instance, a real schedule proposal confirmed on its card

This sequence is not the one in the pictures; it is the provider evidence for the
instance, and it is the sequence the owed cell's brief describes (a one-off
"Schedule for later" run). It is reported because it produced a fact the brief did
not anticipate — see README.md, "Why the pictured run is not the scheduled one".

- **run id** `f27bbbf0-08b4-4352-9609-2d115df414ad`, created `2026-08-25T09:34:43.212Z`, status `armed` at the driver's post-confirm readback (the driver first waited up to 120 s for the card's own repaint — `settled: false` — and then read the row)
- **the sentence** *"Schedule the Blog Draft Writer Agent to run once today at 12:34 Europe/Berlin."*
- **`agent_run_triggers`**: `scheduled`, `scheduled_at` `2026-08-25T10:34:00.000Z`,
  `timezone` `Europe/Berlin`, row created `2026-08-25T09:34:43.241Z`
- the card read `settled` after **Confirm** was pressed on it

## 3. The provider, and what the readings can and cannot establish

`CINATRA_TEST_LLM_PROVIDER` is set in nothing this lane starts, and it was NOT FOUND
in the app server's process chain (read one hop above the listening process from the
process table:
`serverScriptedProviderEnv: null`, `serverEnvReadFrom: "process-table"`,
`serverEnvTokensSeen: 79`). A NON-NULL answer there would be proof the flag is
present; a null answer is consistent with absence and is not by itself a proof of it.

**`cinatra.usage_events` — the model calls this instance actually made:**

```
provider |  model  | source | operation | calls | input_tokens | output_tokens |          first_at          |          last_at
----------+---------+--------+-----------+-------+--------------+---------------+----------------------------+----------------------------
 openai   | gpt-5.5 | llm    | stream    |    16 |       342851 |          4567 | 2026-08-25 08:22:48.498+00 | 2026-08-25 10:04:01.991+00
(1 row)
```

**The negative screens, over the schedule sequence's own slice of the app server's log**
(a hit is proof of a problem; a zero is the absence of that particular line and nothing more):

| screen | reading |
|---|---|
| `preRouterShortCircuits` | 0 |
| `preRouterAttempts` | 0 |
| `scriptedRuntimeLines` | 0 |
| `noProviderRefusals` | 0 |
| `mcpDependencyFailures` | 0 |
| `publicMcpCallbacks` (positive, unattributed) | 19 |
| `bridgeRunSelects` (positive) | 0 |

The same block also carries `session` counts for the whole server session, which are
NOT zero: the model's hosted MCP connector fails its first tool-list fetch on a cold
OAuth path and the app then retries the stream without the tool. README.md states that
in full under "The one fallback in this lane".

## 4. Every run row on the lane at the end

```
id                  |      status      |          created_at           | started_at
--------------------------------------+------------------+-------------------------------+------------
 ccc9cac6-c2ac-4d0d-a461-2c26a7fbeacd | pending_approval | 2026-08-25 08:32:30.249916+00 |
 792b7cff-0c63-4fd6-8b75-846f9a9a1d64 | pending_approval | 2026-08-25 08:39:28.071718+00 |
 f24acd3d-a487-4662-b792-766d8eab7c1c | pending_approval | 2026-08-25 08:42:55.986308+00 |
 12652be9-06c3-4dac-a0fa-446b3d8232db | pending_approval | 2026-08-25 08:45:43.067525+00 |
 2f7167e2-c3d0-4c3a-a0bf-6fea96cc2aa8 | pending_approval | 2026-08-25 09:12:20.739852+00 |
 32d2c782-fe47-47f0-92b4-6a56c7a9e965 | pending_approval | 2026-08-25 09:20:51.132487+00 |
 439c5d2d-724a-4047-8205-622c7511d178 | pending_approval | 2026-08-25 09:30:23.572363+00 |
 f27bbbf0-08b4-4352-9609-2d115df414ad | pending_approval | 2026-08-25 09:34:43.212969+00 |
 2076012c-5a01-4a68-851e-6f8fcb63d30d | pending_approval | 2026-08-25 09:54:13.009965+00 |
 99829417-994b-4b79-adac-65f08a762b92 | pending_approval | 2026-08-25 09:55:31.40424+00  |
 3ad285c7-a7e0-44af-baba-e44dd4794ee2 | pending_trigger  | 2026-08-25 10:03:54.55236+00  |
(11 rows)
```

## 5. Every trigger row on the lane at the end

```
run_id                | trigger_type |      scheduled_at      |   timezone    | enabled |         created_at
--------------------------------------+--------------+------------------------+---------------+---------+----------------------------
 ccc9cac6-c2ac-4d0d-a461-2c26a7fbeacd | scheduled    | 2026-08-25 09:31:00+00 | Europe/Berlin | t       | 2026-08-25 08:32:30.34+00
 792b7cff-0c63-4fd6-8b75-846f9a9a1d64 | scheduled    | 2026-08-25 09:38:00+00 | Europe/Berlin | t       | 2026-08-25 08:39:28.089+00
 f24acd3d-a487-4662-b792-766d8eab7c1c | scheduled    | 2026-08-25 09:42:00+00 | Europe/Berlin | t       | 2026-08-25 08:42:55.999+00
 12652be9-06c3-4dac-a0fa-446b3d8232db | scheduled    | 2026-08-25 09:45:00+00 | Europe/Berlin | t       | 2026-08-25 08:45:43.095+00
 2f7167e2-c3d0-4c3a-a0bf-6fea96cc2aa8 | scheduled    | 2026-08-25 10:11:00+00 | Europe/Berlin | t       | 2026-08-25 09:12:20.761+00
 32d2c782-fe47-47f0-92b4-6a56c7a9e965 | scheduled    | 2026-08-25 10:16:00+00 | Europe/Berlin | t       | 2026-08-25 09:20:51.147+00
 439c5d2d-724a-4047-8205-622c7511d178 | scheduled    | 2026-08-25 10:25:00+00 | Europe/Berlin | t       | 2026-08-25 09:30:23.587+00
 f27bbbf0-08b4-4352-9609-2d115df414ad | scheduled    | 2026-08-25 10:34:00+00 | Europe/Berlin | t       | 2026-08-25 09:34:43.241+00
(8 rows)
```
