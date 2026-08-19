# The resolve envelope, on the real application, host by host

Head under proof: `feat/2787-s9c-resolve-envelope`.
The three committed host cells were captured 2026-08-16 at `7679b127`; the
capture index, the drivers and the corrected `site_widget` finding are from the
2026-08-19 round.

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
| **site_widget** | — | — | — | **NOT CAPTURED** — host reached and card drawn, pair not recorded; see the finding |

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

### site_widget — still not captured, but no longer for the reason given before

**The earlier claim in this file was wrong and is withdrawn.** It said the cell
needs a WordPress container and the CMS plugin. It does not. Round 2 drove the
broker path on a plain local page and got the real card to draw inside the embed
frame; what is missing is the recorded pair (anchors + wire, pending AND
settled), not the ability to reach the host.

What round 2 established, with the drivers in `drivers/`:

- The embed mounts in a **plain HTML page that is not the Cinatra app**
  (`drivers/site-widget-host-page.html`), which speaks the bridge protocol
  (`cinatra.embed.ready` → `cinatra.embed.context`) exactly as the CMS chrome
  does. No WordPress, no plugin.
- The host binding **closes** for that page: `deriveFrameBinding` returns
  `ok: true` with `agentSlug: "wordpress-content-editor"` once the instance row
  and the connect-site exist. Both are written by the SHIPPED writers
  (`writeConnectorConfigToDatabase`, `upsertConnectSiteAndMintCredential`) —
  see `drivers/02-seed-widget-site.mts`.
- The **hosted-PKCE ceremony completes end to end**, recorded by the app's own
  `[widget-auth-audit]`: `init_success` → `page_viewed(login)` →
  `page_viewed(grant)` → `code_issued` with
  `grantedScopes: "lifecycle.read lifecycle.decide conversation.read conversation.write tools.confirm"`
  → `redeem_success`. The frame ends up holding `cit_` + `cwu_`.
- One real gate was found and cleared: the `cit_` consume refused with
  `origin_unconfigured` because the connector declares
  `requiredInstanceFields = [id, name, username, applicationPassword]` and the
  instance row was short of the last two. With them present the widget
  negotiation passes and the frame reaches `data-phase="active"`.
- The **card then draws in the frame**: the review header, the
  "Awaiting your decision" state chip and the decision-rationale floor, with the
  conversation composer under it.

What is NOT here, and why it is not claimed: the run that drew the card was
killed by a host restart before it wrote its log and its settled half. So there
is no `capture-site_widget.txt` carrying the `ANCHORS pending` /
`ANCHORS settled` lines and the resolve/decide envelope for this host. Under the
capture-index rule a picture without its recorded anchors proves nothing, so
**no site_widget picture is committed** — a shot presented on narration alone is
the exact anti-pattern that rule exists to catch.

The cell is reproducible from `drivers/README.md` in one pass on a warm stack.
The assertion it must carry is unchanged: *the same `ReviewGateCard`, resolving
through the broker path with `X-Cinatra-Widget-User-Token` and no cookie
fallback, draws pending and then settled inside the `.cw-frame` embed frame with
`data-lifecycle-card-host="site_widget"`.*

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

## The capture index — every host named by its RECORDED ANCHORS

A file name carries no authority. Each row below names the host from the
`data-lifecycle-card-host` the card itself published, quoted from the log line
beside the picture. Read the log, not the file name; where the two ever disagree,
the log is the record and the file name is the error.

| File | Recorded host (from the card's own DOM) | Recorded state | Where the record is |
|---|---|---|---|
| `s9c-10-chat-thread-pending-page.png` | `chat_thread` | `pending` | `capture-chat.txt` → `ANCHORS pending` |
| `s9c-11-chat-thread-pending-card.png` | `chat_thread` | `pending` | `capture-chat.txt` → `ANCHORS pending` |
| `s9c-12-chat-thread-settled-page.png` | `chat_thread` | `settled` | `capture-chat.txt` → `ANCHORS settled` |
| `s9c-13-chat-thread-settled-card.png` | `chat_thread` | `settled` | `capture-chat.txt` → `ANCHORS settled` |
| `s9c-20-run-card-pending-page.png` | `run_card` | `pending` | `capture-run_card.txt` → `ANCHORS pending` |
| `s9c-20-run-card-pending-card.png` | `run_card` | `pending` | `capture-run_card.txt` → `ANCHORS pending` |
| `s9c-20-run-card-settled-page.png` | `run_card` | `settled` | `capture-run_card.txt` → `ANCHORS settled` |
| `s9c-20-run-card-settled-card.png` | `run_card` | `settled` | `capture-run_card.txt` → `ANCHORS settled` |
| `s9c-30-page-gate-region-pending-page.png` | `page_gate_region` | `pending` | `capture-page_gate_region.txt` → `ANCHORS pending` |
| `s9c-30-page-gate-region-pending-card.png` | `page_gate_region` | `pending` | `capture-page_gate_region.txt` → `ANCHORS pending` |
| `s9c-30-page-gate-region-after-decision-page.png` | `page_gate_region` | **no card** — the host removed it | `capture-page_gate_region.txt` → `AFTER DECISION card instances on this host = 0` |

The chat rows additionally record `insideConversationList: true`, and the settled
chat row records `sameConversation: 1` — the pending card, the decision and the
settled card are one card in one conversation.

The last row is deliberately not a settled card, and its log line says so in the
host's own terms: this host removes the card DOM after a decision, so the picture
is the page's replacement region. See the finding above.

## The other files

- `capture-chat.txt`, `capture-run_card.txt`, `capture-page_gate_region.txt`,
  `capture-wire.txt` — the unedited capture logs: anchors and every wire line.
- `production-build-attempt.txt` — the unedited tail of the failed build.
- `drivers/` — the capture path itself, so this round is reproducible rather than
  narrated. See `drivers/README.md`.
