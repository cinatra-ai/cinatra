/**
 * Polls a status function until it returns a terminal status or the timeout elapses.
 * Used by agent sync MCP primitives (scrape_source_execute_sync, enrichment_source_execute_sync, etc.)
 * to block server-side without requiring the parent LLM agent to manage a polling loop.
 */

const TERMINAL_STATUSES = ["succeeded", "failed", "stopped"] as const;
type TerminalStatus = (typeof TERMINAL_STATUSES)[number] | "timeout";

export type PollResult = {
  status: TerminalStatus;
  message: string;
  timedOut: boolean;
};

export async function pollUntilTerminal(
  pollFn: () => Promise<{ status?: string; message?: string }>,
  timeoutMs: number,
  pollIntervalMs = 5_000,
): Promise<PollResult> {
  const startedAt = Date.now();
  while (true) {
    await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
    const state = await pollFn();
    const s = state.status ?? "";
    if ((TERMINAL_STATUSES as readonly string[]).includes(s)) {
      return { status: s as TerminalStatus, message: state.message ?? "", timedOut: false };
    }
    if (Date.now() - startedAt >= timeoutMs) {
      return {
        status: "timeout",
        message: `Timed out after ${Math.round(timeoutMs / 1000)}s — execution may still be running`,
        timedOut: true,
      };
    }
  }
}
