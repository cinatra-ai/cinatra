// Stub for @cinatra-ai/a2a — prevents loading Redis/DB deps in unit tests.
// xaddRunEvent is a no-op; readRunEvents yields nothing.
export async function xaddRunEvent(
  _runId: string,
  _payload: Record<string, unknown>,
): Promise<string> {
  return "0-0";
}

export async function* readRunEvents(
  _runId: string,
  _opts?: unknown,
): AsyncGenerator<{ id: string; event: Record<string, unknown> }> {
  // yields nothing — tests that need events should mock at a higher level
}

export async function expireRunStream(
  _runId: string,
  _ttlSeconds?: number,
): Promise<void> {}

export async function __disconnectSharedEventLogPublisher(): Promise<void> {}

export type StreamReadOptions = {
  fromId?: string;
  signal?: AbortSignal;
  inactivityMs?: number;
};
