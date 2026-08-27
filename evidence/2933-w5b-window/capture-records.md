# Capture records — cinatra#2933 W5b picture leg

## The environment

- Head photographed: `0ca4b1df227215a455d8f3c800171b4672120523` (PR 2995).
- Database: a database of its own on the verify Postgres, created for this leg;
  Redis of the same verify stack. Both loopback-only.
- Runtime: the app's dev server, the WayFlow agent runtime container brought up
  from this checkout (`--profile wayflow`), the bundled Nango for credential
  storage, and the bundled dev registry, so artifact bindings resolve.
- Provider: **OpenAI**, bound through the app's own setup form. The key
  travelled from the operator's secret manager into the shipped field and was
  sealed by the app; it was never printed, logged or written to disk here.
- Model that answered: **`gpt-5.5`** (`usage_events` also records the dated
  alias `gpt-5.5-2026-04-23`). `CINATRA_TEST_LLM_PROVIDER` unset — the driver
  refuses to run if it is set.
- Native MCP reached the instance through its configured public origin, set
  through the app's own development configuration screen and read back from the
  store.
- People: the instance administrator created through the app's own setup wizard;
  the run owner (**Rita Owner**, `runowner2995w@example.test`, `role=user`,
  organization `member`) and a second ordinary member (**Ben Bystander**,
  `bystander2995w@example.test`) created through the app's own sign-up. Every
  window capture is signed in as the run owner — a person who owns the run and
  is **not** a platform administrator. Every no-access capture is the bystander.
- No pixel was edited. No transcript was seeded. No assistant was stubbed.

## The exchange on each of the five mounts, quoted

One question, typed by the run's owner into the window on the surface, with
nothing named: **"what is this step waiting for?"**. No answer asked which step
was meant and no answer asked for an id.

### `run-page` — run `d345e546-2bb7-43b5-8fd9-1b4a83a33740`

Run **Blog Draft Writer Agent (2)**, status at the time of the answer `pending_approval`.

**The run owner typed** (2026-08-27T03:40:07Z, row 1):

```text
what is this step waiting for?
```

**The assistant answered** (2026-08-27T03:40:20Z, row 2):

```text
This run is **waiting for approval** on the setup step.

| Waiting on | Task | Missing fields |
|---|---|---|
| `@cinatra-ai/agent-builder:schema-field-fallback` | `setup-d345e546-2bb7-43b5-8fd9-1b4a83a33740` | `title`, `summary`, `outline` |

The approval needs to be handled with the buttons on this run page. The chat window itself can explain the blocker, but it can’t approve or submit the step for you.
```

### `step-by-step` — run `9aa7674f-57bb-47ae-b9c8-04168dcdb049`

Run **Email Outreach Agent (1)**, status at the time of the answer `pending_approval`.

**The run owner typed** (2026-08-27T04:09:59Z, row 1):

```text
what is this step waiting for?
```

**The assistant answered** (2026-08-27T04:10:11Z, row 2):

```text
This run is waiting for **approval on step 1**: the email outreach setup form.

Missing fields:

| Field | Status |
|---|---|
| Offering company website | Empty |
| Call to action | Empty |
| Sender name | Empty |

Use the approval form on this screen to fill those in and approve/submit the step.
```

### `schedule` — run `2b62a2aa-d06f-43e2-af41-7f079eba320a`

Run **Blog Draft Writer Agent (5)**, status at the time of the answer `pending_trigger`.

**The run owner typed** (2026-08-27T03:59:55Z, row 1):

```text
what is this step waiting for?
```

**The assistant answered** (2026-08-27T04:00:05Z, row 2):

```text
This run is **not waiting on a person or an approval**.

| Field | Value |
|---|---|
| Run | Blog Draft Writer Agent (5) |
| Agent | `@cinatra-ai/blog-draft-writer-agent` |
| Status | `pending_trigger` |
| Waiting on | Nothing right now |

It is simply **waiting for its trigger** — usually the scheduled time or automation condition that starts the run.
```

### `armed-trigger` — run `a6c7946e-15c6-4d46-9a1f-99a2be91504f`

Run **Blog Draft Writer Agent (6)**, status at the time of the answer `armed`.

**The run owner typed** (2026-08-27T04:06:38Z, row 1):

```text
what is this step waiting for?
```

**The assistant answered** (2026-08-27T04:06:49Z, row 2):

```text
This run is **armed** and waiting for its **recurring schedule** to fire.

| Field | Current value |
|---|---|
| Trigger type | Recurring |
| Cron | `0 9 * * 3` |
| Timezone | UTC |
| Meaning | Every Wednesday at **09:00 UTC** |
| Current state | Armed — waiting for its scheduled time |

So the next step is not waiting on input here. It will run automatically at the scheduled Wednesday 09:00 UTC trigger.
```

### `review` — run `1e1cc4ef-04cb-4eb6-9262-9599cd776d25`

Run **Blog Draft Writer Agent (9)**, status at the time of the answer `completed`.

**The run owner typed** (2026-08-27T04:47:42Z, row 1):

```text
what is this step waiting for?
```

**The assistant answered** (2026-08-27T04:47:55Z, row 2):

```text
This step is **not waiting for anything**.

| Field | Status |
|---|---|
| Run | Blog Draft Writer Agent (9) |
| Agent | `@cinatra-ai/blog-draft-writer-agent` |
| Run status | **Completed** |
| Waiting on | **Nothing** |
| Schedule | Immediate |
| Schedule state | Released — the run has started |
```

## Every run created for this leg

| Run | Title | Final status | Created (UTC) | window rows |
|---|---|---|---|---|
| `b32afdb2-70c1-45e1-ba0e-f6db69e4fe39` | Blog Draft Writer Agent (1) | pending_approval | 2026-08-27T03:28:23Z | 10 |
| `d345e546-2bb7-43b5-8fd9-1b4a83a33740` | Blog Draft Writer Agent (2) | pending_approval | 2026-08-27T03:39:04Z | 2 |
| `1845f037-fbb0-44b0-ab7a-5c3037acf132` | Blog Draft Writer Agent (3) | pending_trigger | 2026-08-27T03:45:03Z | 2 |
| `69066a5c-b796-44be-b58a-f34a76e485d9` | Blog Draft Writer Agent (4) | pending_trigger | 2026-08-27T03:54:52Z | 2 |
| `2b62a2aa-d06f-43e2-af41-7f079eba320a` | Blog Draft Writer Agent (5) | pending_trigger | 2026-08-27T03:58:12Z | 2 |
| `a6c7946e-15c6-4d46-9a1f-99a2be91504f` | Blog Draft Writer Agent (6) | armed | 2026-08-27T04:02:51Z | 2 |
| `9aa7674f-57bb-47ae-b9c8-04168dcdb049` | Email Outreach Agent (1) | pending_approval | 2026-08-27T04:08:50Z | 2 |
| `8b1f42ea-bb93-40ab-bcfb-f1a20170d2cd` | Blog Draft Writer Agent (7) | failed | 2026-08-27T04:11:41Z | 0 |
| `98bd8d43-764e-4f7d-bb9a-a55e0224d2e1` | Blog Draft Writer Agent (8) | completed | 2026-08-27T04:21:53Z | 2 |
| `lifecycle-repair-run:4d69fa45-e532-4dec-8337-85b8f984deac` | (repair run) | pending_approval | 2026-08-27T04:30:29Z | 0 |
| `1e1cc4ef-04cb-4eb6-9262-9599cd776d25` | Blog Draft Writer Agent (9) | completed | 2026-08-27T04:42:06Z | 2 |
| `lifecycle-repair-run:b2759010-1711-4406-9c0d-e6d42f992557` | (repair run) | pending_approval | 2026-08-27T04:48:17Z | 0 |

The five photographed runs are the five named above. `b32afdb2…` and
`69066a5c…` carry the cold-path warm-up turns and are photographed by nothing;
`8b1f42ea…` failed before it produced an artifact (its agent package was not yet
resolvable in the dev registry) and is photographed by nothing; `98bd8d43…` is a
second, independent review gate on which Deviation 3 was reproduced;
`1845f037…` carries a schedule exchange taken on the run-detail route before the
schedule step's own route was used for the record. The `lifecycle-repair-run:`
rows are the repairs the two change requests put in flight.

## sha256 of every recorded capture

```text
add2a5747121dedc98af84389380cf701c90436c5e7b8d4d3835d562a6880e86  armed-trigger__box-placeholder__dark.png
1448fe5d797623721662de7ca271181312fa26b40fc4425f878b9e350936e046  armed-trigger__box-placeholder__light.png
3970e37ca0426a4d3e6cb06fb00b71da17444b894f2806d5a89cb5e15d69c25a  armed-trigger__exchange-after-reload__dark.png
1732e4af20ad0b74afa718f0e2ffe6164565643d9b9e1f36fc30a52a19dc7a08  armed-trigger__exchange-after-reload__light.png
c02430a3b339cba9bc30c63dae9eae00861318ae06d9a35a4bae83bcd9e5205a  armed-trigger__no-respond-access__dark.png
a4004116cef08abf2225ce9f02e868e4172ec7bad180208814552487a3d3392a  armed-trigger__no-respond-access__light.png
702bc238ba2d6a5a1e3ee1d0199e8759417c3765c3485f2eed4c62d763163a8d  review__box-placeholder__dark.png
65d4e280078542ddfd46feb51ee35b34f18794981d56ab1061636c93198e2265  review__box-placeholder__light.png
80b03b01456802cb0147bfebb48bfe4c873fe55deb3741ecd893af7b8241245e  review__exchange-after-reload__dark.png
28cbe21adbb8b9a4ef38197eeb70165bf281ae4cc9393612cd98bd4c6238fa42  review__exchange-after-reload__light.png
3d22123d2d934b7dadd06d249816c810afb823ec0d57adeef45cb840bf947851  review__exchange-open__dark.png
f5ff45b354284e036cb47d984d09b6e3be78a29af4e028dff3dbfc5d45cdb953  review__exchange-open__light.png
46bfa80f6e7fe1fc487052c7ba210447c1dbdd4f42f4742a4fd0be1a6f2f7f1b  review__no-respond-access__dark.png
73d7048783007b6c0588b850ac68307d25e2c49ee1628bbcca279365d2acbd77  review__no-respond-access__light.png
818d73d56521fffa721d0565b666b92e9ed8bd931ce5df00a8b9315c05ac2915  run-page__box-placeholder__dark.png
8451b37cb1101191c0b83f3af113e491db44f7605307bede366994b08acf07a1  run-page__box-placeholder__light.png
f0ed71a288f3f131e74f10c43e7190101d9b829098e27a8afcd5c8f36b689e2c  run-page__exchange-after-reload__dark.png
731171ee33ef799671df171ee6846982fa4d081123cf86579cd6a52a028185f0  run-page__exchange-after-reload__light.png
a800dd15bf180ca8b75227e3fc94302359463b26a2edcad7b0a4bd0ceb843975  run-page__no-respond-access__dark.png
719c7442c2931d9464afd6695805dcae8d045ef4ec059b74aecbf9fca087423b  run-page__no-respond-access__light.png
f9a62f95bef5e710e31ca45938cd1761795ea852bdfbe5e9dd41c8d197dab1f3  schedule__box-placeholder__dark.png
af54b8948fe540fa812cfb152857a2ae249d576d445e87b7fa01c6618e8446ae  schedule__box-placeholder__light.png
f1761162e77e9c6464470ed1c9b071a45943f6dca4a75fd872b8045ffbcbad14  schedule__exchange-after-reload__dark.png
ea61edd9e3765daae9056b9fd4296fe48afd94c3c4166cf35c946dbdb797b3e8  schedule__exchange-after-reload__light.png
30b4f1278ab302d5e54cffe0c822c2121eeef15afd07000b49a1dd12567bbcd4  schedule__no-respond-access__dark.png
7818e681a3e3d5b6a92e0fa550d1711e46e3867d7c1c627d460010caa03d6eed  schedule__no-respond-access__light.png
64ca51d81c2d63cd8cd659fd409dbd5bf5ec15a2ab3c37fe95c60a9d7aeacfed  step-by-step__box-placeholder__dark.png
9f83b37425aa0795c5b2b6c7f95b8fcceb4a60be8171fb10ee18ed44eaa869c4  step-by-step__box-placeholder__light.png
c12a44517b41e8efef751f27909ebba2a6c72fc8ee7e3efabc02f116d61deb83  step-by-step__exchange-after-reload__dark.png
2633002efb902d67d50f8b761e9b1982c23ace628b663f278f74b0328b7e0058  step-by-step__exchange-after-reload__light.png
71330e1b87aa11a77bb46bb80c9af27093f565ccc033856e5aa07ba667f86e2b  step-by-step__no-respond-access__dark.png
d4707d2cda319952df626e65d699ee030493057c35111e22f0d6e8f97ef1ddf1  step-by-step__no-respond-access__light.png
```
