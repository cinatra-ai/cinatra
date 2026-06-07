# @cinatra-ai/mcp-client

A small, server-only client for invoking MCP primitives behind a uniform request/response envelope. It defines the shared invocation types (request, actor context, success/failure result, typed error) and provides an in-process transport plus helpers for calling primitives and normalizing errors.

## Public API

- `PrimitiveTransport` — interface for invoking a primitive and returning a response.
- `createInProcessPrimitiveTransport(handlers, options?)` — build a transport backed by a local handler map.
- `invokePrimitive(transport, request)` — invoke and throw on failure, returning the output.
- `normalizePrimitiveError(error)` — convert any thrown value into a `PrimitiveErrorShape`.
- `PrimitiveInvocationError` — error class carrying `code`, `retryable`, and details.
- `PrimitiveInvocationRequest<TInput>` — request envelope (`primitiveName`, `input`, `actor`, `mode`).
- `PrimitiveInvocationResponse<TOutput>` — discriminated `ok: true | false` result union.
- `PrimitiveActorContext` — caller identity, source, and trusted role/scope hints.
- `PrimitiveInvocationMode` — `"deterministic" | "agentic" | "system"`.
- `PrimitiveErrorShape` — structured error payload (`code`, `message`, `retryable`, ...).
- `PrimitiveInvocationTraceHook` — optional callback for started/succeeded/failed events.

This package is `server-only` and exposes a single entry point (`@cinatra-ai/mcp-client`).

## Usage

```typescript
import {
  createInProcessPrimitiveTransport,
  invokePrimitive,
} from "@cinatra-ai/mcp-client";

const transport = createInProcessPrimitiveTransport({
  "example.primitive.list": async (request) => ({ items: [] }),
});

const output = await invokePrimitive(transport, {
  primitiveName: "example.primitive.list",
  input: {},
  actor: { actorType: "system", source: "worker" },
  mode: "deterministic",
});
```

## Docs

See https://docs.cinatra.ai
