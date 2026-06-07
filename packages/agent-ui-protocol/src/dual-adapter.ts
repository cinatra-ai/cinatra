import "server-only";

import type { AgentUIAdapter } from "./adapter";

// ---------------------------------------------------------------------------
// DualAdapterDispatch — Composite AgentUIAdapter that fans out every call to
// both the AG-UI and A2UI concrete adapters.
//
// Ordering: AG-UI is called before A2UI on every method. This matches the
// historical call order in langgraph-execution.ts / execution.ts (where paired
// calls were always `agUiAdapter?.onX(...); a2uiAdapter?.onX(...);`) so the
// pre-refactor event stream byte-identically equals the post-refactor stream.
//
// fire-and-forget discipline: each child adapter already owns its own
// `void this.publish(...).catch(() => {})` guarding (see ag-ui-adapter.ts
// and a2ui-adapter.ts). The composite never throws on its own — it just
// delegates. If a child method throws synchronously (contract violation),
// the composite INTENTIONALLY propagates so bugs surface in logs rather than
// being masked by a per-child try/catch.
//
// Typing: children are typed as the `AgentUIAdapter` INTERFACE (not as the
// concrete `AgUiAdapter` / `A2UiAdapter` classes). This is deliberate — the
// interface declares 5 params on `onInterrupt`, while `A2UiAdapter.onInterrupt`
// declares only 4 concrete params. TypeScript's structural subtyping + JS
// runtime arity (extra args silently ignored) lets the composite forward all
// 5 args safely. If a future A2UiAdapter starts using fieldName, no composite
// change is needed — it already receives it.
// ---------------------------------------------------------------------------

export class DualAdapterDispatch implements AgentUIAdapter {
  constructor(
    private readonly agUi: AgentUIAdapter,
    private readonly a2ui: AgentUIAdapter,
  ) {}

  onRunStarted(): void {
    this.agUi.onRunStarted();
    this.a2ui.onRunStarted();
  }

  onRunFinished(
    status: "completed" | "failed" | "stopped",
    error?: string,
  ): void {
    this.agUi.onRunFinished(status, error);
    this.a2ui.onRunFinished(status, error);
  }

  onTextDelta(messageId: string, delta: string): void {
    this.agUi.onTextDelta(messageId, delta);
    this.a2ui.onTextDelta(messageId, delta);
  }

  onToolCallStart(toolCallId: string, toolName: string, args: unknown): void {
    this.agUi.onToolCallStart(toolCallId, toolName, args);
    this.a2ui.onToolCallStart(toolCallId, toolName, args);
  }

  onToolCallEnd(toolCallId: string, toolName: string, result: unknown): void {
    this.agUi.onToolCallEnd(toolCallId, toolName, result);
    this.a2ui.onToolCallEnd(toolCallId, toolName, result);
  }

  onStateSnapshot(snapshot: unknown): void {
    this.agUi.onStateSnapshot(snapshot);
    this.a2ui.onStateSnapshot(snapshot);
  }

  onInterrupt(
    schema: Record<string, unknown>,
    xRenderer: string,
    values: Record<string, unknown>,
    reviewTaskId: string,
    fieldName?: string,
  ): void {
    this.agUi.onInterrupt(schema, xRenderer, values, reviewTaskId, fieldName);
    this.a2ui.onInterrupt(schema, xRenderer, values, reviewTaskId, fieldName);
  }

  onResume(): void {
    this.agUi.onResume();
    this.a2ui.onResume();
  }
}
