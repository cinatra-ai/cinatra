"use server";

import { redirect } from "next/navigation";
import { getAuthSession, isPlatformAdmin } from "@/lib/auth-session";
import { createAgentBuilderPrimitiveHandlers } from "@cinatra-ai/agents/mcp-handlers";

type DecisionResult = { ok: true } | { ok: false; error: string };

async function decide(input: {
  id: string;
  decision: "approve" | "reject";
  expectedSnapshotHash: string;
  reason?: string;
}): Promise<DecisionResult> {
  const session = await getAuthSession();
  if (!session || !isPlatformAdmin(session)) {
    return { ok: false, error: "Unauthorized — admin session required." };
  }
  const orgId = session.session?.activeOrganizationId ?? null;
  if (!orgId) return { ok: false, error: "No active organization." };

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
    return { ok: false, error: result.error };
  }
  return { ok: true };
}

export async function approveAgentCreationRequest(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  const snapshotHash = String(formData.get("snapshotHash") ?? "");
  const result = await decide({ id, decision: "approve", expectedSnapshotHash: snapshotHash });
  if (!result.ok) {
    redirect(`/configuration/agents/approvals/${id}?error=${encodeURIComponent(result.error)}`);
  }
  redirect(`/configuration/agents/approvals/${id}?status=approved`);
}

export async function retryPublishAgentCreationRequest(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  const session = await getAuthSession();
  if (!session || !isPlatformAdmin(session)) {
    redirect(
      `/configuration/agents/approvals/${id}?error=${encodeURIComponent("Unauthorized — admin session required.")}`,
    );
  }
  const orgId = session.session?.activeOrganizationId ?? null;
  if (!orgId) {
    redirect(`/configuration/agents/approvals/${id}?error=${encodeURIComponent("No active organization.")}`);
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
    redirect(`/configuration/agents/approvals/${id}?error=${encodeURIComponent(result.error)}`);
  }
  redirect(`/configuration/agents/approvals/${id}?status=published`);
}

export async function rejectAgentCreationRequest(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  const snapshotHash = String(formData.get("snapshotHash") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!reason) {
    redirect(
      `/configuration/agents/approvals/${id}?error=${encodeURIComponent("A rejection reason is required.")}`,
    );
  }
  const result = await decide({
    id,
    decision: "reject",
    expectedSnapshotHash: snapshotHash,
    reason,
  });
  if (!result.ok) {
    redirect(`/configuration/agents/approvals/${id}?error=${encodeURIComponent(result.error)}`);
  }
  redirect(`/configuration/agents/approvals/${id}?status=rejected`);
}
