// ---------------------------------------------------------------------------
// Uploaded-draft visibility on the ADMIN extensions page (cinatra#2653).
//
// An imported agent template lands with status='draft'
// (import-agent-core.ts `status: options?.status ?? "draft"`) and no
// `installed_extension` row, so it appeared NOWHERE: /agents hides drafts by
// status, and /configuration/extensions drops it at the canonical-manifest
// intersection. Owner ruling (PR #2658 review): an uploaded agent must NOT
// show on /agents until an admin approves it — so the draft surfaces on
// /configuration/extensions with a Publish (= approval) affordance instead.
//
// This module is the ONE policy answer to "which draft templates may that
// admin surface list?". It deliberately excludes:
//   • external A2A templates — their lifecycle is their connector's, and the
//     upsert path never writes 'draft' anyway;
//   • assistant-kind templates — the seeded builtin assistants (Cinatra,
//     Drupal, WordPress) are PERMANENT drafts by design
//     (`assertNotAssistantPublication` refuses to ever publish them), so
//     surfacing them would offer a Publish that can only fail.
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
