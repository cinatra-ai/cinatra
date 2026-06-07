// ---------------------------------------------------------------------------
// Channel name helper — tier-neutral, no server-only constraint.
// ---------------------------------------------------------------------------

export function channelFor(runId: string): string {
  return `cinatra:agui:run:${runId}`;
}
