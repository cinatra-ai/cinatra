# Capture records — cinatra#2933 W5b picture leg

## The environment

- Head photographed: `e77bd03815835dce1c8c5645915df5cbef65b381` (PR 2995).
- Database: a lane database of its own on the verify Postgres, created for this
  leg and dropped after it. Redis of the same verify stack. Both loopback-only.
- Runtime: the app's dev server plus the WayFlow agent runtime container brought
  up from this checkout (`--profile wayflow`), and the bundled Verdaccio dev
  registry, so artifact bindings resolve.
- Provider: **OpenAI**, bound through the app's own `/setup/model` form (the key
  travelled from the operator's secret manager into the shipped field and was
  sealed by the app; it was never printed, logged or written to disk here).
  Committed record `connector_config:llm_default_provider = "openai"`.
- Model that answered: **`gpt-5.5`** (`usage_events` also records the dated
  alias `gpt-5.5-2026-04-23`). `CINATRA_TEST_LLM_PROVIDER` unset — the driver
  refuses to run if it is set.
- Native MCP reached the instance through its configured public origin, set at
  `/configuration/development?tab=tunnel` and read back from the store.
- People: the instance administrator created through the app's own setup wizard;
  the run owner (**Rita Owner**, `runowner2995w@example.test`, `role=user`,
  organization `member`) and a second ordinary member (**Ben Bystander**,
  `bystander2995w@example.test`) created through the app's own sign-up. Every
  window capture is signed in as the run owner — a person who owns the run and
  is **not** a platform administrator. Every no-access capture is the bystander.

## Disclosed

- **One cold warm-up turn.** The first turn on a cold public-MCP path was
  refused by the runtime's own reachability probe (2.5 s budget; the cold path
  measured 3.4–6.2 s, the warm path 0.26–0.43 s) and the window stored the
  platform's "could not answer just now" line. Those two rows were deleted from
  the lane database and the turn was re-sent on a warm path; every recorded
  capture shows a real model answer. Warm-up turns are visible in the row list
  below as the extra turns on run `7410e70c…`.
- No pixel was edited. No transcript was seeded. No assistant was stubbed.

## Runs (all created and driven through the app's own screens)

| Run | Agent | Final status | Created (UTC) | window rows |
|---|---|---|---|---|
| `ddb7fbda-0586-4921-9e15-4df1697eff50` | `@cinatra-ai/planner-agent` | pending_approval | 2026-08-26 15:31:25 | 0 |
| `7410e70c-66fd-4c67-8ea9-2edd4b5f6006` | `@cinatra-ai/blog-draft-writer-agent` | armed | 2026-08-26 15:54:17 | 12 |
| `50274240-3607-47c3-94d5-fb1bd13636db` | `@cinatra-ai/blog-draft-writer-agent` | failed | 2026-08-26 16:24:33 | 0 |
| `fac9e117-5e14-493d-bae9-e36cf7269874` | `@cinatra-ai/blog-draft-writer-agent` | failed | 2026-08-26 16:37:02 | 0 |
| `bb4ccdd7-efb1-4240-9b27-8d2036a0903e` | `@cinatra-ai/blog-draft-writer-agent` | completed | 2026-08-26 16:52:42 | 2 |
| `lifecycle-repair-run:f82e95be-b785-474c-920c-a12a10bedf1c` | `@cinatra-ai/blog-draft-writer-agent` | pending_approval | 2026-08-26 17:04:26 | 0 |
| `cb151681-e685-42ed-8909-d187db5fbe1b` | `@cinatra-ai/blog-draft-writer-agent` | completed | 2026-08-26 17:06:02 | 2 |
| `lifecycle-repair-run:7f8b668f-02b8-4a09-86a4-7310ee151a70` | `@cinatra-ai/blog-draft-writer-agent` | pending_approval | 2026-08-26 17:17:28 | 0 |
| `1a0c1f2e-c69b-4973-ba78-4feccc1cd3e7` | `@cinatra-ai/context-selection-agent` | failed | 2026-08-26 17:22:10 | 0 |
| `eac5733a-403d-4b2f-a9aa-ec85718d4d01` | `@cinatra-ai/email-outreach-agent` | pending_approval | 2026-08-26 17:23:56 | 2 |
| `1f6305eb-07e8-4b3c-905c-fa4de5e55f72` | `@cinatra-ai/blog-draft-writer-agent` | completed | 2026-08-26 17:42:42 | 2 |
| `lifecycle-repair-run:1f800808-4371-43ea-b475-e2953adc879c` | `@cinatra-ai/blog-draft-writer-agent` | pending_approval | 2026-08-26 17:53:34 | 0 |
| `de326907-2d87-4ee7-a247-b13b5cc09eeb` | `@cinatra-ai/blog-draft-writer-agent` | completed | 2026-08-26 17:54:19 | 2 |
| `lifecycle-repair-run:856537bc-fd30-494f-8b88-a6ca15204d7a` | `@cinatra-ai/blog-draft-writer-agent` | pending_approval | 2026-08-26 18:03:36 | 0 |
| `ad619ad1-782d-4797-bf8e-be4a8f3000b1` | `@cinatra-ai/blog-draft-writer-agent` | pending_approval | 2026-08-26 18:09:47 | 0 |

## Window rows written by the real turns

`cinatra.agent_run_messages`, `message_type = 'window'` — the store this slice
adds. Read back on a second connection (a fresh page load) after every reload.

| Run | seq | role | written (UTC) |
|---|---|---|---|
| `1f6305eb-07e8-4b3c-905c-fa4de5e55f72` | 1 | user | 2026-08-26 17:52:44 |
| `1f6305eb-07e8-4b3c-905c-fa4de5e55f72` | 2 | assistant | 2026-08-26 17:52:58 |
| `7410e70c-66fd-4c67-8ea9-2edd4b5f6006` | 1 | user | 2026-08-26 16:13:38 |
| `7410e70c-66fd-4c67-8ea9-2edd4b5f6006` | 2 | assistant | 2026-08-26 16:13:49 |
| `7410e70c-66fd-4c67-8ea9-2edd4b5f6006` | 3 | user | 2026-08-26 16:17:44 |
| `7410e70c-66fd-4c67-8ea9-2edd4b5f6006` | 4 | assistant | 2026-08-26 16:18:31 |
| `7410e70c-66fd-4c67-8ea9-2edd4b5f6006` | 5 | user | 2026-08-26 17:15:47 |
| `7410e70c-66fd-4c67-8ea9-2edd4b5f6006` | 6 | assistant | 2026-08-26 17:15:55 |
| `7410e70c-66fd-4c67-8ea9-2edd4b5f6006` | 7 | user | 2026-08-26 17:25:42 |
| `7410e70c-66fd-4c67-8ea9-2edd4b5f6006` | 8 | assistant | 2026-08-26 17:25:51 |
| `7410e70c-66fd-4c67-8ea9-2edd4b5f6006` | 9 | user | 2026-08-26 17:52:13 |
| `7410e70c-66fd-4c67-8ea9-2edd4b5f6006` | 10 | assistant | 2026-08-26 17:52:23 |
| `7410e70c-66fd-4c67-8ea9-2edd4b5f6006` | 11 | user | 2026-08-26 18:02:14 |
| `7410e70c-66fd-4c67-8ea9-2edd4b5f6006` | 12 | assistant | 2026-08-26 18:02:22 |
| `bb4ccdd7-efb1-4240-9b27-8d2036a0903e` | 1 | user | 2026-08-26 17:04:04 |
| `bb4ccdd7-efb1-4240-9b27-8d2036a0903e` | 2 | assistant | 2026-08-26 17:04:13 |
| `cb151681-e685-42ed-8909-d187db5fbe1b` | 1 | user | 2026-08-26 17:16:23 |
| `cb151681-e685-42ed-8909-d187db5fbe1b` | 2 | assistant | 2026-08-26 17:16:36 |
| `de326907-2d87-4ee7-a247-b13b5cc09eeb` | 1 | user | 2026-08-26 18:02:45 |
| `de326907-2d87-4ee7-a247-b13b5cc09eeb` | 2 | assistant | 2026-08-26 18:03:04 |
| `eac5733a-403d-4b2f-a9aa-ec85718d4d01` | 1 | user | 2026-08-26 17:26:14 |
| `eac5733a-403d-4b2f-a9aa-ec85718d4d01` | 2 | assistant | 2026-08-26 17:26:25 |

## sha256 of every recorded capture

| sha256 | file |
|---|---|
| `d494e4a8569bd26f4c3436d2fdd4ed57719a18b3c77f981907f002c391891546` | `armed-trigger__box-placeholder__dark.png` |
| `0dd397cd50a45f60ff67fb514b48e23931cb45a5b818e9484663c124b04efbe9` | `armed-trigger__box-placeholder__light.png` |
| `6e81baf77660872ea7952ac41bdf807d271661f6751fefe880cc47b727d665ee` | `armed-trigger__exchange-after-reload__dark.png` |
| `0536e0208d507c2e44e684ce49def82d54822739fbd439c55c455b26cb9c684d` | `armed-trigger__exchange-after-reload__light.png` |
| `f72526244f44d6594fafb905d1ac9d2adf13716ff5d6ecd9548245928e4377ab` | `armed-trigger__no-respond-access__dark.png` |
| `8da47823710862365562a7b54c752713077f8d6caef77e234467b2b01f7fcd16` | `armed-trigger__no-respond-access__light.png` |
| `9a2c7a9c8e1906434b23967ac52f605faf0f6ad34cf0ff435a561e448be6c024` | `review__box-placeholder__dark.png` |
| `3fc86479aa689e0c9931671da3fbfe86d82fe74b867d69755dc5d44d4b6487cf` | `review__box-placeholder__light.png` |
| `5fb9618a178654b4105c6cff5b4b121852072b465ab8e9431566f09cdcaa8ca5` | `review__exchange-after-reload__dark.png` |
| `89d06f403ab2d3142b7058a4e37417d321d52144ca04f740f9945ca25f03cb6e` | `review__exchange-after-reload__light.png` |
| `558e755769852662ebf5e2bfb0b7b5f0c272f1da34a554bb6a85616fed33bc61` | `review__exchange-open__dark.png` |
| `cb66330e0dd17a4df9da9be059ebb46ddf78da46adf52b5bb112fe2ff138d0d7` | `review__exchange-open__light.png` |
| `dcddfed1863f95cb5c8dd397c5104074262fa6a18ad49689332b179e4189207f` | `review__no-respond-access__dark.png` |
| `1e1f84ef2876ce9031b6b3e33d2da16f06fcd78d2559ce6417bb3b6435c8e4b8` | `review__no-respond-access__light.png` |
| `a598ee1c87e3bc6f8d2273070e9670ed6a728fe660e2cbab0d213636ea914f8b` | `run-page__no-respond-access__dark.png` |
| `e09b0b7679dca692bd0fed207426de7b30ba6aac5a5435729ada8194f8bb5146` | `run-page__no-respond-access__light.png` |
| `afd13e7952b5774cfe2d84cd04e1de134720fbe9c0b3afeecfcd73c6e593dee7` | `run-page__no-window-drawn__dark.png` |
| `5741ecbed88ab1958b124800aaf85c84dae26a0e4825de573cf04de52aefc53d` | `run-page__no-window-drawn__light.png` |
| `99aacfb95438d3f26d3112cbf4e621acc7a85cc9a5f1a4def4fe1efd791512b7` | `schedule__box-placeholder__dark.png` |
| `509e5e4c82c4543975cb3b91a205bfd916e92703004054775d073b79be6ef7ce` | `schedule__box-placeholder__light.png` |
| `21609c66921c095464885cd329209590cf9ea3945f7bd21ecde235d20662ff8c` | `schedule__exchange-after-reload__dark.png` |
| `500a76fd08f1700c485a2835c9d0a06ee4d1075c73cb83942f67a57981be455e` | `schedule__exchange-after-reload__light.png` |
| `f2570937f6b56756628eedcdaa0c2f6f850db647ce7fb8fe90beba7074e3b56d` | `schedule__no-respond-access__dark.png` |
| `29dad5834e0f86dfba05727d744e57556308a69fec336c61b5b036a5c06e36a4` | `schedule__no-respond-access__light.png` |
| `9ddbb2ae35fec9ed0e617144ff156f0f9023a174af0c7baffc88f9cd832ddda1` | `step-by-step__box-placeholder__dark.png` |
| `39281d8db0386ec780c5838809d4736bb0ebe538a3eae43320f1e92578c8d011` | `step-by-step__box-placeholder__light.png` |
| `29047152781c68a672a7bee2225cbc4429509fce41cb98b576fb3b2a915a784f` | `step-by-step__exchange-after-reload__dark.png` |
| `ffa36ccbab127cac5365e43f5e2ce6bba4bd935875a0709b89c474fc5d2bbe7f` | `step-by-step__exchange-after-reload__light.png` |
| `6d430b641a02264eabda459603b4027f081c58eceb565110abc6ee2b9715938b` | `step-by-step__no-respond-access__dark.png` |
| `6ea20953989802563ac547b287dc2c5d3302177dbe6ec2d6a7b495eab24ecfe2` | `step-by-step__no-respond-access__light.png` |
