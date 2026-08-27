# Capture records — cinatra#2933 W5b picture leg

## The environment

- Head photographed: `30deb133b143f059fbd204cb5756d1496568b4f8` (PR 2995).
- Database: a database of its own on the verify Postgres, created for this leg; Redis of the same
  verify stack. Both loopback-only.
- Runtime: the app's dev server, the WayFlow agent runtime container brought up from this checkout
  (`--profile wayflow`, 29 agents mounted, `/.health` `ok`), the bundled Nango for credential
  storage, and the bundled dev registry, so artifact bindings resolve.
- Provider: **OpenAI**, bound through the app's own setup form. The key travelled from the
  operator's secret manager into the shipped field and was sealed by the app; it was never printed,
  logged or written to disk here.
- Model that answered: **`gpt-5.5`**, read back from `usage_events` on this instance.
  `CINATRA_TEST_LLM_PROVIDER` unset — the driver refuses to run if it is set.
- Native MCP reached the instance through its configured public origin, set through the app's own
  development configuration screen and read back from the store.
- People: the instance administrator created through the app's own setup wizard; the run owner
  (**Rita Owner**, `runowner2995w@example.test`, `role=user`, organization `member`) and a second
  ordinary member (**Ben Bystander**, `bystander2995w@example.test`) created through the app's own
  sign-up. Every window capture is signed in as the run owner — a person who owns the run and is
  **not** a platform administrator. Every no-access capture is the bystander.
- Full window, 1440x900 at device scale 2, light and dark, through the app's own theme control.
  Every capture was viewed before it was recorded.
- No pixel was edited. No transcript was seeded. No assistant was stubbed. No reload was faked.

## The sentence in the empty field, read off the DOM

Design `458fb7ffce6cf4ab6a2c60d3ff47198135d8ea2f`, `app-artifact-review.html` §X fixes one sentence
per surface. On each of the five mounts the placeholder was read out of the rendered DOM and compared
with the drawing **character for character, the ellipsis (U+2026) included**. All five match; the
comparison exits non-zero on any difference.

| Reading | §X requires in the empty field | Read off the DOM |
|---|---|---|
| run-page | `Ask Cinatra to fill the fields above, or ask about this step…` | identical |
| step-by-step | `Ask Cinatra to fill this step's fields, or ask about the run…` | identical |
| schedule | `Ask Cinatra to set the schedule above, or ask about it…` | identical |
| armed-trigger | `Ask Cinatra to change this schedule, or ask about it…` | identical |
| review | `Ask Cinatra about this review, or ask for changes to the work…` | identical |

## The exchange on each of the five mounts, quoted

One question, typed by the run's owner into the window on the surface, with nothing named:
**"what is this step waiting for?"**. No answer asked which step was meant and no answer asked for
an id.

### `run-page` — run `aa18c93f-ef74-4620-bf59-7d516175f7ca`

Run **Blog Draft Writer Agent (1)**, status at the time of the answer `pending_approval`.

**The run owner typed** (2026-08-27T11:24:53Z, row 1):

```text
what is this step waiting for?
```

**The assistant answered** (2026-08-27T11:25:02Z, row 2):

```text
This run is **waiting for approval** on a setup step.

The approval is for a schema-field fallback from:

`@cinatra-ai/agent-builder:schema-field-fallback`

Current setup fields are empty:

| Field | Value |
|---|---|
| `title` | empty |
| `summary` | empty |
| `outline` | empty |

Use the approval controls on this run page to decide whether to continue or reject/adjust the setup.
```

### `step-by-step` — run `bf2f6af4-567d-407a-84fa-2faf54a8e56a`

Run **Email Outreach Agent (1)**, status at the time of the answer `pending_approval`.

**The run owner typed** (2026-08-27T11:29:36Z, row 1):

```text
what is this step waiting for?
```

**The assistant answered** (2026-08-27T11:29:45Z, row 2):

```text
This step is waiting for **approval on the setup form**.

| Field | Current value |
|---|---|
| Offering company website | Empty |
| Call to action | Empty |
| Sender name | Empty |

Fill those in on the form, then use the approval control on this run screen to continue.
```

### `schedule` — run `415cd7f5-9911-4126-a5c3-91bbd405035a`

Run **Blog Draft Writer Agent (3)**, status at the time of the answer `pending_trigger`.

**The run owner typed** (2026-08-27T11:35:26Z, row 1):

```text
what is this step waiting for?
```

**The assistant answered** (2026-08-27T11:35:36Z, row 2):

```text
**Nothing right now.**

This run is in **`pending_trigger`** status, so it’s waiting for its scheduled trigger to fire — not for a person, approval, or input.
```

### `armed-trigger` — run `4327cfc0-0a6d-446d-8a30-b411cc3e0efa`

Run **Blog Draft Writer Agent (4)**, status at the time of the answer `armed`.

**The run owner typed** (2026-08-27T11:41:36Z, row 1):

```text
what is this step waiting for?
```

**The assistant answered** (2026-08-27T11:41:44Z, row 2):

```text
This run is **armed** and waiting for its **recurring schedule** to fire.

| Field | Current value |
|---|---|
| Agent | `@cinatra-ai/blog-draft-writer-agent` |
| Run | `Blog Draft Writer Agent (4)` |
| Status | `armed` |
| Waiting on | Schedule |
| Cron | `0 9 * * 3` |
| Timezone | `UTC` |

That means it is set to run **every Wednesday at 09:00 UTC**.
```

### `review` — run `100108c3-e239-4385-8ed1-5cfa1ce145d9`

Run **Blog Draft Writer Agent (5)**, status at the time of the answer `pending_approval, on an OPEN artifact review gate`.

**The run owner typed** (2026-08-27T12:01:17Z, row 1):

```text
what is this step waiting for?
```

**The assistant answered** (2026-08-27T12:01:28Z, row 2):

```text
This step is waiting for **your review decision** on:

**Why a Weekly Publishing Rhythm Beats a Burst of Posts — Blog Post Artifact**

You can:

| Action | What happens |
|---|---|
| **Approve** | Ends the review as approved. |
| **Reject** | Ends the review as rejected. |
| **Comment** | Records a note and keeps the review pending. |
| **Request changes** | Type the changes in this window and submit; the gate resolves as changes-requested and a repair starts. |
```

## Every run created for this leg

| Run | Title | Final status | Created (UTC) | window rows |
|---|---|---|---|---|
| `aa18c93f-ef74-4620-bf59-7d516175f7ca` | Blog Draft Writer Agent (1) | pending_approval | 2026-08-27T11:21:56Z | 2 |
| `868fb7b5-733b-47cb-9133-a88fa5bcdbbe` | Blog Draft Writer Agent (2) | pending_approval | 2026-08-27T11:22:44Z | 2 |
| `bf2f6af4-567d-407a-84fa-2faf54a8e56a` | Email Outreach Agent (1) | pending_approval | 2026-08-27T11:28:05Z | 2 |
| `415cd7f5-9911-4126-a5c3-91bbd405035a` | Blog Draft Writer Agent (3) | pending_trigger | 2026-08-27T11:32:41Z | 2 |
| `4327cfc0-0a6d-446d-8a30-b411cc3e0efa` | Blog Draft Writer Agent (4) | armed | 2026-08-27T11:38:34Z | 2 |
| `100108c3-e239-4385-8ed1-5cfa1ce145d9` | Blog Draft Writer Agent (5) | completed | 2026-08-27T11:46:24Z | 2 |
| `lifecycle-repair-run:533d725c-4811-413c-8f9d-ec312e36316d` | (repair run) | pending_approval | 2026-08-27T12:02:06Z | 0 |

The five photographed runs are the five named above. `868fb7b5-733b-47cb-9133-a88fa5bcdbbe` carries
the cold-path warm-up turn and is photographed by nothing; the `lifecycle-repair-run:` row is the
repair the review page's change request put in flight. Every photographed run carries exactly one
real exchange.

## sha256 of every recorded capture

```text
fa824e688d86cc976d100b4b3eff208ee970b96c1794649f591eb704a63b276a  armed-trigger__box-placeholder__dark.png
f6c9eb0b2f27746236d92edbcf1981331d4173d3d806ab9fbeb3fdd8cce8e725  armed-trigger__box-placeholder__light.png
987ed956589976f1969141a753a7a4d548e938255cc4e3766bce7ef3194f4ec5  armed-trigger__exchange-after-reload__dark.png
546a567da8d1657fe5472c97532284dbd9819a99b3c845e4296b9dfe36d0e54f  armed-trigger__exchange-after-reload__light.png
c02430a3b339cba9bc30c63dae9eae00861318ae06d9a35a4bae83bcd9e5205a  armed-trigger__no-respond-access__dark.png
a4004116cef08abf2225ce9f02e868e4172ec7bad180208814552487a3d3392a  armed-trigger__no-respond-access__light.png
1415b795cdcd82adfe7e493ff8fcc30b6ff9a633997b6f26dfdec8b2b1495503  review__box-placeholder__dark.png
deab76840c3acd82b0c8b2b9167d5afbebcda0561fe6f8ab0076e01c784df13b  review__box-placeholder__light.png
1f55769ca4c1d170f1a98e77d54253029a939c4043353d434280216fd222a9c8  review__exchange-after-reload__dark.png
7d59741209b2f476874aeb01fc0fce423a7b37faa2a41052701457bb50eeaefd  review__exchange-after-reload__light.png
091c9bdd95b65d0fbd2fccc9501bbff6a06a01f1e9f06b68ffb942d515b6eaff  review__exchange-open__dark.png
af5b1429e14835f4bcce9f087df9ca34884cd73fe55ec9599a197e83465e4f1a  review__exchange-open__light.png
46bfa80f6e7fe1fc487052c7ba210447c1dbdd4f42f4742a4fd0be1a6f2f7f1b  review__no-respond-access__dark.png
73d7048783007b6c0588b850ac68307d25e2c49ee1628bbcca279365d2acbd77  review__no-respond-access__light.png
6048776fc2ee539e1811add776c0048fdd1b8de65f0d59e0b12d459aaf4d511e  run-page__box-placeholder__dark.png
004540663f2e31639590c2ebc25135819b325d2def6bf09b7752e5da3bd41888  run-page__box-placeholder__light.png
e2d2379a05cd26290f5f9ff099f138eca2737746d365edf93012cbe670c93f52  run-page__exchange-after-reload__dark.png
55812c8ab0964a5fc0597d6eb3c1bdca76158bde6680f566b72cace21d19fb2b  run-page__exchange-after-reload__light.png
a800dd15bf180ca8b75227e3fc94302359463b26a2edcad7b0a4bd0ceb843975  run-page__no-respond-access__dark.png
719c7442c2931d9464afd6695805dcae8d045ef4ec059b74aecbf9fca087423b  run-page__no-respond-access__light.png
317114429ae46d97af3aa4011a99b805bc463ef4949aed41386c31483d04d018  schedule__box-placeholder__dark.png
027394dd4dc809c2e099cc5a8312ae047a4b88cd025952a2287a05a310c4fde8  schedule__box-placeholder__light.png
023eda36c74e3b038349e5602ea81c044b572cee0a279b67f8936a525e70fe77  schedule__exchange-after-reload__dark.png
38f46685c243a378ca04a9bde48a95f5167bde4cdee243d06214153f76e336b4  schedule__exchange-after-reload__light.png
30b4f1278ab302d5e54cffe0c822c2121eeef15afd07000b49a1dd12567bbcd4  schedule__no-respond-access__dark.png
7818e681a3e3d5b6a92e0fa550d1711e46e3867d7c1c627d460010caa03d6eed  schedule__no-respond-access__light.png
db0e3f0d6802baa61d100ae0cb9e5679de84594355d422f27e40b3f102235f6f  step-by-step__box-placeholder__dark.png
0cc3f56a3cd4fd9de2f90e97194d60cc15fb5d66d52bb0c4f34c80f57d1553b2  step-by-step__box-placeholder__light.png
37cb73f7fdcfb3979f47ac8adb49dd621259b5db37eb9da07518c7e7376f017c  step-by-step__exchange-after-reload__dark.png
5de846ff71cf2dcba23c6f6cdbb7ed274ff4e15a81b366a5159de9d6376dda1f  step-by-step__exchange-after-reload__light.png
71330e1b87aa11a77bb46bb80c9af27093f565ccc033856e5aa07ba667f86e2b  step-by-step__no-respond-access__dark.png
d4707d2cda319952df626e65d699ee030493057c35111e22f0d6e8f97ef1ddf1  step-by-step__no-respond-access__light.png
```
