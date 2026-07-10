"use server";

import { redirect } from "next/navigation";
import { getAuthSession, isPlatformAdmin } from "@/lib/auth-session";
import { createAgentBuilderPrimitiveHandlers } from "@cinatra-ai/agents/mcp-handlers";

// Codes-only flash protocol: decisions redirect with `?status=<code>` (success)
// or `?error=<code>` (failure). The <SearchParamToast> island in the detail
// screen maps each code to a STATIC message — the raw MCP error is logged
// server-side, never reflected into the redirect URL.
const APPROVAL_BASE = "/configuration/agents/approvals";

type DecisionResult = { ok: true } | { ok: false; code: string };

async function decide(input: {
  id: string;
  decision: "approve" | "reject";
  expectedSnapshotHash: string;
  reason?: string;
}): Promise<DecisionResult> {
  const session = await getAuthSession();
  if (!session || !isPlatformAdmin(session)) {
    return { ok: false, code: "unauthorized" };
  }
  const orgId = session.session?.activeOrganizationId ?? null;
  if (!orgId) return { ok: false, code: "no-active-org" };

  const handlers = createAgentBuilderPrimitiveHandlers() as Record<
    string,
    (req: {
      primitiveName: string;
      input: Record<string, unknown>;
      actor: Record<string, unknown>;
      mode: string;
    }) => Promise<unknown>
  >;

  const result = (await handlers["agent_creation_request_decide"]({
    primitiveName: "agent_creation_request_decide",
    input: {
      id: input.id,
      decision: input.decision,
      expectedSnapshotHash: input.expectedSnapshotHash,
      ...(input.reason ? { reason: input.reason } : {}),
    },
    actor: {
      actorType: "human",
      source: "ui",
      userId: session.user.id,
      organizationId: orgId,
      platformRole: "platform_admin",
    },
    mode: "deterministic",
  })) as { error?: string };

  if (result.error) {
    console.error("[agent-approval decide] primitive returned error:", result.error);
    return { ok: false, code: "decision-failed" };
  }
  return { ok: true };
}

export async function approveAgentCreationRequest(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  const snapshotHash = String(formData.get("snapshotHash") ?? "");
  const result = await decide({ id, decision: "approve", expectedSnapshotHash: snapshotHash });
  if (!result.ok) {
    redirect(`${APPROVAL_BASE}/${id}?error=${result.code}`);
  }
  redirect(`${APPROVAL_BASE}/${id}?status=approved`);
}

export async function retryPublishAgentCreationRequest(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  const session = await getAuthSession();
  if (!session || !isPlatformAdmin(session)) {
    redirect(`${APPROVAL_BASE}/${id}?error=unauthorized`);
  }
  const orgId = session.session?.activeOrganizationId ?? null;
  if (!orgId) {
    redirect(`${APPROVAL_BASE}/${id}?error=no-active-org`);
  }
  const handlers = createAgentBuilderPrimitiveHandlers() as Record<
    string,
    (req: { primitiveName: string; input: Record<string, unknown>; actor: Record<string, unknown>; mode: string }) => Promise<unknown>
  >;
  const result = (await handlers["agent_creation_request_retry_publish"]({
    primitiveName: "agent_creation_request_retry_publish",
    input: { id },
    actor: {
      actorType: "human",
      source: "ui",
      userId: session.user.id,
      organizationId: orgId,
      platformRole: "platform_admin",
    },
    mode: "deterministic",
  })) as { error?: string };
  if (result.error) {
    console.error("[agent-approval retry-publish] primitive returned error:", result.error);
    redirect(`${APPROVAL_BASE}/${id}?error=publish-failed`);
  }
  redirect(`${APPROVAL_BASE}/${id}?status=published`);
}

export async function rejectAgentCreationRequest(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  const snapshotHash = String(formData.get("snapshotHash") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!reason) {
    redirect(`${APPROVAL_BASE}/${id}?error=reason-required`);
  }
  const result = await decide({
    id,
    decision: "reject",
    expectedSnapshotHash: snapshotHash,
    reason,
  });
  if (!result.ok) {
    redirect(`${APPROVAL_BASE}/${id}?error=${result.code}`);
  }
  redirect(`${APPROVAL_BASE}/${id}?status=rejected`);
}
