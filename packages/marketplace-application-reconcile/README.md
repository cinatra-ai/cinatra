# @cinatra-ai/marketplace-application-reconcile

A small reconcile worker for Cinatra Marketplace vendor applications. It re-drives the
marketplace-side recovery ability for namespace-reservation rows stuck in the `applied` state —
where the broker user and publish capability grant already succeeded marketplace-side, but the
final database flip to `approved` never landed (network blip, half-failed approve, etc.).

The worker is dependency-injected: a candidate resolver supplies the bounded set of stuck
applications, and a single client method runs the idempotent recovery for each. Per-application
failures are warned and counted, never thrown, so one bad row cannot stop the rest of the run.

## Public API

- `runVendorApplicationStateReconcile` — run one reconcile pass, return a summary
- `ReconcileDeps` — injected client, candidate resolver, and optional `onStuck` hook
- `ReconcileCandidate` — a single application id to attempt
- `ReconcileRunSummary` — per-run counts: attempted, recovered, failed, stuck, skipped
- `VendorApplicationCompleteRecoveryCaller` — structural interface for the recovery call
- `VendorApplicationCompleteRecoveryResult` — discriminated union of recovery outcomes

Sub-entry point:

- `@cinatra-ai/marketplace-application-reconcile/worker` — the worker implementation module

## Usage

```ts
import { runVendorApplicationStateReconcile } from "@cinatra-ai/marketplace-application-reconcile";

const summary = await runVendorApplicationStateReconcile({
  client,
  getStuckApplications: async () => [{ application_id: "app-123" }],
  onStuck: async (id, repairStuckAt) => persistStuckFlag(id, repairStuckAt),
});

console.log(summary); // { attempted, recovered, failed, stuck, skipped, ... }
```

## Docs

See https://docs.cinatra.ai for full documentation.
