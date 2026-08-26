# cinatra#2935 (lifecycle-b W5d) — capture records

The measurements behind `README.md`. Head under proof
`39494751b81e9105b79a84be6759c8f9e49c5104`; captures taken 2026-08-26.

## The files

| file | sha256 | pixels |
|---|---|---|
| `chat__assistant-started-the-agent__light.png` | `61882d076767e8e181534995000059b1feb5edcf9064c39bc1a12abc5121952f` | 2880x1800 |
| `chat__assistant-started-the-agent__dark.png` | `4e5e4ca834d1e99cd51b867425a151a206f85ffc4e5a4892220b3e749fadf277` | 2880x1800 |
| `site-widget__assistant-started-the-agent__light.png` | `c6f58880edf0f59f6f14d6595daf92074e0296b3c877775e68283e84cc6d112f` | 2880x1800 |
| `site-widget__assistant-started-the-agent__dark.png` | `3cebc29c045ecb4519c27083e8875f7a8b23dd62f2d5449922863077d41a3050` | 2880x1800 |
| `site-widget__refused__may-not-start__light.png` | `8129ec4f0a60f384c93c06480c240f9f9e3056d45f459b5622e4c7c1f62872a9` | 2880x1800 |
| `site-widget__refused__may-not-start__dark.png` | `28a1ab24a570b8a29bd7acbae1d47b3965753d6f6c3a42c37101730fa926a071` | 2880x1800 |

1440x900 CSS at device scale 2. The same bytes were viewed before this record was
written and hash-compared between the capture machine and the machine that
committed them.

## The runs

| leg | run id | template | started by | status at answer | status in the row | created |
|---|---|---|---|---|---|---|
| chat (pictured) | `abdf8e63-d120-4bf5-ba29-eba2cb5047e4` | `@cinatra-ai/blog-draft-writer-agent` | the ordinary member | `pending_input` | `pending_approval` | 19:50:53.232Z |
| widget (pictured) | `80fc7252-31c3-4688-ab82-1709cfa05cbd` | `@cinatra-ai/blog-draft-writer-agent` | the ordinary member | `queued` | `pending_approval` | 19:56:37.917Z |
| chat (the repeat, not pictured) | `79152ddd-c06e-4166-a9a2-70cd1d7289fb` | `@cinatra-ai/blog-draft-writer-agent` | the ordinary member | `pending_input` | `pending_approval` | 20:01:17.595Z |
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
| chat, pictured | 19:50:32.275Z | 19:51:04.463Z | 19:51:04.466Z |
| widget, the start | 19:56:23.188Z | 19:56:41.254Z | 19:56:41.263Z |
| widget, the refused start | 19:56:51.910Z | 19:57:07.962Z | — (none drawn) |
| chat, the repeat | 20:01:02.264Z | 20:01:26.428Z | 20:01:26.430Z |

## The anchors, per capture

| capture | `[data-agent-run-slot]` | `[data-inline-run-card]` | `[data-run-card]` | `[data-inline-agent-run-card]` | composers |
|---|---|---|---|---|---|
| chat, light | 1 (`abdf8e63…`) | 1 (`abdf8e63…`) | 0 | 0 | 1 |
| chat, dark | 1 (`abdf8e63…`) | 1 (`abdf8e63…`) | 0 | 0 | 1 |
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
