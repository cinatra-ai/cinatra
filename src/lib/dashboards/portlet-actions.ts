"use server";

// Server actions for the MUTATING portlets (PORT-05 edit-text, PORT-08
// workflow-launcher, PORT-09 agent-launcher) + the launcher's read resolver.
// Security model: every action re-derives the actor from SESSION (never trusts
// a client-supplied actor/scope), and gates EACH effect by the resource it
// touches — object.update on the parent object, assertProjectWriteAccess on
// the project (inside the workflows handler). A tampered client input
// therefore only ever resolves to a resource the session user is already
// authorized for. Trusted refs (projectId/postId) are read from
// the GATED parent object server-side, not from the client.
import {
  resolvePortletAuthz,
  resolvePortletPrimitiveActor,
  objectResourceCheck,
} from "@/lib/dashboards/portlet-authz";
import { getObjectById } from "@/lib/objects-store";
import { enforceResourceAccess } from "@/lib/authz/enforce-resource-access";
import { authorArtifact } from "@/lib/artifacts/artifact-authoring";
import { getArtifact } from "@/lib/artifacts/artifact-service";
import { createDeterministicBlogContentClient } from "@/lib/blog/mcp/client/deterministic-client";
import { createDeterministicAgentsClient } from "@cinatra-ai/agents/mcp-client";
import { createDeterministicWorkflowsClient } from "@cinatra-ai/workflows/mcp-client";
import { buildWorkflowHandlerDeps } from "@/lib/workflow-host-deps";
import { listWordPressInstances } from "@/lib/wordpress-api";

export type PortletActionResult<T = Record<string, never>> =
  | ({ ok: true } & T)
  | { ok: false; code: string; message: string };

// ---------------------------------------------------------------------------
// PORT-05 artifact-edit-text — author a NEW artifact then ref-swap the parent
// object's pointer to it. Only `blog_post_update` is a live refSwapPrimitive
// this phase. projectId/postId/extension/MIME are ALL derived server-side from
// the gated parent object + its current artifact (never from the client).
// ---------------------------------------------------------------------------
export async function editArtifactTextAction(args: {
  parentObjectId: string;
  parentObjectField: string;
  refSwapPrimitive: string;
  title: string;
  content: string;
}): Promise<PortletActionResult<{ artifactId: string }>> {
  const authz = await resolvePortletAuthz();
  if (!authz.orgId || !authz.actorContext) {
    return { ok: false, code: "no_org", message: "Active organization required." };
  }
  // Gate object.update on the parent BEFORE any effect.
  const row = getObjectById(args.parentObjectId, { orgId: authz.orgId });
  if (!row) return { ok: false, code: "not_found", message: "Parent object not found." };
  try {
    await enforceResourceAccess(objectResourceCheck(row), authz.primitiveActor, "object.update", authz.roleHints);
  } catch {
    return { ok: false, code: "forbidden", message: "You cannot edit this object." };
  }
  if (args.refSwapPrimitive !== "blog_post_update") {
    return {
      ok: false,
      code: "port_edit_text_unsupported_refswap",
      message: `Unsupported refSwapPrimitive "${args.refSwapPrimitive}".`,
    };
  }
  const data = (row.data ?? {}) as Record<string, unknown>;
  const projectId = typeof data.projectId === "string" ? data.projectId : null;
  const postId = typeof data.postId === "string" ? data.postId : null;
  const currentArtifactId =
    typeof data[args.parentObjectField] === "string" ? (data[args.parentObjectField] as string) : null;
  if (!projectId || !postId || !currentArtifactId) {
    return {
      ok: false,
      code: "port_edit_text_object_missing_refs",
      message: "Parent object is missing projectId/postId/artifact ref.",
    };
  }
  // Derive the extension + MIME from the CURRENT artifact (server-authoritative).
  const current = getArtifact({ artifactId: currentArtifactId, orgId: authz.orgId, actor: authz.actorContext });
  if (!current) return { ok: false, code: "artifact_not_found", message: "Current artifact not accessible." };
  const extension = current.primaryExtension || current.eligibleExtensions[0];
  if (!extension) return { ok: false, code: "artifact_no_extension", message: "Current artifact has no resolvable extension." };

  const emitted = await authorArtifact({
    orgId: authz.orgId,
    actor: authz.actorContext,
    extension,
    content: args.content,
    declaredMime: current.mime,
    title: args.title,
  });
  if (!emitted.ok) return { ok: false, code: emitted.reason, message: emitted.message };

  // Ref-swap the parent's pointer (refs-only; the blog handler re-gates).
  const actor = await resolvePortletPrimitiveActor();
  const blog = createDeterministicBlogContentClient({ actor });
  await blog.post.update({
    projectId,
    postId,
    postArtifactId: emitted.artifactId,
    postRepresentationRevisionId: emitted.representationRevisionId,
  });
  return { ok: true, artifactId: emitted.artifactId };
}

// ---------------------------------------------------------------------------
// PORT-08 workflow-launcher — instantiate a workflow template. The workflows
// handler asserts project write access (host-injected deps) BEFORE any DB write
// when projectId is present, so a tampered projectId is denied server-side.
// ---------------------------------------------------------------------------
export type WorkflowLauncherTemplate = {
  templateId: string;
  name: string;
  placeholders: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

export async function loadWorkflowLauncherTemplate(args: {
  templateKey: string;
  templateVersion?: string;
}): Promise<WorkflowLauncherTemplate | null> {
  const actor = await resolvePortletPrimitiveActor();
  if (!actor.orgId) return null;
  const client = createDeterministicWorkflowsClient({ actor, deps: buildWorkflowHandlerDeps() });
  const listed = await client.template.list();
  if ("error" in listed) return null;
  const match = listed.templates.find(
    (t) => t.key === args.templateKey && (!args.templateVersion || t.version === args.templateVersion),
  );
  if (!match) return null;
  const got = await client.template.get(match.id);
  if ("error" in got) return null;
  return { templateId: got.id, name: got.name, placeholders: got.placeholders, metadata: got.metadata };
}

// Typed-picker options loaders. The wordpress one strips every secret field
// (applicationPassword, siteUrl, username) — the client receives ONLY
// { id, label }. Same scope-leakage posture as the read loaders.
export type PortletPickerOption = { id: string; label: string };

export async function loadWordpressInstanceOptions(): Promise<PortletPickerOption[]> {
  const actor = await resolvePortletPrimitiveActor();
  if (!actor.orgId) return [];
  const instances = await listWordPressInstances();
  return instances.map((i) => ({ id: i.id, label: i.name }));
}

export async function launchWorkflowAction(args: {
  templateId: string;
  projectId?: string;
  inputs?: Record<string, unknown>;
  name?: string;
}): Promise<PortletActionResult<{ workflowId: string }>> {
  const actor = await resolvePortletPrimitiveActor();
  if (!actor.orgId) return { ok: false, code: "no_org", message: "Active organization required." };
  // The launcher is project-bound: a blank/missing projectId would create a
  // project_id=null workflow that BYPASSES the handler's assertProjectWriteAccess
  // gate (it only fires when projectId is truthy). Reject before instantiate.
  const projectId = typeof args.projectId === "string" ? args.projectId.trim() : "";
  if (!projectId) {
    return { ok: false, code: "project_required", message: "A project is required to launch a workflow." };
  }
  const client = createDeterministicWorkflowsClient({ actor, deps: buildWorkflowHandlerDeps() });
  const res = await client.template.instantiate({
    templateId: args.templateId,
    projectId,
    inputs: args.inputs,
    name: args.name,
  });
  if ("error" in res) return { ok: false, code: res.code ?? "instantiate_failed", message: res.error };
  return { ok: true, workflowId: res.workflowId };
}

// ---------------------------------------------------------------------------
// PORT-09 agent-launcher — start an agent run. The agent_run handler runs an
// owner-only execute gate against the resolved template before any insert.
// ---------------------------------------------------------------------------
export async function launchAgentAction(args: {
  agentRef?: string;
  agentPackage?: string;
  inputParams?: string;
}): Promise<PortletActionResult<{ runId: string }>> {
  const actor = await resolvePortletPrimitiveActor();
  if (!actor.orgId) return { ok: false, code: "no_org", message: "Active organization required." };
  // Agent refs are package names (e.g. "@cinatra-ai/blog-draft-writer-agent");
  // the handler's packageName path includes the vendor-scope alias fallback.
  const packageName = args.agentPackage ?? args.agentRef;
  if (!packageName) return { ok: false, code: "no_agent", message: "No agent configured." };
  const client = createDeterministicAgentsClient({ actor });
  const res = await client.agent.run({ packageName, inputParams: args.inputParams });
  if ("error" in res) return { ok: false, code: "agent_run_failed", message: res.error };
  return { ok: true, runId: res.runId };
}
