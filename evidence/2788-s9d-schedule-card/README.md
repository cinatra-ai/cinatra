# cinatra#2788 (S9d) — §VI's schedule-proposal card, photographed on the running app

Until this slice the chat and the widget answered a schedule proposal with a grey
box reading *"Schedule proposal · Waiting for your decision."* — one line, no
controls, and no sight of the schedule the reader was being asked about. The
maintainer refused that box, and rightly: **a reader has to see what they are
deciding on.** This directory is the evidence that the shipped card now shows it,
photographed on the live application, in both themes, on two hosts.

## What was driven, and by what

Every state below was produced by the shipped path and pressed in the browser:

1. **The proposal was minted by the shipped producer leaf** — `proposeTriggerSchedule`
   (`packages/agents/src/trigger-schedule-propose.ts`), the exact call the
   model-facing tool reaches. It writes nothing, and the walk proves that rather
   than asserting it: after four proposals the consume table, the install outbox
   and `agent_runs` were all still empty (`drivers/walk.test.ts`, step `PROPOSE`).
2. **The card reached a REAL transcript** through `POST /api/assistants/threads`,
   the route the /chat client itself writes with, carrying the shipped
   `{ viewType, schemaVersion, ref }` envelope and nothing else
   (`drivers/seed-chat-thread.mjs`). What is stood in for there is the MODEL
   LAYER — the assistant turn's words — and nothing downstream of it.
3. **Every state change is a press.** Adjust, Confirm and the settled chrome are
   the card's own controls, posting to the shipped `/api/lifecycle-views/decide`.
   The driver invokes no server action and writes no decision row.
4. **The run-page cells** are the same component mounted by `TriggerScreen`
   against the run that Confirm created — the ref is minted server-side from the
   run, and the resolver re-derives the proposal's own (viewer, organization,
   template) binding from its consume row.

**Runtime:** the dev server (`pnpm dev`, Next.js 16.2.10, Turbopack) against a
lane-private Postgres and Redis on loopback, on a lane database of its own,
placeholder-only environment, **no model credential on the host**. Viewport 1228
wide, **device scale factor 2**. The theme is set the way the app stores it
(`localStorage.theme`, next-themes over the named `cinatra` / `dark` classes) — a
context merely asked for `prefers-color-scheme: dark` renders the LIGHT ground
here — and every record carries the class the document actually resolved.
Each picture is an element screenshot of the card's own root, so the grading is
of the card rather than of the page around it; the page anchors
(`[data-conversation-list]`, the host declaration) are measured and written into
each record.

## The grading table

Graded by opening each PNG and reading it against **PLAN: Agents Lifecycle §7**
and the drawing at `design@71398a49c1f8adfe6176ab0dda25486920fac958` §VI (the
commit `scripts/audit/chat-hitl-acceptance-manifest.json` pins). `PLAN-WALK.md`
carries the verbatim sentences each cell is graded against.

| Capture | Requires | Shows | Verdict |
|---|---|---|---|
| `captures/A1__schedule-card__chat_thread__pending.png` | §VI's proposal body in the turn: *When should this run?* over the three option rows, the chosen row taking the indigo edge and tint and **owning its fields**, the estimated duration beneath, then the floor **Adjust · Confirm**. No raw cron field anywhere | The question, then **Run right after setup** / **Schedule for later** / **Recurring** — Recurring chosen, indigo edge and tinted ground, and the only row drawing fields: Repeat every 1 week(s), On **Mon Tue Wed Thu Fri** filled and Sun/Sat not, At 09 : 00, Timezone Europe/Berlin. Then **Estimated run duration**, then **Adjust** and **Confirm**. The word "cron" appears nowhere on the card (measured, not assumed) | **PASS** — this is the cell the placeholder box could not answer: the schedule is legible before anything is pressed. One reservation, stated in "Deviations" below: the duration reads *Unavailable.* rather than a range |
| `captures/A2__schedule-card__chat_thread__pending__adjust-open.png` | **Adjust opens the same option rows in place** — the same rows made writable, not a second form and not a second card | The identical card with its rows live: the weekday buttons, the interval and frequency selects, the hour/minute selects and the timezone input all enabled, Adjust reading `aria-pressed="true"`. Nothing else on the card moved | **PASS** |
| `captures/A3__schedule-card__chat_thread__settled.png` | After Confirm the card settles **in the same place** into the trigger's own chrome: read-only **Trigger configuration** (type, the schedule in plain words, timezone), **Steps held until trigger fires**, and two quiet right-aligned controls — **Cancel trigger**, and **Release now** for an administrator | **Trigger configuration** — Type `recurring`, Schedule **Every weekday at 09:00**, Timezone `Europe/Berlin`; **Steps held until trigger fires** with the no-side-effect sentence; and, right-aligned, **Cancel trigger** and **Release now** (this reader is an administrator), with the first-party **Open the run** link at the left. No option rows and no Confirm remain | **PASS** — and it is the SAME card element in the SAME turn: A1 → A2 → A3 is one continuous interaction in one transcript, not three screens |
| `captures/B1__schedule-card__chat_thread__pending__dark.png` | The same proposal reading on the dark ground, with the selection still legible | The same card, dark tokens, and **Mon–Fri drawn as filled chips** against the unfilled Sun/Sat. Document class `dark`, and a different image hash from A1 | **PASS — after a fix this capture forced.** On the first round every weekday chip rendered identically muted here and the proposed days were invisible: the `outline` variant's own `dark:bg-input/30` survives beside an unprefixed `bg-primary` and painted over the selection. A selected day is now the `default` variant. Pinned by `packages/agents/src/__tests__/schedule-proposal-card.test.tsx` — "the CHOSEN weekdays are drawn on the legible variant, on both grounds" |
| `captures/B2__schedule-card__chat_thread__pending__adjust-open__dark.png` | Adjust in place, on the dark ground | The same rows live on the dark ground, Adjust pressed, the selected days still legible | **PASS** |
| `captures/B3__schedule-card__chat_thread__settled__dark.png` | The settled trigger chrome on the dark ground | Trigger configuration, the held-steps sentence, **Cancel trigger** and **Release now**, all legible on the dark ground | **PASS** |
| `captures/R1__schedule-card__run_card__settled.png` | **The same card on the run page** — one renderer, a different host — drawn for a run a proposal actually produced, addressed by a run-scoped ref minted server-side | The same chrome on `/agents/cinatra-ai/planner-agent/<runId>/trigger`, under `data-lifecycle-card-host="run_card"`: Type `immediate`, Schedule **Runs right after setup**, Timezone `UTC`, the held-steps sentence, and the honest released reading — *"Released — every held step is eligible now, so there is nothing left to cancel."* — with **Cancel trigger** drawn and disabled and no **Release now** | **PASS**, with the state named: an immediate trigger releases as it arms, so this is the RELEASED face of the settled card, not the armed-and-waiting one. It is what the run really was |
| `captures/R2__schedule-card__run_card__settled__dark.png` | The same run-page reading on the dark ground | Identical reading, dark tokens, different image hash | **PASS** |
| `captures/E1__schedule-card__chat_thread__pending__expired-face__standin.png` | §7 step 5: an expired proposal **stays visible**, showing the schedule it asked about, with **Adjust** to propose again — and no Confirm | The expired sentence — *"This schedule proposal expired before it was confirmed. Nothing was scheduled — adjust it to propose again."* — over the same rows still carrying Mon–Fri at 09:00 Europe/Berlin, and a floor with **Adjust** alone. No Confirm | **PASS as a STAND-IN, and only as one.** `main`'s resolver answers an expired proposal `absent`, so this branch cannot reach the expired PHASE through the server: the fix is cinatra#2836 / PR #2837, which is open. The card, the transcript, the browser and every counted anchor are real; the RESOLVE RESPONSE is substituted with the expired body this branch carries byte-identically from that PR. The cell name says `standin` and so does the record's note |
| `captures/E2__schedule-card__chat_thread__pending__expired-face__standin__dark.png` | The same expired reading on the dark ground | The same sentence, rows and lone Adjust, dark tokens | **PASS as a STAND-IN** — same statement as E1 |

### The hashes, and the two anchors that separate the readings

Measured inside the card's own root; `absent` is written down as an observation
rather than left silent.

| Cell | sha256 | `[data-lifecycle-card-phase]` | floor controls in the root |
|---|---|---|---|
| A1 | `dcf2f176dc36…` | `proposal` | Adjust + Confirm |
| A2 | `037feae6d8ea…` | `proposal` | Adjust (pressed) + Confirm |
| A3 | `73f95c5275d3…` | `settled` | **none** — Cancel trigger / Release now instead |
| B1 | `a88a8bdd6c47…` | `proposal` | Adjust + Confirm |
| B2 | `eae5cf90142a…` | `proposal` | Adjust (pressed) + Confirm |
| B3 | `23536f15b8d7…` | `settled` | **none** |
| R1 | `8c61183fa0b5…` | `settled` | **none** |
| R2 | `da8c5e1243c2…` | `settled` | **none** |
| E1 | `f76c0d1c88cd…` | `expired` | **Adjust only** |
| E2 | `ad7f21ef7725…` | `expired` | **Adjust only** |

Every record is registered in `scripts/ci/chat-hitl-capture-index.json` — the one
canonical index both gates read. An unindexed screenshot counts as zero.

## Deviations and limits, stated rather than left to be noticed

1. **The estimated duration reads *Unavailable.*, not a range.** §VI draws
   "Estimated run duration · About 45s – 3.4 hr." The resolver sends
   `durationCopy: null` on purpose — the estimate's second tier is an LLM call,
   and the card would pay it on every resolve of every proposal — so the card
   draws the shipped scheduling step's own honest fallback in the drawing's
   position. On this lane it would read *Unavailable.* either way: the template
   has no completed-run history for the cheap first tier, and no model credential
   exists on this host for the second. **Not fixed here, and not hidden:** giving
   this line a value is a resolver change with a cost question attached, and it
   is worth its own issue rather than a silent addition inside a drawing slice.
2. **`run_card` has no proposal state, structurally.** Confirm CREATES the run,
   so before Confirm there is no run for a URL-reached surface to address, and
   after it the phase is `settled` by definition. That is the deviation the PR
   body already raises against §7 step 5's "in its proposal state you propose or
   adjust there"; these captures show the half that exists.
3. **`page_gate_region` and `site_widget` are not photographed here.** The card
   mounts on both (the registry row serves the widget transcript, and the review
   page mounts the card in its gate region), and the mounts are pinned by
   `src/lib/lifecycle/__tests__/schedule-card-host-mounts.test.ts`. A capture is
   evidence only of the host it was taken on, and neither host is claimed by a
   picture in this directory. The widget cell needs the whole broker chain; the
   PR's earlier evidence branch has one for a different cell set.
4. **Dev runtime, labelled.** These are development-runtime captures under the
   2026-08-13 ruling for dispatch-dependent cells, and every record says
   `"build": "development"`.

## Files

- `captures/` — the ten PNGs, element screenshots of the card root at scale 2.
- `capture-records.json` — the records exactly as the shared recorder wrote them,
  the twin of what was merged into the canonical index.
- `PLAN-WALK.md` — each cell against the verbatim plan sentence that governs it.
- `drivers/` — `lane-setup.mjs` (account, membership in the template's own
  organization, active org), `walk.test.ts` + `walk.config.ts` (the shipped mint
  and the readback), `seed-chat-thread.mjs` (the transcript), `capture.mjs` (the
  browser walk and the records).
