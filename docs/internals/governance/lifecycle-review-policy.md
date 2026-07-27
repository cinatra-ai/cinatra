# Lifecycle review policy and separation of duties

Administrator's view of the artifact-lifecycle policy lattice: what an
organization can require or forbid, how a rule is keyed and matched, what wins
when several layers disagree, the separation-of-duties rule on required gates,
and the activation switches that decide whether any of it runs.

- Status: normative policy reference for the three lifecycle checkpoints.
- Audience: administrators configuring lifecycle policy, and engineers
  implementing against the policy store.

## 1. What policy decides

Core intercepts the artifact lifecycle at three checkpoints:

| Checkpoint | When it applies |
|---|---|
| `recommendation` | Pre-production, at run start — matching skills are recommended for the run's actual intent. |
| `review` | Post-production — a produced artifact gets a review gate, and its downstream effects are held until the decision. |
| `verification` | Post-change — a landed change is verified against what the review authorised. |

The lattice defines, per checkpoint, **whether that checkpoint fires**. Two of
the three are evaluated against it at runtime: the recommendation checkpoint at
run start, and the review checkpoint per produced event. The verification
checkpoint's verdict is defined the same way; the verification record itself is
written by the paths that hold both sides of a comparison — a landed repair, and
a remote-apply read-back.

Policy does not decide who reviews, or what the reviewer concludes.

## 2. The rule key

An organization expresses policy as **bounds**. A bound is a row in
`lifecycle_policy_rules`, keyed by five values:

```
(orgId, checkpoint, artifactType, destinationClass, originKind)
```

| Axis | Values |
|---|---|
| `checkpoint` | `recommendation`, `review`, `verification` |
| `artifactType` | The artifact's type string, or `*` for all types under the rest of the key |
| `destinationClass` | `none`, `external_publish`, `visibility_promotion`, `pipeline_handoff` |
| `originKind` | `agent_produced`, `user_provided`, `intermediate` |

A rule's value (`bound`) is either `required` — the gate **must** fire — or
`forbidden` — the gate **must not** fire.

Three matching rules matter:

- **Absence is silence.** There is no stored `silent` value. A key with no
  matching row is *unconstrained*, and the inner layers decide. Removing a bound
  means deleting the row.
- **Exact beats `*`.** For the same (checkpoint, destination class, origin kind),
  an exact `artifactType` match wins over the wildcard row.
- **One row per key.** A unique index over the five-value key makes a re-upsert
  of the same key an in-place update.

The policy store (`packages/agents/src/lifecycle-policy-store.ts`) owns those
operations: `upsertLifecyclePolicyRule` (idempotent on the key),
`deleteLifecyclePolicyRule` (the only way to return a key to silence) and
`resolveOrgPolicyRule`, which returns `silent` when no row matches. Any
configuration surface goes through them.

**Recommendation is keyed on the wildcard type.** It runs *before* production, so
the produced type is not yet known: an organization expresses "recommendation is
required for these runs" with an `artifactType` of `*`.

### The destination classes

| Class | Meaning |
|---|---|
| `none` | A plain durable local artifact with no external effect. |
| `external_publish` | An external publish or remote apply — for example a CMS write. |
| `visibility_promotion` | A promotion of the artifact's visibility. |
| `pipeline_handoff` | A hand-off to a downstream pipeline. |

The last three are the **external-effect** classes. They are the ones an async
gate holds, and the ones the fail-closed rules protect.

### The origin kinds

The policy axis is a coarse provenance classification derived from the physical
artifact origin: agent-generated output is `agent_produced`; uploads, email
attachments and external links are `user_provided`; live-generator output is
`intermediate`. An origin kind that is not yet classified falls to the
conservative `agent_produced`, so a novel producer is reviewed rather than
silently skipped.

## 3. Precedence

Four layers, outer beating inner (`evaluatePolicy`,
`src/lib/lifecycle/lifecycle-policy.ts`):

1. **Org bounds.** Absolute. `required` fires the gate and nothing below can
   weaken it; `forbidden` bars the gate and nothing below can fire it.
2. **Core defaults.** Apply only in the unconstrained (org-silent) region.
3. **Agent-manifest declarations.** An agent may request a checkpoint **skipped**
   (`requestedSkips` on its compiled lifecycle declarations). The request takes
   effect only where the org is silent, the default would otherwise fire, **and**
   the destination class is not an external-effect class. A manifest can never
   fire a forbidden gate nor skip a required one.
4. **Per-run elevation.** The evaluator's fourth layer accepts a per-run
   `forceOn` set, which turns a checkpoint on that the defaults or a manifest
   left off. There is deliberately no field that forces one off — a run choice
   can only strengthen, and it cannot resolve a fail-closed block.

Every verdict records which layer decided it (`org-bound`, `core-default`,
`manifest`, `elevation`, `fail-closed`) plus a stable reason, so a fired or
skipped checkpoint is always explainable.

### Core defaults

Normative, in the unconstrained region only:

| Checkpoint | Default |
|---|---|
| `recommendation` | Fires for a human-present run; skips for a headless run. |
| `review` | Fires for any external-effect class; fires for a durable `agent_produced` artifact; skips for `intermediate`; skips for a plain non-external `user_provided` artifact. |
| `verification` | Fires when changes were requested, and on `external_publish`; otherwise indeterminate at production time, because the deciding signal arrives later. |

### Fail-closed on external effects

Two rules protect the external-effect classes:

- **A manifest skip is ignored on an external-effect class.** An agent can never
  opt its own publish, promotion or hand-off out of review.
- **An unevaluable default on an external-effect class yields
  `policy_unresolved`.** The protected effect is *blocked* until an explicit
  later policy decision, and a per-run elevation cannot resolve it. On a
  non-external class the same unevaluable default proceeds ungated.

## 4. Separation of duties

The rule, stated by `evaluateSeparationOfDuties`
(`src/lib/lifecycle/lifecycle-separation-of-duties.ts`):

> On an **org-required** gate, the producing actor cannot be the **sole**
> approver.

Concretely:

| Situation | Eligible to approve? |
|---|---|
| The gate is not org-required (it fired by default, manifest or elevation) | Yes — optional gates allow self-approval. |
| Org-required, and the organization opted into self-approval | Yes. |
| Org-required, reviewer is not the producer | Yes. |
| Org-required, reviewer **is** the producer, and another distinct actor has already approved | Yes — the producer is then not the sole approver. |
| Org-required, reviewer **is** the producer, no other approver | No. |

The opt-in is the `self_approval_opt_in` flag carried on the org rule; it is
meaningful only on a `required` bound and defaults to `false`. The lattice
surfaces the requirement as `separationOfDutiesRequired` on its verdict, set
exactly when the outcome is `required` and the organization did not opt in. The
rule takes the **live** acting actor as its reviewer input — never a captured or
replayed identity — and the set of prior distinct approvers as its second input.

**Re-authorization points.** Two later actions are defined as re-authorization
points rather than replays of a stored context: repair dispatch and a remote CMS
apply. Captured request context is provenance, never reusable authority, so an
authority revoked between the decision and the action must not carry the action
through. The repair submission expresses this contractually: it carries an
explicit re-authorization verdict, and the store refuses a response whose verdict
is false.

## 5. Gate lifetime

Automatically created review gates carry a seven-day expiry
(`AUTO_REVIEW_GATE_TTL_MS`). Gates authored by a flow carry no expiry and are
never touched by the expiry pass.

On expiry:

| Gate | Behaviour |
|---|---|
| Optional | Lapses into a release: the gate auto-resolves and its held effect flows — a forgotten optional gate cannot pin an effect forever. The resolution carries a synthetic `expiry:<gateId>` fingerprint, so an auto-lapse is always distinguishable from a human decision (whose fingerprint is a content hash). |
| Required | Stays pending and its effect stays blocked. A required review that expired unactioned is an operational condition, never an automatic release: every such gate the pass picks up is logged by name, and because it is never resolved it is picked up again on subsequent passes. |

A checkpointed run parked behind a gate is released when that gate resolves —
by a human decision or by the optional-expiry auto-resolve. A park whose policy
was unevaluable always resumes at its own deadline, leaving the protected effect
in a terminal blocked state rather than an abandoned strand; a park that is still
live may never be torn down without a resolution.

## 6. Activation

The machinery ships behind two environment switches. Both default **off**, and
both are activated only by the value `on` (case-insensitive, surrounding
whitespace trimmed); anything else — including unset — leaves the switch off.
Each is read on every call rather than memoised, so a boot-time change takes
effect without a module reload. Default-off is the deliberate posture: these
switches change behaviour on hot write paths, so a deployment turns them on when
it chooses to.

| Variable | What it activates |
|---|---|
| `CINATRA_LIFECYCLE_REVIEW_ORCHESTRATION` | The review-orchestration slice: the produced-event emitters on the local write paths, the boot seeding of the two maintenance loops, and the orchestration consumer. |
| `CINATRA_LIFECYCLE_RECOMMENDATION_CHIP_ROW` | The run-start recommendation hold — the pre-execution pause that lets a present human confirm or adjust the recommended skills. |

With `CINATRA_LIFECYCLE_REVIEW_ORCHESTRATION` off, the write paths splice no
produced-event insert (the transactions are unchanged), the boot phase seeds no
loop, and a manually enqueued tick short-circuits — three independent
short-circuits, so the slice is inert rather than merely quiet. Turning it on
adds one idempotent insert per enumerated write, and schedules two recurring
drains: the review-orchestration drain (~30s) that turns pending produced events
into policy-matched gates, and the gate-maintenance drain (~60s) that applies
reject tombstones, resolves expiries and releases parks.

With `CINATRA_LIFECYCLE_RECOMMENDATION_CHIP_ROW` off, no run is held at start.
The headless recommendation path is unaffected by this switch: it is inert for a
silent organization anyway, because the core default for a run with no present
human is to skip the checkpoint — a headless run never pauses.

Note that both switches are global, not per-organization. Per-organization scope
is expressed through the bounds in §2, which the consumer honours; the switch
only decides whether the machinery runs at all.

## 7. Worked examples

How common intentions are expressed as keys.

**Require review of every external publish, org-wide.**
One rule per origin kind that matters, with `artifactType` `*`,
`destinationClass` `external_publish`, `bound` `required`. Nothing can weaken it:
a manifest skip is ignored, and elevation only strengthens. Separation of duties
applies unless the self-approval opt-in is also set.

**Let an agent skip review of its own intermediate scratch output.**
Leave the org silent for that key and let the agent declare the skip. It is
honoured because the class is non-external and the org expressed no bound — and
it stops being honoured the moment a `required` bound is added to that key.

**Turn review off for one noisy artifact type.**
A `forbidden` bound on the exact type. Because exact beats `*`, this coexists
with a broader wildcard `required` rule for the same checkpoint and class, which
continues to govern every other type.

**Let a reviewer approve their own work on an optional gate.**
Nothing to configure: self-approval is allowed wherever the gate is not
org-required. To allow it on a required gate as well, set the self-approval
opt-in on that rule — deliberately, and per key.

## See also

- [Authoring guide — lifecycle producers](../workflows/authoring-lifecycle-producers.md)
  — what an agent may declare, and how those declarations meet these bounds.
- [The CMS review adapter contract](../contracts/cms-review-adapter-contract.md)
  — how a remote CMS write becomes a reviewable target under this policy.
