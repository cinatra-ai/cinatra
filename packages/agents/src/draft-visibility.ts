// ---------------------------------------------------------------------------
// Draft visibility on /agents (cinatra#2653).
//
// An imported agent template lands with status='draft'
// (import-agent-core.ts `status: options?.status ?? "draft"`), and
// `readInstalledAgentTemplates` defaults to ['active','published'] — so a
// fresh import was invisible on /agents with no UI to find or publish it.
//
// This module is the ONE policy answer to "which drafts may the /agents
// picker surface?". It deliberately excludes:
//   • external A2A templates — their lifecycle is their connector's, and the
//     upsert path never writes 'draft' anyway;
//   • assistant-kind templates — the seeded builtin assistants (Cinatra,
//     Drupal, WordPress) are PERMANENT drafts by design
//     (`assertNotAssistantPublication` refuses to ever publish them), so
//     surfacing them would both clutter the picker and offer a Publish that
//     can only fail.
//
// Drafts that pass this predicate BYPASS `selectHitlRunVisibleTemplates`:
// that filter governs which agents may offer a RUN, while a draft is
// surfaced to be FOUND and PUBLISHED — hiding a HITL-less draft would
// recreate exactly the invisibility this module exists to fix.
// ---------------------------------------------------------------------------

import type { AgentTemplateRecord } from "./store";

type RequiredFields = "status" | "sourceType" | "agentKind";

export type DraftVisibilityTemplate = Pick<AgentTemplateRecord, RequiredFields>;

/** True when a template is a draft the /agents picker should surface. */
export function isSurfaceableDraftTemplate<T extends DraftVisibilityTemplate>(
  t: T,
): boolean {
  if (t.status !== "draft") return false;
  if (t.sourceType === "external") return false;
  if (t.agentKind === "assistant") return false;
  return true;
}
