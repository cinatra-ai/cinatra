import { buildAgentInstancePath, buildAgentWorkspacePath } from "@/lib/agent-url";
import { collectAllPrimitiveHandlers } from "@/lib/primitive-handlers";
import { decodeCursor, buildListPage } from "@/lib/mcp-pagination";
import { logAuditEvent, POLICY_VERSION, type AuditEventInput } from "@/lib/authz";
import { readEffectivePublishScopeOverride } from "@/lib/dev-extensions";
import { compileWorkflow } from "../compiler";
import {
  AGENT_RUN_TIMEOUT_MAX_SECONDS,
  WAYFLOW_A2A_TIMEOUT_MS,
  createWayflowFetch,
  resolveWayflowUrl,
} from "../wayflow-url";
import { preflightWayflowAgent } from "../wayflow-preflight";
import {
  createAgentVersion,
  readAgentVersionsByTemplate,
  createAgentRun,
  createAgentTemplate,
  readAgentTemplates,
  readAgentTemplateById,
  readAgentRunById,
  readAgentRuns,
  readAgentRunsByTemplate,
  readAgentRunMessages,
  appendAgentRunMessage,
  transitionRunStatus,
  RunTransitionError,
  type AgentRunStatus,
  updateAgentTemplate,
  deleteAgentTemplate,
  resolveDefaultOrgId,
  readAgentTemplateVersions,
  readAgentTemplateVersionById,
  diffSnapshots,
  createAgentTemplateVersionIfChanged,
  rollbackAgentTemplateToVersion,
  setAgentTemplatePackageName,
  bulkStopAgentRuns,
  bulkStopAgentRunsByTemplate,
  readAgentTemplateByPackageName,
  updateAgentTemplatePackageVersion,
  type AgentTemplateRecord,
  type AgentTemplateVersionRecord,
  writeHitlPrompt,
  readRunCoOwners,
  resolveRunCoOwnerUserIds,
  readAgentRunsByTemplateRaw,
} from "../store";
import { enqueueBackgroundJob } from "@/lib/background-jobs";
import { enqueueAgentRun } from "@/lib/agent-run-enqueue";
import {
  setRunTriggerForActor,
  getRunTriggerForActor,
  deleteRunTriggerForActor,
  type TriggerActorContext,
  type SetTriggerForActorArgs,
} from "../trigger-service";
import { randomUUID, createHash } from "node:crypto";
import { readdir, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { resolveAgentInstallDir } from "../agent-install-path";
import { createZipBuffer } from "../zip-helpers";
// read the chat-side projectContext frame
// from the MCP request context (set at the transport boundary by the chat
// surface). Used by agent_run to tag the new agent_runs row's projectId
// at insert time. Project-context propagation re-establishes the frame in the run-worker
// entry for every artifact/object write.
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";
import {
  validateOasAgentJson,
  scanOasForLiteralSecrets,
  scanOasForUntrustedUrls,
  scanOasForLlmBridgeWiring,
  scanOasForLlmMetadata,
  scanOasForStartNodeInputsWithoutRequired,
  type ReviewFinding,
  detectCredentialPattern,
} from "../validate-agent-json";
import { compileOasAgentJson, injectCinatraLlmIntoApiNodes } from "../oas-compiler";
import type { OasCinatraLlm } from "../llm-provider-policy";
// agent_creation_review primitive (replaces the
// @cinatra/agent-creation-finalizer Flow).
import { handleAgentCreationReview, REVIEWER_LANE_PACKAGES } from "../agent-creation-review";
import {
  handleAgentCreationRequestPropose,
  handleAgentCreationRequestEdit,
  handleAgentCreationRequestList,
  handleAgentCreationRequestGet,
  handleAgentCreationRequestDecide,
  handleAgentCreationRequestRetryPublish,
} from "./agent-creation-request-handlers";
// Hard pre-enqueue preflight at the agent_source_write / write_files boundary.
// Refuses writes when the creation pin is active and required catalog skills
// are not synced. No-ops when the pin is inactive.
import { preflightAgentCreation, type AgentCreationPreflightResult } from "../preflight-agent-creation";
import { resolveRequiredCreationSkillIds } from "../resolve-required-creation-skill-ids";
// packageName alias resolver for agent_run.
import { aliasPackageNameToCanonicalScope } from "../package-name-alias";
import { assertNotReservedAgentPackageName } from "../reserved-workspace-slugs";

// sibling-file credential scan. Walks the package dir for
// non-OAS text files and reuses detectCredentialPattern. Lockfile-aware,
// blocks non-example .env*, caps per-file scan at 1 MB.
import {
  scanPackageSiblingFilesForLiteralSecrets,
  isBlockedEnvFile,
} from "../scan-package-siblings";
import { publishAgentPackage, publishAgentPackageFromGitDir } from "../verdaccio/client";
import { installAgentFromPackage } from "../install-from-package";
// WayFlow reload after a successful publish + DB sync.
import { triggerWayflowReload, type ReloadResult } from "../wayflow-reload-client";
import {
  listAgentPackages,
  InstanceNamespaceNotConfiguredError,
  type VerdaccioConfig,
} from "@cinatra-ai/registries";
import {
  loadVerdaccioConfigForReads,
  loadVerdaccioConfigForServer,
} from "@/lib/verdaccio-config";
import {
  detectSpdxLicense,
  LicenseDetectionRejectedError,
  LicenseAcknowledgementRequiredError,
} from "@cinatra-ai/extensions/license-detection";
// gated-loader helper for GitHub publish destination routing.
// auth gate runs in caller BEFORE this import is used.
// resolvePublishDestination must be called before publishAgentPackageFromGitDir.
import { resolvePublishDestination, PublishDestinationNotConfiguredError } from "@cinatra-ai/extensions/destination-resolver";
import { updateAgentTemplateOrigin } from "../store";
import {
  readInstanceIdentity,
  markFirstPublishedIfCurrentScope,
} from "@/lib/instance-identity-store";
import { getEffectiveViewerScope } from "@/lib/marketplace-credentials";

// best-effort VerdaccioConfig resolver for MCP handlers.
// Returns the structured `{ error }` shape MCP callers already check on
// failure, mirroring the host-app server-action error envelope. Callers
// must guard the returned union with a type narrow before calling
// downstream registry functions.
async function resolveVerdaccioConfigForHandler(): Promise<
  { ok: true; config: VerdaccioConfig } | { ok: false; error: string }
> {
  try {
    // Read-side helper. The only caller is handleAgentBuilderRegistryList
    // (agent_registry_list, read-only); using loadVerdaccioConfigForReads
    // here means consumer-only instances can browse the registry. The
    // vendor-write fallbacks elsewhere in this file still use
    // loadVerdaccioConfigForServer explicitly.
    const config = await loadVerdaccioConfigForReads();
    return { ok: true, config };
  } catch (e) {
    if (e instanceof InstanceNamespaceNotConfiguredError) {
      return {
        ok: false,
        error:
          "Instance vendor name is not configured. Visit /setup/name to provision a registry identity before using the registry.",
      };
    }
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Failed to resolve registry configuration.",
    };
  }
}
import { derivePublishMetadataFromSnapshot } from "../verdaccio/publish-metadata";
import {
  upsertSkill,
  parseFrontmatter,
  // agent_save and agent_delete hooks.
  enqueueInlineForAgent,
  cleanupForAgent,
} from "@cinatra-ai/skills";
import { createDeterministicObjectsClient } from "@cinatra-ai/objects";
import { approveReviewTaskInternal } from "../review-task-actions";
import { enforceRunAccess, actorContextFromMcpRequest } from "../auth-policy";
import type { ActorRoleHints } from "../auth-policy";
// Removed `getActorContext` / `getActorContextOrThrow` imports.
// LLM-reachable paths are now fail-closed at the orchestration entry points
// (requireActorFrame in packages/llm/src/index.ts).
// Legacy session-based callers (UI server actions, route handlers) are gated
// by resolveOrgIdFromSession and resolveIsPlatformAdminFromSession.
import { AuthzError, can } from "@/lib/authz";
import type { ResourceRef } from "@/lib/authz";
// Sealed-room read filter gate. Imported from the dedicated sealed-room module,
// not from any resolver module. 404-hides when
// the actor has no read+ grant on the supplied projectId; the SQL
// `AND project_id = $projectId` clause is enforced inside
// `readAgentRunsByTemplateRaw` / `readAgentRuns` in the store.
import { assertProjectReadAccess } from "@/lib/sealed-room";
// project-move helpers for the
// `agent_run_update.projectId` branch and the dedicated
// `agent_run_move_with_outputs` cascade.
import { assertProjectWritable } from "@/lib/project-writable";
import { runResourceProjectMove, runAgentRunMoveWithOutputs } from "@/lib/resource-project-move";
import { getAuthSession, isPlatformAdmin } from "@/lib/auth-session";
import {
  readTeamsForUser,
  readProjectGrantsForUser,
  readUserById,
} from "@/lib/better-auth-db";
// The local PrimitiveRequest type below uses
// `actor.actorType: string` (a loose shape shared across every handler in
// this file). The auth-policy and store functions require the narrow
// PrimitiveActorContext from @cinatra-ai/mcp-client. We cast
// `request.actor as PrimitiveActorContext` at each call site — the runtime
// value IS already a PrimitiveActorContext (the MCP runtime constructs it
// that way), so this is a static-type narrowing only. Rewriting the local
// type to the narrow union is out of scope here because the change
// cascades across every handler.
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
// Advisory dispatch deferred. The earlier in-process
// invocation via invokePrimitive + createInProcessPrimitiveTransport is no
// longer wired (agent_run queues asynchronously and cannot return helper
// findings inline). The imports are removed until a future phase wires a
// synchronous helper-execution surface.

// ---------------------------------------------------------------------------
// Resolve Better Auth session role hints once per MCP handler invocation and
// forward them into the auth-policy bridge.
//
// Without this, `actor.platformRole` is `undefined` for every MCP-routed
// actor. The auth kernel can only grant `platform_admin` when
// `actor.platformRole === "platform_admin"`, so admin users get denied at
// the kernel boundary on every non-owned run, and `policyAllows` cannot
// apply admin-bypass either.
//
// Returns `undefined` when there is no Better Auth session — the actor was
// constructed by a non-UI caller (worker, scheduler, A2A) and the bridge
// should not synthesize role hints from a missing session. The kernel
// continues to apply its existing role-resolution rules (org membership
// lookup, etc.) without role hints.
//
// Same comma-split pattern as `requireAdminSession` and
// `src/lib/authz/enforce.ts:buildActorContext` so behavior stays uniform
// across the auth surface.
// ---------------------------------------------------------------------------
// DRY denial-response helper.
// Maps AuthzError.reason → a safe external error string.
//   reason==="hidden" → "{hiddenLabel}" (does not leak existence)
//   reason!=="hidden" → "Run access denied."
// ---------------------------------------------------------------------------
function authzErrorToResponse(err: AuthzError, hiddenLabel: string): { error: string } {
  return { error: err.reason === "hidden" ? hiddenLabel : "Run access denied." };
}

// ---------------------------------------------------------------------------
// Read-path denial audit helper.
// Called inside every AuthzError catch on the read primitives (run_get,
// run_list per-row, run_messages_list) so every access denial produces an
// audit_events row with decision:"denied" and operation:"read".
// ---------------------------------------------------------------------------
function emitReadDenialAudit(actor: PrimitiveActorContext, resourceId: string | undefined): void {
  void logAuditEvent({
    actorPrincipalId: actor.userId,
    actorPrincipalType: (actor.actorType as AuditEventInput["actorPrincipalType"]) ?? "human",
    authSource: (actor.source as AuditEventInput["authSource"]) ?? "mcp",
    resourceType: "agent_run",
    resourceId,
    operation: "read",
    decision: "denied",
    policyVersion: POLICY_VERSION,
  });
}

// ---------------------------------------------------------------------------
// WayFlow callback actor resolution.
// Returns true when the actor came from a client_credentials JWT: actorType
// is "a2a" AND userId is absent or does not correspond to a human user row
// in the Better Auth users table (it is a service-principal / clientId-derived
// id with no matching row). Used to substitute run.runBy as effective subject.
// ---------------------------------------------------------------------------
/**
 * Always await this function — it returns
 * Promise<boolean>. A forgotten await yields a truthy Promise object and
 * silently substitutes run.runBy as the effective actor for every caller.
 *
 * DB hit is guarded by the actorType !== "a2a" early return so human and
 * model actors incur no DB lookup.
 */
async function isA2aServiceIdentity(actor: PrimitiveActorContext): Promise<boolean> {
  if (actor.actorType !== "a2a") return false;
  if (!actor.userId) return true; // no userId = service identity
  const userRow = await readUserById(actor.userId);
  return userRow == null;
}

// ---------------------------------------------------------------------------
async function resolveRoleHintsFromSession(): Promise<ActorRoleHints | undefined> {
  try {
    const session = await getAuthSession();
    if (!session) return undefined;
    const userId = session.user?.id ?? null;
    const orgId = session.session?.activeOrganizationId ?? null;
    // Resolve team + project membership for the
    // session user so the kernel ActorContext's `teamIds` / `projectIds`
    // are populated. Without this, policyAllows' `team:<id>` /
    // `project:<id>` branches always evaluate false and silently deny
    // every legitimate team/project member. Lookups are skipped when the
    // session lacks a userId or orgId (returning [] preserves the
    // legacy deny-by-omission behavior). Drizzle errors fall back
    // to undefined via the outer catch.
    // route project resolution through the canonical
    // resolver (owned ∪ accessed, role-by-authority, active-org-anchored).
    // teamRoles is unavailable (no role column on public."teamMember") so
    // team-owned implicit grants degrade to {read, team} — safe.
    const teamIds = userId && orgId
      ? (await readTeamsForUser(userId, orgId)).map((t) => t.id)
      : [];
    const projectGrants = userId && orgId
      ? await readProjectGrantsForUser(userId, orgId, { teamIds })
      : [];
    return {
      platformRole: isPlatformAdmin(session) ? "platform_admin" : "member",
      actorOrganizationId: orgId,
      teamIds,
      projectGrants,
    };
  } catch {
    // Better Auth lookup failure: fail open at the role-hints layer (the
    // kernel will still deny without admin role) rather than poisoning every
    // MCP call with an unrecoverable error. Caller continues without hints.
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// resolve the active org id from the session at request
// time so READ handlers can pass it to store options. Returns undefined when
// the session is missing or has no active org. Caller is responsible for the
// 403 when undefined is returned for a non-admin actor.
//
// The `?? undefined` coercion is mandatory — Better Auth's session shape
// returns `string | null | undefined`. Passing `null` to Drizzle's `eq()`
// Passing null builds `WHERE org_id = NULL`, which is never
// true and silently returns the empty list to the user with no signal that
// auth failed. Coercing to undefined makes the handler-side guard fire
// instead.
//
// orgId is required at insert time. resolveOrgIdFromSession
// still returns undefined when no session/no org; the WRITE handlers
// (agent_run) hard-fail before the insert in that case. The handler-level
// guard narrows organizationId to `string` for the createAgentRun call.
// ---------------------------------------------------------------------------
async function resolveOrgIdFromSession(
  /**
   * the in-process primitive actor envelope. For delegated /
   * cookieless hosted MCP (chat → OpenAI relay → /api/mcp under the chat
   * user's OBO token) there is NO Better Auth cookie session, but the MCP
   * transport stamped the delegated user's `orgId` onto the actor (see
   * packages/agents/src/mcp/registry.ts buildActorFromMcpContext). Prefer
   * that authoritative, transport-verified org BEFORE the session lookup so
   * `agent_run` doesn't hard-fail with "Active organization required."
   * The envelope is server-only and unforgeable.
   */
  actor?: { orgId?: string | null } | null | undefined,
): Promise<string | undefined> {
  try {
    const actorOrgId = actor?.orgId;
    if (typeof actorOrgId === "string" && actorOrgId.length > 0) {
      return actorOrgId;
    }
    const session = await getAuthSession();
    if (session) return session.session?.activeOrganizationId ?? undefined;
    // Dev-bypass: no browser session (e.g. Claude Code MCP calls from localhost).
    // Mirror the MCP transport layer fallback (packages/mcp-server/src/index.tsx ~L963)
    // — resolve to the first org in DB so handler-level org guards don't fire on
    // sessionless localhost requests. Admin status is intentionally NOT elevated here;
    // only resolveIsPlatformAdminFromSession() can grant admin, and only via a real session.
    if (process.env.A2A_DEV_BYPASS === "true") {
      return (await resolveDefaultOrgId()) ?? undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// resolve isPlatformAdmin from the session at request
// time. Tolerant of session-resolution failure (returns false) so that
// non-UI callers — e.g. workers, scheduler, the
// handlers-auth-policy.test.ts harness which does not mock `headers()` —
// don't crash the handler. Callers pair this with `resolveOrgIdFromSession`
// to decide on the 403-on-missing-org guard.
// ---------------------------------------------------------------------------
async function resolveIsPlatformAdminFromSession(
  /**
   * Optional actor envelope from the in-process primitive request. When the
   * upstream caller (route handler, MCP transport bridge) has already
   * verified the session and stamped `platformRole: "platform_admin"` on
   * the actor, that hint is authoritative — every primitive caller is a
   * trusted server-only path, so the envelope cannot be forged. We honour
   * it here so handlers don't need to re-read cookies (which the
   * streaming-response context can detach mid-flight).
   */
  actor?: { platformRole?: string } | null | undefined,
): Promise<boolean> {
  if (actor && actor.platformRole === "platform_admin") {
    return true;
  }
  try {
    const session = await getAuthSession();
    return session ? isPlatformAdmin(session) : false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Request envelope type — matches the pattern used by all cinatra MCP handlers
// ---------------------------------------------------------------------------

type PrimitiveRequest<T = Record<string, unknown>> = {
  primitiveName: string;
  input: T;
  actor: { actorType: string; source: string; userId?: string; clientId?: string };
  mode: string;
};

// ---------------------------------------------------------------------------
// agent_compile
// ---------------------------------------------------------------------------

async function handleAgentBuilderCompile(
  request: PrimitiveRequest<{
    sourceNl?: string;
    executionProvider?: "wayflow"; // LangGraph retired; only "wayflow" accepted
  }>,
): Promise<unknown> {
  const { sourceNl, executionProvider } = request.input;
  if (!sourceNl || typeof sourceNl !== "string") {
    return { error: "sourceNl is required." };
  }

  // LangGraph retired; only "wayflow" accepted (omitted defaults to "wayflow").
  if (executionProvider !== undefined && executionProvider !== "wayflow") {
    return {
      error: `Invalid executionProvider: ${executionProvider}. Must be "wayflow".`,
    };
  }

  try {
    const allHandlers = await collectAllPrimitiveHandlers();
    const primitiveToolNames = Object.keys(allHandlers);
    // Best-effort: append external MCP tool names. Failures are logged and skipped
    // inside fetchExternalMcpToolNames — they never block compilation.
    const { fetchExternalMcpToolNames } = await import("../external-mcp-caller");
    const externalToolNames = await fetchExternalMcpToolNames();
    const toolNames = [...primitiveToolNames, ...externalToolNames];
    const result = await compileWorkflow(sourceNl, toolNames, {
      executionProvider: executionProvider ?? "wayflow",
    });

    // compileWorkflow returns a single agentic result.
    // No narrowing needed — the fields below are always present.
    return {
      type: result.type,
      mode: result.mode,
      taskSpec: result.taskSpec,
      inputSchema: result.inputSchema,
      outputSchema: result.outputSchema,
      inputSpec: result.inputSpec,
      outputSpec: result.outputSpec,
    };
  } catch (err) {
    // Catches both LLM errors and the post-generation validation errors from
    // compileAgenticWorkflow (throws on too-short or ungrounded specs per validation rules).
    const message = err instanceof Error ? err.message : String(err);
    // Enrich compile errors with LLM-actionable hints
    let hint = "";
    if (message.includes("too short")) {
      hint = " Hint: retry compile with a more detailed sourceNl that describes what the agent does, what inputs it takes, and what it should produce.";
    } else if (message.includes("ungrounded")) {
      hint = " Hint: if the agent uses Cinatra tools, retry with a sourceNl that mentions the specific tool family (e.g. 'use scrape_source_* tools'). If the agent is self-contained (no Cinatra tools), this error should not occur — retry once with the same input.";
    } else if (message.includes("invalid 'type' value")) {
      hint = " Hint: the compiler produced an unrecognised agent type. Retry once with the same sourceNl.";
    }
    return { error: `Compile failed: ${message}${hint}` };
  }
}

// ---------------------------------------------------------------------------
// agent_save
// ---------------------------------------------------------------------------

async function handleAgentBuilderSave(
  request: PrimitiveRequest<{
    name?: string;
    description?: string;
    sourceNl?: string;
    compiledPlan?: string;
    inputSchema?: string;
    outputSchema?: string;
    approvalPolicy?: string;
    taskSpec?: string;
    type?: "leaf" | "proxy" | "orchestrator" | "parallel" | "supervisor" | "iterative" | "flow" | "node";
  }>,
): Promise<unknown> {
  const { name, description, sourceNl, compiledPlan, inputSchema, outputSchema, approvalPolicy, taskSpec, type } = request.input;

  if (!name || typeof name !== "string") return { error: "name is required." };
  if (!sourceNl || typeof sourceNl !== "string") return { error: "sourceNl is required." };
  if (!inputSchema || typeof inputSchema !== "string") return { error: "inputSchema is required." };

  // All templates are agentic. taskSpec is required.
  if (!taskSpec || typeof taskSpec !== "string" || taskSpec.trim().length < 20) {
    return { error: "taskSpec is required and must be at least 20 characters." };
  }

  let compiledPlanParsed: unknown;
  let inputSchemaParsed: Record<string, unknown>;
  let outputSchemaParsed: Record<string, unknown> | undefined;
  let approvalPolicyParsed: { steps: Array<{ stepNumber: number; riskClass: string; requiresApproval: boolean }> };

  try {
    compiledPlanParsed = compiledPlan ? JSON.parse(compiledPlan) : [];
    inputSchemaParsed = JSON.parse(inputSchema) as Record<string, unknown>;
    outputSchemaParsed = outputSchema ? (JSON.parse(outputSchema) as Record<string, unknown>) : undefined;
    approvalPolicyParsed = approvalPolicy
      ? (JSON.parse(approvalPolicy) as typeof approvalPolicyParsed)
      : { steps: [] };
  } catch (err) {
    return { error: `JSON parse error: ${err instanceof Error ? err.message : String(err)} Hint: inputSchema, outputSchema, compiledPlan, and approvalPolicy must be JSON strings (use JSON.stringify before passing them). compiledPlan should be the string "[]" when not applicable.` };
  }

  const templateId = randomUUID();
  const versionId = randomUUID();
  const contentHash = createHash("sha256").update(compiledPlan ?? taskSpec ?? sourceNl).digest("hex");
  const orgId = await resolveDefaultOrgId();

  // Thread the actor user id into createAgentTemplate so
  // derivePackageName produces `@user-<actualUserId>/...` instead of falling
  // back to "unknown" for every MCP-saved template (which would otherwise
  // collide globally on duplicate names).
  const actorUserId =
    typeof request.actor?.userId === "string" && request.actor.userId.trim().length > 0
      ? request.actor.userId
      : undefined;

  try {
    const template = await createAgentTemplate({
      id: templateId,
      orgId: orgId ?? undefined,
      creatorId: actorUserId,
      name,
      description,
      sourceNl,
      compiledPlan: compiledPlanParsed as Parameters<typeof createAgentTemplate>[0]["compiledPlan"],
      inputSchema: inputSchemaParsed,
      outputSchema: outputSchemaParsed,
      approvalPolicy: approvalPolicyParsed,
      taskSpec: taskSpec ?? null,
      type,
    });

    // Route agent-template persistence through the
    // Objects Layer at the MCP-handler boundary so the template lands in Graphiti
    // (classifier → identity resolver → Graphiti write → shadow-write).
    // Placement note: the call lives here, not in store.ts:createAgentTemplate,
    // so it stays observable when tests mock the entire ../src/store module
    // (see packages/agents/tests/mcp-handlers.test.ts).
    try {
      // PrimitiveActorContext requires narrow union types for actorType/source
      // and forbids null userId; the request.actor envelope here uses loose
      // strings, so build the actor dynamically and cast at the boundary.
      // The orgId field is the unsafe-cast extension pattern (Pattern B from
      // the existing extension pattern) — PrimitiveActorContext does not
      // declare orgId yet; the consumer reads it via getActorExt in
      // packages/objects/src/mcp/handlers.ts:41-50.
      const actorBase: Record<string, unknown> = {
        actorType: request.actor?.actorType ?? "system",
        source: request.actor?.source ?? "route",
        orgId: (request.actor as { orgId?: string | null })?.orgId ?? template.orgId ?? null,
      };
      const resolvedUserId = request.actor?.userId ?? template.creatorId ?? undefined;
      if (resolvedUserId) actorBase.userId = resolvedUserId;
      const objectsClient = createDeterministicObjectsClient({
        actor: actorBase as unknown as Parameters<typeof createDeterministicObjectsClient>[0]["actor"],
      });
      await objectsClient.save({
        typeHint: "@cinatra-ai/agent-builder:agent-template",
        rawData: {
          ...template,
          createdAt: template.createdAt.toISOString(),
          updatedAt: template.updatedAt.toISOString(),
        },
      });
    } catch (err) {
      // Mirror the fire-and-forget semantics of the legacy shadowUpsertObject
      // path — do not roll back the Drizzle insert when the Objects Layer
      // write fails. Log so operators can investigate.
      // eslint-disable-next-line no-console
      console.warn("[agents] objectsClient.save failed in handleAgentBuilderSave:", err);
    }

    void logAuditEvent({
      actorPrincipalId: request.actor?.userId,
      actorPrincipalType: (request.actor?.actorType as AuditEventInput["actorPrincipalType"]) ?? "human",
      authSource: (request.actor?.source as AuditEventInput["authSource"]) ?? "mcp",
      resourceType: "agent_template",
      resourceId: template.id,
      operation: "create",
      decision: "allowed",
      policyVersion: POLICY_VERSION,
      runId: undefined,
    });

    const version = await createAgentVersion({
      id: versionId,
      templateId,
      contentHash,
      snapshot: {
        compiledPlan: compiledPlanParsed,
        inputSchema: inputSchemaParsed,
        outputSchema: outputSchemaParsed ?? null,
        approvalPolicy: approvalPolicyParsed,
      },
    });

    await createAgentTemplateVersionIfChanged(template, {
      changelogLine: "Initial save",
      bumpTypeOverride: "patch",
      createdBy: request.actor?.userId ?? null,
    });

    // Queue an inline re-evaluation against this newly-saved agent.
    //
    // when `template.packageName` is
    // null/empty (legacy templates predating the packageName
    // backfill, or rows created via paths that don't populate it), do NOT
    // silently fall back to `template.id` (a UUID). The matcher keys the
    // catalog on the canonical `@vendor/name` packageId — falling back to
    // the UUID enqueues a job that runs, finds no matching catalog entry
    // (`agents.find(a => a.packageId === uuid)` returns undefined), returns
    // empty, writes no rows, and SURFACES NO ERROR. Admins see no match
    // rows for the agent and have no signal why.
    //
    // The correct behavior is to emit a structured warning and skip the
    // enqueue. Skill matching will fan in via the inline-for-skill side
    // when a skill is installed, or via the next batch run if the admin
    // backfills the packageName. Failures of the enqueue itself MUST NOT
    // abort the save — log and continue.
    if (!template.packageName) {
      console.warn(
        JSON.stringify({
          event: "skill_match_inline_skipped_legacy_template",
          templateId: template.id,
          reason: "no_packageName",
          context: "agent_save",
        }),
);
    } else {
      try {
        await enqueueInlineForAgent(template.packageName);
      } catch (err) {
        console.warn(
          `[agents/mcp] enqueueInlineForAgent failed for ${template.packageName}:`,
          err instanceof Error ? err.message : err,
);
      }
    }

    return {
      templateId: template.id,
      versionId: version.id,
      detailPath: `/agents/builder/${template.id}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Save failed: ${message}` };
  }
}

// ---------------------------------------------------------------------------
// agent_run
// ---------------------------------------------------------------------------

async function handleAgentBuilderRun(
  request: PrimitiveRequest<{
    templateId?: string;
    packageName?: string;
    inputParams?: string;
    timeoutSeconds?: number;
  }>,
): Promise<unknown> {
  const { templateId, packageName, inputParams, timeoutSeconds } = request.input;

  // XOR templateId/packageName. Either identifies the
  // same template, but accepting both silently risks running the wrong agent
  // if they disagree, and lets clients learn a sloppy contract if they agree.
  const hasTemplateId = typeof templateId === "string" && templateId.length > 0;
  const hasPackageName = typeof packageName === "string" && packageName.length > 0;
  if (hasTemplateId && hasPackageName) {
    return { error: "Pass exactly one of templateId or packageName to agent_run." };
  }
  if (!hasTemplateId && !hasPackageName) {
    return { error: "Pass exactly one of templateId or packageName to agent_run." };
  }

  let inputParamsParsed: Record<string, unknown> = {};
  if (inputParams && typeof inputParams === "string") {
    try {
      inputParamsParsed = JSON.parse(inputParams) as Record<string, unknown>;
    } catch {
      return { error: "inputParams must be a valid JSON string." };
    }
  }

  // 24h matches the wayflow ApiNode/A2A batch-LLM SLA ceiling
  // (docker/wayflow/agent_loader.py). The prior 1800s (30m) cap was set
  // when typical runs were synchronous chat sessions; batch LLM agents
  // and long web_search ApiNode calls exceed that.
  // (prior `typeof === "number"` accepted floats despite the error
  // message saying "integer").
  if (
    timeoutSeconds !== undefined &&
    (!Number.isInteger(timeoutSeconds) ||
      timeoutSeconds < 1 ||
      timeoutSeconds > AGENT_RUN_TIMEOUT_MAX_SECONDS)
) {
    return {
      error: `timeoutSeconds must be an integer between 1 and ${AGENT_RUN_TIMEOUT_MAX_SECONDS} (24h).`,
    };
  }

  const runId = randomUUID();

  const organizationId = await resolveOrgIdFromSession(
    request.actor as { orgId?: string | null } | undefined,
);
  const isAdmin = await resolveIsPlatformAdminFromSession(request.actor as { platformRole?: string } | undefined);
  // hard-fail before any insert when no orgId is resolvable,
  // regardless of admin status. agent_runs.org_id is becoming NOT NULL and
  // even platform admins must operate inside some org context for run
  // creation. The skipOrgFilter pattern remains for READ handlers only.
  if (!organizationId) {
    return { error: "Active organization required." };
  }

  // owner-only execute gate. Load template, synthesise a
  // probe run from the actor + template policy, call the kernel BEFORE any
  // write. AuthzError is caught below and converted into an error response.
  //
  // resolve template via templateId UUID OR
  // packageName lookup. PackageName path includes a NARROW alias fallback:
  // if the caller passes an operator-vendor-scoped name (e.g.
  // `@<instance>/<slug>`) that doesn't exist in agent_templates but the
  // current instance's vendor matches, retry the lookup under the
  // canonical `@cinatra-ai/<slug>` scope. This bridges the Verdaccio/DB
  // scope split (publish-time rescope; DB still keys on the authored
  // `@cinatra-ai/` name for in-repo agents). Strict equality first;
  // arbitrary third-party scopes are NOT collapsed to `@cinatra-ai/`.
  let template: AgentTemplateRecord | null = null;
  let identifierForError = "";
  if (hasTemplateId) {
    identifierForError = templateId as string;
    template = await readAgentTemplateById(templateId as string);
  } else {
    const requested = packageName as string;
    identifierForError = requested;
    template = await readAgentTemplateByPackageName(requested);
    if (!template) {
      const fallback = aliasPackageNameToCanonicalScope(requested);
      if (fallback && fallback !== requested) {
        const aliased = await readAgentTemplateByPackageName(fallback);
        if (aliased) {
          template = aliased;
          // Diagnostic — chat assistant + operators can see which alias hit.
          console.info(
            `[agent_run] resolved packageName "${requested}" via alias "${fallback}" → template ${aliased.id}`,
);
        }
      }
    }
  }
  if (!template) return { error: `Template not found: ${identifierForError}` };
  // Resolved templateId is what every downstream code path expects.
  const resolvedTemplateId = template.id;

  const actor = request.actor as PrimitiveActorContext;
  const roles = await resolveRoleHintsFromSession();
  const probeRun = {
    id: "probe",
    runBy: actor.userId ?? null,
    orgId: organizationId,
    authPolicy: template.agentAuthPolicy ?? null,
    effectivePolicy: template.agentAuthPolicy ?? null,
    coOwnerUserIds: [] as string[],
  };
  try {
    await enforceRunAccess(probeRun, actor, "execute", roles);

    // Full project binding via the canonical `requireAccess` primitive
    // (replaces the prior inline grant check). The synthetic-probe above
    // still enforces the template-level execute power (run.authPolicy);
    // this check binds the
    // run to the target project AND emits a structured audit event on deny.
    //
    // The contract specifies "explicit grant for the template AND for the
    // target project". The template grant is enforced by the probeRun
    // path immediately above; the project grant is enforced here.
    const probeProjectContext = mcpRequestContextStorage.getStore()?.projectContext;
    const probeProjectId = probeProjectContext?.projectId;
    if (probeProjectId && actor.platformRole !== "platform_admin") {
      const { requireAccess } = await import("@/lib/authz/require-access");
      const synthActor = {
        principalType: "HumanUser" as const,
        principalId: actor.userId ?? "anonymous",
        authSource: ((actor.source as string) ?? "mcp") as "mcp",
        policyVersion: POLICY_VERSION,
        organizationId,
        orgRole: (actor as { orgRole?: "org_owner" | "org_admin" | "member" }).orgRole,
        platformRole: (actor as { platformRole?: "platform_admin" | "member" }).platformRole,
        teamIds: (actor as { teamIds?: string[] }).teamIds ?? [],
        projectGrants: (actor as { projectGrants?: unknown[] }).projectGrants ?? [],
        projectIds: (actor as { projectIds?: string[] }).projectIds ?? [],
        roles: (actor as { roles?: string[] }).roles ?? [],
      };
      try {
        await requireAccess(
          synthActor as unknown as Parameters<typeof requireAccess>[0],
          {
            resourceType: "agent_run",
            resourceId: runId,
            organizationId,
            ownerType: "user",
            ownerId: actor.userId ?? "anonymous",
          },
          "create",
          {
            requireProjectGrant: probeProjectId,
            primitiveName: "agent_run",
          },
);
      } catch {
        // requireAccess throws AuthzError + already emitted audit event.
        return { error: "Missing project_access grant for project context." };
      }
    }
  } catch (executeErr) {
    if (executeErr instanceof AuthzError) {
      // ADDITIVE project-scoped agent
      // access. Ownership-based execute was denied; before failing, check
      // whether the caller reaches this agent template via a project_access
      // grant on a project the template is bound to (project_agent_template_
      // bindings). This NEVER removes owner access — it only adds a grant
      // source. Requires write+ on the bound project for execute.
      let projectGranted = false;
      try {
        const grants = (actor as { projectGrants?: { projectId: string; effectiveRole: "read" | "write" | "admin" | "owner"; accessSource: string }[] }).projectGrants ?? [];
        if (grants.length > 0 && actor.platformRole !== "platform_admin") {
          const { resolveAgentProjectAccess } = await import("@/lib/authz/agent-project-access");
          const decision = await resolveAgentProjectAccess(resolvedTemplateId, { projectGrants: grants }, { minRole: "write" });
          if (decision.granted) {
            projectGranted = true;
            void logAuditEvent({
              actorPrincipalId: actor.userId,
              actorPrincipalType: (actor.actorType as AuditEventInput["actorPrincipalType"]) ?? "human",
              authSource: (actor.source as AuditEventInput["authSource"]) ?? "mcp",
              resourceType: "agent_run",
              resourceId: undefined,
              operation: "create",
              decision: "allowed",
              policyVersion: POLICY_VERSION,
              metadata: { via: "project_access", projectId: decision.viaProjectId, role: decision.role },
            });
          }
        }
      } catch {
        projectGranted = false;
      }
      if (!projectGranted) {
        void logAuditEvent({
          actorPrincipalId: actor.userId,
          actorPrincipalType: (actor.actorType as AuditEventInput["actorPrincipalType"]) ?? "human",
          authSource: (actor.source as AuditEventInput["authSource"]) ?? "mcp",
          resourceType: "agent_run",
          resourceId: undefined,
          operation: "create",
          decision: "denied",
          policyVersion: POLICY_VERSION,
        });
        return authzErrorToResponse(executeErr, `Template not found: ${identifierForError}`);
      }
    } else {
      throw executeErr;
    }
  }

  // Preflight WayFlow agent-card registration before enqueueing. If the
  // runtime hasn't loaded this freshly published package, return the
  // structured error immediately so the chat assistant can surface it
  // instead of dispatching a job that will fail with a generic 404 ~60s
  // later. We gate on `sourceType !== "external"` because external A2A
  // agents don't go through the local WayFlow runtime —
  // their dispatch path is the external client, not the agent-card proxy.
  // `executionProvider` is too narrow (legacy/default rows may dispatch
  // to WayFlow without "wayflow" set explicitly). See wayflow-preflight.ts
  // for the OK | NOT_REGISTERED | NOT_CONFIGURED | UNAVAILABLE semantics.
  if (template.sourceType !== "external" && template.packageName) {
    const preflight = await preflightWayflowAgent(template.packageName);
    if (
      preflight.code === "WAYFLOW_AGENT_NOT_REGISTERED" ||
      preflight.code === "WAYFLOW_NOT_CONFIGURED"
) {
      return preflight;
    }
    // OK | PREFLIGHT_UNAVAILABLE → proceed; the BullMQ worker handles
    // transient runtime issues via its own error path.
  }

  // Resolve the latest version snapshot so the run is pinned to it.
  const versions = await readAgentVersionsByTemplate(resolvedTemplateId);
  const latestVersionId = versions[0]?.id;

  // read the chat-side projectContext frame
  // (transport-boundary set by the chat surface for project-scoped chats;
  // undefined for ambient/no-project chats). Pass-through to createAgentRun
  // so the agent_runs row gets tagged at insert. The run-worker then reads
  // `run.projectId` and re-establishes the frame for the execution body
  // (Project-context propagation), which is what every artifact/object write actually
  // reads via mcpRequestContextStorage.
  const projectContext = mcpRequestContextStorage.getStore()?.projectContext;
  const projectIdForRun = projectContext?.projectId ?? null;

  // capture the requesting user's
  // ActorContext-shaped identity so the run-worker can replay it at
  // re-authorization time (and the mid-run revocation check can detect
  // grants pulled between instantiate and start). HumanUser only —
  // synthetic/system actors fall back to live-session derivation per
  // the legacy worker path.
  let delegatedActorSnapshotJson: string | null = null;
  try {
    const { captureDelegatedActorSnapshot } = await import("@/lib/authz/delegated-agent-run");
    const synth = {
      principalType: "HumanUser" as const,
      principalId: actor.userId ?? "anonymous",
      authSource: ((actor.source as string) ?? "mcp") as "mcp",
      policyVersion: POLICY_VERSION,
      organizationId,
      orgRole: (actor as { orgRole?: "org_owner" | "org_admin" | "member" }).orgRole,
      platformRole: (actor as { platformRole?: "platform_admin" | "member" }).platformRole,
      teamIds: (actor as { teamIds?: string[] }).teamIds ?? [],
      projectGrants: (actor as { projectGrants?: unknown[] }).projectGrants as never,
      projectIds: (actor as { projectIds?: string[] }).projectIds ?? [],
      roles: (actor as { roles?: string[] }).roles ?? [],
    };
    const snap = captureDelegatedActorSnapshot(synth as unknown as Parameters<typeof captureDelegatedActorSnapshot>[0]);
    if (snap) delegatedActorSnapshotJson = JSON.stringify(snap);
  } catch (err) {
    // Snapshot capture must never block run creation. Log + continue.
    console.warn("[agent_run] delegated actor snapshot capture failed:", err);
  }

  try {
    const run = await createAgentRun({
      id: runId,
      templateId: resolvedTemplateId,
      versionId: latestVersionId,
      inputParams: inputParamsParsed,
      timeoutSeconds: timeoutSeconds ?? null,
      runBy: request.actor?.userId,
      orgId: organizationId,
      projectId: projectIdForRun,
      delegatedActorSnapshot: delegatedActorSnapshotJson,
    });

    await enqueueAgentRun({ runId }, {
      connectorDependencies: template?.connectorDependencies,
    });

    void logAuditEvent({
      actorPrincipalId: request.actor?.userId,
      actorPrincipalType: (request.actor?.actorType as AuditEventInput["actorPrincipalType"]) ?? "human",
      authSource: (request.actor?.source as AuditEventInput["authSource"]) ?? "mcp",
      resourceType: "agent_run",
      resourceId: run.id,
      operation: "create",
      decision: "allowed",
      policyVersion: POLICY_VERSION,
      runId: run.id,
    });

    return { runId: run.id, status: "queued" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Run failed: ${message}` };
  }
}

// ---------------------------------------------------------------------------
// agent_list
// ---------------------------------------------------------------------------

async function handleAgentBuilderList(
  request: PrimitiveRequest<{ query?: string; status?: string; limit?: number; cursor?: string; packageName?: string }>,
): Promise<unknown> {
  try {
    // Removed tautological `if (getActorContext()) getActorContextOrThrow()`
    // pattern (no-op gate). LLM-reachable paths are now fail-closed at the
    // orchestration entry points (requireActorFrame in
    // packages/llm/src/index.ts). Legacy session-based callers
    // (UI server actions, route handlers) are gated by resolveOrgIdFromSession
    // and resolveIsPlatformAdminFromSession below — that is the authoritative
    // gate for non-LLM call sites.
    const { query, status, limit, cursor, packageName } = request.input ?? {};
    const offset = decodeCursor(cursor);

    // scope reads to session.activeOrganizationId.
    // Non-admin actors without an active org are denied at the handler
    // boundary (before any store call) — this is where the SQL filter from
    // the org-scope guard becomes enforced.
    const organizationId = await resolveOrgIdFromSession(
      request.actor as { orgId?: string | null } | undefined,
);
    const isAdmin = await resolveIsPlatformAdminFromSession(request.actor as { platformRole?: string } | undefined);
    if (!organizationId && !isAdmin) {
      throw new AuthzError({
        statusCode: 403,
        reason: "forbidden",
        message: "Active organization required.",
      });
    }

    const result = await readAgentTemplates({
      query,
      status,
      limit,
      offset,
      packageName,
      organizationId: isAdmin && !organizationId ? undefined : organizationId,
      /* @admin-cross-org */ // admin without an active org reads all orgs.
      skipOrgFilter: isAdmin && !organizationId,
    });
    return buildListPage(
      result.items.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        status: t.status,
        packageName: t.packageName ?? null,
        createdAt: t.createdAt,
      })),
      result.total,
      offset,
      limit ?? 50,
);
  } catch (err) {
    // collapse AuthzError to spec'd surface error.
    if (err instanceof AuthzError) {
      return {
        error: err.reason === "hidden" ? "Not available." : "Access denied.",
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { error: `List failed: ${message}` };
  }
}

// ---------------------------------------------------------------------------
// agent_get
// ---------------------------------------------------------------------------

async function handleAgentBuilderGet(
  request: PrimitiveRequest<{ templateId?: string }>,
): Promise<unknown> {
  // see handleAgentBuilderList for rationale; LLM frame
  // requirement is enforced at orchestration entry.
  const { templateId } = request.input;
  if (!templateId || typeof templateId !== "string") return { error: "templateId is required." };
  try {
    const template = await readAgentTemplateById(templateId);
    if (!template) return { error: `Template not found: ${templateId}` };
    return template;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Get failed: ${message}` };
  }
}

// ---------------------------------------------------------------------------
// agent_run_get
// ---------------------------------------------------------------------------

async function handleAgentBuilderRunGet(
  request: PrimitiveRequest<{ runId?: string }>,
): Promise<unknown> {
  // see handleAgentBuilderList for rationale; LLM frame
  // requirement is enforced at orchestration entry.
  const { runId } = request.input;
  if (!runId || typeof runId !== "string") return { error: "runId is required." };
  try {
    // scope reads to session.activeOrganizationId.
    // Non-admin actors without an active org are denied at the handler
    // boundary. The kernel cross-org guard inside enforceRunAccess
    // (the org-scope guard) is the SECOND line of defence on the run row itself.
    const organizationId = await resolveOrgIdFromSession(
      request.actor as { orgId?: string | null } | undefined,
);
    const isAdmin = await resolveIsPlatformAdminFromSession(request.actor as { platformRole?: string } | undefined);
    if (!organizationId && !isAdmin) {
      throw new AuthzError({
        statusCode: 403,
        reason: "forbidden",
        message: "Active organization required.",
      });
    }

    // passing actor causes readAgentRunById to call enforceRunAccess.
    // Cast bridges loose local PrimitiveRequest.actor to the narrow
    // PrimitiveActorContext. AuthzError(403/404) propagates through the catch.
    // resolve role hints from the Better Auth session
    // and forward into readAgentRunById so admin users are recognized at the
    // kernel boundary.
    const actor = request.actor as PrimitiveActorContext;
    const roles = await resolveRoleHintsFromSession();
    const run = await readAgentRunById(runId, actor, roles);
    if (!run) return { error: `Run not found: ${runId}` };
    return run;
  } catch (err) {
    // branch on AuthzError so 404 hidden ("don't leak existence")
    // and 403 forbidden produce indistinguishable error messages externally.
    // Without this branch, the kernel's hidden semantic was leaking via the
    // distinct "Run access denied." vs "Not found." strings.
    if (err instanceof AuthzError) {
      // emit denial audit regardless of surface message
      // (hidden-policy maps to "Run not found:" but the denied decision is
      // always logged so the audit trail is complete).
      emitReadDenialAudit(request.actor as PrimitiveActorContext, runId);
      return authzErrorToResponse(err, `Run not found: ${runId}`);
    }
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Run get failed: ${message}` };
  }
}

// ---------------------------------------------------------------------------
// agent_run_update — project move semantics
// ---------------------------------------------------------------------------
//
// The only currently-mutable field is `projectId`. Other run-state mutations
// (status, errors, etc.) flow through `transitionRunStatus` (the single
// canonical entry point), not this handler. Widening would require its own
// explicit change.
//
// Authz contract:
//   - source: caller must hold `execute` on the run via enforceRunAccess.
//   - target: caller must hold `write` on the new project AND the new
//     project must NOT be archived (assertProjectWritable). Skipped when
//     moving OUT of a project (newProjectId === null).
//
// Active-run protection:
//   - Reject when status NOT IN {queued, completed, failed, stopped}.
//     Active states (running / pending_approval / pending_input / armed /
//     pending_trigger / waiting_trigger) MUST settle before a move so the
//     run-worker's projectContext frame can't be invalidated mid-run.
// ---------------------------------------------------------------------------

// agent_runs.status values that allow a project move.
// Mirrors the AgentRunStatus enum in packages/agents/src/store.ts:1378.
// "queued" is included because it is pre-dispatch (BullMQ has not started
// the worker yet — the projectContext frame is read at worker entry, so a
// move BEFORE dispatch is safe). The 3 terminal states (completed / failed /
// stopped) are obvious — the worker has exited and no future writes can
// happen.
const MOVABLE_AGENT_RUN_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "completed",
  "failed",
  "stopped",
]);

async function handleAgentBuilderRunUpdate(
  request: PrimitiveRequest<{
    runId?: string;
    projectId?: string | null;
    reason?: string;
  }>,
): Promise<unknown> {
  const { runId, projectId, reason } = request.input;
  if (!runId || typeof runId !== "string") return { error: "runId is required." };

  // Schema contract: callers must pass `projectId` (even as null) to invoke
  // a move. Omitting `projectId` is a no-op today (no other mutable fields).
  if (projectId === undefined) {
    return { ok: true as const, noop: true as const };
  }

  try {
    const actor = request.actor as PrimitiveActorContext;
    const roles = await resolveRoleHintsFromSession();

    // Load the run with enforceRunAccess("execute") — owner / co-owner /
    // admin all permitted (the established RunAccessOperation tier).
    // readAgentRunById(actor, roles) returns null for hidden/cross-tenant
    // rows; enforceRunAccess inside the call throws AuthzError → caught
    // below and surfaced as 404-hidden.
    const run = await readAgentRunById(runId, actor, roles);
    if (!run) return { error: `Run not found: ${runId}` };

    // Reload with "execute" enforcement (readAgentRunById uses "read"
    // by default). Mutation requires execute.
    await enforceRunAccess(
      { ...run, coOwnerUserIds: undefined },
      actor,
      "execute",
      roles,
);

    // Active-run — active-run protection.
    if (!MOVABLE_AGENT_RUN_STATUSES.has(run.status)) {
      return {
        error: `Cannot move run in state '${run.status}'. Wait for the run to settle (queued / completed / failed / stopped) before moving.`,
      };
    }

    // Same-value no-op.
    if ((run.projectId ?? null) === (projectId ?? null)) {
      return { ok: true as const, noop: true as const };
    }

    // Target-side target-side authz.
    if (projectId !== null) {
      await assertProjectWritable(
        actor as Parameters<typeof assertProjectWritable>[0],
        projectId,
        "write",
);
    }

    // Transactional cascade.
    const actorId = actor.userId ?? "system";
    runResourceProjectMove({
      table: "agent_runs",
      resourceId: run.id,
      resourceKind: "agent_run",
      oldProjectId: run.projectId ?? null,
      newProjectId: projectId,
      actorId,
      sourceRunId: run.id,
      reason: reason ?? null,
    });
    return { ok: true as const };
  } catch (err) {
    if (err instanceof AuthzError) {
      return authzErrorToResponse(err, `Run not found: ${runId}`);
    }
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Run update failed: ${message}` };
  }
}

// ---------------------------------------------------------------------------
// agent_run_move_with_outputs — (moves outputs too)
// ---------------------------------------------------------------------------
//
// Moves the run AND every provenance-linked output object
// (objects.run_id = runId) in ONE transactional cascade. Same authz +
// active-run protection as agent_run_update. Cross-tenant moves are
// rejected (the target project's org_id boundary is enforced via
// assertProjectWritable's grant check — grants are tenant-scoped).
// ---------------------------------------------------------------------------

async function handleAgentBuilderRunMoveWithOutputs(
  request: PrimitiveRequest<{
    runId?: string;
    newProjectId?: string | null;
    reason?: string;
  }>,
): Promise<unknown> {
  const { runId, newProjectId, reason } = request.input;
  if (!runId || typeof runId !== "string") return { error: "runId is required." };
  if (newProjectId === undefined) {
    return { error: "newProjectId is required (pass null to move to ambient)." };
  }

  try {
    const actor = request.actor as PrimitiveActorContext;
    const roles = await resolveRoleHintsFromSession();

    const run = await readAgentRunById(runId, actor, roles);
    if (!run) return { error: `Run not found: ${runId}` };

    await enforceRunAccess(
      { ...run, coOwnerUserIds: undefined },
      actor,
      "execute",
      roles,
);

    // Active-run — active-run protection (same set as agent_run_update).
    if (!MOVABLE_AGENT_RUN_STATUSES.has(run.status)) {
      return {
        error: `Cannot move run in state '${run.status}'. Wait for the run to settle (queued / completed / failed / stopped) before moving.`,
      };
    }

    // Same-value no-op.
    if ((run.projectId ?? null) === (newProjectId ?? null)) {
      return {
        ok: true as const,
        noop: true as const,
        movedOutputIds: [] as string[],
      };
    }

    // Target-side authz. Cross-tenant rejection is enforced by the grant
    // check: a user in org A has no grant on an org B project, so
    // assertProjectWritable throws 403/404 for the cross-tenant target.
    if (newProjectId !== null) {
      await assertProjectWritable(
        actor as Parameters<typeof assertProjectWritable>[0],
        newProjectId,
        "write",
);
    }

    const actorId = actor.userId ?? "system";
    const result = runAgentRunMoveWithOutputs({
      runId: run.id,
      oldProjectId: run.projectId ?? null,
      newProjectId,
      actorId,
      reason: reason ?? null,
    });
    return {
      ok: true as const,
      auditId: result.auditId,
      movedOutputIds: result.movedOutputIds,
      outputCount: result.movedOutputIds.length,
    };
  } catch (err) {
    if (err instanceof AuthzError) {
      return authzErrorToResponse(err, `Run not found: ${runId}`);
    }
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Run move-with-outputs failed: ${message}` };
  }
}

// ---------------------------------------------------------------------------
// agent_update
// ---------------------------------------------------------------------------

async function handleAgentBuilderUpdate(
  request: PrimitiveRequest<{
    templateId?: string;
    name?: string;
    description?: string;
    taskSpec?: string;
    sourceNl?: string;
    status?: string;
    inputSchema?: Record<string, unknown>;
    approvalPolicy?: Record<string, unknown>;
    type?: "leaf" | "proxy" | "orchestrator" | "parallel" | "supervisor" | "iterative" | "flow" | "node";
    executionProvider?: "wayflow";
    packageName?: string;
    agentDependencies?: Record<string, string>;
  }>,
): Promise<unknown> {
  const { templateId, name, description, taskSpec, sourceNl, status, inputSchema, approvalPolicy, type, executionProvider, packageName, agentDependencies } = request.input;
  if (!templateId || typeof templateId !== "string") return { error: "templateId is required." };

  const VALID_STATUSES = ["draft", "published", "archived"];
  if (status !== undefined && !VALID_STATUSES.includes(status)) {
    return { error: `Invalid status: ${status}. Must be one of: ${VALID_STATUSES.join(", ")}.` };
  }

  const VALID_TYPES = ["leaf", "proxy", "orchestrator", "parallel", "supervisor", "iterative", "flow", "node"];
  if (type !== undefined && !VALID_TYPES.includes(type)) {
    return { error: `Invalid type: ${type}. Must be one of: ${VALID_TYPES.join(", ")}.` };
  }

  const patch: Record<string, unknown> = {};
  if (name !== undefined) patch.name = name;
  if (description !== undefined) patch.description = description;
  if (taskSpec !== undefined) patch.taskSpec = taskSpec;
  if (sourceNl !== undefined) patch.sourceNl = sourceNl;
  if (status !== undefined) patch.status = status;
  if (inputSchema !== undefined) patch.inputSchema = inputSchema;
  if (approvalPolicy !== undefined) patch.approvalPolicy = approvalPolicy;
  if (type !== undefined) patch.type = type;
  if (executionProvider !== undefined) patch.executionProvider = executionProvider;
  if (agentDependencies !== undefined) patch.agentDependencies = agentDependencies;

  // packageName is handled separately — setAgentTemplatePackageName guards immutability.
  const hasPackageName = packageName !== undefined && typeof packageName === "string" && packageName.length > 0;

  if (Object.keys(patch).length === 0 && !hasPackageName) return { error: "No fields to update provided." };

  try {
    // set packageName only when null; reject if already set.
    if (hasPackageName) {
      const current = await readAgentTemplateById(templateId);
      if (!current) return { error: `Template not found: ${templateId}` };
      if (current.packageName) {
        return {
          error: `packageName is immutable once assigned. Current value: '${current.packageName}'. Create a new template if you need a different package identity.`,
        };
      }
      await setAgentTemplatePackageName(templateId, packageName!);
    }

    if (Object.keys(patch).length === 0) {
      return { templateId, updated: true };
    }

    const updated = await updateAgentTemplate(templateId, patch as Parameters<typeof updateAgentTemplate>[1]);
    if (!updated) return { error: `Template not found: ${templateId}` };

    // Mirror the create path — re-save the updated
    // template through the Objects Layer so Graphiti reflects the latest state.
    // objects_save handles upsert via delete-then-recreate internally
    // (see packages/objects/src/mcp/handlers.ts:215-232 and AGENTS.md:28-38).
    try {
      // See Pattern B note in handleAgentBuilderSave for why actorBase is
      // built as Record<string, unknown> and cast to the actor type.
      const actorBase: Record<string, unknown> = {
        actorType: request.actor?.actorType ?? "system",
        source: request.actor?.source ?? "route",
        orgId: (request.actor as { orgId?: string | null })?.orgId ?? updated.orgId ?? null,
      };
      const resolvedUserId = request.actor?.userId ?? updated.creatorId ?? undefined;
      if (resolvedUserId) actorBase.userId = resolvedUserId;
      const objectsClient = createDeterministicObjectsClient({
        actor: actorBase as unknown as Parameters<typeof createDeterministicObjectsClient>[0]["actor"],
      });
      await objectsClient.save({
        typeHint: "@cinatra-ai/agent-builder:agent-template",
        rawData: {
          ...updated,
          createdAt: updated.createdAt.toISOString(),
          updatedAt: updated.updatedAt.toISOString(),
        },
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[agents] objectsClient.save failed in handleAgentBuilderUpdate:", err);
    }

    await createAgentTemplateVersionIfChanged(updated, {
      createdBy: request.actor?.userId ?? null,
      // No changelogLine — autoChangelog will derive one based on bumpType
      // No bumpTypeOverride — determineBumpType will classify the change
    });

    void logAuditEvent({
      actorPrincipalId: request.actor?.userId,
      actorPrincipalType: (request.actor?.actorType as AuditEventInput["actorPrincipalType"]) ?? "human",
      authSource: (request.actor?.source as AuditEventInput["authSource"]) ?? "mcp",
      resourceType: "agent_template",
      resourceId: updated.id,
      operation: "update",
      decision: "allowed",
      policyVersion: POLICY_VERSION,
      runId: undefined,
    });

    return {
      templateId: updated.id,
      updated: true,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Update failed: ${message}` };
  }
}

// ---------------------------------------------------------------------------
// agent_delete
// ---------------------------------------------------------------------------

async function handleAgentBuilderDelete(
  request: PrimitiveRequest<{ templateId?: string }>,
): Promise<unknown> {
  const { templateId } = request.input;
  if (!templateId || typeof templateId !== "string") return { error: "templateId is required." };
  try {
    // Load template first, then gate on registry.uninstall.
    // The kernel-based path
    // (can() returns false when actor lacks an active org) centralizes the
    // policy decision through requireResourceAccess/can.
    const template = await readAgentTemplateById(templateId);
    if (!template) return { error: `Template not found: ${templateId}` };

    const orgId = template.orgId ?? null;
    const actorCtx = await actorContextFromMcpRequest(
      request.actor as PrimitiveActorContext,
      orgId,
);
    const uninstallRef: ResourceRef = {
      resourceType: "registry",
      resourceId: templateId,
      ownerType: "organization",
      ownerId: template.orgId ?? undefined,
      organizationId: template.orgId ?? undefined,
    };
    if (!can(actorCtx, "registry.uninstall", uninstallRef)) {
      throw new AuthzError({ statusCode: 403, reason: "forbidden", message: "Delete not permitted." });
    }

    const deleted = await deleteAgentTemplate(templateId);
    if (!deleted) return { error: `Template not found: ${templateId}` };
    void logAuditEvent({
      actorPrincipalId: request.actor?.userId,
      actorPrincipalType: (request.actor?.actorType as AuditEventInput["actorPrincipalType"]) ?? "human",
      authSource: (request.actor?.source as AuditEventInput["authSource"]) ?? "mcp",
      resourceType: "agent_template",
      resourceId: templateId,
      operation: "delete",
      decision: "allowed",
      policyVersion: POLICY_VERSION,
      runId: undefined,
    });
    // Purge purge skill_matches rows for this agent.
    //
    // same legacy-template behavior
    // as agent_save above. When `template.packageName` is null/empty the
    // skill_matches rows (if any) were keyed on the canonical packageId, so
    // a UUID-based cleanup would no-op. Emit a structured warning and skip;
    // any orphan rows are still purged on the next backfill of packageName
    // or via an explicit admin-triggered cleanup. Failures of the cleanup
    // itself MUST NOT raise — the delete already completed.
    if (!template.packageName) {
      console.warn(
        JSON.stringify({
          event: "skill_match_inline_skipped_legacy_template",
          templateId: template.id,
          reason: "no_packageName",
          context: "agent_delete",
        }),
);
    } else {
      try {
        await cleanupForAgent(template.packageName);
      } catch (err) {
        console.warn(
          `[agents/mcp] cleanupForAgent failed for ${template.packageName}:`,
          err instanceof Error ? err.message : err,
);
      }
    }
    return { templateId, deleted: true };
  } catch (err) {
    if (err instanceof AuthzError) return { error: "Access denied." };
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Delete failed: ${message}` };
  }
}

// ---------------------------------------------------------------------------
// agent_run_list
// ---------------------------------------------------------------------------

async function handleAgentBuilderRunList(
  request: PrimitiveRequest<{ templateId?: string; templateIds?: string[]; status?: string; limit?: number; cursor?: string; projectId?: string | null }>,
): Promise<unknown> {
  // see handleAgentBuilderList for rationale; LLM frame
  // requirement is enforced at orchestration entry.
  const { templateId, templateIds, status, limit, cursor } = request.input;
  // sealed-room read filter input.
  // Normalized: only non-empty strings are honored (null/""/whitespace
  // = ambient). assertProjectReadAccess is called below AFTER the org
  // gate so an unauthorized cross-tenant probe is denied by the org
  // gate first (avoids leaking project existence via 404-hidden vs
  // 403 distinguishability).
  const rawProjectId = request.input?.projectId;
  const projectId =
    typeof rawProjectId === "string" && rawProjectId.trim().length > 0
      ? rawProjectId.trim()
      : null;
  const offset = decodeCursor(cursor);
  try {
    // scope reads to session.activeOrganizationId.
    // Non-admin actors without an active org are denied at the handler
    // boundary. The kernel cross-org guard inside enforceRunAccess
    // (the org-scope guard) remains as the per-row second line of defence on the
    // templateId branch.
    const organizationId = await resolveOrgIdFromSession(
      request.actor as { orgId?: string | null } | undefined,
);
    const isAdmin = await resolveIsPlatformAdminFromSession(request.actor as { platformRole?: string } | undefined);
    if (!organizationId && !isAdmin) {
      throw new AuthzError({
        statusCode: 403,
        reason: "forbidden",
        message: "Active organization required.",
      });
    }

    // 404-hide if the actor has no
    // read+ grant on the supplied projectId. Platform admins bypass
    // (mirrors the org-bypass for admins above). The actor's
    // projectGrants axis is plumbed onto request.actor by the agents
    // MCP registry (A2A path) and by the orchestrator for in-process
    // calls. When projectGrants is undefined the gate fails closed.
    if (projectId !== null) {
      const actorForGate = request.actor as unknown as Parameters<
        typeof assertProjectReadAccess
      >[0];
      assertProjectReadAccess(actorForGate, projectId);
    }

    // when templateId is provided, use the raw store
    // variant (no enforcement) and apply per-row enforceRunAccess explicitly
    // so we can implement empty-list semantics: denied rows are dropped
    // (not propagated as errors) and each denial emits a logAuditEvent.
    // When templateId is omitted (cross-template list), keep the legacy path.
    // forward resolved role hints so admin users see
    // non-owned runs in their list results.
    let result: { items: Array<{ id: string; templateId: string; status: string; inputParams: Record<string, unknown>; startedAt: Date | null; completedAt: Date | null }>; total: number };
    if (templateId && !templateIds) {
      const actor = request.actor as PrimitiveActorContext;
      const roles = await resolveRoleHintsFromSession();
      const rawPage = await readAgentRunsByTemplateRaw(templateId, {
        status,
        limit,
        offset,
        organizationId: isAdmin && !organizationId ? undefined : organizationId,
        skipOrgFilter: isAdmin && !organizationId,
        // pass projectId through. Store appends
        // `AND project_id = $projectId` when the per-table feature flag
        // is ON (default).
        projectId,
      });
      const allowedItems: typeof rawPage.items = [];
      for (const row of rawPage.items) {
        try {
          const coOwnerUserIds = await resolveRunCoOwnerUserIds(row.id);
          const template = await readAgentTemplateById(row.templateId);
          const effectivePolicy = template?.agentAuthPolicy ?? null;
          await enforceRunAccess(
            { ...row, effectivePolicy, coOwnerUserIds },
            actor,
            "read",
            roles,
);
          allowedItems.push(row);
        } catch (rowErr) {
          if (rowErr instanceof AuthzError) {
            // Empty-list semantics: drop the row + emit per-row denial audit.
            emitReadDenialAudit(actor, row.id);
            continue;
          }
          throw rowErr;
        }
      }
      // use the unfiltered DB total so callers can
      // paginate correctly. Using allowedItems.length would cause page 2 to
      // report total=N<limit and look like the final page even when the DB has
      // more rows. Capture rawPage.total before filtering.
      // total reflects post-filter row count (matches the
      // empty-list contract asserted by mcp-run-read-policy Test 4). When all
      // rows are denied this returns { items: [], total: 0 } plus per-row
      // denial audits. Trade-off vs pagination math is now based on
      // the visible (filtered) page; callers must request more pages until
      // items.length < limit rather than relying on a fixed unfiltered total.
      result = { items: allowedItems, total: allowedItems.length };
    } else {
      // The else-branch (cross-template / templateIds)
      // called readAgentRuns without per-row enforceRunAccess, leaking
      // run rows across policy boundaries to any org member. Apply the same
      // per-row enforcement loop used by the templateId branch above.
      const actor = request.actor as PrimitiveActorContext;
      const roles = await resolveRoleHintsFromSession();
      const rawPage = await readAgentRuns({
        templateId,
        templateIds,
        status,
        limit,
        offset,
        organizationId: isAdmin && !organizationId ? undefined : organizationId,
        /* @admin-cross-org */ // admin without an active org reads all orgs.
        skipOrgFilter: isAdmin && !organizationId,
        // sealed-room filter applies on the cross-
        // template / templateIds branch too.
        projectId,
      });
      const allowedItems: typeof rawPage.items = [];
      for (const row of rawPage.items) {
        try {
          const coOwnerUserIds = await resolveRunCoOwnerUserIds(row.id);
          const template = await readAgentTemplateById(row.templateId);
          const effectivePolicy = row.authPolicy ?? template?.agentAuthPolicy ?? null;
          await enforceRunAccess({ ...row, effectivePolicy, coOwnerUserIds }, actor, "read", roles);
          allowedItems.push(row);
        } catch (rowErr) {
          if (rowErr instanceof AuthzError) {
            emitReadDenialAudit(actor, row.id);
            continue;
          }
          throw rowErr;
        }
      }
      // Use unfiltered DB total so pagination math stays consistent.
      // total reflects post-filter row count (matches the
      // empty-list contract asserted by mcp-run-read-policy Test 4). When all
      // rows are denied this returns { items: [], total: 0 } plus per-row
      // denial audits. Trade-off vs pagination math is now based on
      // the visible (filtered) page; callers must request more pages until
      // items.length < limit rather than relying on a fixed unfiltered total.
      result = { items: allowedItems, total: allowedItems.length };
    }
    return buildListPage(
      result.items.map((r) => ({
        id: r.id,
        templateId: r.templateId,
        status: r.status,
        inputParams: r.inputParams,
        startedAt: r.startedAt,
        completedAt: r.completedAt,
      })),
      result.total,
      offset,
      limit ?? 50,
);
  } catch (err) {
    // collapse AuthzError 401/403/404 to spec'd messages.
    if (err instanceof AuthzError) {
      return {
        error:
          err.reason === "hidden"
            ? "Run list not available."
            : "Run access denied.",
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Run list failed: ${message}` };
  }
}

// ---------------------------------------------------------------------------
// agent_run_messages_list
// ---------------------------------------------------------------------------

async function handleAgentBuilderRunMessagesList(
  request: PrimitiveRequest<{ runId?: string; messageType?: string }>,
): Promise<unknown> {
  // see handleAgentBuilderList for rationale; LLM frame
  // requirement is enforced at orchestration entry.
  const { runId, messageType } = request.input;
  if (!runId || typeof runId !== "string") return { error: "runId is required." };
  try {
    // scope reads to session.activeOrganizationId.
    // Non-admin actors without an active org are denied at the handler
    // boundary; the kernel cross-org guard via readAgentRunById is the
    // second line of defence on the run row.
    const organizationId = await resolveOrgIdFromSession(
      request.actor as { orgId?: string | null } | undefined,
);
    const isAdmin = await resolveIsPlatformAdminFromSession(request.actor as { platformRole?: string } | undefined);
    if (!organizationId && !isAdmin) {
      throw new AuthzError({
        statusCode: 403,
        reason: "forbidden",
        message: "Active organization required.",
      });
    }

    // actor threading; readAgentRunById will enforce "read".
    // forward role hints so admin users can read
    // messages from non-owned runs.
    const actor = request.actor as PrimitiveActorContext;
    const roles = await resolveRoleHintsFromSession();
    const run = await readAgentRunById(runId, actor, roles);
    if (!run) return { error: `Run not found: ${runId}` };
    const messages = await readAgentRunMessages(runId);
    const filtered =
      messageType && typeof messageType === "string"
        ? messages.filter((m) => m.messageType === messageType)
        : messages;

    // LangGraph retired — DB messages are the only source.
    const allItems = filtered.map((m) => ({
      id: m.id,
      sequence: m.sequence,
      role: m.role,
      messageType: m.messageType,
      body: m.body,
      createdAt: m.createdAt,
    }));

    return {
      items: allItems,
      total: allItems.length,
      hasMore: false,
      runId,
      runStatus: run.status,
      lgThreadId: run.lgThreadId ?? null,
    };
  } catch (err) {
    // collapse AuthzError 401/403/404 to spec'd messages.
    if (err instanceof AuthzError) {
      // emit denial audit on every read-path denial.
      emitReadDenialAudit(request.actor as PrimitiveActorContext, runId);
      return {
        error:
          err.reason === "hidden"
            ? `Run not found: ${runId}`
            : "Run access denied.",
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Run messages list failed: ${message}` };
  }
}

// ---------------------------------------------------------------------------
// agent_run_resume
// ---------------------------------------------------------------------------

async function handleAgentBuilderRunResume(
  request: PrimitiveRequest<{ runId?: string; userResponse?: string; approvalNote?: string }>,
): Promise<unknown> {
  const { runId, userResponse, approvalNote } = request.input;
  if (!runId || typeof runId !== "string") return { error: "runId is required." };
  try {
    const actor = request.actor as PrimitiveActorContext;
    // resolve role hints once for this handler and
    // forward into every actor-threaded auth-policy call so admin users can
    // resume non-owned runs (and so admin-only runDataVisibility policies do
    // not deny admins via the policy gate after).
    const roles = await resolveRoleHintsFromSession();
    // readAgentRunById enforces the "read" gate inline.
    const run = await readAgentRunById(runId, actor, roles);
    if (!run) return { error: `Run not found: ${runId}` };

    // Load run_co_owners once and thread the userId
    // list into every subsequent enforceRunAccess call below. Without this,
    // the bare AgentRunRecord has no coOwnerUserIds field and the co-owner
    // branch of enforceRunAccess silently misses, so a user shared into a
    // pending_approval run via the RunSharingPanel can read the run
    // (readAgentRunById loads + threads co-owners internally) but cannot
    // resume / approve HITL on it.
    const coOwnerRows = await readRunCoOwners(run.id);
    const coOwnerUserIds = coOwnerRows.map((r) => r.userId);
    // Load effectivePolicy for run_resume so the
    // write-tier enforceRunAccess calls below actually evaluate runExecuteVisibility
    // and approveHitl policy fields. Without this, effectivePolicy was undefined
    // on the spread and the policy gate was silently skipped for every actor
    // that passed the kernel can() check.
    const resumeTemplate = await readAgentTemplateById(run.templateId);
    const resumeEffectivePolicy = run.authPolicy ?? resumeTemplate?.agentAuthPolicy ?? null;
    const runWithCoOwners = { ...run, effectivePolicy: resumeEffectivePolicy, coOwnerUserIds };

    // WayFlow callback actor resolution.
    // client_credentials callbacks arrive as actorType:"a2a" with a service-identity userId (no human user
    // row). Trust the bearer (already validated as internal-A2A upstream) and
    // substitute run.runBy as the effective policy subject so enforceRunAccess
    // sees the run's true owner.
    let effectiveActor = actor;
    if (run.runBy && await isA2aServiceIdentity(actor)) {
      effectiveActor = { ...actor, userId: run.runBy };
    }

    // explicit "execute" check. Read access alone is insufficient
    // for resume, even when the state machine would otherwise allow it.
    await enforceRunAccess(runWithCoOwners, effectiveActor, "execute", roles);

    if (run.status !== "pending_approval") {
      return { error: `Run is not pending approval (status: ${run.status}). Only pending_approval runs can be resumed.` };
    }

    // pending_approval resumes require run.approveHitl.
    // CONTEXT decision item 4 enumerates the four HITL permissions; this is
    // the call site for approveHitl. respondToHitl applies when the input
    // includes an explicit response payload.
    await enforceRunAccess(runWithCoOwners, effectiveActor, "approveHitl", roles);

    // Detect explicit hitl response payload in the input. If a typed field
    // (e.g. hitlResponse) is added, branch on its presence here.
    // For now we look for any non-undefined hitl* field beyond the
    // approvalNote (which is approve-side metadata, NOT a response payload).
    const hasHitlResponsePayload = Object.keys(request.input ?? {})
      .some((k) => /^hitl(Response|Reply|Answer)/i.test(k) && (request.input as Record<string, unknown>)[k] !== undefined);
    if (hasHitlResponsePayload) {
      await enforceRunAccess(runWithCoOwners, effectiveActor, "respondToHitl", roles);
    }

    // Deferral: editOutput is mapped in OPERATION_PERMISSION but its
    // call site lives in the dedicated edit-output handler (not yet authored).
    // When that handler is added, the author should call:
    //   await enforceRunAccess(run, actor, "editOutput");
    // before persisting the user's edits.

    // reuse the template loaded above (resumeTemplate)
    // instead of re-fetching. The earlier load is necessary for effectivePolicy;
    // the second fetch was redundant and caused a "Template not found" error in
    // tests that mocked readAgentTemplateById with mockResolvedValueOnce.
    const template = resumeTemplate;
    if (!template) return { error: `Template not found: ${run.templateId}` };

    // WayFlow resume path keyed by agent_runs.a2aTaskId.
    // WayFlow is the only execution path.
    if (
      run.a2aTaskId &&
      template.sourceType === "internal"
) {
      const packageName = template.packageName;
      if (!packageName) {
        return { error: `template.packageName is null for templateId=${template.id}; cannot route WayFlow resume` };
      }
      // vendor-namespaced routing via resolveWayflowUrl. Throws on
      // malformed packageName or unset WAYFLOW_BASE_URL — surfaced as MCP error.
      let wayflowUrl: string;
      try {
        wayflowUrl = resolveWayflowUrl(packageName);
      } catch (err) {
        return {
          error: `Cannot resume WayFlow task for '${packageName}': ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      // WayFlow resume requires sending a new message into the SAME
      // fasta2a contextId as the original input-required task. Sending with a new
      // contextId (or no contextId) starts a fresh conversation and the flow
      // retries from the beginning instead of continuing from the checkpoint.
      if (!run.a2aContextId) {
        return { error: `Run ${runId} has no a2aContextId. Cannot resume WayFlow task without context ID.` };
      }
      const { createExternalA2AClient } = await import("@cinatra-ai/a2a");
      const client = await createExternalA2AClient({
        agentUrl: wayflowUrl,
        // 24h ceiling + long-timeout undici dispatcher aligned with
        // wayflow's batch-LLM timeout patches (docker/wayflow/agent_loader.py).
        // globalThis.fetch's 300s `headersTimeout` default would kill
        // the connection before the 24h AbortSignal fires.
        timeoutMs: WAYFLOW_A2A_TIMEOUT_MS,
        fetchImpl: createWayflowFetch(),
      });
      // Precedence for the WayFlow resume message — kept identical to
      // approveReviewTaskInternal (review-task-actions.ts) so UI and MCP paths
      // stay in lockstep:
      //   1. userResponse (string, non-empty after trim)  — structured-form path,
      //      passed through UNCHANGED to preserve JSON formatting.
      //   2. approvalNote (string, non-empty after trim) — legacy bare-approval, trimmed.
      //   3. fallback "[Approved by operator]"           — bare click-to-approve.
      // userResponse wins over approvalNote when both are present; renderers needing
      // the approval note delivered to WayFlow must embed it inside the JSON payload.
      const trimmedNote = typeof approvalNote === "string" ? approvalNote.trim() : "";
      let resumeText: string;
      if (typeof userResponse === "string" && userResponse.trim().length > 0) {
        resumeText = userResponse;
      } else if (trimmedNote.length > 0) {
        resumeText = trimmedNote;
      } else {
        resumeText = "[Approved by operator]";
      }
      // Payload extraction. MCP handler input has no structured `valuesObj`, so on parse failure submittedValues stays null.
      let submittedValues: Record<string, unknown> | null = null;
      if (typeof userResponse === "string" && userResponse.trim().length > 0) {
        try {
          const parsed = JSON.parse(userResponse);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            submittedValues = parsed as Record<string, unknown>;
          }
        } catch {
          // No structured fallback in MCP path — leave null.
        }
      }

      await writeHitlPrompt({
        runId: run.id,
        agentId: packageName,                          // existing local var; do NOT change to template.packageName
        stepKey: run.a2aTaskId,                        // bare task.id, no `wayflow-` prefix
        message: trimmedNote,
        submittedValues,
        // MCP path: schema not available at resume time — schema_snapshot stored as null
        schemaSnapshot: null,
        excluded: trimmedNote.length === 0,
      }).catch((e) => {
        console.warn(`[handleAgentBuilderRunResume] writeHitlPrompt failed run=${run.id}`, e);
      });
      // Send into the existing context so fasta2a routes to the paused conversation.
      const task = await client.sendTask({
        message: {
          role: "user",
          kind: "message",
          messageId: randomUUID(),
          contextId: run.a2aContextId,
          parts: [{ kind: "text", text: resumeText }],
        },
        configuration: { acceptedOutputModes: ["text"] },
      });

      // multi-gate handler. Lazy import (relative path
      // is "../execution" because this file lives in packages/agents/src/mcp/).
      // fromStatus is "pending_approval" — the resume handler reached this branch
      // because run.a2aTaskId was set, which only happens when the run paused at
      // an A2A gate (status === "pending_approval").
      const { handleWayflowTaskState } = await import("../execution");
      await handleWayflowTaskState({ runId: run.id, run, fromStatus: "pending_approval", task });

      const finalState = task.status?.state;
      return {
        runId: run.id,
        status:
          finalState === "input-required" ? "pending_approval"
          : finalState === "failed" ? "failed"
          : "completed",
        message:
          finalState === "input-required" ? "WayFlow task paused at next gate."
          : finalState === "failed" ? "WayFlow task failed."
          : "WayFlow task completed.",
      };
    }

    // ---------------------------------------------------------------------------
    // LangGraph retired. Setup-phase HITL still uses approveReviewTaskInternal
    // with the synthetic setup-{runId} ID — that path is auth-neutral and provider-agnostic.
    // The legacy LangGraph resume branch (enqueue background job for LangGraph execution)
    // is removed.
    // ---------------------------------------------------------------------------
    if (!run.a2aTaskId) {
      // Setup HITL fired before any execution started (lgThreadId / a2aTaskId both null).
      // The setup gate ONLY fires when required inputSchema fields are MISSING from
      // inputParams, so resume MUST carry those fields as a JSON object. Passing
      // `undefined` (the old behavior) skipped the merge in approveReviewTaskInternal,
      // leaving inputParams empty so the re-enqueued run re-hit the same gate forever.
      // The parsed object flows to the grouped-form merge (validated against the
      // template's inputSchema.properties). Genuine mid-run WayFlow HITL gates take the
      // a2aTaskId branch above, so this does not weaken any real approval.
      if (typeof userResponse !== "string" || userResponse.trim().length === 0) {
        return {
          error:
            'This run is paused at a setup-input gate. Resume with userResponse set to a JSON object of the missing input fields, e.g. userResponse: JSON.stringify({ seedUrls: ["https://..."] }).',
        };
      }
      let setupValues: unknown;
      try {
        setupValues = JSON.parse(userResponse);
      } catch {
        return {
          error: "Setup approval requires userResponse to be valid JSON (a JSON object of input fields).",
        };
      }
      if (setupValues === null || typeof setupValues !== "object" || Array.isArray(setupValues)) {
        return {
          error: "Setup approval requires userResponse to be a JSON object of input fields.",
        };
      }
      if (Object.keys(setupValues as Record<string, unknown>).length === 0) {
        return {
          error:
            "Setup approval requires at least one input field in userResponse; an empty object would re-park the run at the same setup gate.",
        };
      }
      await approveReviewTaskInternal(
        `setup-${runId}`,
        effectiveActor.userId ?? run.runBy ?? "mcp-caller",
        setupValues,
      );
      return {
        runId,
        status: "resuming",
        message: "Setup phase approved, execution re-enqueued.",
      };
    }

    return { error: "Resume is only supported for WayFlow runs (template.sourceType=internal with a2aTaskId). LangGraph runs are no longer supported." };
  } catch (err) {
    // collapse AuthzError 401/403/404 to spec'd messages.
    if (err instanceof AuthzError) {
      return {
        error:
          err.reason === "hidden"
            ? `Run not found: ${runId}`
            : "Run access denied.",
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Resume failed: ${message}` };
  }
}

// ---------------------------------------------------------------------------
// agent_run_stop
// ---------------------------------------------------------------------------

async function handleAgentBuilderRunStop(
  request: PrimitiveRequest<{ runId?: string }>,
): Promise<unknown> {
  const { runId } = request.input;
  if (!runId || typeof runId !== "string") return { error: "runId is required." };
  try {
    const actor = request.actor as PrimitiveActorContext;
    // resolve role hints from the Better Auth session
    // and forward into the readAgentRunById + enforceRunAccess calls below
    // so admin users can stop non-owned runs.
    const roles = await resolveRoleHintsFromSession();
    const run = await readAgentRunById(runId, actor, roles);
    if (!run) return { error: `Run not found: ${runId}` };
    // Thread co-owners into the explicit gate so the
    // co-owner branch of enforceRunAccess fires consistently with the read
    // gate inside readAgentRunById. Whether co-owners can stop a run is
    // governed by the COOWNER_OPS set in auth-policy.ts ("execute" is IN —
    // co-owner stop matches the existing behavior; if a future change narrows
    // COOWNER_OPS to drop "execute", this call site will respect that).
    const coOwnerRows = await readRunCoOwners(run.id);
    const coOwnerUserIds = coOwnerRows.map((r) => r.userId);
    // Load effectivePolicy for run_stop so the
    // execute-tier enforceRunAccess call evaluates runExecuteVisibility.
    // Without this, effectivePolicy was undefined and the policy gate silently
    // skipped for any actor passing the kernel can() check.
    const stopTemplate = await readAgentTemplateById(run.templateId);
    const stopEffectivePolicy = run.authPolicy ?? stopTemplate?.agentAuthPolicy ?? null;
    // explicit execute-tier check before terminal-state shortcut.
    await enforceRunAccess({ ...run, effectivePolicy: stopEffectivePolicy, coOwnerUserIds }, actor, "execute", roles);
    if (["stopped", "completed", "failed"].includes(run.status)) {
      return { runId, status: run.status, message: `Run already in terminal state: ${run.status}` };
    }
    await transitionRunStatus(runId, run.status as AgentRunStatus, "stopped").catch((err) => {
      if (err instanceof RunTransitionError && err.code === "stale_from_status") {
        // Race: status changed between our read and the CAS. Safe to ignore — the
        // run is terminal either way by the time this path unwinds.
        return;
      }
      throw err;
    });
    void logAuditEvent({
      actorPrincipalId: request.actor?.userId,
      actorPrincipalType: (request.actor?.actorType as AuditEventInput["actorPrincipalType"]) ?? "human",
      authSource: (request.actor?.source as AuditEventInput["authSource"]) ?? "mcp",
      resourceType: "agent_run",
      resourceId: runId,
      operation: "stop",
      decision: "allowed",
      policyVersion: POLICY_VERSION,
      runId: runId,
    });
    return { runId, status: "stopped", message: "Run marked stopped. The background job will halt after its current step." };
  } catch (err) {
    // collapse AuthzError 401/403/404 to spec'd messages.
    if (err instanceof AuthzError) {
      return {
        error:
          err.reason === "hidden"
            ? `Run not found: ${runId}`
            : "Run access denied.",
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Stop failed: ${message}` };
  }
}

// ---------------------------------------------------------------------------
// agent_runs_stop  (bulk stop)
// ---------------------------------------------------------------------------

async function handleAgentBuilderRunsStop(
  request: PrimitiveRequest<{ templateId?: string; runIds?: string[] }>,
): Promise<unknown> {
  const { templateId, runIds } = request.input;
  const hasRunIds = Array.isArray(runIds) && runIds.length > 0;
  if (!hasRunIds && (!templateId || typeof templateId !== "string")) {
    return { error: "Provide either templateId or a non-empty runIds array." };
  }
  try {
    // Gate the bulk stop handler with the same
    // org-scope and per-run authorization checks used by the single-stop
    // handler (handleAgentBuilderRunStop). Without this, any actor with an MCP
    // token could terminate any run cross-org by knowing a UUID.
    const organizationId = await resolveOrgIdFromSession(
      request.actor as { orgId?: string | null } | undefined,
);
    const isAdmin = await resolveIsPlatformAdminFromSession(request.actor as { platformRole?: string } | undefined);
    if (!organizationId && !isAdmin) {
      return { error: "Active organization required." };
    }
    const actor = request.actor as PrimitiveActorContext;
    const roles = await resolveRoleHintsFromSession();

    let result: { stopped: number; alreadyTerminal: number; total: number };
    if (hasRunIds) {
      // Per-run authorization: load each run, enforce execute access, collect
      // the allowed IDs, then bulk-stop only those.
      const allowedIds: string[] = [];
      for (const rid of runIds!) {
        try {
          const run = await readAgentRunById(rid, actor, roles);
          if (!run) continue; // hidden by read gate — skip silently
          const coOwnerRows = await readRunCoOwners(run.id);
          const coOwnerUserIds = coOwnerRows.map((r) => r.userId);
          const tpl = await readAgentTemplateById(run.templateId);
          const effectivePolicy = run.authPolicy ?? tpl?.agentAuthPolicy ?? null;
          await enforceRunAccess({ ...run, effectivePolicy, coOwnerUserIds }, actor, "execute", roles);
          allowedIds.push(rid);
        } catch (rowErr) {
          if (rowErr instanceof AuthzError) {
            void logAuditEvent({
              actorPrincipalId: actor.userId,
              actorPrincipalType: (actor.actorType as AuditEventInput["actorPrincipalType"]) ?? "human",
              authSource: (actor.source as AuditEventInput["authSource"]) ?? "mcp",
              resourceType: "agent_run",
              resourceId: rid,
              operation: "stop",
              decision: "denied",
              policyVersion: POLICY_VERSION,
              runId: rid,
            });
            continue; // skip denied run
          }
          throw rowErr;
        }
      }
      if (allowedIds.length === 0) return { stopped: 0, alreadyTerminal: 0, total: 0 };
      result = await bulkStopAgentRuns(allowedIds);
    } else {
      // Template path: verify the template is owned by the actor's org (or
      // isAdmin) before issuing the bulk stop.
      const tpl = await readAgentTemplateById(templateId!);
      if (!tpl) return { error: `Template not found: ${templateId}` };
      if (!isAdmin && tpl.orgId !== organizationId) {
        return { error: `Template not found: ${templateId}` }; // hide-existence
      }
      result = await bulkStopAgentRunsByTemplate(templateId!);
    }

    void logAuditEvent({
      actorPrincipalId: actor.userId,
      actorPrincipalType: (actor.actorType as AuditEventInput["actorPrincipalType"]) ?? "human",
      authSource: (actor.source as AuditEventInput["authSource"]) ?? "mcp",
      resourceType: "agent_run",
      resourceId: templateId ?? (runIds ?? []).join(","),
      operation: "bulk_stop",
      decision: "allowed",
      policyVersion: POLICY_VERSION,
    });
    return {
      stopped: result.stopped,
      alreadyTerminal: result.alreadyTerminal,
      total: result.total,
    };
  } catch (err) {
    if (err instanceof AuthzError) return authzErrorToResponse(err, "Bulk stop denied.");
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Bulk stop failed: ${message}` };
  }
}

// ---------------------------------------------------------------------------
// agent_template_duplicate
// ---------------------------------------------------------------------------

async function handleAgentBuilderTemplateDuplicate(
  request: PrimitiveRequest<{ templateId?: string; name?: string }>,
): Promise<unknown> {
  const { templateId, name } = request.input;
  if (!templateId || typeof templateId !== "string") return { error: "templateId is required." };

  try {
    const source = await readAgentTemplateById(templateId);
    if (!source) return { error: `Template not found: ${templateId}` };

    const orgId = await resolveDefaultOrgId();
    const newId = randomUUID();
    const copyName = name && typeof name === "string" ? name : `Copy of ${source.name}`;

    const copy = await createAgentTemplate({
      id: newId,
      orgId: orgId ?? undefined,
      name: copyName,
      description: source.description ?? undefined,
      sourceNl: source.sourceNl,
      compiledPlan: source.compiledPlan,
      inputSchema: source.inputSchema,
      outputSchema: source.outputSchema ?? undefined,
      approvalPolicy: source.approvalPolicy,
      taskSpec: source.taskSpec,
      type: source.type,
      status: "draft",
    });

    // Copy the latest version snapshot
    const versions = await readAgentVersionsByTemplate(templateId);
    if (versions[0]) {
      await createAgentVersion({
        id: randomUUID(),
        templateId: newId,
        contentHash: versions[0].contentHash,
        snapshot: versions[0].snapshot,
      });
    }

    return { templateId: copy.id, name: copy.name, detailPath: `/agents/builder/${copy.id}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Duplicate failed: ${message}` };
  }
}

// ---------------------------------------------------------------------------
// agent_export
// ---------------------------------------------------------------------------

async function handleAgentBuilderExport(
  request: PrimitiveRequest<{ templateId?: string }>,
): Promise<unknown> {
  const { templateId } = request.input;
  if (!templateId || typeof templateId !== "string") return { error: "templateId is required." };

  try {
    const template = await readAgentTemplateById(templateId);
    if (!template) return { error: `Template not found: ${templateId}` };

    const exportedAt = new Date().toISOString();

    // Guard: ensure compiledPlan is always an array in the ZIP (legacy double-encoded guard)
    const compiledPlanSafe = Array.isArray(template.compiledPlan)
      ? template.compiledPlan
      : (typeof template.compiledPlan === "string"
          ? (() => { try { const p = JSON.parse(template.compiledPlan as unknown as string); return Array.isArray(p) ? p : []; } catch { return []; } })()
          : []);

    // Strip UI-only __ fields from inputSchema before export — agent.json is a public capability contract
    const inputSchemaCopy = JSON.parse(JSON.stringify(template.inputSchema)) as Record<string, unknown>;
    const props = inputSchemaCopy.properties as Record<string, unknown> | undefined;
    if (props) {
      for (const key of Object.keys(props)) {
        if (key.startsWith("__")) delete props[key];
      }
    }
    if (Array.isArray(inputSchemaCopy.required)) {
      inputSchemaCopy.required = (inputSchemaCopy.required as string[]).filter((k: string) => !k.startsWith("__"));
    }

    // exports now read the canonical on-disk OAS Flow agent.json.
    // The DB row is a derived cache of DB-column values; it cannot round-trip
    // back to a compact OAS Flow without also shipping $referenced_components
    // etc. For exports, read the canonical file from the repo when we can.
    let agentJson: string;
    const exportSlug = template.packageName ? (template.packageName.split("/").pop() ?? "") : "";
    const canonicalAgentJsonPath = exportSlug
      ? (resolveAgentJsonPathForRead(exportSlug)?.path ?? null)
      : null;
    if (canonicalAgentJsonPath) {
      try {
        agentJson = (await readFile(canonicalAgentJsonPath, "utf8")) as string;
      } catch {
        // Fall through to a minimal OAS envelope derived from DB columns.
        agentJson = JSON.stringify({
          agentspec_version: "26.1.0",
          component_type: "Flow",
          id: template.id,
          name: template.name,
          description: template.description ?? null,
          sourceNl: template.sourceNl,
          status: template.status,
          exportedAt,
          metadata: {
            cinatra: {
              type: template.type,
              hitlScreens: template.hitlScreens ?? [],
            },
          },
          inputs: [],
          outputs: [],
          start_node: { $component_ref: "start" },
          nodes: [],
          control_flow_connections: [],
          $referenced_components: {},
        }, null, 2);
      }
    } else {
      agentJson = JSON.stringify({
        agentspec_version: "26.1.0",
        component_type: "Flow",
        id: template.id,
        name: template.name,
        description: template.description ?? null,
        sourceNl: template.sourceNl,
        status: template.status,
        exportedAt,
        metadata: {
          cinatra: {
            type: template.type === "orchestrator" ? "orchestrator" : "leaf",
            hitlScreens: template.hitlScreens ?? [],
          },
        },
        inputs: [],
        outputs: [],
        start_node: { $component_ref: "start" },
        nodes: [],
        control_flow_connections: [],
        $referenced_components: {},
      }, null, 2);
    }
    void compiledPlanSafe; void inputSchemaCopy; // now sourced from on-disk file

    const manifestJson = JSON.stringify({
      version: 1,
      exportedAt,
      cinatra: "agent-builder-v1",
    }, null, 2);

    const zipBuf = createZipBuffer([
      { name: "agent.json", content: agentJson },
      { name: "manifest.json", content: manifestJson },
    ]);

    const slug = template.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const dateStr = exportedAt.slice(0, 10).replace(/-/g, "");
    const fileName = `${slug}-${dateStr}.zip`;

    return {
      templateId: template.id,
      name: template.name,
      zipBase64: zipBuf.toString("base64"),
      fileName,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Export failed: ${message}` };
  }
}

// ---------------------------------------------------------------------------
// agent_import
// ---------------------------------------------------------------------------

async function handleAgentBuilderImport(
  request: PrimitiveRequest<{ zipBase64?: string; name?: string }>,
): Promise<unknown> {
  const { zipBase64, name } = request.input;
  if (!zipBase64 || typeof zipBase64 !== "string") return { error: "zipBase64 is required." };

  try {
    // Delegate to importAgentTemplate with redirect: false — MCP handlers must not
    // trigger Next.js redirects. The upsert-by-packageName path is handled inside
    // importAgentTemplate when the ZIP's agent.json carries a packageName.
    const { importAgentTemplate } = await import("../import-export-actions");
    const result = await importAgentTemplate(zipBase64, name ?? undefined, { redirect: false });

    return {
      templateId: result.templateId,
      upserted: result.upserted,
      detailPath: `/agents/builder/${result.templateId}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Import failed: ${message}` };
  }
}

// ---------------------------------------------------------------------------
// agent_version_list
// ---------------------------------------------------------------------------

async function handleAgentBuilderVersionList(
  req: PrimitiveRequest<{ templateId: string; limit?: number; cursor?: string }>,
): Promise<unknown> {
  const { templateId, limit, cursor } = req.input;
  const page = await readAgentTemplateVersions(templateId, { limit, cursor });
  return {
    items: page.items.map(summarizeVersion),
    total: page.total,
    hasMore: page.hasMore,
    nextCursor: page.nextCursor,
  };
}

function summarizeVersion(v: AgentTemplateVersionRecord) {
  return {
    id: v.id,
    templateId: v.templateId,
    versionNumber: v.versionNumber,
    semver: v.semver,
    bumpType: v.bumpType,
    changelogLine: v.changelogLine,
    contentHash: v.contentHash,
    createdBy: v.createdBy,
    createdAt: v.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// agent_version_get
// ---------------------------------------------------------------------------

async function handleAgentBuilderVersionGet(
  req: PrimitiveRequest<{ versionId: string }>,
): Promise<unknown> {
  const version = await readAgentTemplateVersionById(req.input.versionId);
  if (!version) {
    throw new Error(`agent_version_get: version ${req.input.versionId} not found`);
  }
  return {
    ...summarizeVersion(version),
    snapshot: version.snapshot, // full parsed snapshot
  };
}

// ---------------------------------------------------------------------------
// agent_version_rollback
// ---------------------------------------------------------------------------

async function handleAgentBuilderVersionRollback(
  req: PrimitiveRequest<{ templateId: string; targetVersionId: string }>,
): Promise<unknown> {
  const result = await rollbackAgentTemplateToVersion(
    req.input.templateId,
    req.input.targetVersionId,
    req.actor?.userId ?? null,
);
  void logAuditEvent({
    actorPrincipalId: req.actor?.userId,
    actorPrincipalType: (req.actor?.actorType as AuditEventInput["actorPrincipalType"]) ?? "human",
    authSource: (req.actor?.source as AuditEventInput["authSource"]) ?? "mcp",
    resourceType: "agent_template_version",
    resourceId: result.template.id,
    operation: "rollback",
    decision: "allowed",
    policyVersion: POLICY_VERSION,
    runId: undefined,
  });
  return {
    templateId: result.template.id,
    currentVersionId: result.restoredVersionId,
  };
}

// ---------------------------------------------------------------------------
// agent_version_diff
// ---------------------------------------------------------------------------

async function handleAgentBuilderVersionDiff(
  req: PrimitiveRequest<{ templateId: string; fromVersionId: string; toVersionId: string }>,
): Promise<unknown> {
  const [from, to] = await Promise.all([
    readAgentTemplateVersionById(req.input.fromVersionId),
    readAgentTemplateVersionById(req.input.toVersionId),
  ]);
  if (!from || from.templateId !== req.input.templateId) {
    throw new Error(`agent_version_diff: from version not found for template ${req.input.templateId}`);
  }
  if (!to || to.templateId !== req.input.templateId) {
    throw new Error(`agent_version_diff: to version not found for template ${req.input.templateId}`);
  }
  const diff = diffSnapshots(from.snapshot, to.snapshot);
  return {
    from: summarizeVersion(from),
    to: summarizeVersion(to),
    diff,
  };
}

// ---------------------------------------------------------------------------
// 4-rung agent definition path resolution.
// New canonical layout: <installDir>/cinatra/<slug>-agent/cinatra/oas.json
// the resolver introduces a 4-rung probe so legacy installs still resolve
// while we migrate forward:
//   1. <installDir>/cinatra/<slug>/cinatra/oas.json    — NEW canonical
//   2. <installDir>/cinatra/<slug>/cinatra/agent.json  — transitional (same dir, old filename)
//   3. <installDir>/<legacySlug>/cinatra/agent.json    — legacy
//   4. <installDir>/<legacySlug>/agent.json            — legacy (older layout)
// LEGACY_SLUG_MAP handles the two slugs whose legacy directory names differed from the slug.
// ---------------------------------------------------------------------------

const LEGACY_SLUG_MAP: Record<string, string> = {
  "drupal-agent": "drupal-content-editor",
  "wordpress-agent": "wordpress-content-editor",
};

function resolveAgentJsonPathForRead(packageSlug: string): {
  path: string;
  relPath: string;
} | null {
  const root = resolveAgentInstallDir();
  // Rung 1 — NEW canonical
  const rung1 = join(root, "cinatra-ai", packageSlug, "cinatra", "oas.json");
  if (existsSync(rung1)) return { path: rung1, relPath: relative(process.cwd(), rung1) };
  // Rung 2 — transitional (same dir, old filename)
  const rung2 = join(root, "cinatra-ai", packageSlug, "cinatra", "agent.json");
  if (existsSync(rung2)) return { path: rung2, relPath: relative(process.cwd(), rung2) };
  // Rung 3 — legacy: explicit map for renamed slugs, otherwise keep slug as-is
  const legacySlug = LEGACY_SLUG_MAP[packageSlug] ?? packageSlug;
  const rung3 = join(root, legacySlug, "cinatra", "agent.json");
  if (existsSync(rung3)) return { path: rung3, relPath: relative(process.cwd(), rung3) };
  // Rung 4 — legacy (older layout)
  const rung4 = join(root, legacySlug, "agent.json");
  if (existsSync(rung4)) return { path: rung4, relPath: relative(process.cwd(), rung4) };
  return null;
}

// Resolves the on-disk directory that contains the agent (for sibling reads
// like package.json, skills/). Mirrors the 4-rung probe order in
// resolveAgentJsonPathForRead but returns the parent agent directory.
function resolveAgentRootDirForRead(packageSlug: string): string | null {
  const root = resolveAgentInstallDir();
  // Rung 1/2 — new canonical / transitional: <installDir>/cinatra/<slug>/
  const newRoot = join(root, "cinatra-ai", packageSlug);
  if (existsSync(join(newRoot, "cinatra", "oas.json")) || existsSync(join(newRoot, "cinatra", "agent.json"))) {
    return newRoot;
  }
  // Rung 3/4 — legacy: <installDir>/<legacySlug>/
  const legacySlug = LEGACY_SLUG_MAP[packageSlug] ?? packageSlug;
  const legacyRoot = join(root, legacySlug);
  if (existsSync(join(legacyRoot, "cinatra", "agent.json")) || existsSync(join(legacyRoot, "agent.json"))) {
    return legacyRoot;
  }
  return null;
}

function resolveAgentJsonPathForWrite(packageSlug: string): {
  dir: string;
  path: string;
  relPath: string;
} {
  // For writes: prefer the new canonical layout. If a legacy flat
  // <installDir>/<legacySlug>/agent.json exists, overwrite in
  // place to avoid creating a divergent second copy; otherwise write to the
  // new canonical path under cinatra/<slug>/cinatra/oas.json.
  const root = resolveAgentInstallDir();
  const legacySlug = LEGACY_SLUG_MAP[packageSlug] ?? packageSlug;
  const legacyFlat = join(root, legacySlug, "agent.json");
  if (existsSync(legacyFlat)) {
    return {
      dir: join(root, legacySlug),
      path: legacyFlat,
      relPath: relative(process.cwd(), legacyFlat),
    };
  }
  const canonicalDir = join(root, "cinatra-ai", packageSlug, "cinatra");
  const canonicalPath = join(canonicalDir, "oas.json");
  return {
    dir: canonicalDir,
    path: canonicalPath,
    relPath: relative(process.cwd(), canonicalPath),
  };
}

// ---------------------------------------------------------------------------
// agent_source_list
// ---------------------------------------------------------------------------

async function handleAgentBuilderGitList(
  _request: PrimitiveRequest,
): Promise<unknown> {
  // agents now live under <installDir>/cinatra/<slug>-agent/. Walk
  // that vendor-namespace dir first; fall back to legacy <installDir>/<slug>/
  // for older installs.
  const root = resolveAgentInstallDir();
  const slugSet = new Set<string>();

  // New layout: <installDir>/cinatra/<slug>-agent/
  const vendorDir = join(root, "cinatra-ai");
  if (existsSync(vendorDir)) {
    try {
      const subEntries = (await readdir(vendorDir, { withFileTypes: true })) as unknown as Array<{
        name: string;
        isDirectory: () => boolean;
      }>;
      for (const sub of subEntries) {
        if (sub.isDirectory()) slugSet.add(sub.name);
      }
    } catch {
      /* skip if unreadable */
    }
  }

  // Legacy layout: <installDir>/<slug>/ (only entries that look like agent dirs).
  let topEntries: Array<{ name: string; isDirectory: () => boolean }> = [];
  try {
    topEntries = (await readdir(root, { withFileTypes: true })) as unknown as Array<{
      name: string;
      isDirectory: () => boolean;
    }>;
  } catch {
    /* root unreadable — items collected so far still returned */
  }
  for (const entry of topEntries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "cinatra") continue; // Vendor dir already walked above
    // Probe legacy paths to filter non-agent dirs.
    if (
      existsSync(join(root, entry.name, "cinatra", "agent.json"))
      || existsSync(join(root, entry.name, "agent.json"))
) {
      slugSet.add(entry.name);
    }
  }

  const items: unknown[] = [];
  for (const slug of slugSet) {
    const resolved = resolveAgentJsonPathForRead(slug);
    if (!resolved) continue;
    try {
      const raw = (await readFile(resolved.path, "utf8")) as string;
      const content = JSON.parse(raw) as Record<string, unknown>;
      // packageName + packageVersion live under metadata.cinatra.
      const cinatra = (content.metadata as Record<string, unknown> | undefined)?.cinatra as Record<string, unknown> | undefined;
      // description, packageName, and packageVersion fall back to the sibling
      // package.json one level up from cinatra/ — preferred for WayFlow flow agents
      // which don't always set metadata.cinatra.packageName in oas.json.
      let description = (content.description as string | null | undefined) ?? null;
      let siblingPkgName: string | null = null;
      let siblingPkgVersion: string | null = null;
      const candidatePkgPaths = [
        // New layout sibling: <installDir>/cinatra/<slug>/package.json
        join(root, "cinatra-ai", slug, "package.json"),
        // Legacy layout sibling: <installDir>/<legacySlug>/package.json
        join(
          root,
          (LEGACY_SLUG_MAP[slug] ?? slug),
          "package.json",
),
      ];
      for (const pkgPath of candidatePkgPaths) {
        try {
          const siblingPkg = JSON.parse((await readFile(pkgPath, "utf8")) as string) as { name?: unknown; version?: unknown; description?: unknown };
          if (!description && typeof siblingPkg.description === "string" && siblingPkg.description) {
            description = siblingPkg.description;
          }
          if (!siblingPkgName && typeof siblingPkg.name === "string" && siblingPkg.name) {
            siblingPkgName = siblingPkg.name;
          }
          if (!siblingPkgVersion && typeof siblingPkg.version === "string" && siblingPkg.version) {
            siblingPkgVersion = siblingPkg.version;
          }
          if (description && siblingPkgName && siblingPkgVersion) break;
        } catch { /* try next candidate */ }
      }
      items.push({
        path: resolved.relPath,
        packageName: cinatra?.packageName ?? content.packageName ?? siblingPkgName ?? null,
        packageVersion: cinatra?.packageVersion ?? content.packageVersion ?? siblingPkgVersion ?? null,
        name: content.name ?? null,
        description,
      });
    } catch {
      // Skip unreadable or invalid files — do not fail the entire list
    }
  }
  return { items, total: items.length };
}

// ---------------------------------------------------------------------------
// agent_source_read
// ---------------------------------------------------------------------------

async function handleAgentBuilderGitRead(
  request: PrimitiveRequest<{ packageSlug?: string }>,
): Promise<unknown> {
  const { packageSlug } = request.input;
  if (!packageSlug || typeof packageSlug !== "string") {
    return { error: "packageSlug is required." };
  }
  // Path traversal guard
  if (packageSlug.includes("..") || packageSlug.includes("/") || packageSlug.includes("\\")) {
    return { error: "packageSlug must not contain path separators or '..'." };
  }
  // prefer agents/{slug}/cinatra/agent.json; fall back to legacy flat path.
  const resolved = resolveAgentJsonPathForRead(packageSlug);
  if (!resolved) {
    return { error: `Agent file not found: agents/${packageSlug}/cinatra/agent.json` };
  }
  let raw: string;
  try {
    raw = (await readFile(resolved.path, "utf8")) as string;
  } catch {
    return { error: `Agent file not found: ${resolved.relPath}` };
  }
  let content: unknown;
  try {
    content = JSON.parse(raw);
  } catch {
    return { error: `${resolved.relPath} is not valid JSON.` };
  }
  return { content, path: resolved.relPath };
}

// validateOasAgentJson is imported from ../validate-agent-json

// ---------------------------------------------------------------------------
// pre-write preflight helper.
//
// When the agent-creation Anthropic pin is active, the agent_source_write +
// agent_source_write_files handlers MUST refuse to write authoring artifacts
// before the required catalog skills are synced / governance permits / size +
// count caps hold. NEVER a mid-run partial failure.
//
// Returns null when pin is inactive (preflight
// fully bypassed). Returns a PreflightResult when pin is active so the caller
// can short-circuit on `ok:false`.
//
// The required skills set is the canonical 3-reviewer-lane set exported by
// agent-creation-review.ts (security/code/planner) — the write path doesn't
// know which lane will be dispatched later, so it gates on the broadest set.
// Reused (not copied) so the lane definition stays single-sourced.
// ---------------------------------------------------------------------------

const REVIEWER_LANE_PACKAGES_FOR_WRITE = REVIEWER_LANE_PACKAGES;

async function runAgentSourceWritePreflightIfPinned(): Promise<AgentCreationPreflightResult | null> {
  const { isAgentCreationPinActive } = await import("@/lib/database");
  if (!isAgentCreationPinActive()) return null;
  let laneSkillSets: Awaited<ReturnType<typeof resolveRequiredCreationSkillIds>>;
  try {
    laneSkillSets = await resolveRequiredCreationSkillIds(REVIEWER_LANE_PACKAGES_FOR_WRITE);
  } catch (err) {
    return {
      ok: false,
      pinActive: true,
      errors: [
        {
          code: "catalog_unavailable",
          message: `Could not resolve required catalog skills: ${err instanceof Error ? err.message : String(err)}.`,
        },
      ],
    };
  }
  const requiredCatalogSkillIds = Array.from(new Set(laneSkillSets.flatMap((l) => l.skillIds)));
  return preflightAgentCreation({ requiredCatalogSkillIds, laneSkillSets });
}

// ---------------------------------------------------------------------------
// writing_files milestone emit.
//
// Fired AFTER the write preflight passes and BEFORE the actual write, only
// when the caller threaded `progressContext.runId` AND the request actor is
// a HumanUser with a userId. Recipient is ALWAYS server-derived from the
// actor — never caller-controlled (rev3 fanout-escalation guard). The emit
// is fire-and-forget (safeEmit* swallows DB failures); dynamic-import
// failure is also swallowed so the write always proceeds.
// ---------------------------------------------------------------------------

async function emitWritingFilesIfThreaded(
  progressContext: { runId: string } | undefined,
  actor: PrimitiveRequest["actor"] | undefined,
  packageName: string,
): Promise<void> {
  if (!progressContext?.runId) return;
  const userId = actor?.userId;
  if (!actor || actor.actorType !== "human" || !userId) return;
  try {
    const { safeEmitAgentCreationProgress } = await import(
      "@cinatra-ai/notifications/server"
);
    await safeEmitAgentCreationProgress({
      recipient: { kind: "user", userId },
      runId: progressContext.runId,
      packageName,
      milestone: "writing_files",
    });
  } catch (err) {
    console.warn(
      "[agent_source_write] writing_files milestone emit dynamic-import failed:",
      err instanceof Error ? err.message : err,
);
  }
}

// ---------------------------------------------------------------------------
// agent_source_write
// ---------------------------------------------------------------------------

async function handleAgentBuilderGitWrite(
  request: PrimitiveRequest<{
    packageSlug?: string;
    content?: string;
    progressContext?: { runId: string };
  }>,
): Promise<unknown> {
  // Admin gate (defense-in-depth + primary gate for non-delegated surfaces).
  // The delegated-chat tool policy denies agent_source_write for every actor
  // (it is not on the allowlist), but /api/agents/passthrough goes through
  // createAgentBuilderPrimitiveHandlers() WITHOUT the relay policy — so this
  // handler-level gate is what actually blocks a non-admin via that surface.
  // Mirrors the existing handleAgentBuilderGitPublish admin check.
  const isAdmin = await resolveIsPlatformAdminFromSession(
    request.actor as { platformRole?: string } | undefined,
  );
  if (!isAdmin) {
    return { error: "Unauthorized — admin session required to write." };
  }
  // hard pre-enqueue preflight at the write boundary.
  // When the Anthropic agent-creation pin is active, refuse to write
  // authoring artifacts before the required catalog skills are synced /
  // governance permits / size + count caps hold. NEVER a mid-run partial
  // failure. When pin is INACTIVE (the default) the preflight no-ops.
  //
  const writePreflight = await runAgentSourceWritePreflightIfPinned();
  if (writePreflight && !writePreflight.ok) {
    return {
      error: `agent_source_write blocked by preflight (${writePreflight.errors.map((e) => e.code).join(", ")}): ${writePreflight.errors.map((e) => e.message).join(" / ")}`,
    };
  }

  const { packageSlug, content } = request.input;
  if (!packageSlug || typeof packageSlug !== "string") {
    return { error: "packageSlug is required." };
  }
  if (!content || typeof content !== "string") {
    return { error: "content is required (JSON string)." };
  }
  // Path traversal guard
  if (packageSlug.includes("..") || packageSlug.includes("/") || packageSlug.includes("\\")) {
    return { error: "packageSlug must not contain path separators or '..'." };
  }
  // Validate JSON structure and OAS Flow shape before writing
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return { error: "content is not valid JSON." };
  }
  const validationErrors = validateOasAgentJson(parsed);
  if (validationErrors.length > 0) {
    return { error: `Validation failed: ${validationErrors.join("; ")}` };
  }
  // defense-in-depth strip of legacy fields that must never appear
  // in a compact OAS Flow agent.json. The validator also rejects these, but
  // strip here in case a future validator bug lets them through.
  // NOTE: top-level `id` is REQUIRED by the OAS Flow schema (flowSchema.id).
  // Do NOT strip it — doing so drops a field the validator just confirmed
  // present, breaking write-then-read idempotency.
  delete (parsed as Record<string, unknown>).componentType;
  const metaCinatraForWrite = (parsed.metadata as Record<string, unknown> | undefined)?.cinatra as Record<string, unknown> | undefined;
  if (metaCinatraForWrite) {
    for (const legacy of [
      "formatVersion",
      "executionMode",
      "executionProvider",
      "lgGraphCode",
      "lgGraphId",
      "packageName",
      "packageVersion",
      "agentDependencies",
      "approvalPolicy",
      "inputSchema",
      "outputSchema",
      "prompt",
      "taskSpec",
      "compiledPlan",
    ]) {
      delete metaCinatraForWrite[legacy];
    }
  }
  // write to agents/{slug}/cinatra/agent.json by default; if a legacy
  // flat agents/{slug}/agent.json already exists, overwrite
  // in place to avoid creating a divergent second copy.
  // writing_files milestone (preflight passed + inputs validated;
  // no-op unless progressContext threaded + HumanUser actor).
  await emitWritingFilesIfThreaded(
    request.input.progressContext,
    request.actor,
    packageSlug,
);
  const target = resolveAgentJsonPathForWrite(packageSlug);
  try {
    await mkdir(target.dir, { recursive: true });
    await writeFile(target.path, JSON.stringify(parsed, null, 2) + "\n", "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to write agent file: ${message}` };
  }
  // -deferred — write `.cinatra-in-progress.json` at the slug
  // directory level. The wayflow loader uses this as an intent signal:
  // when present, the reload's failed[] reports `marker_in_progress_draft`
  // instead of the alarming `marker_missing` / `marker_malformed` kinds.
  // The next successful publish (via `materializeAgentPackageToDisk`)
  // atomically replaces the whole slug dir, which removes this marker.
  //
  // Slug-dir resolution: the canonical layout writes to
  // `<root>/cinatra/<slug>/cinatra/oas.json` (target.dir ends in `/cinatra`),
  // so `dirname(target.dir)` is the slug dir. The legacy-flat layout
  // writes to `<root>/<legacy-slug>/agent.json`, where
  // `target.dir` IS the slug dir — `dirname` would wrongly point at the
  // install root. Detect by checking the trailing `cinatra/` segment.
  // (
  // by reload discovery, but we want the marker placement correct in case
  // they ever are, AND to keep the file alongside the agent's own dir.)
  // Failure is non-fatal — the OAS write itself succeeded.
  try {
    const slugDir = target.dir.endsWith(`${sep}cinatra`)
      ? dirname(target.dir)
      : target.dir;
    const inProgressPath = join(slugDir, ".cinatra-in-progress.json");
    const inProgressBody = {
      packageSlug,
      lastEditAt: new Date().toISOString(),
    };
    await writeFile(
      inProgressPath,
      JSON.stringify(inProgressBody, null, 2) + "\n",
      "utf8",
);
  } catch (err) {
    console.warn(
      `[agent_source_write] failed to write in-progress marker (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }`,
);
  }
  return { path: target.relPath, written: true };
}

// ---------------------------------------------------------------------------
// agent_source_write_files
// ---------------------------------------------------------------------------

async function handleAgentBuilderGitWriteFiles(
  request: PrimitiveRequest<{
    packageSlug?: string;
    packageJson?: string;
    skillMd?: string;
    progressContext?: { runId: string };
  }>,
): Promise<unknown> {
  // Admin gate (mirrors handleAgentBuilderGitWrite — same rationale: the
  // non-delegated /api/agents/passthrough surface uses these handlers WITHOUT
  // the relay policy, so the handler-level admin check is the primary gate).
  const isAdmin = await resolveIsPlatformAdminFromSession(
    request.actor as { platformRole?: string } | undefined,
  );
  if (!isAdmin) {
    return { error: "Unauthorized — admin session required to write files." };
  }
  // hard pre-enqueue preflight at the write boundary.
  // See handleAgentBuilderGitWrite — same gate, applied to write_files too.
  //
  const writePreflight = await runAgentSourceWritePreflightIfPinned();
  if (writePreflight && !writePreflight.ok) {
    return {
      error: `agent_source_write_files blocked by preflight (${writePreflight.errors.map((e) => e.code).join(", ")}): ${writePreflight.errors.map((e) => e.message).join(" / ")}`,
    };
  }

  const { packageSlug, packageJson, skillMd } = request.input;

  if (!packageSlug || typeof packageSlug !== "string") return { error: "packageSlug is required." };
  if (!packageJson || typeof packageJson !== "string") return { error: "packageJson is required (JSON string)." };
  if (!skillMd || typeof skillMd !== "string") return { error: "skillMd is required (Markdown string)." };

  if (packageSlug.includes("..") || packageSlug.includes("/") || packageSlug.includes("\\")) {
    return { error: "packageSlug must not contain path separators or '..'." };
  }

  let parsedPackageJson: Record<string, unknown>;
  try {
    const raw = JSON.parse(packageJson);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { error: "packageJson must be a JSON object." };
    }
    parsedPackageJson = raw as Record<string, unknown>;
  } catch {
    return { error: "packageJson is not valid JSON." };
  }

  // sibling-file credential scan (in-memory,).
  // Runs BEFORE the disk write. If the operator/LLM tried to bake a credential
  // into package.json scripts or SKILL.md body, we reject the entire write.
  // This block scans raw strings — independent of `parsedPackageJson` — so it
  // composes safely with the name-rescoping and cinatra-block
  // normalization that run after it. Running it first puts the
  // earliest credential gate at the top of the write path.
  {
    const inMemBlockers: ReviewFinding[] = [];
    for (const [relPath, content] of [["package.json", packageJson], [`skills/${packageSlug}/SKILL.md`, skillMd]]) {
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        const pattern = detectCredentialPattern(line);
        if (pattern) {
          inMemBlockers.push({
            code: "literal_credential_in_sibling_file",
            severity: "blocker",
            message: `literal credential detected in ${relPath}:${i + 1}: pattern=${pattern}`,
            location: `${relPath}:${i + 1}`,
            source: "deterministic",
          });
        }
      }
    }
    if (inMemBlockers.length > 0) {
      return {
        error: `Refusing to write package files — ${inMemBlockers.length} literal credential${inMemBlockers.length === 1 ? "" : "s"} detected in package.json or SKILL.md. Move credentials to /settings/connections (Nango).`,
        code: "review_blocked",
        blockers: inMemBlockers,
      };
    }
  }

  // server-side rescope `package.json#name`
  // to the operator's instance namespace. The chat LLM often emits a stale
  // "@cinatra-ai/<slug>" or "@cinatra/<slug>" name even when the operator's
  // vendor namespace is different (e.g. "@acme"); that creates a
  // manifest/origin scope mismatch at publish time. Force `name` to
  // "@<vendorName>/<packageSlug>" so the disk slug, package name, and
  // published scope can never drift apart. Default vendorName is
  // "cinatra-ai" when readInstanceIdentity() is empty, matching the
  // publish-side scope derivation.
  //
  // Keep the sibling-credential scan here; scope normalization is handled by
  // the canonical rescoping logic and the simpler `installRoot/agentRoot`
  // path below.
  const identity = readInstanceIdentity();
  const vendorName = identity
    ? ((identity as { vendorName?: string; instanceNamespace?: string }).vendorName ??
       (identity as { vendorName?: string; instanceNamespace?: string }).instanceNamespace ??
       "cinatra-ai")
    : "cinatra-ai";
  const normalizedPackageName = `@${vendorName}/${packageSlug}`;
  // fail loudly at authoring time if the chat/LLM tried to
  // name an agent with a reserved workspace package slug (only bites the
  // canonical @cinatra-ai scope; operator-vendor scopes have no collision).
  assertNotReservedAgentPackageName(normalizedPackageName);
  const incomingName = typeof parsedPackageJson.name === "string" ? parsedPackageJson.name : null;
  let nameNormalized: { from: string | null; to: string } | null = null;
  if (incomingName !== normalizedPackageName) {
    nameNormalized = { from: incomingName, to: normalizedPackageName };
    // Sanitize the warn-log: incoming name could be arbitrary LLM output.
    const sanitizeFrom = (v: string | null): string => v === null ? "<missing>" : v.slice(0, 80);
    console.warn(
      `[agent_source_write_files] Rescoping package.json#name for "${packageSlug}":`,
      { from: sanitizeFrom(incomingName), to: normalizedPackageName },
);
  }
  parsedPackageJson.name = normalizedPackageName;

  // server-side normalize the `cinatra` block.
  // The LLM frequently emits package.json without a `cinatra` block at all,
  // which makes the marketplace `?tab=agent` filter exclude the package
  // (marketplace card meta.kind is null without cinatra.kind, so
  // m.kind !== "agent" hides the card). Force kind + apiVersion regardless
  // of what the LLM emitted — this pipeline is agent-only; coercing a stale
  // "skill" or missing kind to "agent" is the safer default for chat-created
  // packages. Same shape applied at publish time for defense-in-depth.
  // Composed with the name-rescoping above: name-rescoping runs first, then cinatra-block
  // normalization — they touch independent keys of parsedPackageJson and the
  // order doesn't matter, but keeping name-first matches the publish-time
  // ordering at actions.ts:393-398.
  const incomingCinatra = parsedPackageJson.cinatra;
  const cinatraBlock: Record<string, unknown> =
    incomingCinatra && typeof incomingCinatra === "object" && !Array.isArray(incomingCinatra)
      ? { ...(incomingCinatra as Record<string, unknown>) }
      : {};
  let cinatraNormalized: { kind?: { from: unknown; to: string }; apiVersion?: { from: unknown; to: string } } | null = null;
  if (cinatraBlock.kind !== "agent") {
    cinatraNormalized = cinatraNormalized ?? {};
    cinatraNormalized.kind = { from: cinatraBlock.kind ?? null, to: "agent" };
    cinatraBlock.kind = "agent";
  }
  if (cinatraBlock.apiVersion !== "cinatra.ai/v1") {
    cinatraNormalized = cinatraNormalized ?? {};
    cinatraNormalized.apiVersion = { from: cinatraBlock.apiVersion ?? null, to: "cinatra.ai/v1" };
    cinatraBlock.apiVersion = "cinatra.ai/v1";
  }
  parsedPackageJson.cinatra = cinatraBlock;
  if (cinatraNormalized) {
    // Sanitize log: never echo a verbatim object/string value the LLM emitted.
    //
    const sanitizeFrom = (v: unknown): string => {
      if (v === null || v === undefined) return "<missing>";
      if (typeof v === "string") return v.slice(0, 40);
      return `<non-string: ${typeof v}>`;
    };
    console.warn(
      `[agent_source_write_files] Normalized package.json#cinatra for "${packageSlug}":`,
      {
        kind: cinatraNormalized.kind ? { from: sanitizeFrom(cinatraNormalized.kind.from), to: cinatraNormalized.kind.to } : undefined,
        apiVersion: cinatraNormalized.apiVersion ? { from: sanitizeFrom(cinatraNormalized.apiVersion.from), to: cinatraNormalized.apiVersion.to } : undefined,
      },
);
  }

  // writing_files milestone (preflight passed + inputs validated;
  // no-op unless progressContext threaded + HumanUser actor).
  await emitWritingFilesIfThreaded(
    request.input.progressContext,
    request.actor,
    packageSlug,
);

  // new canonical layout: <installDir>/cinatra/<slug>/
  const installRoot = resolveAgentInstallDir();
  const agentRoot = join(installRoot, "cinatra-ai", packageSlug);
  const packageJsonPath = join(agentRoot, "package.json");
  const skillMdPath = join(agentRoot, "skills", packageSlug, "SKILL.md");

  try {
    await mkdir(agentRoot, { recursive: true });
    // cinatra/ dir kept — oas.json (written by handleAgentBuilderGitWrite) needs it.
    await mkdir(join(agentRoot, "cinatra"), { recursive: true }); // INNER pkg dir (oas.json) — not vendor
    await mkdir(join(agentRoot, "skills", packageSlug), { recursive: true });

    await writeFile(packageJsonPath, JSON.stringify(parsedPackageJson, null, 2) + "\n", "utf8");
    await writeFile(skillMdPath, skillMd, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Best-effort cleanup so a failed write doesn't leave a partial directory behind.
    await rm(agentRoot, { recursive: true, force: true }).catch(() => {});
    return { error: `Failed to write files: ${message}` };
  }

  return {
    written: true,
    paths: {
      packageJson: relative(process.cwd(), packageJsonPath),
      skillMd: relative(process.cwd(), skillMdPath),
    },
    // surface the rescope so the chat assistant can correct
    // future writes and explain the change to the user. Omitted when the
    // incoming name already matched the canonical shape.
    ...(nameNormalized ? { nameNormalized } : {}),
  };
}

// ---------------------------------------------------------------------------
// agent_source_validate
// ---------------------------------------------------------------------------

async function handleAgentBuilderGitValidate(
  request: PrimitiveRequest<{ content?: string; packageSlug?: string }>,
): Promise<unknown> {
  let { content } = request.input;
  const { packageSlug } = request.input;

  // Convenience for the chat-driven authoring flow — when the caller has
  // just written an oas.json via agent_source_write, they should be able
  // to pass `packageSlug` and have validate auto-load the file from disk
  // instead of having to thread the JSON content back through the LLM
  // (which is a frequent failure mode — the LLM forgets `content` and
  // sends only `packageSlug`, getting "content is required").
  if (!content && typeof packageSlug === "string" && packageSlug.length > 0) {
    if (packageSlug.includes("..") || packageSlug.includes("/") || packageSlug.includes("\\")) {
      return { valid: false, errors: ["packageSlug must not contain path separators or '..'."] };
    }
    const resolved = resolveAgentJsonPathForRead(packageSlug);
    if (!resolved) {
      return {
        valid: false,
        errors: [
          `Agent file not found for slug "${packageSlug}". Use agent_source_write first, or pass content directly.`,
        ],
      };
    }
    try {
      content = await readFile(resolved.path, "utf8");
    } catch (err) {
      return {
        valid: false,
        errors: [
          `Failed to read ${resolved.relPath}: ${(err as Error).message}`,
        ],
      };
    }
  }

  if (!content || typeof content !== "string") {
    return {
      valid: false,
      errors: ["content (JSON string) or packageSlug is required."],
    };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return { valid: false, errors: ["content is not valid JSON."] };
  }

  const errors = validateOasAgentJson(parsed);
  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// agent_source_review
// ---------------------------------------------------------------------------
//
// single review surface for chat-driven agent authoring.
// Runs the deterministic lint server-side and partitions findings by
// severity. In advisory mode, emits one
// `advisory_dispatch_deferred` suggestion per helper that would have been
// dispatched and returns `ranAdvisoryAgents: []`. agent_run queues via
// BullMQ and cannot return findings inline; synchronous helper execution
// is out of scope.
//
// Contracts:
// - reviewMode: 2-mode ("deterministic" | "advisory") — no 3-mode.
// - Advisory short-circuits when deterministic blockers exist (no deferred
//   markers emitted on that path either — the gate decision wins).
// - Triviality predicate (isTrivialOas) omits the agent-planner deferred
//   marker for simple OAS; other helpers still get markers in advisory mode.
// - Actor envelope threads unchanged — no `as never` / `as unknown` casts.
// - Gate is idempotent: byte-identical inputs produce byte-identical
//   blockers across re-runs (runDeterministicReview is pure).
//
// Helper agents (the resolver) are identified by these packageNames. The slug ->
// scoped-name mapping mirrors the extensions/cinatra-ai/ directory layout — each
// helper agent is published under @cinatra-ai/<slug>.
const ADVISORY_HELPER_SLUGS = [
  "agent-planner",
  "agent-security-reviewer",
  "agent-code-reviewer",
] as const;
type AdvisoryHelperSlug = (typeof ADVISORY_HELPER_SLUGS)[number];

/**
 * Pure deterministic review: aggregates the three scan functions from
 * validate-agent-json.ts and partitions by severity. All v1 scans emit
 * severity: "blocker", so warnings/suggestions are currently empty for
 * the deterministic surface — future scans may emit other severities.
 *
 *
 * author-controlled allow-list that downgraded `untrusted_external_url`
 * blockers to warnings. Author-supplied OAS metadata MUST NOT be able to
 * defang a security finding — that's a publish-gate bypass. A future
 * server-side allow-list (managed in code or config, not in OAS) is the
 * correct path if specific MCPToolBox URLs need to be permitted.
 *
 * IDEMPOTENCE: pure function over a single parsed OAS. Calling twice on
 * byte-identical input yields byte-identical arrays (no Date.now(), no
 * randomUUID, no side effects).
 */
export function runDeterministicReview(parsedOas: Record<string, unknown>): {
  blockers: ReviewFinding[];
  warnings: ReviewFinding[];
  suggestions: ReviewFinding[];
} {
  const findings: ReviewFinding[] = [
    ...scanOasForLiteralSecrets(parsedOas),
    ...scanOasForUntrustedUrls(parsedOas),
    ...scanOasForLlmBridgeWiring(parsedOas),
    // review-gate parity for the LLM
    // metadata scanner. Compile-gate already calls this scanner; without
    // mirroring it here, `agent_source_review` returns clean and the
    // immediately-following `agent_source_compile` rejects on the same OAS.
    ...scanOasForLlmMetadata(parsedOas),
    // Warning-only HITL scanner: NOT
    // wired into `validateOasAgentJson()` (hard gate) because some agents
    // legitimately accept programmatic-only StartNode inputs (orchestrators
    // wire values via sub-flow DataFlowEdges). Surfacing via
    // `agent_source_review` so the chat assistant catches the missing-
    // metadata.cinatra.required pattern that silently dropped the user's
    // `webpage-image-count` URL prompt.
    ...scanOasForStartNodeInputsWithoutRequired(parsedOas),
  ];
  const blockers: ReviewFinding[] = [];
  const warnings: ReviewFinding[] = [];
  const suggestions: ReviewFinding[] = [];
  for (const f of findings) {
    if (f.severity === "blocker") blockers.push(f);
    else if (f.severity === "warning") warnings.push(f);
    else suggestions.push(f);
  }
  return { blockers, warnings, suggestions };
}

/**
 * Triviality predicate. Trivial OAS skips the agent-planner
 * advisory dispatch.
 *
 * Trivial iff ALL of:
 * - zero InputMessageNode entries (no HITL)
 * - zero FlowNode entries (no subflow)
 * - zero A2AAgent entries (no peer agent invocation)
 * - zero MCPToolBox entries with a non-cinatra id/name (no external MCP)
 * - at most ONE executable step (AgentNode-backed-by-Agent OR ApiNode).
 *   OutputMessageNode does NOT count toward this quota — it is structural.
 */
function isTrivialOas(parsedOas: Record<string, unknown>): boolean {
  const refs = parsedOas["$referenced_components"];
  if (!refs || typeof refs !== "object") {
    // No referenced components — degenerate / minimal. Treat as trivial.
    return true;
  }
  let executableSteps = 0;
  for (const value of Object.values(refs as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    const type = entry["component_type"];
    if (typeof type !== "string") continue;
    if (type === "InputMessageNode") return false;
    if (type === "FlowNode") return false;
    if (type === "A2AAgent") return false;
    if (type === "MCPToolBox") {
      // External iff neither id nor name starts with "cinatra-". The internal
      // cinatra-mcp toolbox is the only one that is always-trivial.
      const id = typeof entry["id"] === "string" ? (entry["id"] as string) : "";
      const name =
        typeof entry["name"] === "string" ? (entry["name"] as string) : "";
      const isCinatraInternal =
        id.startsWith("cinatra-") || name.startsWith("cinatra-");
      if (!isCinatraInternal) return false;
    }
    if (type === "AgentNode") {
      // AgentNode is only executable when it has an embedded Agent (with
      // system_prompt etc.) — the test fixture binds it via
      // { agent: { $component_ref: "inner_agent" } }. Count any
      // AgentNode that carries an `agent` field as an executable LLM step.
      if (entry["agent"]) executableSteps += 1;
    }
    if (type === "ApiNode") {
      executableSteps += 1;
    }
  }
  return executableSteps <= 1;
}

async function handleAgentSourceReview(
  request: PrimitiveRequest<{
    packageSlug?: string;
    content?: string;
    reviewMode: "deterministic" | "advisory";
  }>,
): Promise<{
  blockers: ReviewFinding[];
  warnings: ReviewFinding[];
  suggestions: ReviewFinding[];
  ranAdvisoryAgents: string[];
}> {
  const { packageSlug, content, reviewMode } = request.input;

  // ---- Load parsedOas from either packageSlug or content. -----------------
  let rawContent: string | undefined = content;
  if (!rawContent && typeof packageSlug === "string" && packageSlug.length > 0) {
    if (
      packageSlug.includes("..") ||
      packageSlug.includes("/") ||
      packageSlug.includes("\\")
) {
      return {
        blockers: [
          {
            code: "invalid_package_slug",
            severity: "blocker",
            message:
              "packageSlug must not contain path separators or '..'.",
            source: "deterministic",
          },
        ],
        warnings: [],
        suggestions: [],
        ranAdvisoryAgents: [],
      };
    }
    const resolved = resolveAgentJsonPathForRead(packageSlug);
    if (!resolved) {
      return {
        blockers: [
          {
            code: "agent_not_found",
            severity: "blocker",
            message: `Agent file not found for slug "${packageSlug}". Use agent_source_write first, or pass content directly.`,
            source: "deterministic",
          },
        ],
        warnings: [],
        suggestions: [],
        ranAdvisoryAgents: [],
      };
    }
    try {
      rawContent = (await readFile(resolved.path, "utf8")) as string;
    } catch (err) {
      return {
        blockers: [
          {
            code: "agent_read_failed",
            severity: "blocker",
            message: `Failed to read ${resolved.relPath}: ${(err as Error).message}`,
            source: "deterministic",
          },
        ],
        warnings: [],
        suggestions: [],
        ranAdvisoryAgents: [],
      };
    }
  }

  if (!rawContent || typeof rawContent !== "string") {
    return {
      blockers: [
        {
          code: "missing_input",
          severity: "blocker",
          message: "Provide exactly one of packageSlug or content.",
          source: "deterministic",
        },
      ],
      warnings: [],
      suggestions: [],
      ranAdvisoryAgents: [],
    };
  }

  let parsedOas: Record<string, unknown>;
  try {
    parsedOas = JSON.parse(rawContent) as Record<string, unknown>;
  } catch (err) {
    return {
      blockers: [
        {
          code: "invalid_json",
          severity: "blocker",
          message: `content is not valid JSON: ${(err as Error).message}`,
          source: "deterministic",
        },
      ],
      warnings: [],
      suggestions: [],
      ranAdvisoryAgents: [],
    };
  }

  // ---- Run deterministic lint. -------------------------------------------
  const deterministic = runDeterministicReview(parsedOas);

  // When the caller passed packageSlug, also scan sibling files
  // (SKILL.md, package.json, scripts, etc.) for literal credentials.
  // agent_source_review is documented as the single authoring review
  // surface; if it stays OAS-only, users get clean output here but fail
  // at compile/publish.
  if (packageSlug) {
    //
    // content), validate it before using it for FS access. Guard against
    // path-traversal regardless of caller.
    if (packageSlug.includes("..") || packageSlug.includes("/") || packageSlug.includes("\\")) {
      return {
        blockers: [
          {
            code: "invalid_package_slug",
            severity: "blocker" as const,
            message: "packageSlug must not contain path separators or ..\.",
            source: "deterministic" as const,
          },
        ],
        warnings: [],
        suggestions: [],
        ranAdvisoryAgents: [],
      };
    }
    const agentRootForSiblingScan = resolveAgentRootDirForRead(packageSlug);
    if (agentRootForSiblingScan) {
      const siblingFindings = await scanPackageSiblingFilesForLiteralSecrets(agentRootForSiblingScan);
      for (const f of siblingFindings) {
        if (f.severity === "blocker") deterministic.blockers.push(f);
        else if (f.severity === "warning") deterministic.warnings.push(f);
        else deterministic.suggestions.push(f);
      }
    }
  }

  // Deterministic-only mode: return immediately. No advisory dispatch.
  if (reviewMode === "deterministic") {
    return {
      blockers: [...deterministic.blockers],
      warnings: [...deterministic.warnings],
      suggestions: [...deterministic.suggestions],
      ranAdvisoryAgents: [],
    };
  }

  // Advisory mode: short-circuit on blockers (no helper dispatch when the
  // OAS is already known to be unsafe).
  if (deterministic.blockers.length > 0) {
    return {
      blockers: [...deterministic.blockers],
      warnings: [...deterministic.warnings],
      suggestions: [...deterministic.suggestions],
      ranAdvisoryAgents: [],
    };
  }

  // Advisory mode: build helper list. Always include security-reviewer +
  // code-reviewer; include planner iff OAS is non-trivial.
  const helpersToDispatch: AdvisoryHelperSlug[] = [
    "agent-security-reviewer",
    "agent-code-reviewer",
  ];
  if (!isTrivialOas(parsedOas)) {
    helpersToDispatch.push("agent-planner");
  }

  // ─────────────────────────────────────────────────────────────────────
  //
  //
  // Production advisory dispatch is structurally broken: `agent_run` queues
  // a BullMQ job and returns `{ runId, status: "queued" }` synchronously —
  // it does NOT return helper findings. The earlier implementation tried to
  // read `entry.value.result` from the invokePrimitive return value, but
  // that field never exists; the tests passed only because they mocked the
  // wrong shape.
  //
  // Two options were considered:
  //   A) Wait synchronously for the queued run to finish (poll the run
  //      record). That introduces unbounded latency into a chat-assistant
  //      tool call.
  //   B) Wire a separate synchronous helper-execution surface (e.g. a
  //      direct call into `/api/llm-bridge` against the helper's OAS body).
  //      That's a real architectural addition — out of scope.
  //
  // For v1 we ship the deterministic-only path (which is the meat of
  // the lint that catches credentials, missing agent_id,
  // untrusted MCP URLs) and emit a clear deferred-marker suggestion per
  // helper that WOULD have been dispatched. The chat assistant sees the
  // deferred markers; the deterministic findings are unaffected.
  //
  // `ranAdvisoryAgents` is empty — we are honest about what actually
  // executed. A future change will implement synchronous helper execution
  // and turn this into a real dispatch; the test suite reflects the
  // current stub contract.
  // ─────────────────────────────────────────────────────────────────────
  const advisoryDeferredSuggestions: ReviewFinding[] = helpersToDispatch.map(
    (slug) => ({
      code: "advisory_dispatch_deferred",
      severity: "suggestion",
      message: `Advisory helper "${slug}" was eligible for dispatch but is deferred in v1 (synchronous helper execution wiring is out of scope for ; agent_run queues via BullMQ and cannot return findings inline). Deterministic lint findings above are authoritative for blocker decisions.`,
      source: slug as ReviewFinding["source"],
    }),
);

  return {
    blockers: [...deterministic.blockers],
    warnings: [...deterministic.warnings],
    suggestions: [
      ...deterministic.suggestions,
      ...advisoryDeferredSuggestions,
    ],
    ranAdvisoryAgents: [],
  };
}

// ---------------------------------------------------------------------------
// agent_source_compile
// ---------------------------------------------------------------------------

async function handleAgentBuilderGitCompileAndWrite(
  request: PrimitiveRequest<{ packageSlug?: string }>,
): Promise<unknown> {
  // Admin gate — `agent_source_compile` mutates live `agent_templates` by
  // package name (the compiled OAS syncs into the published template row),
  // so a non-admin reaching this handler would mutate live runtime state.
  // The delegated-chat policy denies this tool for everyone (not on
  // allowlist), but /api/agents/passthrough bypasses the relay — handler
  // gate is the primary block there. Mirrors publish.
  const isAdmin = await resolveIsPlatformAdminFromSession(
    request.actor as { platformRole?: string } | undefined,
  );
  if (!isAdmin) {
    return { error: "Unauthorized — admin session required to compile." };
  }
  const { packageSlug } = request.input;
  if (!packageSlug || typeof packageSlug !== "string") {
    return { error: "packageSlug is required." };
  }
  // Path traversal guard
  if (packageSlug.includes("..") || packageSlug.includes("/") || packageSlug.includes("\\")) {
    return { error: "packageSlug must not contain path separators or '..'." };
  }

  // prefer agents/{slug}/cinatra/agent.json; fall back to legacy flat path.
  const resolved = resolveAgentJsonPathForRead(packageSlug);
  if (!resolved) {
    return {
      error: `Agent file not found: agents/${packageSlug}/cinatra/agent.json. Use agent_source_write to create it first.`,
    };
  }
  const agentJsonPath = resolved.path;

  // Read existing agent.json
  let raw: string;
  try {
    raw = (await readFile(agentJsonPath, "utf8")) as string;
  } catch {
    return {
      error: `Agent file not found: ${resolved.relPath}. Use agent_source_write to create it first.`,
    };
  }

  let agentContent: Record<string, unknown>;
  try {
    agentContent = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { error: `${resolved.relPath} is not valid JSON.` };
  }

  // review_blocked gate. Runs the deterministic review BEFORE
  // compileOasAgentJson + writeFile so a fixture with blockers never produces
  // side effects on disk or in the DB. Returns the structured rejection shape
  // (extends existing { error: string } with code + blockers) so callers can
  // discriminate review failures from other compile errors. Idempotent —
  // runDeterministicReview is pure.
  {
    const review = runDeterministicReview(agentContent);
    if (review.blockers.length > 0) {
      return {
        error: `agent.json failed review (${review.blockers.length} blocker${review.blockers.length === 1 ? "" : "s"}): ${review.blockers.map((b) => b.message).join("; ")}`,
        code: "review_blocked",
        blockers: review.blockers,
      };
    }
  }

  // sibling-file scan . The OAS gate
  // above scans oas.json shape; this one scans every other text file in the
  // package dir (SKILL.md, package.json, scripts/, etc.). Blocks non-example
  // .env* files outright. Runs before compileOasAgentJson side effects.
  {
    const agentRootForSiblingScan = resolveAgentRootDirForRead(packageSlug);
    if (agentRootForSiblingScan) {
      const siblingFindings = await scanPackageSiblingFilesForLiteralSecrets(agentRootForSiblingScan);
      const siblingBlockers = siblingFindings.filter((f) => f.severity === "blocker");
      if (siblingBlockers.length > 0) {
        return {
          error: `Package sibling-file review failed (${siblingBlockers.length} blocker${siblingBlockers.length === 1 ? "" : "s"}): ${siblingBlockers.map((b) => b.message).join("; ")}`,
          code: "review_blocked",
          blockers: siblingBlockers,
        };
      }
    }
  }

  // compile-and-write is now a sync-to-DB operation. The agent.json
  // is authored as compact OAS Flow; the "compile" step is running the OAS
  // compiler to derive legacy graphInput shapes and pushing them to the DB row.
  // Resolve packageName from the sibling package.json so the compiler can find it.
  let agentPackageName: string = packageSlug;
  let agentPackageVersion: string | null = null;
  // probe new canonical, then legacy via resolveAgentRootDirForRead.
  const agentRootForCompile = resolveAgentRootDirForRead(packageSlug);
  if (agentRootForCompile) {
    try {
      const pkgRaw = await readFile(join(agentRootForCompile, "package.json"), "utf8");
      const pkg = JSON.parse(pkgRaw as string) as { name?: string; version?: string };
      if (pkg.name) agentPackageName = pkg.name;
      if (pkg.version) agentPackageVersion = pkg.version;
    } catch {
      /* use slug fallback */
    }
  }

  const compileResult = await compileOasAgentJson({ packageName: agentPackageName });
  if (!compileResult.ok) {
    return { error: `agent.json could not be compiled: ${compileResult.error}` };
  }
  const compiled = compileResult.value;

  // fan `metadata.cinatra.llm` out to every
  // `/api/llm-bridge` ApiNode in `agentContent` (top-level + every FlowNode-
  // embedded subflow) so the on-disk file carries the per-node `cinatra_llm`
  // that the org-scope guard's bridge route reads at runtime. No-op when the OAS does
  // not declare `metadata.cinatra.llm` (back-compat). Idempotent —
  // injectCinatraLlmIntoApiNodes preserves any pre-existing cinatra_llm
  // value on a node.
  {
    const llmMetadata = (agentContent.metadata as
      | { cinatra?: { llm?: OasCinatraLlm } }
      | undefined)?.cinatra?.llm;
    injectCinatraLlmIntoApiNodes(agentContent, llmMetadata);
  }

  // The agent.json on disk is already canonical OAS; the write-back persists
  // the  `cinatra_llm` injection above when the OAS declares the
  // policy block. Pre- OAS files round-trip byte-for-byte.
  const updatedRaw = JSON.stringify(agentContent, null, 2);
  try {
    await writeFile(agentJsonPath, updatedRaw, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to write updated agent.json: ${message}` };
  }

  // Register agent skills in the skills catalog so they are discoverable via skill_ids.
  const registeredSkillIds: string[] = [];
  try {
    // Sync packageVersion + compiled approvalPolicy + inputSchema + outputSchema
    // + prompt (as taskSpec) to the DB template so subsequent runs reflect the
    // current on-disk OAS Flow.
    {
      try {
        const template = await readAgentTemplateByPackageName(agentPackageName);
        if (template) {
          if (agentPackageVersion) {
            await updateAgentTemplatePackageVersion(template.id, agentPackageVersion);
          }
          await updateAgentTemplate(template.id, {
            approvalPolicy: compiled.approvalPolicy as Parameters<typeof updateAgentTemplate>[1]["approvalPolicy"],
            inputSchema: compiled.inputSchema as Parameters<typeof updateAgentTemplate>[1]["inputSchema"],
            outputSchema: (compiled.outputSchema ?? undefined) as Parameters<typeof updateAgentTemplate>[1]["outputSchema"] | undefined,
            taskSpec: compiled.prompt ?? undefined,
            hitlScreens: compiled.hitlScreens,
            type: compiled.type,
            // Persist triggerMode + gatedSteps so the runtime gate and
            // Trigger tab UI can
            // read them directly from agent_templates without recompiling.
            triggerMode: compiled.triggerMode,
            gatedSteps: compiled.gatedSteps,
          });
        }
      } catch (versionSyncErr) {
        console.warn(`[agent_source_compile] DB sync failed:`, versionSyncErr);
      }
    }

    // skills dir lives next to the agent root (handles both new
    // canonical and legacy layouts via resolveAgentRootDirForRead).
    const agentRootForSkills = resolveAgentRootDirForRead(packageSlug);
    const skillsDir = agentRootForSkills ? join(agentRootForSkills, "skills") : null;
    let skillEntries: { isDirectory(): boolean; name: string }[] = [];
    if (skillsDir) {
      try {
        skillEntries = await readdir(skillsDir, { withFileTypes: true, encoding: "utf8" });
      } catch {
        skillEntries = [];
      }
    }

    for (const entry of skillEntries) {
      if (!entry.isDirectory()) continue;
      if (!skillsDir) continue;
      const skillMdPath = join(skillsDir, entry.name, "SKILL.md");
      let skillContent: string;
      try {
        skillContent = await readFile(skillMdPath, "utf8") as string;
      } catch { continue; }

      const { attributes } = parseFrontmatter(skillContent);
      const skillName = (attributes as Record<string, string>).name || entry.name;
      const skillDesc = (attributes as Record<string, string>).description || "";

      // Compute the deterministic skillId using packageSlug (e.g. "email-outreach")
      // so skills land at data/skills/email-outreach/ and update in-place on every
      // compile run instead of creating a new record with an incremented suffix.
      const slugify = (v: string) => v.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      const packageId = `custom:${slugify(packageSlug)}`;
      const existingSkillId = `${packageId}:${slugify(skillName)}`;

      try {
        const registered = await upsertSkill({
          // Register as level: "agent" so the skill lands at
          // data/skills/~agent/{slugified-npm-name}/{skillSlug}/SKILL.md instead
          // of the generic system path. upsertSkill derives skillSlug as the
          // last colon-segment of skillId when type === "agent".
          type: "agent",
          // packageName carries the npm-scoped name so
          // upsertSkill's slugify produces "cinatra-agents-<slug>" for the
          // ~agent/{packageSlug}/ segment on disk.
          packageName: agentPackageName,
          // Stamp the catalog row's agentId field with the
          // npm-scoped package name from agents/<slug>/package.json#name so
          // getAssignedSkillIdsForAgent can resolve the agent <-> skill link
          // declaratively.
          agentId: agentPackageName,
          name: skillName,
          description: skillDesc,
          content: skillContent,
          // Pitfall 4: existingSkillId uses slugify(packageSlug) — KEEP
          // unchanged so the skill ID stays byte-identical with legacy
          // catalog rows. Never re-derive from agentPackageName here.
          // The type === "agent" disk-path branch extracts skillSlug from
          // this ID's last colon segment.
          skillId: existingSkillId,
          // Agent SKILL.md files are tool execution instructions, not
          // user-facing chat badges — suppress prefill text generation.
          prefillText: "-",
        });
        registeredSkillIds.push(registered.id);
      } catch (skillErr) {
        console.warn(`[agent_source_compile] Failed to upsert skill ${entry.name}:`, skillErr);
      }
    }
  } catch (skillsErr) {
    console.warn(`[agent_source_compile] Skill registration skipped:`, skillsErr);
  }

  return {
    path: resolved.relPath,
    compiledPlan: compiled.compiledPlan,
    prompt: compiled.prompt,
    type: compiled.type,
    registeredSkillIds,
  };
}

// ---------------------------------------------------------------------------
// agent_source_publish
// ---------------------------------------------------------------------------

async function handleAgentBuilderGitPublish(
  request: PrimitiveRequest<{
    packageSlug?: string;
    changelog?: string;
    /** publish destination; defaults to "private". the runtime gate wires
     *  resolvePublishDestination(destination) at the call site below. */
    destination?: "private" | "public";
    /** set true after user acknowledges LicenseWarningDialog for copyleft. */
    licenseAcknowledged?: boolean;
  }>,
): Promise<unknown> {
  // (admin gate BEFORE resolvePublishDestination.
  // The caller must run an auth gate; the MCP registration loop
  // applies no per-tool role enforcement, so we guard explicitly here.
  //
  // The canonical role gate for publish is the `requireAccess`
  // primitive against `marketplace_template::publish`, which the central registry
  // classifies with `requireRole: "release_manager"`. We KEEP the existing
  // `platform_admin` path as an additional allow so current admins are NOT locked
  // out — `actorHoldsRole(actor, "release_manager")` does NOT special-case
  // platform_admin (it only matches platform_admin/org_owner/org_admin/member),
  // so a publish routed *purely* through `requireAccess` would deny an admin who
  // lacks an explicit release_manager grant. Admins therefore bypass
  // `requireAccess`; non-admins must satisfy the release_manager role gate.
  //
  // Audit contract:
  //   - admin allow      → explicit logAuditEvent decision:"allowed"
  //   - release_manager  → requireAccess emits decision:"allowed"
  //   - denial           → requireAccess emits decision:"denied"; we also emit an
  //                        explicit denial audit when the actor is neither admin
  //                        nor a release_manager (defense-in-depth + uniform
  //                        attribution at this gate).
  const isAdmin = await resolveIsPlatformAdminFromSession(
    request.actor as { platformRole?: string } | undefined,
);
  {
    const gateActor = request.actor as
      | (PrimitiveActorContext & {
          orgId?: string | null;
          orgRole?: "org_owner" | "org_admin" | "member";
          platformRole?: "platform_admin" | "member";
          teamIds?: string[];
          projectGrants?: unknown[];
          projectIds?: string[];
          roles?: string[];
        })
      | undefined;
    const gatePackageSlug =
      typeof request.input?.packageSlug === "string" ? request.input.packageSlug : undefined;
    // ResourceRef.resourceId is required (non-optional). Fall back to a
    // sentinel when packageSlug is absent — the existing post-gate validation
    // ("packageSlug is required.") still rejects the missing-slug case after
    // the auth gate has audited; the sentinel only feeds the authz resource ref.
    const gateResourceId = gatePackageSlug ?? "<unknown>";
    const gateOrgId =
      gateActor?.orgId ?? (await resolveOrgIdFromSession(gateActor)) ?? undefined;

    if (isAdmin) {
      // Admin superset allow — audit the allowed authz decision explicitly
      // (requireAccess is skipped to avoid locking out admins without an
      // explicit release_manager grant).
      void logAuditEvent({
        organizationId: gateOrgId,
        actorPrincipalId: gateActor?.userId,
        actorPrincipalType: (gateActor?.actorType as AuditEventInput["actorPrincipalType"]) ?? "human",
        authSource: (gateActor?.source as AuditEventInput["authSource"]) ?? "mcp",
        resourceType: "marketplace_template",
        resourceId: gatePackageSlug,
        operation: "publish",
        decision: "allowed",
        policyVersion: POLICY_VERSION,
        metadata: { via: "platform_admin" },
      });
    } else {
      // Non-admin: enforce the release_manager role gate via the canonical
      // requireAccess primitive. requireAccess emits its own allowed/denied
      // audit event; on deny it throws AuthzError, which we collapse to the
      // existing Unauthorized surface (after an explicit denial audit so the
      // gate attribution is uniform regardless of which wall denied).
      try {
        const { requireAccess } = await import("@/lib/authz/require-access");
        // The standard MCP actor envelope does NOT carry role grants (the MCP
        // actor builder omits them), so reading only gateActor.roles would deny a
        // real release_manager. Resolve the user's effective role names (org +
        // platform grants) and merge before the gate — mirroring the boundary's
        // own resolveEffectiveRoleNamesForUser usage.
        let gateRoles = gateActor?.roles ?? [];
        if (gateActor?.userId && gateOrgId) {
          try {
            const { resolveEffectiveRoleNamesForUser } = await import(
              "@/lib/authz/role-grant-store"
            );
            const resolved = await resolveEffectiveRoleNamesForUser(
              gateActor.userId,
              gateOrgId,
            );
            gateRoles = [...new Set([...gateRoles, ...resolved])];
          } catch {
            /* role store unreachable — fall back to the envelope roles */
          }
        }
        const synthActor = {
          principalType: "HumanUser" as const,
          principalId: gateActor?.userId ?? "anonymous",
          authSource: ((gateActor?.source as string) ?? "mcp") as "mcp",
          policyVersion: POLICY_VERSION,
          organizationId: gateOrgId,
          orgRole: gateActor?.orgRole,
          platformRole: gateActor?.platformRole,
          teamIds: gateActor?.teamIds ?? [],
          projectGrants: gateActor?.projectGrants ?? [],
          projectIds: gateActor?.projectIds ?? [],
          roles: gateRoles,
        };
        await requireAccess(
          synthActor as unknown as Parameters<typeof requireAccess>[0],
          {
            resourceType: "marketplace_template",
            resourceId: gateResourceId,
            organizationId: gateOrgId,
            ownerType: "organization",
            ownerId: gateOrgId,
          },
          "publish",
          { primitiveName: "agent_source_publish" },
);
      } catch (gateErr) {
        // requireAccess already emitted a decision:"denied" audit row. Emit an
        // explicit denial audit here too so the gate produces a uniform
        // attribution row, then collapse to the existing Unauthorized surface.
        void logAuditEvent({
          organizationId: gateOrgId,
          actorPrincipalId: gateActor?.userId,
          actorPrincipalType: (gateActor?.actorType as AuditEventInput["actorPrincipalType"]) ?? "human",
          authSource: (gateActor?.source as AuditEventInput["authSource"]) ?? "mcp",
          resourceType: "marketplace_template",
          resourceId: gatePackageSlug,
          operation: "publish",
          decision: "denied",
          policyVersion: POLICY_VERSION,
          metadata: {
            via: "requireAccess",
            code:
              gateErr instanceof AuthzError ? gateErr.reason : "release_manager_required",
          },
        });
        return { error: "Unauthorized — admin session required to publish." };
      }
    }
  }

  const { packageSlug, changelog, destination = "private", licenseAcknowledged = false } = request.input;
  if (!packageSlug || typeof packageSlug !== "string") {
    return { error: "packageSlug is required." };
  }
  if (packageSlug.includes("..") || packageSlug.includes("/") || packageSlug.includes("\\")) {
    return { error: "packageSlug must not contain path separators or '..'." };
  }

  // probe new canonical, then legacy via resolveAgentRootDirForRead.
  const agentDir = resolveAgentRootDirForRead(packageSlug);
  if (!agentDir) {
    return { error: `Agent directory not found for slug: ${packageSlug}` };
  }
  try {
    await readdir(agentDir);
  } catch {
    return { error: `Agent directory not readable: ${relative(process.cwd(), agentDir)}` };
  }

  // review_blocked gate. Reads agents/<slug>/cinatra/oas.json
  // (the publish handler does not otherwise load it — it passes the
  // directory to the Verdaccio publisher) and runs the deterministic review
  // BEFORE the SPDX license-detection block and the Verdaccio publisher.
  // Ordering note: review_blocked is the most specific failure mode for
  // content the operator authored themselves; surfacing it ahead of the
  // license-detection rejection gives faster, more actionable feedback. The
  // gate is admin-gated (the admin check ran above) so this does not leak
  // privileged info — only admins can reach it. Idempotent —
  // runDeterministicReview is pure. Failing to locate or parse oas.json is
  // non-fatal (legacy packages may not carry one yet) — the existing
  // license + publish-time validators still apply downstream.
  {
    const resolvedOas = resolveAgentJsonPathForRead(packageSlug);
    if (resolvedOas) {
      try {
        const oasRaw = (await readFile(resolvedOas.path, "utf8")) as string;
        const oasParsed = JSON.parse(oasRaw) as Record<string, unknown>;
        const review = runDeterministicReview(oasParsed);
        if (review.blockers.length > 0) {
          return {
            error: `agent.json failed review (${review.blockers.length} blocker${review.blockers.length === 1 ? "" : "s"}): ${review.blockers.map((b) => b.message).join("; ")}`,
            code: "review_blocked",
            blockers: review.blockers,
          };
        }
      } catch (gateErr) {
        // Read/parse failure — log and proceed. The license + publish
        // validators still gate the publish path downstream.
        console.warn(
          "[agent_source_publish] review gate skipped (read/parse failed):",
          gateErr,
);
      }
    }
  }

  // publish-side sibling-file scan .
  // The publisher copies the entire package dir into the tarball (verdaccio/
  // client.ts:393 — copyDir, no skip-list beyond top-level package.json/agent.json),
  // so we must scan everything that would ship. Blocks .env*, scans SKILL.md /
  // package.json / scripts / etc. for literal credentials. Runs BEFORE the
  // license-detection gate so review_blocked wins (same ordering rationale).
  {
    const siblingFindings = await scanPackageSiblingFilesForLiteralSecrets(agentDir);
    const siblingBlockers = siblingFindings.filter((f) => f.severity === "blocker");
    if (siblingBlockers.length > 0) {
      return {
        error: `Package sibling-file review failed (${siblingBlockers.length} blocker${siblingBlockers.length === 1 ? "" : "s"}): ${siblingBlockers.map((b) => b.message).join("; ")}`,
        code: "review_blocked",
        blockers: siblingBlockers,
      };
    }
  }

  // SPDX license detection gate.
  // Runs BEFORE publish; copyleft tier requires explicit acknowledgement,
  // reject tier blocks publish entirely. server re-validates
  // licenseAcknowledged flag here so client cannot bypass the modal.
  try {
    const licenseResult = await detectSpdxLicense(agentDir);
    if (licenseResult.tier === "reject") {
      throw new LicenseDetectionRejectedError(licenseResult.reason);
    }
    if (licenseResult.tier === "copyleft" && !licenseAcknowledged) {
      throw new LicenseAcknowledgementRequiredError(licenseResult.spdxId);
    }
  } catch (licenseError) {
    if (
      licenseError instanceof LicenseDetectionRejectedError ||
      licenseError instanceof LicenseAcknowledgementRequiredError
) {
      return { error: licenseError.message, code: licenseError.code };
    }
    // Unexpected error during license detection — surface as a descriptive error,
    // not a hard throw, so the MCP caller receives a structured response.
    const msg = licenseError instanceof Error ? licenseError.message : "License detection failed.";
    return { error: `License detection error: ${msg}` };
  }

  // call resolvePublishDestination(destination) after auth gate.
  // resolvePublishDestination must appear BEFORE publishAgentPackageFromGitDir.
  //
  // fallback path: when the deployment-registry fixture
  // still has privateDestinationConfigured:false (the default in this codebase
  // until the deployment wrapper ships the live resolver), but the operator HAS configured
  // a Verdaccio registry through the setup wizard (so `instance_identity.
  // registries.local` is populated), fall back to that. The administration UI
  // (/configuration/environment?tab=registries) shows the same connection as
  // "connected", so it would be surprising for the chat assistant to refuse
  // private publish in that state. The fallback runs ONLY for destination
  // "private" — public publishes still require the fixture's public token.
  // enforce strict semver BEFORE any
  // Verdaccio mutation for the public marketplace destination
  // (the gate must run pre-publish, not post-publish). Placed
  // ahead of resolvePublishDestination so the resolver→publish proximity
  // gate (resolver-bypass-regression) stays within its window. The admin gate
  // above already requires platform_admin (⊇ release_manager). Logic is inlined
  // (not imported from @cinatra-ai/extensions) to avoid an agents↔extensions
  // workspace cycle; the canonical gate lives in
  // @cinatra-ai/extensions/publish-authority.
  if (destination === "public") {
    try {
      const { readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const pkgRaw = await readFile(join(agentDir, "package.json"), "utf8");
      const pkgVersion = (JSON.parse(pkgRaw) as { version?: string }).version;
      const v = typeof pkgVersion === "string" ? pkgVersion : "";
      const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-.]+)?$/;
      const isDevVersion = v.startsWith("0.0.0-dev.");
      if (!v || isDevVersion || !SEMVER.test(v)) {
        console.warn(`[agent_source_publish]  publish authority: outcome=failure version=${v || "<none>"} pkg=${packageSlug}`);
        return {
          error: `publish refused by publish authority: version '${v || "<none>"}' is ${isDevVersion ? "a dev compile version" : "not valid semver"} — set a real semver version in package.json before publishing to the public marketplace.`,
          code: "publish_authority_denied",
        };
      }
    } catch (verErr) {
      return {
        error: `publish refused by publish authority: could not read package.json version to validate semver: ${verErr instanceof Error ? verErr.message : String(verErr)}`,
        code: "publish_authority_denied",
      };
    }
  }

  let gitPublishConfig: VerdaccioConfig;
  // dev-mode publish-scope override; hard-ignored in prod.
  const gitPublishScopeOverride = readEffectivePublishScopeOverride();
  try {
    gitPublishConfig = await resolvePublishDestination(destination, {
      vendorScopeOverride: gitPublishScopeOverride,
    });
  } catch (e) {
    if (e instanceof InstanceNamespaceNotConfiguredError) {
      return {
        error: "Instance vendor name is not configured. Visit /setup/name to provision a registry identity before publishing.",
      };
    }
    if (e instanceof PublishDestinationNotConfiguredError && destination === "private") {
      try {
        const fallback = await loadVerdaccioConfigForServer();
        // clone the fallback so the override still propagates when
        // the destination-resolver path isn't available. Otherwise the
        // fixture-backed fallback silently drops the dev-mode override.
        gitPublishConfig = gitPublishScopeOverride
          ? { ...fallback, packageScope: `@${gitPublishScopeOverride}` }
          : fallback;
      } catch (fallbackErr) {
        if (fallbackErr instanceof InstanceNamespaceNotConfiguredError) {
          return {
            error: "Instance vendor name is not configured. Visit /setup/name to provision a registry identity before publishing.",
          };
        }
        const msg = fallbackErr instanceof Error ? fallbackErr.message : "Failed to resolve publish destination.";
        return { error: `No private publish destination is configured (${e.message}); local Verdaccio fallback also failed: ${msg}.` };
      }
    } else {
      const msg = e instanceof Error ? e.message : "Failed to resolve publish destination.";
      return { error: msg };
    }
  }

  // when an override is active, the package.json on disk must
  // already be under the override scope. publishAgentPackageFromGitDir reads
  // the name verbatim from disk (Verdaccio rejects scope mismatches), so a
  // package.json with @<instanceNamespace>/<slug> cannot be redirected at
  // publish time. Validate up front and return a clear error.
  if (gitPublishScopeOverride) {
    try {
      const { readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const pkgPath = join(agentDir, "package.json");
      const pkgRaw = await readFile(pkgPath, "utf8");
      const pkgName = (JSON.parse(pkgRaw) as { name?: string }).name;
      const expectedScope = `@${gitPublishScopeOverride}/`;
      if (typeof pkgName !== "string" || !pkgName.startsWith(expectedScope)) {
        return {
          error: `Publish scope override is set to @${gitPublishScopeOverride} but package.json says ${pkgName ?? "<no name>"}. Update the package.json name to start with ${expectedScope} or clear the override at /configuration/development?tab=extensions.`,
        };
      }
    } catch (readErr) {
      return {
        error: `Could not read package.json to validate publish-scope override: ${readErr instanceof Error ? readErr.message : String(readErr)}`,
      };
    }
  }

  try {
    const result = await publishAgentPackageFromGitDir({ agentDir, changelog: changelog ?? null }, gitPublishConfig);

    if (result.published && result.packageVersion && destination === "public") {
      console.warn(`[agent_source_publish] /03 publish authority: outcome=success version=${result.packageVersion} pkg=${result.packageName}`);
    }

    // Full DB upsert — reinstalls the published package so all template fields
    // (approvalPolicy, hitlScreens, inputSchema, type, etc.) stay in sync with
    // the newly published OAS. installAgentFromPackage extracts from Verdaccio
    // and upserts the existing template row in place.
    //
    // track install success here so the
    // later reload call doesn't fire when this step threw (which would mount
    // a stale or absent agent on the runtime).
    let installSucceeded = false;
    if (result.published && result.packageName && result.packageVersion) {
      try {
        // thread the publisher's identity through the install so
        // the newly upserted agent_templates row carries creator_id + org_id
        // and is visible to the caller in the standard /agents list. Without
        // this, the install path landed with NULL org_id + empty owner_id,
        // and agent_list (which scopes by activeOrganizationId) returned
        // nothing for any user — leaving freshly-published agents
        // unreachable through the UI until manually backfilled.
        const actor = request.actor as
          | { userId?: string; orgId?: string | null; platformRole?: string }
          | undefined;
        const publisherUserId = actor?.userId;
        const publisherOrgId =
          actor?.orgId ?? (await resolveOrgIdFromSession()) ?? undefined;
        await installAgentFromPackage(
          {
            packageName: result.packageName,
            packageVersion: result.packageVersion,
            creatorId: publisherUserId,
            orgId: publisherOrgId ?? undefined,
            ownerLevel: publisherOrgId ? "organization" : "user",
            ownerId: publisherOrgId ?? publisherUserId,
            status: "published",
          },
          gitPublishConfig,
);
        installSucceeded = true;
      } catch (syncErr) {
        console.warn("[agent_source_publish] DB template sync failed:", syncErr);
      }

      // persist origin coordinates after successful publish.
      // tokens MUST NOT appear in origin; only opaque destinationId written.
      // single source of truth: scope comes from gitPublishConfig.packageScope,
      // which reflects the dev-mode vendorScopeOverride when set.
      try {
        await updateAgentTemplateOrigin(result.packageName, {
          packageName: result.packageName,
          version: result.packageVersion,
          destinationId: destination === "private"
            ? (gitPublishConfig as { destinationId?: string }).destinationId ?? null
            : null,
          scope: gitPublishConfig.packageScope,
          visibility: destination,
          registryUrl: gitPublishConfig.registryUrl,
          importedFrom: {
            source: "github",
            updatePolicy: "manual",
          },
        });
      } catch (originErr) {
        console.warn("[agent_source_publish] Origin persistence failed:", originErr);
      }

      void logAuditEvent({
        actorPrincipalId: request.actor?.userId,
        actorPrincipalType: (request.actor?.actorType as AuditEventInput["actorPrincipalType"]) ?? "human",
        authSource: (request.actor?.source as AuditEventInput["authSource"]) ?? "mcp",
        resourceType: "agent_registry",
        resourceId: result.packageName ?? packageSlug,
        operation: "publish",
        decision: "allowed",
        policyVersion: POLICY_VERSION,
        runId: undefined,
      });
    }

    // Freeze-on-publish wiring. Flips
    // `firstPublishedAt` from null → now() when the published package matches
    // the operator's current scope. No-op when already frozen or for a
    // different scope (e.g. re-publishing a shipped `@cinatra/...` agent on
    // a non-cinatra instance). Triggers on `alreadyPublished: true` too —
    // the registry already accepted a version under our scope at some point,
    // so the namespace lock must reflect that even if THIS call was a
    // no-op republish. Best-effort: never throw (registry side effect has
    // already happened); surface freeze failure via response field.
    let namespaceFreezeWarning: string | null = null;
    if ((result.published || result.alreadyPublished) && typeof result.packageName === "string") {
      try {
        markFirstPublishedIfCurrentScope(result.packageName);
      } catch (freezeErr) {
        const msg = freezeErr instanceof Error ? freezeErr.message : String(freezeErr);
        console.warn("[agent_source_publish] firstPublishedAt freeze skipped:", freezeErr);
        namespaceFreezeWarning = msg;
      }
    }

    // `PublishAgentPackageResult.packageName`
    // is a required field of the result type
    // (`packages/agents/src/verdaccio/client.ts:37-43`); the git-dir publisher
    // throws before returning if it cannot determine the name. No fallback.
    const detailPath = buildAgentWorkspacePath(result.packageName);

    // single reload trigger AFTER the durable
    // side-effects (publish to Verdaccio + DB sync + origin freeze) succeed.
    // Reload failure does NOT roll back the publish — the agent is already
    // on disk + in Verdaccio + in the DB. Surface as `installed_pending_reload`
    // so the caller can warn the operator.
    //
    // Do NOT trigger reload if the DB sync (installAgentFromPackage)
    // threw. In that case, the Verdaccio tarball is published but the disk
    // materialization + template row may be inconsistent — reload would mount
    // an agent we haven't fully wired up.
    let wayflowReload: ReloadResult | undefined;
    const reloadEligible =
      (result.published && installSucceeded) || result.alreadyPublished;
    if (reloadEligible) {
      try {
        wayflowReload = await triggerWayflowReload();
      } catch (reloadErr) {
        // Defense-in-depth: triggerWayflowReload doesn't throw, but if a
        // future refactor breaks that, catch here so the publish stays durable.
        console.warn("[agent_source_publish] wayflow reload threw:", reloadErr);
        wayflowReload = {
          ok: false,
          reason: "network",
          detail: reloadErr instanceof Error ? reloadErr.message : String(reloadErr),
        };
      }
    }

    return {
      packageSlug,
      packageName: result.packageName,
      packageVersion: result.packageVersion,
      registryUrl: result.registryUrl,
      published: result.published,
      alreadyPublished: result.alreadyPublished,
      detailPath,
      ...(namespaceFreezeWarning ? { namespaceFreezeWarning } : {}),
      ...(wayflowReload
        ? wayflowReload.ok
          ? { wayflowReload: { ok: true, report: wayflowReload.report } }
          : {
              installedPendingReload: true,
              wayflowReload: { ok: false, reason: wayflowReload.reason, detail: wayflowReload.detail },
            }
        : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Publish failed.";
    return { error: message };
  }
}

// ---------------------------------------------------------------------------
// agent_setup_assist was retired alongside the pre-run
// setup wizard. Field collection now happens via per-field AG-UI INTERRUPT
// events at run time — no LLM-assisted wizard, no MCP primitive needed.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// agent_run_trigger_set / get / delete
//
// MCP handlers for the trigger configuration primitives. All three delegate
// to trigger-service.ts; auth is enforced at the service layer using the
// actor envelope built from `request.actor`. NO requireAuthSession() here —
// programmatic MCP clients (orchestrators, agent SDK callers) carry only the
// actor envelope; the upper transport layer is responsible for authenticating
// connections and populating it.
// ---------------------------------------------------------------------------

function actorContextFromRequest(
  request: PrimitiveRequest<unknown>,
): TriggerActorContext | null {
  const userId = request.actor?.userId;
  if (!userId) return null;
  const role =
    (request.actor as { role?: string | null } | undefined)?.role ?? null;
  return { userId, role, source: request.actor?.source ?? "mcp" };
}

export async function handleAgentRunTriggerSet(
  request: PrimitiveRequest<{
    runId: string;
    triggerType: "immediate" | "scheduled" | "recurring";
    scheduledAt?: string;
    cronExpression?: string;
    timezone?: string;
    enabled?: boolean;
  }>,
): Promise<unknown> {
  const actor = actorContextFromRequest(request);
  if (!actor) return { error: "unauthorized" };
  const args: SetTriggerForActorArgs = {
    runId: request.input.runId,
    triggerType: request.input.triggerType,
    scheduledAt: request.input.scheduledAt,
    cronExpression: request.input.cronExpression,
    timezone: request.input.timezone,
    enabled: request.input.enabled,
  };
  const result = await setRunTriggerForActor(actor, args);
  if (!result.ok) return { error: result.error };
  return { runId: result.runId, jobSchedulerId: result.jobSchedulerId };
}

export async function handleAgentRunTriggerGet(
  request: PrimitiveRequest<{ runId: string }>,
): Promise<unknown> {
  const actor = actorContextFromRequest(request);
  if (!actor) return { error: "unauthorized" };
  // The service-layer call enforces ownership BEFORE returning trigger
  // metadata — prevents information disclosure of scheduled times / cron
  // / releasedAt to non-owners (mitigation).
  const result = await getRunTriggerForActor(actor, request.input.runId);
  if (!result.ok) return { error: result.error };
  const trigger = result.trigger;
  if (!trigger) return null;
  // Serialize Date objects to ISO for the wire (MCP transport is JSON).
  return {
    runId: trigger.runId,
    triggerType: trigger.triggerType,
    scheduledAt: trigger.scheduledAt?.toISOString() ?? null,
    cronExpression: trigger.cronExpression,
    timezone: trigger.timezone,
    enabled: trigger.enabled,
    releasedAt: trigger.releasedAt?.toISOString() ?? null,
    createdAt: trigger.createdAt.toISOString(),
    updatedAt: trigger.updatedAt.toISOString(),
  };
}

export async function handleAgentRunTriggerDelete(
  request: PrimitiveRequest<{ runId: string }>,
): Promise<unknown> {
  const actor = actorContextFromRequest(request);
  if (!actor) return { error: "unauthorized" };
  const result = await deleteRunTriggerForActor(actor, {
    runId: request.input.runId,
  });
  if (!result.ok) return { error: result.error };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function createAgentBuilderPrimitiveHandlers(): Record<
  string,
  (request: unknown) => Promise<unknown>
> {
  // all handler inputs are cast via
  // `Parameters<typeof handlerFn>[0]`. This pattern ensures the cast type
  // tracks the handler signature automatically; adding a new input field
  // on a handler propagates here without manual sync.
  return {
    agent_compile: (req) =>
      handleAgentBuilderCompile(
        req as Parameters<typeof handleAgentBuilderCompile>[0],
),
    agent_save: (req) =>
      handleAgentBuilderSave(
        req as Parameters<typeof handleAgentBuilderSave>[0],
),
    agent_run: (req) =>
      handleAgentBuilderRun(req as Parameters<typeof handleAgentBuilderRun>[0]),
    agent_list: (req) =>
      handleAgentBuilderList(req as Parameters<typeof handleAgentBuilderList>[0]),
    agent_get: (req) =>
      handleAgentBuilderGet(req as Parameters<typeof handleAgentBuilderGet>[0]),
    agent_run_get: (req) =>
      handleAgentBuilderRunGet(req as Parameters<typeof handleAgentBuilderRunGet>[0]),
    agent_run_list: (req) =>
      handleAgentBuilderRunList(req as Parameters<typeof handleAgentBuilderRunList>[0]),
    // agent_run project-move primitives.
    agent_run_update: (req) =>
      handleAgentBuilderRunUpdate(
        req as Parameters<typeof handleAgentBuilderRunUpdate>[0],
),
    agent_run_move_with_outputs: (req) =>
      handleAgentBuilderRunMoveWithOutputs(
        req as Parameters<typeof handleAgentBuilderRunMoveWithOutputs>[0],
),
    agent_run_messages_list: (req) =>
      handleAgentBuilderRunMessagesList(req as Parameters<typeof handleAgentBuilderRunMessagesList>[0]),
    agent_run_resume: (req) =>
      handleAgentBuilderRunResume(req as Parameters<typeof handleAgentBuilderRunResume>[0]),
    agent_run_stop: (req) =>
      handleAgentBuilderRunStop(req as Parameters<typeof handleAgentBuilderRunStop>[0]),
    agent_runs_stop: (req) =>
      handleAgentBuilderRunsStop(req as Parameters<typeof handleAgentBuilderRunsStop>[0]),
    agent_delete: (req) =>
      handleAgentBuilderDelete(req as Parameters<typeof handleAgentBuilderDelete>[0]),
    agent_template_duplicate: (req) =>
      handleAgentBuilderTemplateDuplicate(req as Parameters<typeof handleAgentBuilderTemplateDuplicate>[0]),
    agent_update: (req) =>
      handleAgentBuilderUpdate(req as Parameters<typeof handleAgentBuilderUpdate>[0]),
    agent_export: (req) =>
      handleAgentBuilderExport(req as Parameters<typeof handleAgentBuilderExport>[0]),
    agent_import: (req) =>
      handleAgentBuilderImport(req as Parameters<typeof handleAgentBuilderImport>[0]),
    agent_registry_publish: (req) =>
      handleAgentBuilderRegistryPublish(req as Parameters<typeof handleAgentBuilderRegistryPublish>[0]),
    agent_registry_list: (req) =>
      handleAgentBuilderRegistryList(req as Parameters<typeof handleAgentBuilderRegistryList>[0]),
    // agent_registry_unpublish/delete moved to the
    // @cinatra-ai/extensions MCP surface as extensions_registry_unpublish /
    // extensions_registry_delete (kind-agnostic registry ops).
    agent_version_list: (req) =>
      handleAgentBuilderVersionList(req as Parameters<typeof handleAgentBuilderVersionList>[0]),
    agent_version_get: (req) =>
      handleAgentBuilderVersionGet(req as Parameters<typeof handleAgentBuilderVersionGet>[0]),
    agent_version_diff: (req) =>
      handleAgentBuilderVersionDiff(req as Parameters<typeof handleAgentBuilderVersionDiff>[0]),
    agent_version_rollback: (req) =>
      handleAgentBuilderVersionRollback(req as Parameters<typeof handleAgentBuilderVersionRollback>[0]),
    agent_source_list: (req) => handleAgentBuilderGitList(req as Parameters<typeof handleAgentBuilderGitList>[0]),
    agent_source_read: (req) =>
      handleAgentBuilderGitRead(req as Parameters<typeof handleAgentBuilderGitRead>[0]),
    // the on-disk source-write primitives
    // create/refresh `extensions/cinatra-ai/<slug>/cinatra/oas.json`, the
    // exact file the purge saga's listOnDiskOasDependents re-scan inspects.
    // A write landing between purge's final on-disk dependents scan and the
    // irreversible registry/DB delete would create a MISSED dependent. Hold
    // the global extension-lifecycle lock across the whole write so it is
    // strictly ordered against the purge saga (re-entrant: install/purge
    // holders pass through as a no-op).
    agent_source_write: async (req) => {
      const { withGlobalExtensionLifecycleLock } = await import(
        "../materialize-agent-package"
);
      return withGlobalExtensionLifecycleLock(() =>
        handleAgentBuilderGitWrite(req as Parameters<typeof handleAgentBuilderGitWrite>[0]),
);
    },
    agent_source_write_files: async (req) => {
      const { withGlobalExtensionLifecycleLock } = await import(
        "../materialize-agent-package"
);
      return withGlobalExtensionLifecycleLock(() =>
        handleAgentBuilderGitWriteFiles(
          req as Parameters<typeof handleAgentBuilderGitWriteFiles>[0],
),
);
    },
    agent_source_validate: (req) =>
      handleAgentBuilderGitValidate(req as Parameters<typeof handleAgentBuilderGitValidate>[0]),
    agent_source_compile: async (req) => {
      const { withGlobalExtensionLifecycleLock } = await import(
        "../materialize-agent-package"
);
      return withGlobalExtensionLifecycleLock(() =>
        handleAgentBuilderGitCompileAndWrite(req as Parameters<typeof handleAgentBuilderGitCompileAndWrite>[0]),
);
    },
    agent_source_publish: (req) =>
      handleAgentBuilderGitPublish(req as Parameters<typeof handleAgentBuilderGitPublish>[0]),
    // single review surface; deterministic lint + advisory
    // helper dispatch in one MCP primitive. Blockers gate compile/publish.
    agent_source_review: (req) =>
      handleAgentSourceReview(req as Parameters<typeof handleAgentSourceReview>[0]),
    // chat-authoring review primitive that replaces the
    // agent-creation-finalizer Flow. Runs lint + 3 LLM advisors in-process.
    agent_creation_review: (req) =>
      handleAgentCreationReview(
        req as Parameters<typeof handleAgentCreationReview>[0],
),
    // Agent-Creation Approval Workflow — non-admin proposal path +
    // admin decide. Propose/edit/list/get are author-or-admin reachable from
    // the delegated-chat allowlist (read+write own proposal). Decide is
    // admin-only at the handler boundary AND NOT on the delegated-chat
    // allowlist (admin acts via the /configuration/agents/approvals UI).
    agent_creation_request_propose: (req) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (handleAgentCreationRequestPropose as any)(req),
    agent_creation_request_edit: (req) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (handleAgentCreationRequestEdit as any)(req),
    agent_creation_request_list: (req) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (handleAgentCreationRequestList as any)(req),
    agent_creation_request_get: (req) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (handleAgentCreationRequestGet as any)(req),
    agent_creation_request_decide: (req) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (handleAgentCreationRequestDecide as any)(req),
    agent_creation_request_retry_publish: (req) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (handleAgentCreationRequestRetryPublish as any)(req),
    // trigger configuration MCP primitives.
    agent_run_trigger_set: (req) =>
      handleAgentRunTriggerSet(
        req as Parameters<typeof handleAgentRunTriggerSet>[0],
),
    agent_run_trigger_get: (req) =>
      handleAgentRunTriggerGet(
        req as Parameters<typeof handleAgentRunTriggerGet>[0],
),
    agent_run_trigger_delete: (req) =>
      handleAgentRunTriggerDelete(
        req as Parameters<typeof handleAgentRunTriggerDelete>[0],
),
  };
}

// ---------------------------------------------------------------------------
// Test-only exports. Not part of the public API.
// ---------------------------------------------------------------------------
export {
  handleAgentBuilderGitList as __handleAgentBuilderGitList,
  handleAgentBuilderGitRead as __handleAgentBuilderGitRead,
  handleAgentBuilderGitWrite as __handleAgentBuilderGitWrite,
  handleAgentBuilderGitWriteFiles as __handleAgentBuilderGitWriteFiles,
  handleAgentBuilderGitCompileAndWrite as __handleAgentBuilderGitCompileAndWrite,
};

// ---------------------------------------------------------------------------
// agent_registry_publish
// ---------------------------------------------------------------------------

async function handleAgentBuilderRegistryPublish(
  request: PrimitiveRequest<{
    templateId?: string;
    semver?: string;
    changelog?: string;
  }>,
): Promise<unknown> {
  // (admin gate BEFORE resolvePublishDestination.
  // The caller must run an auth gate; the MCP registration loop
  // applies no per-tool role enforcement, so we guard explicitly here.
  const isAdmin = await resolveIsPlatformAdminFromSession(request.actor as { platformRole?: string } | undefined);
  if (!isAdmin) {
    return { error: "Unauthorized — admin session required to publish." };
  }

  const { templateId, semver, changelog = "Initial release" } = request.input;
  if (!templateId) return { error: "templateId is required." };
  if (!semver) return { error: "semver is required." };

  const template = await readAgentTemplateById(templateId);
  if (!template) return { error: `Agent template not found: ${templateId}` };

  const versions = await readAgentVersionsByTemplate(templateId);
  if (versions.length === 0) return { error: "Template has no versions. Save the template first." };
  const latestVersion = versions[0];
  const publishMetadata = derivePublishMetadataFromSnapshot(latestVersion.snapshot);

  // route through resolvePublishDestination.
  // agent_registry_publish defaults to "private" destination (by design).
  // Auth gate enforced above via resolveIsPlatformAdminFromSession().
  // same instance-identity fallback as agent_source_publish above:
  // when the fixture has privateDestinationConfigured:false but the
  // operator has wired a local Verdaccio via the setup wizard, prefer that.
  let registryPublishConfig: VerdaccioConfig;
  // dev-mode publish-scope override; hard-ignored in prod.
  const registryPublishScopeOverride = readEffectivePublishScopeOverride();
  try {
    registryPublishConfig = await resolvePublishDestination("private", {
      vendorScopeOverride: registryPublishScopeOverride,
    });
  } catch (e) {
    if (e instanceof InstanceNamespaceNotConfiguredError) {
      return {
        error: "Instance vendor name is not configured. Visit /setup/name to provision a registry identity before publishing.",
      };
    }
    if (e instanceof PublishDestinationNotConfiguredError) {
      try {
        const fallback = await loadVerdaccioConfigForServer();
        // clone the fallback so the override still propagates when
        // the destination-resolver path isn't available.
        registryPublishConfig = registryPublishScopeOverride
          ? { ...fallback, packageScope: `@${registryPublishScopeOverride}` }
          : fallback;
      } catch (fallbackErr) {
        if (fallbackErr instanceof InstanceNamespaceNotConfiguredError) {
          return {
            error: "Instance vendor name is not configured. Visit /setup/name to provision a registry identity before publishing.",
          };
        }
        const msg = fallbackErr instanceof Error ? fallbackErr.message : "Failed to resolve publish destination.";
        return { error: `No private publish destination is configured (${e.message}); local Verdaccio fallback also failed: ${msg}.` };
      }
    } else {
      const msg = e instanceof Error ? e.message : "Failed to resolve publish destination.";
      return { error: msg };
    }
  }

  // `template` carries `executionProvider`; `package-files.ts`
  // reads it directly from `input.template.executionProvider`, so no separate
  // field is threaded through `publishAgentPackage` input.
  const result = await publishAgentPackage(
    {
      template,
      version: latestVersion,
      semver,
      title: template.name,
      description: template.description ?? undefined,
      changelog,
      riskLevel: publishMetadata.riskLevel,
      toolAccess: publishMetadata.toolAccess,
      hasApprovalGates: publishMetadata.hasApprovalGates,
      // Pass agentDependencies from the template record so the
      // published packument includes cinatra.agentDependencies for the resolver.
      agentDependencies: template.agentDependencies ?? undefined,
    },
    registryPublishConfig,
);

  // persist origin coordinates after successful publish.
  // single source of truth: scope comes from registryPublishConfig.packageScope,
  // which reflects the dev-mode vendorScopeOverride when set.
  // key the row update by template.packageName (stable identifier),
  // not result.packageName. When override is active, result.packageName is
  // `@<override>/<slug>` while template.packageName remains `@<original>/<slug>`;
  // keying by the rebuilt name silently no-ops the update. Origin's own
  // packageName field still records result.packageName so the row reflects
  // where the artifact actually lives.
  if (result.published && result.packageName && result.packageVersion && template.packageName) {
    try {
      await updateAgentTemplateOrigin(template.packageName, {
        packageName: result.packageName,
        version: result.packageVersion,
        destinationId: (registryPublishConfig as { destinationId?: string }).destinationId ?? null,
        scope: registryPublishConfig.packageScope,
        visibility: "private",
        registryUrl: registryPublishConfig.registryUrl,
      });
    } catch (originErr) {
      console.warn("[agent_registry_publish] Origin persistence failed:", originErr);
    }
  }

  // Freeze-on-publish wiring. Mirrors the
  // `agent_source_publish` handler. Triggers on `alreadyPublished: true` too.
  let namespaceFreezeWarning: string | null = null;
  if ((result.published || result.alreadyPublished) && typeof result.packageName === "string") {
    try {
      markFirstPublishedIfCurrentScope(result.packageName);
    } catch (freezeErr) {
      const msg = freezeErr instanceof Error ? freezeErr.message : String(freezeErr);
      console.warn("[agent_registry_publish] firstPublishedAt freeze skipped:", freezeErr);
      namespaceFreezeWarning = msg;
    }
  }

  // `PublishAgentPackageResult.packageName`
  // is a required field; `publishAgentPackage` either throws or returns it.
  const detailPath = buildAgentWorkspacePath(result.packageName);

  return {
    templateId,
    packageName: result.packageName,
    packageVersion: result.packageVersion,
    registryUrl: result.registryUrl,
    published: result.published,
    alreadyPublished: result.alreadyPublished,
    detailPath,
    ...(namespaceFreezeWarning ? { namespaceFreezeWarning } : {}),
  };
}

// ---------------------------------------------------------------------------
// agent_registry_list
// ---------------------------------------------------------------------------

async function handleAgentBuilderRegistryList(
  request: PrimitiveRequest<{ limit?: number; offset?: number }>,
): Promise<unknown> {
  const limit = Math.min(request.input.limit ?? 50, 200);
  const offset = request.input.offset ?? 0;
  // listAgentPackages requires explicit VerdaccioConfig.
  const configResult = await resolveVerdaccioConfigForHandler();
  if (!configResult.ok) {
    return { error: configResult.error };
  }
  // Pass the canonical viewer scope so an approved vendor sees its own
  // private packages; unprivileged consumers get the public-only view.
  const viewerScope = getEffectiveViewerScope(readInstanceIdentity());
  const all = (await listAgentPackages({ limit: 200, viewerScope }, configResult.config)).filter(
    (item) => !item.deprecated,
);
  const total = all.length;
  const page = all.slice(offset, offset + limit);

  return {
    items: page.map((entry) => ({
      packageName: entry.packageName,
      packageVersion: entry.packageVersion,
      title: entry.title,
      description: entry.description,
      changelog: entry.changelog,
      riskLevel: entry.riskLevel,
      hasApprovalGates: entry.hasApprovalGates,
      toolAccess: entry.toolAccess,
      ownerOrgId: entry.ownerOrgId,
      publishedAt: entry.publishedAt,
      registryUrl: entry.registryUrl,
      registryUiUrl: entry.registryUiUrl,
    })),
    total,
    hasMore: offset + limit < total,
  };
}

// handleAgentBuilderRegistryDelete / ...Unpublish removed.
// Generalized + relocated to packages/extensions/src/mcp/handlers.ts as
// extensions_registry_delete / extensions_registry_unpublish (kind-agnostic
// Verdaccio package-name+version ops under the extension-lifecycle namespace).

// ---------------------------------------------------------------------------
// agents_list — agents-only handler (merged from packages/agents thin layer)
// ---------------------------------------------------------------------------

export type AgentRunItem = {
  id: string;
  name: string;        // run.title or template name
  agentType: string;   // template name (e.g. "Email Outreach")
  templateId: string;  // raw templateId UUID
  status: string;
  createdAt: string;   // ISO string
  href: string;
};

// Keep AgentListItem as an alias for backward-compat with any callers that cast to it.
export type AgentListItem = AgentRunItem;

export function createAgentsPrimitiveHandlers() {
  return {
    "agents_list": async (_request: PrimitiveRequest<unknown>): Promise<AgentRunItem[]> => {
      const orgId = await resolveDefaultOrgId();
      const page = await readAgentRuns({ limit: 200, organizationId: orgId ?? undefined });

      // Batch-load templates so we can resolve display names and package-based hrefs.
      const uniqueTemplateIds = [...new Set(page.items.map((r) => r.templateId))];
      const templateEntries = await Promise.all(
        uniqueTemplateIds.map(async (id) => [id, await readAgentTemplateById(id)] as const),
);
      const templateMap = new Map(templateEntries);

      return page.items.map((run): AgentRunItem => {
        const template = templateMap.get(run.templateId) ?? null;
        const agentType = template?.name ?? "Agent";
        return {
          id: run.id,
          name: run.title ?? agentType,
          agentType,
          templateId: run.templateId,
          status: run.status,
          createdAt: run.createdAt.toISOString(),
          href: template?.packageName
            ? buildAgentInstancePath(template.packageName, run.id)
            : `/agents/builder/${run.templateId}`,
        };
      });
    },
  } as const;
}
