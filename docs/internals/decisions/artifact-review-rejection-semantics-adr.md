# ADR — Artifact-review rejection semantics (WayFlow)

- Status: ACCEPTED (epic #1620, sub-issue S12 #1795, owner-authored via the
  entry-90 ruling, 2026-07-18). The wire contract lands with the generic
  artifact-review surface; the live A2A reject SEND wires with the reviewer
  generalization (#1796) that owns an emitting review gate.
- Scope: what a review REJECTION does to the workflow behind a HITL review gate —
  the resume shape and the invariant that a reject can never travel the approve
  path. NOT the decision chrome (fenced until the review-surface design spec) and
  NOT the gate-emission side that pins the review targets (that is #1796).
- Source: epic #1620 ("artifact extensions own their UI"); the S12 contract on
  #1795 (item 6: "WayFlow rejection semantics DECIDED AND IMPLEMENTED here").
  Companion: the [artifact-UI boundary ADR](./artifact-ui-boundary-adr.md) (the
  core-owns-dispatch / extension-owns-view line this decision extends to the
  workflow) and the run-scoped HITL prompt primitives (#1794, PR #1803).
- Code: `src/lib/artifacts/artifact-review-rejection.ts` (the pure typed-resume
  payload builders) + `src/lib/artifacts/artifact-review-decision.ts` (the
  decision core that emits the discriminated resume instruction).

## Context

A HITL review gate pauses an agent run at `pending_approval`. The existing
APPROVE path (`packages/agents/src/review-task-actions.ts`,
`approveReviewTaskInternal` → `wayflow-` branch) resumes the paused WayFlow
conversation by sending the operator's `userResponse` text into
`run.a2aContextId` and stamps the approval marker (`approved: true`) into the
resume payload. The REJECT path, however, only ever handled the `setup-` gate
(marking the run `failed`); a `wayflow-` reject threw "not supported". A generic
review surface must give a rejection first-class, well-defined semantics — and,
critically, must guarantee a reject affordance can NEVER be mistaken for (or
mis-wired onto) an approval.

Two shapes were on the table:

1. **Typed reject-resume payload** — resume the workflow with a structurally
   distinct reject envelope the workflow BRANCHES on (compensation / re-draft /
   alternate path decided by the workflow).
2. **Authorized terminal-reject** — fail (or cancel) the run outright on reject,
   with no resume.

## Decision

**A review rejection resumes the workflow with a TYPED REJECT payload the
workflow branches on (shape 1), primary.** The authorized terminal-reject
(shape 2) is retained ONLY as the fallback for a gate with no resumable workflow
context — a `setup-` gate, or a `wayflow-` gate whose A2A context is gone — where
there is no branch to resume into, so failing the run is the correct terminal
outcome (never leaving it pending forever).

Rationale: the epic boundary is "core owns dispatch/shell/floor; the claiming
extension ships the type's view." Symmetrically, **the workflow owns what a
rejection MEANS for its domain.** Core must therefore hand the workflow a
first-class, structurally distinct reject signal and let the workflow's own
branch decide — exactly as an approval hands it the operator's `userResponse`. A
blanket terminal-reject would erase that domain choice (a rejected draft could
never be re-drafted in-flow; a rejected send could never trigger compensation).

**The load-bearing invariant — a reject NEVER travels the approve path:**

- The approve envelope stamps `approved: true` and `review.decision ===
  "approved"`. The reject envelope carries **no** `approved` key and
  `review.decision === "rejected"`. The two share no truthy approval marker, so a
  legacy `InputMessageNode` that only checks `approved` sees it absent on a
  reject and does not treat the reject as an approval.
- The serializer (`buildReviewResumeText`) is DISCRIMINATED by kind: approve
  yields `{ kind: "approve", userResponse }`; reject yields `{ kind: "reject",
  rejectResponse }` — a DIFFERENT field name. The approve resume site reads
  `userResponse`; the reject resume site reads `rejectResponse`. A reject
  physically cannot be fed to the approve send, and vice versa.
- The decision core (`submitReviewDecisionCore`) never routes a `reject`
  disposition through the approve builders in `hitl-gate-submit.ts` (which stamp
  `approved`/`approvedAt`) — it calls the reject builder directly.
- A test (`artifact-review-rejection.test.ts`) pins `payloadAssertsApproval(reject
  envelope) === false` and that the reject serialization has no `approved` key.

**Disposition on reject:** a rejection records a TOMBSTONE disposition on the
reviewed artifacts (the decision core's `ReviewDispositionOp` union admits only
`tombstone`) — never a hard delete of a durable/referenced artifact. The
tombstone rides the canonical artifact soft-delete path (`tombstoneArtifact`);
the review audit row captures the reviewed revision + the HOST-derived renderer
provenance (re-resolved from the artifact type at submit time — never accepted
from the client decision, which names only the immutable targets + disposition).

**Durable resume (exactly-once persistence, at-least-once delivery):** the typed
reject (or approve) resume is NOT a post-commit side effect that could fail and
strand a resolved-but-unresumed workflow. The resume INTENT is part of the
decision commit plan and is persisted TRANSACTIONALLY with the gate CAS + audit
rows + dispositions (a durable outbox — the intent is persisted EXACTLY ONCE, and
the binder's delivery worker drains it AT-LEAST-ONCE, so the downstream resume
consumer must be idempotent per gate; a send-then-crash safely redelivers on lease
expiry). A commit that resolves the gate therefore also durably enqueues the
reject send; a sequential retry of the same decision (matched by its fingerprint)
is an idempotent no-op that re-drives nothing.

## Consequences

- The WIRE CONTRACT (`ARTIFACT_REVIEW_RESUME_ENVELOPE_VERSION`) is fixed here;
  every reviewer type (#1796 onward) conforms to it, and a workflow branch pins
  the envelope version it understands.
- The live A2A reject SEND (into `run.a2aContextId`, the reject counterpart of
  `approveReviewTaskInternal`'s `wayflow-` branch) is the outbox delivery worker
  that drains the committed resume intent; it wires with #1796, which owns a
  workflow whose reject BRANCH exists to receive the typed payload. Until then the
  reject terminal-fail fallback is the only reachable behavior for a `setup-` gate,
  and a `wayflow-` reject with no workflow-side branch is a no-op-until-#1796 by
  construction (there is no branch to resume). This split is deliberate: shipping
  a reject SEND with no receiving branch would be sending into the void.
- Approvals are unchanged: the approve envelope keeps `approved: true` for
  back-compat with existing WayFlow approval nodes, and additionally carries the
  typed `review` block so a review-aware workflow can branch uniformly on
  `review.decision`.
