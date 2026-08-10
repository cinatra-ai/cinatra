"use server";

// ---------------------------------------------------------------------------
// publishAgentTemplateAction (cinatra#2653) — the UI publish path for a draft
// agent template surfaced on /agents.
//
// Before this action the ONLY way to promote an imported draft was the MCP
// `agent_update` tool. This server action mirrors that handler's publish
// semantics exactly (mcp/handlers.ts `handleAgentBuilderUpdate`):
//
//   1. `updateAgentTemplate(id, { status: "published" })` — carries BOTH
//      assistant-kind guard arms (the pre-read assertion and the atomic
//      `agent_kind <> 'assistant'` WHERE arm), so an assistant can never be
//      published even under a race;
//   2. `createAgentTemplateVersionIfChanged(updated, ...)` — creates the
//      first `agent_template_versions` row and ADVANCES
//      `agent_templates.current_version_id`. The import path compiles an
//      `agent_versions` snapshot but never binds a current version
//      (import-agent-core.ts never touches `current_version_id`), so this
//      step is what makes "Publish" honest: the published agent leaves with
//      a bound current version instead of a dangling NULL pointer.
//
// Admin-gated with the SAME floor as the upload path that creates these
// drafts (`requireAdminSession`, matching importAgentTemplate).
// ---------------------------------------------------------------------------

import { revalidatePath } from "next/cache";
import { requireAdminSession } from "@/lib/auth-session";
import { logAuditEvent } from "@/lib/authz";
import { POLICY_VERSION } from "@/lib/authz/actor-context";
import {
  createAgentTemplateVersionIfChanged,
  readAgentTemplateById,
  updateAgentTemplate,
} from "./store";

export type PublishAgentTemplateResult =
  | { ok: true; templateId: string }
  | { ok: false; error: string };

export async function publishAgentTemplateAction(
  templateId: string,
): Promise<PublishAgentTemplateResult> {
  const session = await requireAdminSession();

  if (!templateId || typeof templateId !== "string") {
    return { ok: false, error: "templateId is required." };
  }

  const template = await readAgentTemplateById(templateId);
  if (!template) {
    return { ok: false, error: "Agent template not found." };
  }
  // Idempotent success — a double-click / stale card publishing an
  // already-published template is not an error.
  if (template.status === "published") {
    return { ok: true, templateId };
  }
  if (template.status !== "draft") {
    return {
      ok: false,
      error: `Only a draft can be published (current status: ${template.status}).`,
    };
  }
  if (template.agentKind === "assistant") {
    // Early, readable refusal; the store's own guard arms are the backstop.
    return { ok: false, error: "An assistant cannot be published." };
  }

  const updated = await updateAgentTemplate(templateId, { status: "published" });
  if (!updated) {
    // Zero-row outcome: the atomic assistant guard (or a concurrent delete)
    // refused the flip. `updateAgentTemplate` classified it as a no-op.
    return { ok: false, error: "Publish was refused for this template." };
  }

  // Bind a current version (see header). Without this the template publishes
  // with `current_version_id = NULL` — the second defect confirmed on #2653.
  await createAgentTemplateVersionIfChanged(updated, {
    createdBy: session.user.id,
  });

  void logAuditEvent({
    organizationId: updated.orgId ?? undefined,
    actorPrincipalId: session.user.id,
    actorPrincipalType: "human",
    authSource: "ui",
    resourceType: "agent_template",
    resourceId: updated.id,
    operation: "update",
    decision: "allowed",
    policyVersion: POLICY_VERSION,
    metadata: { statusTransition: { from: "draft", to: "published" } },
  });

  revalidatePath("/agents");
  return { ok: true, templateId };
}
