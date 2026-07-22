// A2A-publication guard for assistant templates (cinatra#1875 W2, Epic #1873 — AC#7).
//
// An assistant template (`agent_kind='assistant'`) is a CONVERSATIONAL principal
// dispatched through the assistant runtime — it is NEVER an A2A-addressable agent.
// This leaf holds the two pure decisions that keep assistants out of A2A
// publication, kept DEPENDENCY-FREE so they are unit-testable without pulling the
// heavy `store.ts` import graph (db, nango, sealed-room, …):
//
//   1. `assertNotAssistantPublication` — the STORE INVARIANT. The store refuses to
//      move an assistant template to `status='published'` (the only DB path to a
//      published assistant, since `serializeTemplate` always writes executor on
//      create and the install seam sets the kind separately). Every publish caller
//      funnels through `updateAgentTemplate`, so this one guard is the chokepoint.
//   2. `excludeAssistantTemplates` — the SHARED READER FILTER. Applied inside
//      `readPublishedAgentTemplates`, the single reader the three A2A surfaces
//      consume (the `/api/a2a` mount, the public `/.well-known/agent.json`
//      AgentCard, and the in-process `resolveAgentByPackageName`), so all three
//      omit assistant rows through one chokepoint (defense-in-depth on top of the
//      invariant).
//
// The `agent_update` MCP endpoint carries a redundant refusal on top of these.

/** The error thrown by the store invariant when a publish targets an assistant. */
export const ASSISTANT_A2A_PUBLICATION_ERROR =
  "an assistant template (agent_kind='assistant') cannot be published to A2A";

/** The published status a template is being moved to that the invariant guards. */
const PUBLISHED_STATUS = "published";

/**
 * True when a status patch would PUBLISH an assistant template. `agentKind` is the
 * template's PERSISTED kind (never a caller-supplied value); `nextStatus` is the
 * patched status (undefined when the patch does not touch status). Only the
 * assistant→published combination is an attempt — an executor publish, or an
 * assistant patch that leaves status alone / moves it anywhere else, is allowed.
 */
export function isAssistantPublicationAttempt(
  agentKind: string | null | undefined,
  nextStatus: string | null | undefined,
): boolean {
  return agentKind === "assistant" && nextStatus === PUBLISHED_STATUS;
}

/**
 * Throw {@link ASSISTANT_A2A_PUBLICATION_ERROR} when the patch would publish an
 * assistant; a no-op otherwise. Called by `updateAgentTemplate` on the publish
 * transition only (the read of the persisted kind is paid solely there).
 */
export function assertNotAssistantPublication(
  agentKind: string | null | undefined,
  nextStatus: string | null | undefined,
): void {
  if (isAssistantPublicationAttempt(agentKind, nextStatus)) {
    throw new Error(ASSISTANT_A2A_PUBLICATION_ERROR);
  }
}

/**
 * Drop every assistant-kind row from a template list. The deserialized record's
 * `agentKind` is authoritative (`store.ts` maps null/unknown → 'executor', so only
 * an explicit 'assistant' is excluded). Used by `readPublishedAgentTemplates` as
 * the shared chokepoint for all three A2A consumers.
 */
export function excludeAssistantTemplates<T extends { agentKind?: string | null }>(
  rows: readonly T[],
): T[] {
  return rows.filter((t) => t.agentKind !== "assistant");
}
