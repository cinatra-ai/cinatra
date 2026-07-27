# Authoring guide — lifecycle producers

How a producing agent takes part in the core artifact-lifecycle interceptions:
what it **declares** (which checkpoints it asks to skip, which artifact types it
produces, whether it can repair), what core does with those declarations, and
what a producer must never build for itself.

- Status: normative authoring guidance for producing agents and for the core
  write paths that emit on their behalf.
- Audience: authors of agents that create durable artifacts, and of the local
  write choke points that emit the produced event.

Core intercepts the artifact lifecycle at three checkpoints — **recommendation**
(pre-production), **review** (post-production), and **post-change verification**
— and decides whether each one fires. A producer never composes its own
recommender, reviewer or verifier: it produces artifacts, declares a few facts
about itself, and implements the typed repair round-trip if it can.

## 1. What makes something a producer

A producer is any write path that persists a durable local artifact revision
through one of the **enumerated emitters**. The set is closed
(`src/lib/lifecycle/lifecycle-produced-event.ts`):

| Emitter | Write path |
|---|---|
| `createSemanticArtifact` | The file-form artifact writer (`src/lib/artifacts/artifact-creation.ts`). |
| `dashboard_twin_writer` | The dashboard artifact twin's own transaction. |
| `object_cms_snapshot_capture` | The CMS content-snapshot capture (`src/lib/artifacts/cms-content-snapshot-capture.ts`). |

An event row naming any other emitter is rejected at the contract boundary
(`validateProducedEvent`). Adding a fourth write path means adding it to that
enumeration — not inventing a private review hook.

### The produced event

Each emitter writes one `artifact_produced_outbox` row **in the same transaction
as the artifact/representation write**, so the event and the artifact commit or
roll back together. The row's primary key is deterministic —
`sha256(artifactId ␀ representationRevisionId ␀ eventKind)` — and the insert is
`ON CONFLICT (event_id) DO NOTHING`, so a replay is a no-op and a reconciliation
pass can look for the exact id it expects. A `UNIQUE (artifact_id,
representation_revision_id, event_kind)` constraint keeps the derived id and the
tuple in agreement.

Three axes on the row decide everything downstream:

- **`origin_kind`** — the lattice provenance axis. Emitters carry the physical
  artifact origin kind; `lifecycleOriginKind` maps it: `agent_generated` →
  `agent_produced`, `live_generator` → `intermediate`, `upload` /
  `email_attachment` / `external_link` → `user_provided`. An unclassified new
  kind falls to the conservative `agent_produced`.
- **`destination_class`** — `none`, `external_publish`, `visibility_promotion`
  or `pipeline_handoff`. The last three are the **external-effect** classes.
  `createSemanticArtifact` emits `none` (a plain durable local write has no
  external effect at creation time); a captured CMS snapshot emits
  `external_publish`, because it is a proposed remote apply.
- **`continuation_mode`** — `async_effects_gated` (the standard: the run never
  pauses retroactively, the artifact's downstream effect is held until the
  decision) or `checkpointed` (per-flow opt-in: the run evaluates policy, then
  parks). `createSemanticArtifact` emits the standard mode.

## 2. The declaration block

A producer's lifecycle declarations are compiled onto
`agent_templates.lifecycle_config` as JSON-as-text — the same shape
`trigger_mode` / `gated_steps` use. The compiled shape is
`CompiledManifestLifecycle` (`src/lib/lifecycle/lifecycle-policy.ts`):

```json
{
  "requestedSkips": ["recommendation"],
  "producedTypes": ["artifact-blog-post-body"],
  "repairCapable": true
}
```

| Field | Type | Meaning |
|---|---|---|
| `requestedSkips` | array of checkpoint names (`recommendation`, `review`, `verification`) | Checkpoints the producer asks to have skipped. A **request**, honoured only under the conditions in §3. |
| `producedTypes` | array of strings | The artifact types the producer declares it creates. The lattice does not branch on it. |
| `repairCapable` | boolean | Whether this producer implements the typed repair round-trip (§4). |

**Reading is tolerant and fail-soft.** The parse (`parseCompiledManifest` in
`packages/agents/src/lifecycle-review-orchestration-store.ts`,
`parseLifecycleConfig` in `packages/agents/src/recommendation-interception.ts`)
never throws: an absent, empty or malformed value yields no declarations, unknown
checkpoint names are filtered out, non-string entries in `producedTypes` are
dropped, and `repairCapable` is honoured only when it is a real boolean. A
producer with no declarations gets pure core defaults.

**Resolution path.** The review orchestration resolves declarations from the
produced event's `producer_run_id` → the run's template → `lifecycle_config`.
Any missing link in that chain yields no declarations — which is a **stricter**
outcome, not a looser one, because the core defaults then apply unchanged.

A declaration block is data on the template row, so a producer that wants a skip
honoured must have that block compiled onto the template it actually runs as.
A block that never reaches `agent_templates.lifecycle_config` has no effect.

## 3. How the policy lattice consumes the declarations

Whether a checkpoint fires is decided by the four-layer lattice
(`evaluatePolicy`), outer layer beating inner:

1. **Org bounds** — `required` or `forbidden` for a (checkpoint, artifact type,
   destination class, origin kind) key. Absolute.
2. **Core defaults** — apply only where the org expressed no bound.
3. **Manifest declarations** — refine *within* bounds.
4. **Per-run elevation** — a present human may force a checkpoint **on**; there
   is no field that forces one off.

A `requestedSkips` entry takes effect only when **all** of the following hold:

- the org is **silent** for that key (a skip can never weaken `required`, and
  `forbidden` already produced a non-fire);
- the core default for that checkpoint would otherwise **fire** (a skip of a
  checkpoint that already skips changes nothing); and
- the destination class is **not** an external-effect class.

That last condition is the **external-effects fail-closed rule**: a manifest may
never skip a gate on `external_publish`, `visibility_promotion` or
`pipeline_handoff`. Publishing, promotion and pipeline hand-off are the effects
the review exists to hold, so a producer cannot opt itself out of them. When a
checkpoint's default is *unevaluable* on an external-effect class (verification
at produced-event time, whose signal arrives later), the outcome is
`policy_unresolved`: the protected effect is blocked until an explicit later
policy decision, and no elevation resolves it. On a non-external class the same
unevaluable default proceeds ungated.

The verdict records which layer decided (`decidedBy`: `org-bound`,
`core-default`, `manifest`, `elevation`, `fail-closed`) and a stable
human-readable `reason`, so a skipped checkpoint is always explainable.

**Core defaults, for reference** (`coreDefault`):

| Checkpoint | Default in the unconstrained region |
|---|---|
| `recommendation` | Fires for a human-present run; skips for a headless run. |
| `review` | Fires for any external-effect class; fires for a durable `agent_produced` artifact; skips for `intermediate`; skips for a plain non-external `user_provided` artifact. |
| `verification` | Fires when `changes_requested` occurred, and on `external_publish`; otherwise indeterminate (resolved by the fail-closed rule above). |

## 4. Declaring repair capability

`repairCapable: true` says this producer can implement a reviewer's
`changes_requested` itself. Core routes the decision accordingly
(`routeChangesRequested`):

| Declaration | Route |
|---|---|
| `repairCapable: true` | `producer_repair` — the producer implements the repair, per its continuation mode. |
| `repairCapable` absent/false, org repair route configured | `org_repair_route`. |
| `repairCapable` absent/false, no org route | `human_escalation`. |

Nothing silently drops: every `changes_requested` lands on one of the three.

### The round-trip a repair-capable producer must satisfy

A `changes_requested` request carries the gate/decision identity, an idempotency
key, the **exact base target**, an `expectedBaseRevisionId` (a compare-and-swap
witness), structured findings with stable ids and optional field/region paths,
and the continuation mode + address. The producer answers with a
`RepairResponse`. The store validates it (`validateRepairLineage`) before pinning
anything:

| Rule | Failure code |
|---|---|
| The response's base target equals the requested base. | `base-mismatch` |
| The base artifact still exists. | `tombstoned-base` |
| The base's live revision still equals the CAS witness. | `stale-base` |
| The successor names an artifact + revision. | `successor-invalid` |
| The successor differs from the base — a repair produces a **new** revision. | `successor-equals-base` |
| The per-finding outcome map keys exactly the request's findings: none unknown, none duplicated, none missing. | `finding-unknown` / `finding-duplicate` / `finding-unmapped` |

Three further properties an author should design for:

- **The successor is pinned into a NEW gate.** A repaired revision is never
  re-pinned under the reviewer's original gate; the held effect re-points onto
  the successor gate.
- **Repair dispatch is a live re-authorization point.** The captured request
  context is provenance, never reusable authority — the repair call carries a
  live `reauthorized` verdict resolved at dispatch time.
- **Cycles are bounded.** A single review lineage takes at most
  `MAX_REPAIR_CYCLES` (5) repair round-trips; beyond the bound core escalates to
  a human instead of reopening again.

`packages/agents/src/blog-post-repair-producer.ts` is the worked example: it
declares `producedTypes` + `repairCapable`, materialises the repaired body into a
successor artifact, and submits the typed response through the repair store.

### Verification does not trust the producer's report

Post-change verification re-derives what changed from the actual field maps
(`computeVerificationVerdict`); the producer's per-finding `applied` flag is
provenance only. The outcomes are `verified`, `drifted` (a change outside the
review's scope manifest — this takes precedence, because an unexpected change is
the safety concern) and `unmet` (an accepted, field-scoped finding whose field
did not change, a failed validator, or a representation that does not correspond
to the repaired revision). Claiming a finding applied while changing nothing
produces `unmet`.

## 5. What a producer must not do

- **No bespoke gates.** A producer does not implement its own review,
  recommendation or verification step, and does not decide whether a checkpoint
  applies to its output. Core is both the authority and the implementation; a
  producer's only inputs to that decision are the declarations in §2 and the
  event axes in §1.
- **No parallel decision store.** Review decisions live in the gate store. A
  producer never records an approval, rejection or disposition of its own.
- **The one agent-facing seam is advisory.** Any agent may attach an advisory
  comment to a gate through the advisory seam
  (`src/lib/lifecycle/lifecycle-advisory-seam.ts`): gate-bound,
  provenance-stamped, idempotent per `(gate, idempotencyKey)`, and
  **structurally decision-free** — the request type admits no verdict field, and
  an object smuggling `disposition`, `decision`, `verdict`, `approve` or
  `reject` through an untyped boundary is rejected.
- **Do not treat a requested skip as a guarantee.** It is honoured only under
  §3's conditions; an org bound or an external-effect class overrides it.
- **Do not repurpose `reject`.** `reject` is a tombstone with unchanged
  semantics; `changes_requested` is the disposition that means "make these
  changes", and it is the only one that opens a repair.

## 6. Author checklist

1. Produce through one of the enumerated emitters — do not add a private write
   path that skips the produced event.
2. Emit the right axes: the physical origin kind, and a destination class that
   names the real external effect (`none` when there is none).
3. Choose the continuation mode deliberately: `async_effects_gated` unless the
   flow genuinely needs to park.
4. Compile a declaration block onto the template only for facts that are true:
   `producedTypes` for what you create, `repairCapable` only if you implement
   §4, `requestedSkips` only for checkpoints you can justify skipping on
   non-external output.
5. If `repairCapable`, satisfy every lineage rule in §4 and expect verification
   to re-derive your work.
6. Attach commentary through the advisory seam; leave decisions to core.

## See also

- [Lifecycle review policy and separation of duties](../governance/lifecycle-review-policy.md)
  — the bounds an organization sets, and what wins when layers disagree.
- [The CMS review adapter contract](../contracts/cms-review-adapter-contract.md)
  — the producer-side contract for remote CMS content.
