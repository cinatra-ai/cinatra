# The resolve envelope, on the real application, host by host

Head under proof: `feat/2787-s9c-resolve-envelope` at `7679b127`.
Captured 2026-08-16.

The goal this evidence answers to: the lifecycle screens show up INSIDE the chat,
and the proof shows them inside the chat. This slice is plumbing, and the
plumbing runs under the chat card — `ReviewGateCard` parses the envelope, and the
transcript's lifecycle shell consumes it. So the chat surface leads.

Nothing here is a component harness. Every pixel is a shipped surface in a
running instance, and every wire line was read off the browser's own network
layer while that surface drove itself.

## Every record carries the host it actually rendered

A file name claims nothing. Before each shot the capture reads the card's own
attributes off the DOM and writes them into the log beside the picture:
`data-lifecycle-card-host`, `data-lifecycle-card-state`, `data-lifecycle-card`,
`data-conformance-id`, and whether the decision bar and the target island are
inside that element. The chat records additionally assert the card sits inside
`[data-conversation-list]`. Read `capture-<host>.txt` next to any picture and you
can check the claim without trusting the file name.

## Runtime

| Fact | Value |
|---|---|
| Runtime | **Development runtime** (`pnpm dev`), labelled on every cell |
| Why not a production build | `pnpm build` dies with a V8 heap OOM on this machine. Unedited tail: `production-build-attempt.txt`. |
| App | worktree dev server on port 3058, own queue name |
| Stack | throwaway Compose project `s9c2787h4`: own Postgres (5463), own Redis (6399), own volumes, own network |
| Database | fresh: `apply-public-schema.mjs` + `pnpm auth:migrate`, then the app's own boot bootstrap created the `cinatra` schema |
| Setup wizard | `CINATRA_E2E_SETUP_BYPASS=true` — the wizard only |
| LLM | none. `CINATRA_TEST_LLM_PROVIDER=scripted`, so the chat turn dispatches the real self-MCP lifecycle pull with no model call. |
| Operator's stack | untouched. Its 7 containers stayed up across the whole capture. |
| Teardown | 2 containers, 2 volumes, 1 network created and removed; 0 of each remain |

## Per-host cells

| Host | Pending | Decision through the card's floor | Settled | Verdict |
|---|---|---|---|---|
| **chat_thread** | `s9c-10`, `s9c-11` | yes, in the conversation | `s9c-12`, `s9c-13` — same conversation | **PASS** |
| **run_card** | `s9c-20-*-pending-*` | yes, in the run panel | `s9c-20-*-settled-*` — settles in place | **PASS** |
| **page_gate_region** | `s9c-30-*-pending-*` | yes | none — see the finding | **PASS with a recorded limit** |
| **site_widget** | — | — | — | **NOT CAPTURED** — see the finding |

### chat_thread — the one that matters most

`capture-chat.txt` records, in order: the composer sends one turn; the card
appears inside `[data-conversation-list]` with
`{"host":"chat_thread","state":"pending","kind":"artifact_review_gate","conformance":"review-gate-card","insideConversationList":true,"decisionBar":true,"island":true}`;
the resolve answers `{"kind":"artifact_review_gate","state":{"state":"pending",…},"body":null}`;
Approve is pressed on the card's own floor; the decide endpoint answers
`{"kind":"decided","disposition":"approve","idempotent":false}`; the card
re-resolves `settled` and redraws as
`{"host":"chat_thread","state":"settled","insideConversationList":true}` with one
conversation list on the page. Pending, decision and settled are the same card in
the same conversation.

`s9c-11` shows the drawn card: the review header, the target island with the real
repaired revision, the composer-binding row, and one decision floor.

### run_card

The run detail page mounts the card through the run panel's own review-gate step.
Anchors: `{"host":"run_card","state":"pending",…,"decisionBar":true,"island":true}`
then `{"host":"run_card","state":"settled"}`. It settles in place — no navigation.

### page_gate_region, and its recorded limit

Pending draws normally. After the decision **this host removes the card DOM**: a
landed decision refreshes the router, the refreshed page finds the gate resolved
and renders its own "This review is no longer open" region instead of mounting
the card. The capture asserts it rather than describing it —
`AFTER DECISION card instances on this host = 0` in
`capture-page_gate_region.txt` — and `s9c-30-*-after-decision-page.png` is that
replacement region, not a settled card. Pre-existing page behaviour, untouched by
this slice.

### site_widget — not captured, and why

The widget's card is drawn behind the real hosted-PKCE broker handshake: the
embed declares `host: "site_widget"` with a `cwu_` credential that only a
completed sign-in through the CMS-mounted widget produces, and the capture-index
rule requires the record to be asserted inside the declared `.cw-frame` embed
frame rather than the main frame. That frame is mounted by the CMS plugin, so the
cell needs a WordPress container, the plugin, connect-site credentials and the
broker negotiation — a stack this round did not stand up.

The exact assertion the cell would carry: *the same `ReviewGateCard`, resolving
through the broker path with `X-Cinatra-Widget-User-Token` and no cookie
fallback, draws pending and then settled inside the `.cw-frame` embed frame with
`data-lifecycle-card-host="site_widget"`.* It is recorded as missing rather than
substituted with a main-frame screenshot, which the capture-index rule would
reject and which would be the exact anti-pattern that rule exists to catch.

## The wire

`capture-wire.txt`, read off the browser on the real instance.

Verification carries its sanitized §VII reading beside `advisory` — and the
record behind it was written by the shipped writers, not by hand:

```
{"kind":"verification_summary","state":{"state":"advisory"},"body":{"version":1,
 "outcome":"drifted","reviewedRevisionId":"29db7f76-…","repairedRevisionId":"e5f36231-…",
 "scopePaths":["representation.form"],
 "fieldDiff":[{"field":"representation.resource","before":"0811e687-…","after":"fbc66bb9-…"}]}}
```

No record id, no gate id, no artifact id. The sanitizer's promise, on the wire.

Schedule, and both kinds on a forged ref — `absent`, body null, status 200 every
time, so neither the body nor the status is an oracle:

```
{"kind":"trigger_schedule_proposal","state":{"state":"absent"},"body":null}
{"kind":"artifact_review_gate","state":{"state":"absent"},"body":null}
{"kind":"verification_summary","state":{"state":"absent"},"body":null}
```

The recommendation hold, refused at the door — the live counterpart of the
rejection fixture in the protocol suite:

```
status 400  {"error":"Invalid lifecycle view request"}
```

Schedule and verification pixels are not this slice's to draw; those cards land
in the two slices that follow.

## What is real, and what is seeded

REAL, and all of it is on the path under proof:

- the identity — a Better Auth email sign-up through the running app;
- the review gate, the repair, the successor gate and the verification record —
  all written by the SHIPPED writers through the dev lifecycle-seed route, which
  contains no SQL and cannot write a row around a writer;
- the artifacts at their pinned revisions, produced by those same writers;
- the agent template — the committed no-LLM review-gate fixture agent, staged
  into `extensions/` and registered by the shipped dev boot scan;
- the chat turn — the scripted provider routes it, and the real self-MCP
  dispatch, the real producer and the real sink put the data part on the turn;
- the authorization ladder, the resolve endpoint, the envelope, the card and
  every decision.

SEEDED, and none of it is the thing under proof:

- the org MEMBERSHIP row for the signed-up user. This install refuses a second
  organization, so the capture user was made an owner of the existing one.
- the agent RUN row. The sanctioned harness bypass that
  `tests/e2e/agents-run/review-gate-fixture.ts` already takes and states.
- for the run_card cell only: one INTERRUPT frame appended to that run's own
  event log, in the exact shape the executor's marked-gate branch emits, plus the
  run moved to `pending_approval`. That is the run's live paused state, seeded
  because driving it needs the WayFlow runtime container this host did not run.
  It decides only WHETHER the panel mounts the card; everything the card then
  does is the shipped path.

## Files

- `s9c-10..13-chat-thread-*` — pending page, pending card, settled page, settled card.
- `s9c-20-run-card-*` — pending page, pending card, settled page, settled card.
- `s9c-30-page-gate-region-*` — pending page, pending card, after-decision page.
- `capture-chat.txt`, `capture-run_card.txt`, `capture-page_gate_region.txt`,
  `capture-wire.txt` — the unedited capture logs: anchors and every wire line.
- `production-build-attempt.txt` — the unedited tail of the failed build.
