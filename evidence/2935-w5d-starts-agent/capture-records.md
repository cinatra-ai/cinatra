# cinatra#2935 (lifecycle-b W5d) — capture records

The measurements behind `README.md`. Head under proof
`a8e81c9b6ffa26e9199ba9252124ac745417ae4b`; the **chat pair re-taken 2026-08-27**,
the four third-party-application captures **unchanged from 2026-08-26** and
byte-identical to the previous evidence commit
`a9ac9b3650a42c6a2c049fe4950aeb57c8be063e`.

## The files

| file | sha256 | pixels |
|---|---|---|
| `chat__assistant-started-the-agent__light.png` | `69ad9c4843230d01da76270c1572857f356e4cb63646c51d47b4d4262a19d3cd` | 2880x1800 |
| `chat__assistant-started-the-agent__dark.png` | `820d6038facfdb54ce4ff64cce0395a3483f1efcda87ac4918e5a48d0439ebd9` | 2880x1800 |
| `site-widget__assistant-started-the-agent__light.png` | `c6f58880edf0f59f6f14d6595daf92074e0296b3c877775e68283e84cc6d112f` | 2880x1800 |
| `site-widget__assistant-started-the-agent__dark.png` | `3cebc29c045ecb4519c27083e8875f7a8b23dd62f2d5449922863077d41a3050` | 2880x1800 |
| `site-widget__refused__may-not-start__light.png` | `8129ec4f0a60f384c93c06480c240f9f9e3056d45f459b5622e4c7c1f62872a9` | 2880x1800 |
| `site-widget__refused__may-not-start__dark.png` | `28a1ab24a570b8a29bd7acbae1d47b3965753d6f6c3a42c37101730fa926a071` | 2880x1800 |

1440x900 CSS at device scale 2. The same bytes were viewed before this record was
written. The four unchanged rows are the same bytes as at
`a9ac9b3650a42c6a2c049fe4950aeb57c8be063e`, checked three ways: the file hashes
above, the git blob ids at both commits, and `git status` reporting only the two
chat files modified.

## The runs

| leg | run id | template | started by | status at answer | status in the row | created |
|---|---|---|---|---|---|---|
| chat (pictured, re-taken 2026-08-27) | `48bf61fc-23a3-4339-9df0-ca18087edb2d` | `@cinatra-ai/blog-draft-writer-agent` | the ordinary member | `queued` | `pending_approval` | 01:52:07.896Z |
| widget (pictured) | `80fc7252-31c3-4688-ab82-1709cfa05cbd` | `@cinatra-ai/blog-draft-writer-agent` | the ordinary member | `queued` | `pending_approval` | 19:56:37.917Z |
| the refused start | **no row** | `@cinatra-ai/lint-policy-agent` | — | — | — | — |

Every row carries `human_present = true` and the person's own organization. The
widget answer named `queued` and the row is `pending_approval`: the status moved
after the answer was written, which is exactly what the report sentence's event
tense ("The run started.") protects against.

`select count(*) from cinatra.agent_runs where template_id = <the restricted
template> and created_at > <the round's start>` → **0**.

## The turn timings

| leg | sent | tool call settled | card attached |
|---|---|---|---|
| chat, pictured (re-taken) | 01:51:51.084Z | 01:52:09.866Z | 01:52:15.735Z |
| widget, the start | 19:56:23.188Z | 19:56:41.254Z | 19:56:41.263Z |
| widget, the refused start | 19:56:51.910Z | 19:57:07.962Z | — (none drawn) |

## The anchors, per capture

| capture | `[data-agent-run-slot]` | `[data-inline-run-card]` | `[data-run-card]` | `[data-inline-agent-run-card]` | composers |
|---|---|---|---|---|---|
| chat, light | 1 (`48bf61fc…`) | 1 (`48bf61fc…`) | 0 | 0 | 1 |
| chat, dark | 1 (`48bf61fc…`) | 1 (`48bf61fc…`) | 0 | 0 | 1 |
| widget start, light | 1 (`80fc7252…`) | 1 (`80fc7252…`) | 0 | 0 | 1 |
| widget start, dark | 1 (`80fc7252…`) | 1 (`80fc7252…`) | 0 | 0 | 1 |
| widget refusal, light | 1 (`80fc7252…`) | 1 (`80fc7252…`) | 0 | 0 | 1 |
| widget refusal, dark | 1 (`80fc7252…`) | 1 (`80fc7252…`) | 0 | 0 | 1 |

The refusal captures list **one** card id, the first run's — the refused start
drew none.

## The model

`usage_events`, the four turns pictured or repeated here:

| occurred | provider | model | operation |
|---|---|---|---|
| 19:51:01.030Z | `openai` | `gpt-5.5` | `stream` |
| 19:56:40.315Z | `openai` | `gpt-5.5` | `stream` |
| 19:57:06.808Z | `openai` | `gpt-5.5` | `stream` |
| 20:01:26.826Z | `openai` | `gpt-5.5` | `stream` |

## The database

- The round's own database, cloned from the previous round's template and
  migrated forward: `pnpm db:migrate` → "No migrations to run".
- Core schema head: `core__0096_agent-run-created-at-immutable`; the app's own
  precondition logged `DB core schema current (applied core__0096 >= shipped
  core__0096)` at boot.
- `cinatra` schema: 172 tables.
- The acting person: `member` in `public.member`; `cinatra.role_grant`,
  `cinatra.project_access` and `cinatra.project_co_owners` each **0 rows** for
  them.
- The restricted project: `owner_level='user'`, owned by the other user,
  `visibility='private'`; the restricted template anchored to it with
  `owner_level='project'`.
- The connect site: `423e66c5…`, client `wordpress`, widget origin on
  `127.0.0.1`, credential version 1.

## The drawing renders

`specs/app-lifecycle-cards.html` at `fe2182547d4a`, rendered headless at 1440 CSS
wide, light and dark:

| section | light sha256 | dark sha256 |
|---|---|---|
| §I (first slice) | `031a029c34b7e63b2d4c8efc09b4ac95ae3bf17437edba36408661d65fcb87c9` | `031a029c34b7e63b2d4c8efc09b4ac95ae3bf17437edba36408661d65fcb87c9` |
| §IX (first slice) | `e9fd6d14fdfdb33c9f511a92102bb61bb5e126bcd8647ad479b9315ffd4981a5` | `e9fd6d14fdfdb33c9f511a92102bb61bb5e126bcd8647ad479b9315ffd4981a5` |

Equal, which is deviation D5: the page draws one palette.

## The chat pair's own readback (2026-08-27)

The stored turn behind the two re-taken captures is in `RUN-READBACK.md`: the
parts in order (`agent_run` → the card part → the text), the `agent_run` tool
result verbatim, and the three-way string comparison showing the platform's
`message`, the stored text part and the line on screen are the same sentence.
`skill_file_read`, `agent_run_get` and `agent_run_messages_list` are all absent
from every turn of that thread.

Pre-turn verification on the instance, before anything was driven:

| check | reading |
|---|---|
| the lock's pin for `@cinatra-ai/chat-assistant-core-skill` | `ec584587d06dc33ca904dff91e6e369a4a847def` |
| `sync-dev-extensions.mjs --pinned` | `112/112`, re-pinning `b1b51c8c5af3 → ec584587d06d` |
| the package on disk (`git rev-parse`) | `ec584587d06dc33ca904dff91e6e369a4a847def` |
| its `references/chat-run-polling.md`, first line | `### Step 6.1 — After a start, the reply is the platform's message` |
| `agent_run`'s description | ends on `RUN_START_REPLY_RULE`; no polling mandate |

The pictured run, read out of `cinatra.agent_runs`: `human_present = true`,
`run_by` the ordinary member's own user id, the organization the templates are
anchored to, `status` `pending_approval` in the row against `queued` in the
answer — the status moved after the sentence was written, which is exactly what
the report sentence's event tense ("The run started.") protects against.
**One run row exists for this round in total**, and one `usage_events` row at
01:52:10.394Z: the turn was a real model stream, not a fixture.
