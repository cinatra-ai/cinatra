# The resolve envelope, on the real application

Head under proof: `feat/2787-s9c-resolve-envelope` at `e543867e`.
Captured 2026-08-16.

This slice is plumbing: it replaces the state-only resolve answer with a
per-kind envelope `{ kind, state, body }`. The visual it owes is therefore the
one its parity suite proves in bytes — the review card drawing UNCHANGED on the
real application, through the real resolve path, with the envelope live
underneath — plus the wire that ties those pixels to the fail-closed contract.

Nothing here is a component harness. Every pixel is the shipped review page in
a running Cinatra instance, and every wire line below was read off the browser's
own network layer while that page was driving itself.

## Runtime

| Fact | Value |
|---|---|
| Runtime | **Development runtime** (`pnpm dev`), explicitly labelled |
| Why not a production build | `pnpm build` died with a V8 heap OOM on this machine. The unedited tail is `production-build-attempt.log`. |
| App | worktree dev server on port 3057, own queue name |
| Stack | throwaway Compose project `s9c2787cap`: own Postgres (5462), own Redis (6398), own volumes, own network |
| Database | fresh: `apply-public-schema.mjs` + `pnpm auth:migrate`, then the app's own boot bootstrap created the `cinatra` schema |
| Setup wizard | `CINATRA_E2E_SETUP_BYPASS=true` — the wizard only, nothing else |
| Operator's stack | untouched. Its 7 containers stayed up across the whole capture. |
| Teardown | 2 containers, 2 volumes, 1 network created and removed; 0 of each remain |

The capture rule asks for production-build screenshots on deterministic cells.
The build does not fit this machine's memory, so every cell below is a
development-runtime capture and is labelled as one. That is the rule's stated
fallback, not a shortcut around it.

## What is real, and what is seeded

REAL, and every one of them is on the path under proof:

- the identity — a Better Auth email sign-up through the running app;
- the artifact — a real upload through `POST /api/artifacts/upload`, drawn in
  the card at its real pinned representation revision;
- the agent template — the committed no-LLM review-gate fixture agent, staged
  into `extensions/` and registered by the shipped dev boot scan;
- the authorization ladder, the resolve endpoint, the envelope, the card, and
  the decision — all shipped code, untouched by the harness.

SEEDED, and none of them is the thing under proof:

- the org MEMBERSHIP row for the signed-up user. This install refuses a second
  organization, so the capture user was made an owner of the existing one.
- the agent RUN row. This is the sanctioned harness bypass that
  `tests/e2e/agents-run/review-gate-fixture.ts` already takes and states.
- the review GATE row, with the shipped store's canonical pinned-target shape.
  Minting it through the run executor needs the WayFlow runtime container,
  which this capture host does not run. The gate the resolve reads is otherwise
  identical to a minted one.
- the verification RECORD row, so the verification kind had a reading to return.

## The cells

| # | Cell | Runtime | File | Verdict |
|---|---|---|---|---|
| 1 | Review card, `pending`, host `page_gate_region`, target island loaded | development | `s9c-01-review-pending-page.png`, `s9c-02-review-pending-card.png` | **PASS** |
| 2 | The decision lands through the card's own floor, and the card re-resolves | development | `capture.log` (`settled` on the wire) + `s9c-03-review-after-decision-page.png` | **PASS** |
| 3 | Review envelope on the wire, bodyless | — | `capture.log` | **PASS** |
| 4 | Verification envelope on the wire, `advisory` WITH its §VII body | — | `capture.log` | **PASS** |
| 5 | Schedule envelope on the wire | — | `capture.log` | **PASS** |
| 6 | A forged ref answers `absent` with no body, on two kinds | — | `capture.log` | **PASS** |
| 7 | Review card, `settled` DOM | development | — | **NOT REACHABLE on this host** (see findings) |
| 8 | A non-review kind DRAWN | — | — | **NOT CAPTURED** (see findings) |

Cell 1 is the whole point: the card draws its header, the target island with the
uploaded artifact at its pinned revision, the Expand control and exactly one
decision floor — the same drawing the parity fixture pins byte for byte, now
served by the envelope.

## The wire

Read off the browser's own network layer. Full lines are in `capture.log`.

Review kind, drawn card — the kind carries state and NO body:

```
{"kind":"artifact_review_gate","state":{"state":"pending","canDecide":true,"canComment":true},"body":null}
```

Verification kind, the SAME opaque ref — `advisory` now arrives WITH the
sanitized §VII reading, which is the change this slice exists for:

```
{"kind":"verification_summary","state":{"state":"advisory"},"body":{"version":1,"outcome":"drifted",
 "reviewedRevisionId":"98ffc4fe-…","repairedRevisionId":"98ffc4fe-…","scopePaths":["title"],
 "fieldDiff":[{"field":"title","before":"Quarterly summary","after":"Quarterly summary (revised)"},
              {"field":"body","before":"The draft the reviewer is looking at.","after":"The revised draft."}]}}
```

Note what is NOT in that body: no record id, no gate id, no artifact id. The
sanitizer's promise, on the wire.

Schedule kind, and both kinds on a forged ref — `absent`, and the body is null
every time:

```
{"kind":"trigger_schedule_proposal","state":{"state":"absent"},"body":null}
{"kind":"artifact_review_gate","state":{"state":"absent"},"body":null}
{"kind":"verification_summary","state":{"state":"absent"},"body":null}
```

A forged ref buys exactly one thing, and it is the same thing for every kind.
The status is 200 in all three cases, so the code is not an oracle either.

After a real Approve through the card's floor:

```
{"kind":"artifact_review_gate","state":{"state":"settled"},"body":null}
```

## Findings

1. **The `settled` CARD is not reachable on the page-gate-region host.** A
   landed decision does two things at once: the card re-resolves to `settled`,
   and the router refreshes. The refreshed page finds the gate resolved and
   renders its OWN "This review is no longer open" region INSTEAD of mounting
   the card, so the card's settled drawing is replaced before it can be
   photographed. Loading the same page fresh behaves the same way — the page
   never mounts the card for a decided gate. The wire line above proves the
   card itself resolved `settled`. This is pre-existing page behaviour and is
   untouched by this slice; the settled card's DOM is pinned in bytes by the
   parity fixture instead.

2. **No non-review kind is DRAWN anywhere yet, so cell 8 has no pixels.** The
   schedule and verification cards are exactly what the next two slices build.
   Until then the only surface that would draw them is the not-yet-drawn shell,
   reachable only from a chat transcript carrying the data part, which needs
   dispatch machinery this capture host does not run. The assertion that
   capture would have proven is: *a drawn non-review card reads its per-kind
   body out of the envelope and renders it.* What IS proven here is the half
   that belongs to this slice — the server resolves that body and puts it on
   the wire under the right kind, sanitized and bounded.

3. **`restricted` was not reached**, for the same reason the earlier lane
   recorded: run access is owner-first on this instance, so a reader who can
   see the gate but not decide it cannot be produced without inventing an
   authorization state. It is covered by the shipped unit tests.

## Files

- `s9c-01-review-pending-page.png` — the whole review page, card pending.
- `s9c-02-review-pending-card.png` — the card element alone, island loaded.
- `s9c-03-review-after-decision-page.png` — the page after a real Approve.
- `capture.log` — the unedited capture log: every wire line, every cell verdict.
- `production-build-attempt.log` — the unedited tail of the failed build.
