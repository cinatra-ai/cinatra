# An expired schedule proposal, on the real chat surface

Head under proof: `fix/2836-expired-proposal-stays-visible` (PR #2837, issue #2836).
Captured 2026-08-19 on a lane-private stack, in answer to the review round's
blocking item 2: *"No real chat capture. Acceptance 2 requires one; visual proof
is fail-closed. Capture the expired card and the card after Adjust on the real
surface, posted as the canonical proof pair."*

The defect this evidence answers to: an expired proposal card **vanished** out of
the reader's own transcript. So the proof has to show the card **present**, in a
real conversation, saying that it expired, and offering the way out.

Nothing here is a component harness. Every pixel is the shipped `/chat` surface
in a running instance, and every wire line was read off the browser's own network
layer while that surface drove itself.

## Every record carries the anchors it actually rendered with

A file name claims nothing. Immediately before each shot the capture reads the
card's own attributes off the DOM and writes them into `capture-chat_thread.txt`
beside the picture: `data-lifecycle-card`, `data-lifecycle-card-host`,
`data-lifecycle-card-state`, the body's `data-lifecycle-card-phase`, and the
Adjust control's own presence/disabled state. The same log carries every
`POST /api/lifecycle-views/resolve` the page made, with the state and phase the
server answered. Read the log next to any picture and you can check the claim
without trusting the file name.

`data-lifecycle-card-host` is new in this round. It was added precisely so a
capture can cite the host off the card's own root instead of asserting it in
prose, and it is pinned by the card suite in both directions.

## Runtime

| Fact | Value |
|---|---|
| Runtime | **Development runtime** (`pnpm dev`) |
| App | worktree dev server on port **13837**, own queue name `x2837f-queue` |
| Stack | throwaway Compose project **`x2837f`**: own Postgres (**15434**), own Redis (**16379**), own volume, own network |
| Database | fresh: `apply-public-schema.mjs` + `pnpm auth:migrate`, then the app's own boot bootstrap |
| Setup wizard | `CINATRA_E2E_SETUP_BYPASS=true` |
| LLM | **none.** No model call is involved: the thread is seeded through the app's own persistence route and the card resolves server-side from its ref. |
| Operator's stack | untouched. Ports 3000/3003/3009/3010/5434/5435/6379 were never bound by this lane. |

## How the card got on screen, and what that does and does not prove

The proposal token is minted with the **shipped** `mintTriggerScheduleProposalToken`
under the server's own `BETTER_AUTH_SECRET`, dated one TTL plus a minute into the
past, so it is genuinely expired rather than labelled expired. The thread is
seeded through `POST /api/assistants/threads` — the same first-class persistence
route the `/chat` client itself writes — with the lifecycle data part
`{viewType, schemaVersion, ref}` on the assistant message, then bound and
title-slugged the way the app's own store primitives leave a thread at rest. The
page is then opened at the canonical `/chat/<vendor>/<slug>/<titleSlug>` URL.

What that means: **the producer half is stubbed, and everything after it is real.**
The MCP tool that would mint this data part during a live turn is not exercised
here; the resolver, the resolve route, the reader re-authorization, the token
crypto, the renderable-views registry, the lifecycle shell, the expired body and
the Adjust server action all are.

## The cells

| # | Cell | Pictures | Verdict |
|---|---|---|---|
| 10 | The expired card, present in the conversation | `x2837f-10-chat-thread-expired-card.png`, `…-page.png` | **PASS** |
| 11 | After Adjust — a live proposal in the card's place | `x2837f-11-chat-thread-after-adjust-card.png`, `…-page.png` | **PASS** |
| 12 | After reload — the transcript's own ref reads expired again | `x2837f-12-chat-thread-after-reload-card.png` | **PASS** |

### 10 — the expired card is on screen, and says so

Anchors, quoted from `capture-chat_thread.txt`:

```
data-lifecycle-card            = "trigger_schedule_proposal"
data-lifecycle-card-host       = "chat_thread"
data-lifecycle-card-state      = "settled"
data-lifecycle-card-phase      = "expired"
adjust button present          = true
adjust button disabled         = false
card text = "Schedule proposalThis proposal expired before it was confirmed.
             Blog Draft Writer Agent — Every weekday at 09:00Adjust"
```

and the wire line beside it:

```
resolve #1  HTTP 200
  request.ref  = TRANSCRIPT-REF
  state.state  = "settled"
  view.phase   = "expired"
  view.agentName    = "Blog Draft Writer Agent"
  view.scheduleCopy = "Every weekday at 09:00"
```

This is the defect closed. Before the fix the same ref answered `absent`, and
`absent` draws no card DOM at all.

### 11 — Adjust re-proposes, in the card's place

The button was pressed on the real surface. The card came back to life under a
**different** ref:

```
data-lifecycle-card-state      = "pending"
data-lifecycle-card-phase      = null
adjust button present          = false
card text                      = "Schedule proposalWaiting for your decision."

resolve #2  HTTP 200
  request.ref  = RE-PROPOSED-REF      (a different token from the transcript's)
  state.state  = "pending"
  view.phase   = "proposal"
```

The re-proposed card draws as the shell's ordinary pending reading. That is the
documented scope boundary, not a defect: the drawn §VI card — the option rows,
the duration line, the Confirm floor — belongs to the stopped card-family epic's
S9d slice, and this change does not draw it.

### 12 — reload returns to the expired reading, honestly

```
data-lifecycle-card-state      = "settled"
data-lifecycle-card-phase      = "expired"

resolve #3  HTTP 200
  request.ref  = TRANSCRIPT-REF
  state.state  = "settled"
  view.phase   = "expired"
```

This is propose-purity holding on the real surface: a proposal has no server
record until Confirm, so the re-proposal is local to the screen and a reload
returns to the transcript's own ref — which reads expired permanently, and never
blank.

## The consume-identity lineage, on these two real tokens

Round 2's central claim is that the replacement Adjust mints **inherits** the
original's consume identity, so the whole lineage addresses one primary-keyed
consume row and a double-confirm becomes a state the database cannot hold. Both
tokens from cell 11 were read back with the shipped crypto:

```
original     status=expired  nonce=7siL7dJXBBcCNUg3pP6cAw  expiresAt=1787146768
replacement  status=live     nonce=7siL7dJXBBcCNUg3pP6cAw  expiresAt=1787148727
consumeKey   d3c8147a…2468ac  — IDENTICAL on both
sameToken      = false   (a genuinely different token, on its own fresh window)
sameConsumeKey = true    (ONE consume identity for the whole lineage)
```

## Recorded limits

Three, stated rather than dressed up:

1. **The producer is not exercised.** The data part is seeded, not emitted by a
   live model turn. Everything downstream of it is the shipped path.
2. **No `site_widget` capture.** The round's blocking item 1 — Adjust must not
   offer a cookie-bound affordance on the brokered widget host — is answered in
   code and pinned by the card suite (the widget declaration draws the reading,
   draws Adjust disabled with `data-lifecycle-action-disabled="no_cookie_session"`
   and its reason, and issues no call even when the press is forced). Standing up
   a real embed frame needs a registered site, a connector instance and a broker
   token, which is S8d/S9d apparatus this change does not touch. The widget cell
   is therefore pinned, not pictured, and that is said here rather than implied.
3. **Development runtime**, not a production build.
