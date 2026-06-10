import "server-only";
import { z } from "zod";
import type { McpRuntimeToolServer } from "@cinatra-ai/mcp-server";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";
import { buildActorContextFromPrimitive } from "@/lib/authz/build-actor-context";
import type { ActorContext } from "@/lib/authz/actor-context";
// Sealed-room read filter for artifacts.
// `assertProjectReadAccess` is the 404-hidden authz gate; the actual
// SQL `AND project_id = $projectId` clause is enforced in
// `listObjectsByFilter` (via `listArtifacts`) so post-fetch,
// Graphiti, and semantic-search candidate sets are re-filtered in the
// data layer, not the handler.
import { assertProjectReadAccess } from "@/lib/sealed-room";
import {
  listArtifacts,
  getArtifact,
  tombstoneArtifact,
} from "./artifact-service";
// artifact_assertion_* and artifact_representation_* primitives expose
// the semantic identity and representation history of each artifact.
// READ-ONLY: the classifier, matcher, and authoring runtime own the
// assert/confirm/archive primitives, gated by their own authz model.
import {
  listEligibleAssertions,
  listActiveAssertions,
  getAssertionByIdForReplay,
} from "./semantic-assertion-store";
import {
  listRepresentations,
  getLatestRepresentation,
  getRepresentationByIdForReplay,
} from "./representation-store";
// Chat-driven authoring service.
import {
  authorArtifact,
  searchArtifactExtensions,
  getArtifactExtension,
} from "./artifact-authoring";
import { getAuthoringChain } from "./authoring-recursion-ledger";

// Agent MCP CRUD. Every tool wraps the canonical artifact service; never
// add a second write path. orgId is REQUIRED on all tools (fail-closed
// because objects-store treats orgId=null as "no org boundary"); the actor
// is the canonical ActorContext (a2a precedence) so ownership/visibility
// filters apply; results use the standard MCP envelope.

const listSchema = z.object({
  limit: z.number().int().positive().max(500).optional(),
  // Sealed-room read filter. When set, the handler 404-hides if the
  // actor has no read+ grant on the project, and `listArtifacts` passes
  // the projectId through to `listObjectsByFilter` so the SQL adds
  // `AND project_id = $projectId`. Artifacts are objects; there is no
  // separate physical artifacts table, so this rides the existing
  // `objects.project_id` column.
  projectId: z.string().nullish(),
  // Filter to artifacts whose eligible assertion set includes this extension
  // package (config-supplied by the artifact-list portlet; not a caller tenant
  // override). Backwards-compatible: omit → all artifacts.
  extensionPackageName: z.string().min(1).optional(),
});
const idSchema = z.object({ artifactId: z.string().min(1) });

// Assertion + representation primitives.
const assertionListSchema = z.object({
  artifactId: z.string().min(1),
  // Default: eligible only. When `true`, include matcher drafts in
  // the response. Archived rows always require the by-id replay
  // primitive (never returned in a list).
  includeDrafts: z.boolean().optional(),
});
const assertionByIdSchema = z.object({ assertionId: z.string().min(1) });
const representationByIdSchema = z.object({
  representationRevisionId: z.string().min(1),
});

// Chat-driven authoring.
const artifactExtensionSearchSchema = z.object({
  query: z.string().min(1).max(200),
  limit: z.number().int().positive().max(20).optional(),
});
const artifactExtensionGetSchema = z.object({
  extension: z.string().min(1),
});
const artifactAuthoringEmitSchema = z.object({
  extension: z.string().min(1),
  /** Composed content (chat-authored markdown text). Capped server-side
   *  at 10MB — `content-too-large` rejection. */
  content: z.string().min(1),
  declaredMime: z.string().min(1),
  title: z.string().min(1).max(500),
  // ABSENT BY DESIGN: `parentStepId` is NOT an LLM-supplied field.
  // This primitive has no automatic server-side recursive fan-out, so
  // every emit through it is a ROOT step (parentStepId = null, depth = 0).
  // Server-side orchestrator-driven sub-authoring must derive parent step
  // ids from the agent_run chain, never from MCP input.
});

const TOOL_META = {
  artifacts_list: {
    description:
      "List artifacts (files, documents, dashboards, connector refs) for the active organization, newest first. Each summary carries the semantic identity (`primaryExtension`, `eligibleExtensions`). Optionally filter to artifacts eligible for a given `extensionPackageName`. Read-only.",
    inputSchema: listSchema,
  },
  artifacts_get: {
    description:
      "Fetch one artifact's metadata (type, mime, size, origin, latest representation revision, semantic identity) by id. Read-only.",
    inputSchema: idSchema,
  },
  artifacts_tombstone: {
    description:
      "Tombstone (soft-delete) an artifact. A version still referenced by a run/message is retained and stays replay-resolvable; bytes are reclaimed only after retention. Never hard-deletes.",
    inputSchema: idSchema,
  },
  // Semantic identity reads.
  artifact_assertion_list: {
    description:
      "List the active semantic assertions for an artifact: which extensions classify this row (matcher drafts + eligible non-default + the default-artifact floor). Pass `includeDrafts: true` to include matcher drafts; default returns eligible only. Read-only.",
    inputSchema: assertionListSchema,
  },
  artifact_assertion_get: {
    description:
      "Fetch one assertion by its immutable id (replay-safe — returns the row regardless of CURRENT eligibility, including archived). Read-only.",
    inputSchema: assertionByIdSchema,
  },
  artifact_representation_list: {
    description:
      "List the immutable representation revisions of an artifact, oldest→newest. Each row pins (resourceId, revision, form) and is the basis for `representationRevisionId`-keyed serve URLs. Read-only.",
    inputSchema: idSchema,
  },
  artifact_representation_get: {
    description:
      "Fetch one representation revision by its immutable id. The row itself is append-only and replay-safe, but the parent-artifact actor-visibility gate filters tombstoned (objects.deleted_at IS NOT NULL) parents, so a tombstoned-but-retained representation returns 404 until the deleted-allowed branch is used alongside semantic-aware tombstoning. Read-only.",
    inputSchema: representationByIdSchema,
  },
  artifact_representation_latest: {
    description:
      "Fetch the LATEST representation revision for an artifact. Convenience for downstream readers; identical to the highest-revision row from `artifact_representation_list`. Read-only.",
    inputSchema: idSchema,
  },
  // Chat-driven authoring primitives.
  artifact_extension_search: {
    description:
      "Search installed semantic artifact extensions by intent words (e.g. \"ICP\", \"brand voice\", \"blog post\"). Returns a score-ranked list of candidates with `{packageName, label, acceptedMimes, authorableMimes, hasAuthoringSkill, score}`. `authorableMimes` is the SUBSET of `acceptedMimes` you may pass as `declaredMime` to `artifact_authoring_emit` (text/markdown, text/plain, text/html, application/json, application/xml). Binary MIMEs in `acceptedMimes` are for the upload route only — passing them to emit returns `mime-not-text-authorable`. Use this BEFORE `artifact_authoring_emit` to pick the right extension. Read-only.",
    inputSchema: artifactExtensionSearchSchema,
  },
  artifact_extension_get: {
    description:
      "Fetch the semantic manifest view for one artifact extension by package name (e.g. \"@cinatra-ai/marketing-icp-artifact\"). Returns `{packageName, label, acceptedMimes, authorableMimes, authoringSkillIds, matcherSkillIds, agentDependencies}`. The chat reads `authoringSkillIds[0]` (the authoring skill to follow) and picks a `declaredMime` from `authorableMimes` (NOT `acceptedMimes` — the latter includes binary upload-only MIMEs). Use AFTER `artifact_extension_search`. Read-only.",
    inputSchema: artifactExtensionGetSchema,
  },
  artifact_authoring_emit: {
    description:
      "Emit a chat-authored semantic artifact. Server validates: (1) extension installed, (2) extension accepts the `file` form (extensions that only declare `dashboard` or `connectorRef` forms are refused with `extension-not-file-form`), (3) `manifest.skills.authoring` non-empty (extensions without an authoring skill are refused with `extension-has-no-authoring-skill`; use `createArtifactFromTemplate` for those), (4) `declaredMime` in `manifest.acceptedMimes` (else `mime-not-accepted`) AND in `manifest.authorableMimes` (text MIMEs only — binary MIMEs return `mime-not-text-authorable`, use upload route instead), (5) content ≤ 10MB. Opens a recursion-ledger step (refuses on `cycle`, `depth-cap-exceeded`, or `parent-not-found`). Writes via createSemanticArtifact (`skipFallbackClassification: true`) with `originKind: 'agent_generated'`, asserts the type with `assertedBy: 'authoring_skill'`, and commits the ledger. Returns `{artifactId, representationRevisionId, depth, authoringStepId}`. Structured errors expose `error.reason`, one of: `extension-not-found` | `extension-not-file-form` | `extension-has-no-authoring-skill` | `mime-not-accepted` | `mime-not-text-authorable` | `content-too-large` | `cycle` | `depth-cap-exceeded` | `parent-not-found`.",
    inputSchema: artifactAuthoringEmitSchema,
  },
  artifact_authoring_chain_get: {
    description:
      "Inspect the authoring-recursion-ledger chain for one step (debug / replay surface). Returns ancestors from root to the named step. Read-only.",
    inputSchema: z.object({ authoringStepId: z.string().min(1) }),
  },
} as const;

function resolveScope(): {
  orgId: string;
  userId: string | null;
  actor: ActorContext;
} {
  const ctx = mcpRequestContextStorage.getStore();
  // a2a precedence (mirrors packages/agents/src/mcp/registry.ts).
  const a2a = ctx?.a2aActorContext;
  const userId = a2a?.userId ?? ctx?.userId ?? null;
  // A2A precedence is fail-closed: when an A2A identity is present its
  // org MUST come from the A2A context; we never fall back to the transport
  // org because that would mix A2A identity with transport scope. Only a
  // non-A2A call uses the transport org.
  const orgId = (a2a ? a2a.orgId : ctx?.orgId) ?? null;
  if (!orgId) {
    throw new Error(
      "artifacts MCP: no active organization (fail-closed — refusing an unscoped read/write" +
        (a2a ? "; A2A context carries no orgId" : "") +
        ")",
    );
  }
  const platformRole = ctx?.platformRole;
  const primitive = {
    actorType: a2a ? "a2a" : platformRole ? "human" : "model",
    source: a2a ? "a2a" : "agent",
    ...(userId ? { userId } : {}),
    ...(a2a?.tokenScopes ? { tokenScopes: a2a.tokenScopes } : {}),
  } as Parameters<typeof buildActorContextFromPrimitive>[0];
  const actor = buildActorContextFromPrimitive(primitive, orgId, {
    platformRole,
    // Transport-resolved org-membership role, carried natively on the MCP
    // request context. NON-A2A ONLY: it was resolved for the transport
    // identity (ctx.userId/ctx.orgId); the A2A branch's identity comes from
    // a2aActorContext (potentially a different user/org).
    orgRole: a2a ? undefined : ctx?.orgRole,
    actorOrganizationId: orgId,
    teamIds: a2a?.teamIds,
    projectIds: a2a?.projectIds,
    // Pass projectGrants through to buildActorContextFromPrimitive so
    // the canonical axis (owned ∪ accessed, role-by-authority) reaches
    // the kernel ActorContext. projectIds is kept for back-compat
    // (binary shortcuts).
    projectGrants: a2a?.projectGrants,
  }) as unknown as ActorContext;
  return { orgId, userId, actor };
}

function envelope(payload: unknown) {
  const resolved = payload === undefined ? null : payload;
  return {
    content: [{ type: "text", text: JSON.stringify(resolved) }],
    structuredContent:
      typeof resolved === "object" && resolved !== null
        ? (resolved as Record<string, unknown>)
        : { result: resolved },
  };
}

export function registerArtifactPrimitives(server: McpRuntimeToolServer): void {
  server.registerTool(
    "artifacts_list",
    { title: "artifacts_list", ...TOOL_META.artifacts_list },
    (async (input: unknown) => {
      const parsed = listSchema.parse(input ?? {});
      const { orgId, actor } = resolveScope();
      // Sealed-room gate. The ActorContext built by resolveScope()
      // already carries projectGrants through buildActorContextFromPrimitive
      // on the A2A path; assertProjectReadAccess 404-hides if missing.
      const projectId =
        typeof parsed.projectId === "string" && parsed.projectId.trim().length > 0
          ? parsed.projectId.trim()
          : null;
      if (projectId !== null) {
        assertProjectReadAccess(actor, projectId);
      }
      return envelope({
        artifacts: listArtifacts({
          orgId,
          actor,
          limit: parsed.limit,
          projectId,
          ...(parsed.extensionPackageName ? { extensionPackageName: parsed.extensionPackageName } : {}),
        }),
      });
    }) as never,
  );

  server.registerTool(
    "artifacts_get",
    { title: "artifacts_get", ...TOOL_META.artifacts_get },
    (async (input: unknown) => {
      const { artifactId } = idSchema.parse(input);
      const { orgId, actor } = resolveScope();
      const artifact = getArtifact({ artifactId, orgId, actor });
      if (!artifact) throw new Error(`artifact ${artifactId} not found`);
      return envelope({ artifact });
    }) as never,
  );

  server.registerTool(
    "artifacts_tombstone",
    { title: "artifacts_tombstone", ...TOOL_META.artifacts_tombstone },
    (async (input: unknown) => {
      const { artifactId } = idSchema.parse(input);
      const { orgId, userId, actor } = resolveScope();
      // Pass the ActorContext so the service authorizes the delete through
      // the ownership/visibility filter; userId is only the audit-trail
      // string.
      const res = tombstoneArtifact({
        orgId,
        artifactId,
        actor,
        auditActor: userId,
      });
      return envelope({ tombstoned: true, ...res });
    }) as never,
  );

  // -----------------------------------------------------------------
  // Semantic identity reads. All five primitives are READ-ONLY;
  // classification, matcher, and authoring writes (assert/confirm/archive)
  // use their own authz model. Each primitive gates on
  // `getArtifact({actor})` first so the caller's ownership/visibility
  // filter applies before any semantic data is returned.
  // -----------------------------------------------------------------

  server.registerTool(
    "artifact_assertion_list",
    { title: "artifact_assertion_list", ...TOOL_META.artifact_assertion_list },
    (async (input: unknown) => {
      const { artifactId, includeDrafts } = assertionListSchema.parse(input);
      const { orgId, actor } = resolveScope();
      const visible = getArtifact({ artifactId, orgId, actor });
      if (!visible) throw new Error(`artifact ${artifactId} not found`);
      const assertions = includeDrafts
        ? listActiveAssertions(orgId, artifactId)
        : listEligibleAssertions(orgId, artifactId);
      return envelope({ artifactId, assertions });
    }) as never,
  );

  server.registerTool(
    "artifact_assertion_get",
    { title: "artifact_assertion_get", ...TOOL_META.artifact_assertion_get },
    (async (input: unknown) => {
      const { assertionId } = assertionByIdSchema.parse(input);
      const { orgId, actor } = resolveScope();
      const assertion = getAssertionByIdForReplay(orgId, assertionId);
      if (!assertion) {
        throw new Error(`assertion ${assertionId} not found`);
      }
      // Authz: gate on the parent artifact's actor-visibility.
      const visible = getArtifact({
        artifactId: assertion.artifactId,
        orgId,
        actor,
      });
      if (!visible) {
        throw new Error(`assertion ${assertionId} not found`);
      }
      return envelope({ assertion });
    }) as never,
  );

  server.registerTool(
    "artifact_representation_list",
    {
      title: "artifact_representation_list",
      ...TOOL_META.artifact_representation_list,
    },
    (async (input: unknown) => {
      const { artifactId } = idSchema.parse(input);
      const { orgId, actor } = resolveScope();
      const visible = getArtifact({ artifactId, orgId, actor });
      if (!visible) throw new Error(`artifact ${artifactId} not found`);
      return envelope({
        artifactId,
        representations: listRepresentations(orgId, artifactId),
      });
    }) as never,
  );

  server.registerTool(
    "artifact_representation_get",
    {
      title: "artifact_representation_get",
      ...TOOL_META.artifact_representation_get,
    },
    (async (input: unknown) => {
      const { representationRevisionId } =
        representationByIdSchema.parse(input);
      const { orgId, actor } = resolveScope();
      const rep = getRepresentationByIdForReplay(orgId, representationRevisionId);
      if (!rep) {
        throw new Error(
          `representation ${representationRevisionId} not found`,
        );
      }
      const visible = getArtifact({
        artifactId: rep.artifactId,
        orgId,
        actor,
      });
      if (!visible) {
        throw new Error(
          `representation ${representationRevisionId} not found`,
        );
      }
      return envelope({ representation: rep });
    }) as never,
  );

  server.registerTool(
    "artifact_representation_latest",
    {
      title: "artifact_representation_latest",
      ...TOOL_META.artifact_representation_latest,
    },
    (async (input: unknown) => {
      const { artifactId } = idSchema.parse(input);
      const { orgId, actor } = resolveScope();
      const visible = getArtifact({ artifactId, orgId, actor });
      if (!visible) throw new Error(`artifact ${artifactId} not found`);
      const latest = getLatestRepresentation(orgId, artifactId);
      if (!latest) {
        // An artifact MUST have at least one representation (created in
        // step 2's atomic creation tx). If we get here, the row was
        // created outside the canonical path.
        throw new Error(
          `artifact ${artifactId} has no representations (DB invariant break)`,
        );
      }
      return envelope({ artifactId, representation: latest });
    }) as never,
  );

  // ---- Chat-driven authoring primitives.
  server.registerTool(
    "artifact_extension_search",
    {
      title: "artifact_extension_search",
      ...TOOL_META.artifact_extension_search,
    },
    (async (input: unknown) => {
      const { query, limit } = artifactExtensionSearchSchema.parse(input);
      // Resolve scope to enforce auth (must have an active org) and to pass the
      // actor into the uniform access filter (install-governed artifact
      // extensions the actor can't list are dropped).
      const { actor } = resolveScope();
      const results = await searchArtifactExtensions({ query, limit, actor });
      return envelope({ results });
    }) as never,
  );

  server.registerTool(
    "artifact_extension_get",
    {
      title: "artifact_extension_get",
      ...TOOL_META.artifact_extension_get,
    },
    (async (input: unknown) => {
      const { extension } = artifactExtensionGetSchema.parse(input);
      const { actor } = resolveScope();
      const manifest = await getArtifactExtension(extension, actor);
      if (!manifest) {
        throw new Error(
          `artifact extension "${extension}" is not installed`,
        );
      }
      return envelope({ manifest });
    }) as never,
  );

  server.registerTool(
    "artifact_authoring_emit",
    {
      title: "artifact_authoring_emit",
      ...TOOL_META.artifact_authoring_emit,
    },
    (async (input: unknown) => {
      const parsed = artifactAuthoringEmitSchema.parse(input);
      const { orgId, actor } = resolveScope();
      // Propagate agent_run provenance. The request context populates
      // `runId` when the emit runs inside an agent_run (an authoring
      // agent calling this primitive); the chat-skill direct path leaves
      // it undefined.
      const ctx = mcpRequestContextStorage.getStore();
      const runId = ctx?.runId ?? null;
      const result = await authorArtifact({
        orgId,
        actor,
        extension: parsed.extension,
        content: parsed.content,
        declaredMime: parsed.declaredMime,
        title: parsed.title,
        // Chat emit is ALWAYS a root step; parentStepId is never
        // input-controlled.
        parentStepId: null,
        runId,
      });
      if (!result.ok) {
        // Structured error — MCP framework surfaces error.message +
        // error.reason. The chat skill checks the reason and stops
        // the chain or asks the user.
        const err = new Error(result.message) as Error & {
          reason: typeof result.reason;
          detail?: string;
        };
        err.reason = result.reason;
        if ("detail" in result) err.detail = result.detail;
        throw err;
      }
      return envelope({
        artifactId: result.artifactId,
        representationRevisionId: result.representationRevisionId,
        depth: result.depth,
        authoringStepId: result.authoringStepId,
      });
    }) as never,
  );

  server.registerTool(
    "artifact_authoring_chain_get",
    {
      title: "artifact_authoring_chain_get",
      ...TOOL_META.artifact_authoring_chain_get,
    },
    (async (input: unknown) => {
      const parsed = z
        .object({ authoringStepId: z.string().min(1) })
        .parse(input);
      const { orgId } = resolveScope();
      const chain = getAuthoringChain(orgId, parsed.authoringStepId);
      return envelope({ chain });
    }) as never,
  );
}

export function createArtifactsModule() {
  return {
    registerCapabilities: registerArtifactPrimitives,
  };
}
