# cinatra#2566 / PR #2612 — S2 blocker resolution (lane TRIPLE-245)

Head under proof: `389ee0509890bd762549074aa67fff095d2377f4`.

**The design-surface battery at design@`6c20871b4108176c1d0193f19ecd2947f6c6355f`
STILL DID NOT RUN.** What this record settles is the prior lane's open question
(PR comment `issuecomment-5234007696`): whether `artifact_review_gates_list`
returning `{"refs":[]}` was a fixture gap or a defect in the S3 listing path.

## Verdict: FIXTURE GAP, with a named mechanism. Not a defect in the listing path.

The listing filters every candidate row through
`enforceReviewRunAccess(gate.run_id, actor, "read", roleHints)`
(`src/lib/lifecycle/lifecycle-pull-mcp.ts` `handleReviewGatesList`). That helper
fetches the run with `readAgentRunById` and hands the result to
`enforceRunAccess`, whose FIRST statement is:

```ts
// packages/agents/src/auth-policy.ts:1027
if (!run) {
  throw new AuthzError({ statusCode: 404, reason: "hidden", message: "Not found." });
}
```

So a gate whose `run_id` does not resolve to an `agent_runs` row contributes no
ref — by construction, for every caller. A SQL-seeded gate satisfies the
candidate query (`listOpenReviewGateCandidates` filters on `org_id` +
`status='pending'` only) and then fails this ladder unless a REAL run row exists
that the actor may read.

**The two surfaces agree.** `/agents/reviews` (`src/app/agents/reviews/page.tsx:85`)
applies the identical `enforceReviewRunAccess(row.runId, …)` filter, so the chat
pull is not narrower than the shipped review page. There is no divergence to
call a defect.

**The orchestration corollary, stated plainly:** when a produced event has no
producing run, `sweepReviewOrchestration` emits the gate against
`orphanRunId(eventId)` (`lifecycle-review-orchestration-store.ts`). Such a gate
can never be listed or rendered by anyone. That is a real, code-level property of
the shipped system — worth a separate look — but it is NOT a defect in S2/S3.

## What was driven on the real running app

Real dev server on this head, port 3151, dedicated schema on the verify Postgres
(5634), 111/111 extensions pinned, boot log confirming
`[artifact-review-gate] gate seam bound to the #2009 store at boot` and
`[lifecycle-review-orchestration] S1 activation ACTIVE`.

Nothing below is SQL-seeded. Identity provisioning (a platform-admin flip and one
membership row) is the only direct write; every lifecycle act is the shipped path.

1. Real Better Auth sign-up + sign-in; real org through the shipped
   `/api/auth/organization/create` + `set-active`.
2. Real artifact through `POST /api/artifacts/upload` → the app's own
   `createSemanticArtifact` transaction wrote the `ArtifactProduced` event
   (`produced-outbox.csv`).
3. The app's OWN 30s `sweepReviewOrchestration` drained it to `processed` with a
   NULL `continuation_address` — **no gate, correctly**: the review core default
   fires on `origin_kind='agent_produced'`, and an upload is `user_provided` +
   `destination_class='none'` → skip.

## Why no gate could be minted here

The only credential-free agent-produced path is `artifact_authoring_emit`, and it
refuses on this instance: no installed artifact extension resolves an authoring
skill (`hasAuthoringSkill:false` for both authorable extensions —
`@cinatra-ai/text-artifact`, `@cinatra-ai/json-artifact`). Only
`blog-idea-artifact` and `marketing-icp-artifact` declare a `role:"authoring"`
edge, and neither is installed for the actor's org (`agent_list` → 0 items).

No shipped extension and no e2e fixture declares the
`metadata.cinatra.artifactReview.targetsInput` marker, so the run-executor's
marked-gate path has **no shipped producer** either. A real artifact-review gate
therefore requires a credentialed agent run producing an artifact — unavailable
in this lane (no usable LLM provider key on this host).

## Items that DID land, on the real /api/mcp under a real chat-OBO actor

Token minted in the app's own shape (`src/lib/chat-mcp-actor-token.ts`: HS256,
`aud=<origin>/api/mcp`, `iss=<origin>/api/auth`). Raw IO in `refusal-io.txt` /
`tool-io-list.txt`.

| Item | Result | Observed |
|---|---|---|
| All three S3 pull primitives reachable under the chat-OBO actor | **PASS** | 76 tools; `artifact_review_gates_list`, `artifact_review_gate_render`, `verification_record_render` all enumerate |
| §IX — NO decision through the pull | **PASS** | zero primitives matching decide/approve/reject/resume/comment/schedule/respond visible to the chat-delegated perimeter |
| §IV — identifier-free refusal, undecodable ref | **PASS** | both render primitives answer exactly `Not available to you.` |
| §IV — identifier-free refusal, well-formed unknown ref | **PASS** | byte-identical sentence; indistinguishable from the above |
| An empty list is NOT a refusal | **PASS** | `{"refs":[]}`, a plain non-minting result |
| The documented transport boundary (schema rejection is the caller's own arguments) | **PASS** | `limit:99` → `Input validation error … limit: Too big: expected number to be <=10` |

## Still owed — every card item

§II the card in the thread per host frame; §III target panel + tier ladder +
honest-gap lines + ONE decision floor; §IV every reachable state including the
two DISTINCT absences network-asserted; §IX the presence matrix across chat
thread / run card / review island (and NO widget); decisions through BOTH
transports. All need a minted card, so **none of them ran**.

**Do not merge on this record.** The design-surface proof is still unpaid.
