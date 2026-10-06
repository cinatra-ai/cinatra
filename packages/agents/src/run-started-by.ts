import type { McpRequestContext } from "@cinatra-ai/mcp-server";

/** #3749: only the signed OBO or trusted run-bound seam can name a starter.
 * Ordinary chats and ambient run headers do not name a run that started one. */
export function runStartedByFromFrame(frame: McpRequestContext | undefined): string | null {
  const signed = frame?.delegatedActor?.delegation === "agent_run"
    ? frame.delegatedActor.runId : undefined;
  const seam = frame?.verifiedRunScopeId;
  for (const id of [signed, seam]) {
    if (id !== undefined && (typeof id !== "string" || id.trim().length === 0 || id !== id.trim())) {
      throw new Error("The verified starter run is invalid; no child was started.");
    }
  }
  if (signed && seam && signed !== seam) {
    throw new Error("The verified starter run contexts disagree; no child was started.");
  }
  return signed ?? seam ?? null;
}
