"use server";

// ---------------------------------------------------------------------------
// publishAgentTemplateFormAction (cinatra#2653) — the ADMIN approval path for
// an uploaded draft agent template, served from /configuration/extensions.
//
// Owner ruling (PR #2658 review): an uploaded agent extension must NOT show
// up in /agents until an admin approves it. The draft therefore surfaces on
// the admin extensions page, and THIS action is the approval: it publishes
// the draft and binds its current version in ONE transactional store
// operation (`publishAgentTemplateAndBindVersion`) — the status flip carries
// both assistant-kind guard arms, and the version binding
// (`current_version_id`) commits atomically with it, so a published template
// can never leave this path without a usable version (CodeRabbit major on
// the previous two-step shape). Re-running it on an already-published
// template is the repair path, not a masked no-op.
//
// Conventions per packages/extensions/src/actions.ts (Template A,
// restoreExtensionPackageFormAction): `requireAdminSession()` first; failures
// are RETURNED, never thrown (a thrown server-action error is masked in a
// production build); success ends in `redirect("/configuration/extensions")`,
// which re-renders the destination (revalidatePath unnecessary).
// ---------------------------------------------------------------------------

import { redirect } from "next/navigation";
import { requireAdminSession } from "@/lib/auth-session";
import { logAuditEvent } from "@/lib/authz";
import { POLICY_VERSION } from "@/lib/authz/actor-context";
import {
  publishAgentTemplateAndBindVersion,
  readAgentTemplateById,
} from "./store";

export type PublishAgentTemplateResult = { ok: false; error: string };

export async function publishAgentTemplateFormAction(input: {
  templateId: string;
}): Promise<PublishAgentTemplateResult | void> {
  "use server";
  const session = await requireAdminSession();

  const templateId = input?.templateId;
  if (!templateId || typeof templateId !== "string") {
    return { ok: false, error: "templateId is required." };
  }

  const template = await readAgentTemplateById(templateId);
  if (!template) {
    return { ok: false, error: "Agent template not found." };
  }
  if (template.agentKind === "assistant") {
    // Early, readable refusal; the store's own guard arms are the backstop.
    return { ok: false, error: "An assistant cannot be published." };
  }
  if (template.status !== "draft" && template.status !== "published") {
    // "published" is allowed through: publishAgentTemplateAndBindVersion is
    // the REPAIR path for a published template with no bound version.
    return {
      ok: false,
      error: `Only a draft can be published (current status: ${template.status}).`,
    };
  }

  const result = await publishAgentTemplateAndBindVersion(templateId, {
    createdBy: session.user.id,
  });
  if (!result) {
    // Zero-row outcome: the atomic assistant guard (or a concurrent delete)
    // refused the flip; nothing was committed.
    console.error(
      `[agents] publish refused for template ${templateId} (guard or concurrent delete).`,
    );
    return { ok: false, error: "Publish was refused for this template." };
  }

  // Fire-and-forget audit; a failed audit write must not roll back the
  // publish (same contract as promoteExtensionToPublicAction).
  try {
    void logAuditEvent({
      organizationId: result.record.orgId ?? undefined,
      actorPrincipalId: session.user.id,
      actorPrincipalType: "human",
      authSource: "ui",
      resourceType: "agent_template",
      resourceId: result.record.id,
      operation: "update",
      decision: "allowed",
      policyVersion: POLICY_VERSION,
      metadata: {
        statusTransition: { from: template.status, to: "published" },
        boundVersionId: result.version.id,
      },
    });
  } catch {
    // best-effort
  }

  // revalidatePath is unnecessary because redirect re-renders the destination.
  redirect("/configuration/extensions");
}
