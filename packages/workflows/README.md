# @cinatra-ai/workflows

A versioned, scoped, calendar-driven workflow engine backed by Postgres. A workflow is
a first-class process DAG (not an agent): the package owns the Zod spec, a DST-correct
schedule resolver, transition/gate state machines, immutable run evidence, and a
step-executor registry.

## Public API

The root entry point (`@cinatra-ai/workflows`) re-exports:

- `workflowTemplate`, `workflow`, `workflowTask`, `workflowDependency`, `workflowGate`, `workflowEvent`, `workflowTaskAttempt`, `workflowArtifact`, `workflowApproval` — Drizzle table definitions for the workflow model
- `releaseWorkflowsSchemaTables` — the full set of schema tables
- `db`, `releaseWorkflowsPool` — lazily-initialized Drizzle client and Postgres pool
- `lintWorkflowSpecForTriggerBundling`, `lintManifestForTriggerBundling` — flag workflow nodes that bundle a trigger
- `TriggerLintFinding` — finding type returned by the lint functions
- `computeCriticalPath` — Critical-Path Method over persisted Gantt rows
- `CpmTaskRow`, `CpmEdge`, `CriticalPathResult` — critical-path input/output types

### Sub-entry points

- `./schema`, `./db`, `./store` — schema tables, DB client, server-only persistence
- `./spec` — shared Zod spec and validation tiers (template / draft / start)
- `./schedule` — schedule resolver (relative offsets, timezone, DST handling)
- `./state` — transition matrices, roll-up, and gate-ledger model
- `./scope` — read-visibility and delegated execution actor
- `./engine` — step-executor registry and contracts
- `./bpmn` — BPMN spec interop
- `./manifest`, `./extension-ops`, `./extension-handler`, `./install-saga-hook` — extension packaging and install hooks
- `./mcp-handlers`, `./module`, `./integration/register-object-types` — MCP primitives, host wiring, and object-layer registration
- `./seed` — example workflow seed

## Usage

```ts
import { computeCriticalPath } from "@cinatra-ai/workflows";
import { lintWorkflowSpecForTriggerBundling } from "@cinatra-ai/workflows";

const findings = lintWorkflowSpecForTriggerBundling(spec);
const path = computeCriticalPath(tasks, edges);
```

## Docs

See https://docs.cinatra.ai
