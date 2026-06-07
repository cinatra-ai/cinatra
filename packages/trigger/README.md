# @cinatra-ai/trigger

Provider package for the `trigger_config_*` MCP primitives that manage how an agent run is triggered — immediate, scheduled, or recurring. Handlers are thin, actor-aware wrappers that delegate auth and persistence to the trigger service in `@cinatra-ai/agents`; no storage logic lives here.

## Public API

- `triggerPrimitiveMetadata` — metadata for the three trigger primitives (visibility, mutation, approval policy).
- `TriggerPrimitiveMetadata` — type of each metadata entry.
- `createTriggerHandlers` — builds the `trigger_config_get` / `_set` / `_delete` handler map.
- `triggerConfigSetSchema` — Zod schema for trigger configuration input.
- `runIdSchema` — Zod schema for a single `runId` argument.
- `TriggerConfigSetInput`, `RunIdInput` — inferred input types for the schemas above.

The exposed primitives are:

- `trigger_config_get` — read the current trigger for a run (null if unset).
- `trigger_config_set` — create or update a trigger (immediate / scheduled / recurring).
- `trigger_config_delete` — remove a trigger and cancel any pending job.

## Usage

```ts
import { createTriggerHandlers, triggerConfigSetSchema } from "@cinatra-ai/trigger";

const handlers = createTriggerHandlers();
const input = triggerConfigSetSchema.parse({
  runId,
  triggerType: "scheduled",
  scheduledAt: "2026-01-01T09:00:00Z",
});

await handlers.trigger_config_set({ primitiveName: "trigger_config_set", input, actor, mode: "agentic" });
```

## Docs

See https://docs.cinatra.ai
