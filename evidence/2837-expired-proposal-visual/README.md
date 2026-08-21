# An expired schedule proposal, on the real chat surface

Head under proof: `fix/2836-expired-proposal-stays-visible` (PR #2837, issue #2836),
**re-shot at the head that carries the lineage-claim fix** and the merge-forward
over `main`. The previous round's pictures were taken on 19 Aug, before both, and
one anchor they recorded had already gone false at the newer head.

The defect this evidence answers to: an expired proposal card **vanished** out of
the reader's own transcript. So the proof has to show the card **present**, in a
real conversation, saying that it expired, and offering the way out.

Nothing here is a component harness. Every pixel is the shipped `/chat` surface
in a running instance, and every wire line was read off the browser's own network
layer while that surface drove itself.

## A name is a claim, so every claim has a record

Cells are named in the capture-record grammar and every claim each one makes is
counted on the screen it was taken on, in the scope
`scripts/ci/lib/capture-record-contract.mjs` counts it in — `frame` for the frame
the picture was taken in, `root` for inside the card's own root
(`:scope`-inclusive). The counts live in `capture-records.json` beside the
pictures and in `capture-chat_thread.txt` in readable form, together with every
`POST /api/lifecycle-views/resolve` the page made.

**Two of the three cells are registered in
`scripts/ci/chat-hitl-capture-index.json`**, the file the gates read. The third
is not, and its record carries the contract's own findings verbatim rather than
an argument. An unindexed screenshot counts as zero, and that one is counted as
zero. See cell 11 below.

`validateCaptureIndex` returns **zero violations** over the whole index with
these two records in it.

## Runtime

| Fact | Value |
|---|---|
| Runtime | **Development runtime** (`pnpm dev`, Next.js 16.2.10, Turbopack) |
| App | worktree dev server on port **13838** |
| Stack | lane-private containers: own Postgres (**55837**), own Redis (**16838**), loopback-only |
| Database | fresh: `apply-public-schema.mjs` + `pnpm auth:migrate`, then the app's own boot bootstrap |
| Setup wizard | `CINATRA_E2E_SETUP_BYPASS=true` |
| LLM | **none.** No model call is involved: the thread is seeded through the app's own persistence route and the card resolves server-side from its ref. |
| Operator's stack | untouched. Ports 3000/3003/3009/3010/5434/5435/6379/4873/7474/7687 were never bound by this lane. |

## Why two card crops hash the same as the 19 Aug ones

They do, and that is a result rather than a reuse. The card crop is
deterministic: same reading, same agent name, same schedule copy, same one
control. A truthful re-shoot of an unchanged drawing produces the same bytes.

The **full-page** shots beside them do not match, because they carry this run's
own thread id in the breadcrumb and the title bar. Those are the frames that show
the run is new: a new database, a new reader, a new organization, a new thread and
freshly minted tokens.

## How the card got on screen, and what that does and does not prove

The proposal token is minted with the **shipped**
`mintTriggerScheduleProposalToken` under the server's own `BETTER_AUTH_SECRET`,
dated one TTL plus a minute into the past, so it is genuinely expired rather than
labelled expired. The thread is seeded through `POST /api/assistants/threads` —
the same first-class persistence route the `/chat` client itself writes — with
the lifecycle data part `{viewType, schemaVersion, ref}` on the assistant message,
then bound and title-slugged the way the app's own store primitives leave a
thread at rest. The page is then opened at the canonical
`/chat/<vendor>/<slug>/<titleSlug>` URL.

What that means: **the producer half is stubbed, and everything after it is real.**
The MCP tool that would mint this data part during a live turn is not exercised
here; the resolver, the resolve route, the reader re-authorization, the token
crypto, the renderable-views registry, the lifecycle shell, the expired body, the
Adjust server action and the lineage ratchet all are.

## The cells

| # | Cell | Verdict | Indexed |
|---|---|---|---|
| 10 | `S10__schedule-card__chat_thread__settled` — the expired card, present in the conversation | **PASS** | yes |
| 11 | `S11__schedule-card__chat_thread__pending` — after Adjust, a live proposal in the card's place | **PASS on the behaviour, DEVIATES from the contract's shape** | no, by the reason below |
| 12 | `S12__schedule-card__chat_thread__settled__after-reload` — reload returns to the expired reading | **PASS** | yes |

### 10 — the expired card is on screen, and says so

```
data-lifecycle-card            = "trigger_schedule_proposal"
data-lifecycle-card-host       = "chat_thread"
data-lifecycle-card-state      = "settled"
data-lifecycle-card-phase      = "expired"
adjust button present          = true
adjust button disabled         = false
card text = "Schedule proposalThis proposal expired before it was confirmed.
             Blog Draft Writer Agent — Every weekday at 09:00Adjust"

[frame] 1  [data-conversation-list]
[frame] 1  [data-lifecycle-card-host="chat_thread"]
[frame] 1  [data-lifecycle-card="trigger_schedule_proposal"]
[root ] 1  [data-lifecycle-card-state]
[root ] 0  [data-action]
```

and the wire line beside it:

```
resolve #1  HTTP 200
  request.ref  = TRANSCRIPT-REF
  state.state  = "settled"
  body.phase   = "expired"
  body.agentName    = "Blog Draft Writer Agent"
  body.scheduleCopy = "Every weekday at 09:00"
```

This is the defect closed. Before the fix the same ref answered `absent`, and
`absent` draws no card DOM at all.

The contract forbids `[data-action]` inside a settled card's root, and the count
is 0 honestly rather than by luck: the Adjust control carries
`data-lifecycle-action`, which is the lifecycle shell's own control attribute,
not the decision-bar attribute the forbiddance is about.

### 11 — Adjust re-proposes, in the card's place

The button was pressed on the real surface. The card came back to life under a
**different** ref:

```
data-lifecycle-card-state      = "pending"
data-lifecycle-card-host       = null
data-lifecycle-card-phase      = null
adjust button present          = false
card text                      = "Schedule proposalWaiting for your decision."

resolve #2  HTTP 200
  request.ref  = RE-PROPOSED-REF      (a different token from the transcript's)
  state.state  = "pending"
  state.canDecide = true
  body.phase   = "proposal"
```

**Why this cell is not in the index, stated rather than argued.** The contract's
`chat_thread` + `pending` claim requires
`[data-lifecycle-card-host="chat_thread"]` in the frame and a decision control
inside the root. Both are observed **0** times, and both are the shipped drawing
rather than a gap in the capture:

- the re-proposed card is the **S1 placeholder**, which main's carriage matrix
  rules is not a lifecycle-card root — it names the kind and a state, declares no
  host, and offers nothing to press;
- the drawn §VI card that would satisfy both — the option rows, the duration
  line, the Confirm floor — belongs to the stopped card-family epic's S9d slice,
  which this change does not draw.

So registering it would manufacture a finding nobody can clear by
re-photographing. The picture and the counts are real; the contract's *class* is
what does not describe this reading yet. Both findings are recorded verbatim on
the record in `capture-records.json`.

### 12 — reload returns to the expired reading, honestly

```
data-lifecycle-card-state      = "settled"
data-lifecycle-card-phase      = "expired"
[frame] 1  [data-lifecycle-card-host="chat_thread"]
[root ] 0  [data-action]

resolve #3  HTTP 200
  request.ref  = TRANSCRIPT-REF
  state.state  = "settled"
  body.phase   = "expired"
```

Propose-purity holding on the real surface: a proposal has no server record until
Confirm, so the re-proposal is local to the screen and a reload returns to the
transcript's own ref — which reads expired permanently, and never blank.

## The lineage, on these two real tokens and the row the press wrote

Both tokens from cell 11 were read back with the shipped crypto:

```
original     status=expired  nonce=97NJp8bOVJAB_fjA8YnDkQ
replacement  status=live     nonce=97NJp8bOVJAB_fjA8YnDkQ
consumeKey   33502a11bf046a51d4744e9a18174fb8bb4402560e6d211d69fbdfde1f55a8f6
sameToken      = false   (a genuinely different token, on its own fresh window)
sameConsumeKey = true    (ONE consume identity for the whole lineage)
```

And the **ratchet row that press actually wrote**, read straight out of the lane
database:

```
SELECT consume_key, left(latest_token,24), expires_at > now(), reproposed_by
  FROM cinatra.trigger_schedule_proposal_lineage;

-> exactly ONE row
   consume_key   = 33502a11…f1e55a8f6   (the same key both tokens derive)
   latest_token  = gtqLcXeoSZSOVmn6EZjuFNRp…   (the RE-PROPOSED ref)
   live          = t
   reproposed_by = the reader above
```

One live token per lineage, named by the ratchet, on the real surface.

## Recorded limits

Four, stated rather than dressed up:

1. **The producer is not exercised.** The data part is seeded, not emitted by a
   live model turn. Everything downstream of it is the shipped path.
2. **The DRAWN form's Adjust has no surface to photograph.** This round's
   blocking fix routes `adjustScheduleProposal` — the drawn card's server action
   — through the lineage claim. No shipped UI calls it yet, which is exactly why
   it was a wire-reachable bypass rather than a visible bug: a `"use server"`
   export becomes wire-reachable when a client module imports the file, and the
   expired card here is the first such import. That path is proven instead
   against **real Postgres** in
   `packages/agents/src/__tests__/trigger-schedule-proposal-lineage.integration.test.ts`,
   where a concurrent double-adjust leaves exactly one live token in the slot and
   the loser gets the documented refusal.
3. **No `site_widget` capture.** Adjust must not offer a cookie-bound affordance
   on the brokered widget host; that is answered in code and pinned by the card
   suite (the widget declaration draws the reading, draws Adjust disabled with
   `data-lifecycle-action-disabled="no_cookie_session"` and its reason, and issues
   no call even when the press is forced). Standing up a real embed frame needs a
   registered site, a connector instance and a broker token, which is S8d/S9d
   apparatus this change does not touch. The widget cell is pinned, not pictured.
4. **Development runtime**, not a production build.
