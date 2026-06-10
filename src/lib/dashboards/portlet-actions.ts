"use server";

// Server actions for the MUTATING portlets (edit-text, edit-binary-prompt,
// workflow-launcher, agent-launcher) + the launcher's read resolver.
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
import { getObjectById, type ObjectRecord } from "@/lib/objects-store";
import { enforceResourceAccess } from "@/lib/authz/enforce-resource-access";
import { authorArtifact } from "@/lib/artifacts/artifact-authoring";
import { getArtifact } from "@/lib/artifacts/artifact-service";
import { resolveArtifactVersionForServe } from "@/lib/artifacts/artifact-read";
import { createDeterministicBlogContentClient } from "@/lib/blog/mcp/client/deterministic-client";
import { readBlogPostsProjectById } from "@/lib/blog/store";
import { isBackgroundJobActive } from "@/lib/background-jobs";
import { createDeterministicAgentsClient } from "@cinatra-ai/agents/mcp-client";
import { createDeterministicWorkflowsClient } from "@cinatra-ai/workflows/mcp-client";
import { buildWorkflowHandlerDeps } from "@/lib/workflow-host-deps";
import { listWordPressInstances } from "@/lib/wordpress-api";
import {
  BINARY_GENERATION_PRIMITIVE_PAIRS,
  BINARY_REF_SWAP_PRIMITIVES,
  BINARY_REGEN_PROMPT_MAX_LENGTH,
  deriveBlogPostRefs,
} from "@/lib/dashboards/portlet-binary-regen-shared";

// Default T = unknown so payload-less actions can return a bare `{ ok: true }`
// (`{ ok: true } & unknown` collapses to `{ ok: true }`; the previous
// `Record<string, never>` default made that literal unassignable).
export type PortletActionResult<T = unknown> =
  | ({ ok: true } & T)
  | { ok: false; code: string; message: string };

// ---------------------------------------------------------------------------
// Artifact-edit-text — author a NEW artifact then ref-swap the parent
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
// Artifact-edit-binary-prompt — prompt-driven regeneration of the parent
// object's binary artifact via the EXISTING blog hero-image primitives.
// Same security model as editArtifactTextAction: session-derived actor,
// object.update gate on the parent BEFORE any effect, projectId/postId
// derived from the GATED object (never the client), primitive names from
// config resolved through a server-side allow-list. The generation state is
// a PER-PROJECT singleton, so start/cancel additionally verify which post
// the running job belongs to before acting.
// ---------------------------------------------------------------------------

type GatedBlogPostParent = {
  row: ObjectRecord;
  projectId: string;
  postId: string;
  authz: Awaited<ReturnType<typeof resolvePortletAuthz>>;
};

/** Gate object.update on the parent, then derive + membership-check the blog
 *  project/post refs from the GATED row. Shared by start/cancel/swap. */
async function gateBinaryRegenParent(parentObjectId: string): Promise<
  | { ok: true; parent: GatedBlogPostParent }
  | { ok: false; code: string; message: string }
> {
  const authz = await resolvePortletAuthz();
  if (!authz.orgId || !authz.actorContext) {
    return { ok: false, code: "no_org", message: "Active organization required." };
  }
  const row = getObjectById(parentObjectId, { orgId: authz.orgId });
  if (!row) return { ok: false, code: "not_found", message: "Parent object not found." };
  try {
    await enforceResourceAccess(objectResourceCheck(row), authz.primitiveActor, "object.update", authz.roleHints);
  } catch {
    return { ok: false, code: "forbidden", message: "You cannot edit this object." };
  }
  const { projectId, postId } = deriveBlogPostRefs((row.data ?? {}) as Record<string, unknown>);
  if (!projectId || !postId) {
    return {
      ok: false,
      code: "port_edit_binary_object_missing_refs",
      message: "Parent object is missing projectId/postId refs.",
    };
  }
  // Membership check: the derived post must actually belong to the derived
  // project — a mismatched object row must not steer a foreign project's
  // singleton pipeline.
  const project = await readBlogPostsProjectById(projectId);
  if (!project || !project.posts.some((p) => p.id === postId)) {
    return { ok: false, code: "not_found", message: "Blog post not found in its project." };
  }
  return { ok: true, parent: { row, projectId, postId, authz } };
}

export async function startBinaryRegenerationAction(args: {
  parentObjectId: string;
  generationPrimitive: string;
  prompt?: string;
}): Promise<PortletActionResult> {
  if (!BINARY_GENERATION_PRIMITIVE_PAIRS[args.generationPrimitive]) {
    return {
      ok: false,
      code: "port_edit_binary_unsupported_primitive",
      message: `Unsupported generationPrimitive "${args.generationPrimitive}".`,
    };
  }
  // Bound the only free-text client input at this trust boundary — the
  // primitive schema accepts an unbounded string and the generator
  // interpolates it into the provider prompt verbatim.
  const prompt = (args.prompt ?? "").trim();
  if (prompt.length > BINARY_REGEN_PROMPT_MAX_LENGTH) {
    return {
      ok: false,
      code: "port_edit_binary_prompt_too_long",
      message: `Prompt exceeds ${BINARY_REGEN_PROMPT_MAX_LENGTH} characters.`,
    };
  }
  const gated = await gateBinaryRegenParent(args.parentObjectId);
  if (!gated.ok) return gated;
  const { projectId, postId } = gated.parent;
  // The pipeline state is a project-level singleton: when a job is ACTIVELY
  // running for a DIFFERENT post, refuse (the start primitive would silently
  // return the foreign run's state). A stale "running" row whose job is gone
  // falls through — the primitive self-heals it.
  const project = await readBlogPostsProjectById(projectId);
  const state = project?.imageGeneration;
  if (
    state?.status === "running" &&
    state.postId &&
    state.postId !== postId &&
    (state.jobId ? await isBackgroundJobActive(state.jobId) : false)
  ) {
    return {
      ok: false,
      code: "port_edit_binary_busy",
      message: "Another item in this project is already generating an image.",
    };
  }
  const actor = await resolvePortletPrimitiveActor();
  const blog = createDeterministicBlogContentClient({ actor });
  try {
    await blog.image.startRegeneration({ projectId, postId, prompt: prompt || undefined });
  } catch {
    // Canned message only — primitive errors can carry provider/internal text.
    return { ok: false, code: "port_edit_binary_start_failed", message: "Could not start image generation." };
  }
  return { ok: true };
}

export async function cancelBinaryRegenerationAction(args: {
  parentObjectId: string;
  generationPrimitive: string;
}): Promise<PortletActionResult> {
  const cancelPrimitive = BINARY_GENERATION_PRIMITIVE_PAIRS[args.generationPrimitive];
  if (!cancelPrimitive) {
    return {
      ok: false,
      code: "port_edit_binary_unsupported_primitive",
      message: `Unsupported generationPrimitive "${args.generationPrimitive}".`,
    };
  }
  const gated = await gateBinaryRegenParent(args.parentObjectId);
  if (!gated.ok) return gated;
  const { projectId, postId } = gated.parent;
  // The cancel primitive stops whatever job the PROJECT singleton is running.
  // Only allow it when that run belongs to THIS post — this portlet must not
  // be able to kill another post's generation.
  const project = await readBlogPostsProjectById(projectId);
  const state = project?.imageGeneration;
  if (state?.status !== "running" || state.postId !== postId) {
    return {
      ok: false,
      code: "port_edit_binary_not_cancelable",
      message: "No image generation is running for this item.",
    };
  }
  const actor = await resolvePortletPrimitiveActor();
  const blog = createDeterministicBlogContentClient({ actor });
  try {
    await blog.image.cancelRegeneration(projectId);
  } catch {
    return { ok: false, code: "port_edit_binary_cancel_failed", message: "Could not cancel image generation." };
  }
  return { ok: true };
}

/** Manual-mode ref-swap (revert/apply): point the post's image refs at an
 *  EXISTING artifact revision. The client supplies only the snapshot pair —
 *  both ids are re-validated server-side: the artifact must be readable in
 *  session scope, image/*-typed, and the revision must resolve for THAT
 *  artifact in THIS org (`resolveArtifactVersionForServe`, liveOnly). The
 *  refs-shape `blog_post_update` requires the current post-body refs, which
 *  are read from the GATED object data. */
export async function applyBinaryRefSwapAction(args: {
  parentObjectId: string;
  refSwapPrimitive: string;
  imageArtifactId: string;
  imageRepresentationRevisionId: string;
}): Promise<PortletActionResult> {
  if (!BINARY_REF_SWAP_PRIMITIVES.has(args.refSwapPrimitive)) {
    return {
      ok: false,
      code: "port_edit_binary_unsupported_refswap",
      message: `Unsupported refSwapPrimitive "${args.refSwapPrimitive}".`,
    };
  }
  const gated = await gateBinaryRegenParent(args.parentObjectId);
  if (!gated.ok) return gated;
  const { row, projectId, postId, authz } = gated.parent;
  if (!authz.orgId || !authz.actorContext) {
    return { ok: false, code: "no_org", message: "Active organization required." };
  }
  const data = (row.data ?? {}) as Record<string, unknown>;
  const postArtifactId = typeof data.postArtifactId === "string" ? data.postArtifactId : null;
  const postRepresentationRevisionId =
    typeof data.postRepresentationRevisionId === "string" ? data.postRepresentationRevisionId : null;
  if (!postArtifactId || !postRepresentationRevisionId) {
    return {
      ok: false,
      code: "port_edit_binary_object_missing_refs",
      message: "Parent object is missing its post body refs.",
    };
  }
  // Re-resolve the client-supplied target through session-gated reads.
  const target = getArtifact({ artifactId: args.imageArtifactId, orgId: authz.orgId, actor: authz.actorContext });
  if (!target) {
    return { ok: false, code: "forbidden", message: "Target artifact is not accessible." };
  }
  if (!target.mime.startsWith("image/")) {
    return { ok: false, code: "port_edit_binary_not_image", message: "Target artifact is not an image." };
  }
  const resolved = resolveArtifactVersionForServe({
    orgId: authz.orgId,
    artifactId: args.imageArtifactId,
    representationRevisionId: args.imageRepresentationRevisionId,
    liveOnly: true,
  });
  if (!resolved) {
    return { ok: false, code: "port_edit_binary_bad_revision", message: "Target revision does not match the artifact." };
  }
  const actor = await resolvePortletPrimitiveActor();
  const blog = createDeterministicBlogContentClient({ actor });
  try {
    await blog.post.update({
      projectId,
      postId,
      postArtifactId,
      postRepresentationRevisionId,
      imageArtifactId: args.imageArtifactId,
      imageRepresentationRevisionId: args.imageRepresentationRevisionId,
    });
  } catch {
    return { ok: false, code: "port_edit_binary_swap_failed", message: "Could not swap the image reference." };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Workflow-launcher — instantiate a workflow template. The workflows
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
// Agent-launcher — start an agent run. The agent_run handler runs an
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
