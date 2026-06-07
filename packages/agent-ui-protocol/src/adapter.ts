// ---------------------------------------------------------------------------
// AgentUIAdapter — tier-neutral interface; the type export keeps imports safe.
// No server-only constraint — safe to import on client for typing purposes.
// ---------------------------------------------------------------------------

export type AgentUIAdapter = {
  onRunStarted(): void;
  onRunFinished(status: "completed" | "failed" | "stopped", error?: string): void;
  onTextDelta(messageId: string, delta: string): void;
  onToolCallStart(toolCallId: string, toolName: string, args: unknown): void;
  onToolCallEnd(toolCallId: string, toolName: string, result: unknown): void;
  onStateSnapshot(snapshot: unknown): void;
  onInterrupt(
    schema: Record<string, unknown>,
    xRenderer: string,
    values: Record<string, unknown>,
    reviewTaskId: string,
    /**
     * Optional setup-field name carried on the INTERRUPT event so the UI
     * approval flow can forward it back to `approveReviewTaskInternal` in the
     * resume payload without re-reading `planned_action.provenance`.
     */
    fieldName?: string,
  ): void;
  /** Signals that a HITL step was resumed so the client clears interruptContext. */
  onResume(): void;
};
