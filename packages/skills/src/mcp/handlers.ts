import { z } from "zod";
import { decodeCursor, buildListPage } from "@/lib/mcp-pagination";
import type { PrimitiveInvocationRequest } from "@cinatra-ai/mcp-client";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import { PrimitiveInvocationError } from "@cinatra-ai/mcp-client";
import {
  readSkillContent,
  uninstallSkillPackage,
  listCustomSkills,
  getCustomSkillById,
  upsertCustomSkill,
  upsertSkill,
  deleteCustomSkill,
  listCustomSkillsForAgent,
  resolveEffectiveSkillAccessPolicy,
} from "../skills-store";
// Catalog read/rebuild split (cinatra#1364): list/lookup handlers use the PURE
// snapshot read; the install/uninstall handlers trigger the EXPLICIT rebuild.
import { readSkillsCatalogSnapshot, rebuildSkillsCatalog } from "../skill-packages";
// LOCAL_USER_ID stays out of production paths; dev-bypass fallback resolves
// dynamically inside guarded blocks below.
import {
  createOrUpdateCustomSkillForAgent,
  resolveCustomSkillContent,
} from "../personal-skills";
import { getInstalledSkillById, listInstalledSkills, listInstalledSkillPackages, parseFrontmatter } from "../skills-registry";
// Request-aware recommendation (cinatra#2041 S3): the MCP "what skills fit this
// task" primitive reuses the SAME server-side scoring entry the run-start
// interception uses — one implementation, never a parallel one.
import { recommendSkillsForAgentTask } from "../recommendation/recommend.server";
import { REQUEST_AWARE_SCORER_VERSION } from "../recommendation/request-aware-scorer";
import { isWidgetChatSkillId } from "../extension-skill-resolver";
import { isRuntimeDeliverableLifecycleState } from "../skill-source";
import { getAssignedSkillIdsForAgent, matchAgentsToSkills } from "@/lib/agents-store";
import { readSkillLifecycleStates } from "@/lib/database";
// Fan out scoped re-evaluation jobs on install / personal-skill upsert events
// and purge skill_matches rows on package uninstall.
import {
  enqueueInlineForSkill,
  cleanupForSkill,
} from "../llm-matching/event-hooks";
// Admin-gated MCP handlers for the skill-match admin surface (schedule + batch
// + per-pair eval). The four handlers at the END of
// createSkillsPrimitiveHandlers consume these.
import { requireAdminActor } from "./auth";
import {
  evaluatePair,
  estimateBatchCost,
  readSchedule,
  writeSchedule,
  registerSkillMatchScheduleAtBoot,
  // Shared adapters keep admin re-evaluate matches aligned with the
  // inline/batch paths' SkillForMatching shape (matchWhenRaw + hash parity).
  adaptAgentForMatching,
  adaptSkillForMatching,
  // Applied to the admin dry-run cost estimate so pairCount + USD match what
  // the batch transport actually does.
  evaluateRuleShortCircuit,
  // Cron-expression syntactic validator. Rejects malformed expressions BEFORE
  // persistence so a bad row can't
  // survive to boot-time scheduler re-registration.
  isValidCronExpression,
} from "../llm-matching";
import { enqueueBackgroundJob, BACKGROUND_JOB_NAMES } from "@/lib/background-jobs";
import { readAgentsForSkillMatching } from "@/lib/agents-store";
// Defer "../github" import until first use so unit tests that load this module
// for schema introspection don't drag in the connector-nango /
// google-oauth-connection module graph.
import { requireResourceAccess, actorContextFromMcpRequest, buildSkillResourceRef } from "@cinatra-ai/agents/auth-policy";
import { AuthzError } from "@/lib/authz";
import { getAuthSession, isPlatformAdmin } from "@/lib/auth-session";

// Owner-only fragment schema. ownerUserId is optional everywhere; the actor's
// principalId fills it in when absent. Exported first so introspecting callers
// see the canonical optional-ownerUserId shape up front.
export const customSkillOwnerSchema = z.object({
  ownerUserId: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Lifecycle runtime-delivery gate for MCP direct reads (A3, cinatra#1363).
// ---------------------------------------------------------------------------

/**
 * FAIL-CLOSED lifecycle gate for a single skill id read through an MCP tool.
 * True only when the lifecycle read succeeds AND the state is runtime-deliverable
 * (active/deprecated, or a derived NULL). A read error, a missing row, or a
 * draft/archived/unknown state → false. A `false` result means the skill is a
 * runtime-delivery leak and may be returned ONLY to a `manage` actor
 * (management-plane); a read (runtime) actor gets 404 semantics.
 */
function isMcpSkillRuntimeDeliverable(skillId: string): boolean {
  const r = readSkillLifecycleStates([skillId]);
  return (
    r.ok &&
    isRuntimeDeliverableLifecycleState(r.states.has(skillId) ? r.states.get(skillId) : undefined)
  );
}

// ---------------------------------------------------------------------------
// Session helpers shared with the agent-builder MCP handler pattern.
// ---------------------------------------------------------------------------

async function resolveOrgIdFromSession(
  /**
   * For delegated / cookieless hosted MCP (chat → OpenAI relay → /api/mcp
   * under the chat user's OBO token) there is NO Better Auth cookie session,
   * but the MCP transport stamps the delegated user's `orgId` onto the actor
   * envelope. Prefer that authoritative, transport-verified org BEFORE the
   * session lookup; otherwise org is `undefined` here and a widened workspace
   * read gate can let chat users enumerate workspace-level skill bodies
   * cross-org. The envelope is server-only and unforgeable.
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
    return undefined;
  } catch {
    return undefined;
  }
}

async function resolveIsPlatformAdminFromSession(): Promise<boolean> {
  try {
    const session = await getAuthSession();
    return session ? isPlatformAdmin(session) : false;
  } catch {
    return false;
  }
}

export const skillIdSchema = z.object({
  skillId: z.string().min(1),
  ownerUserId: z.string().optional(),
});

export const agentIdSchema = z.object({
  agentId: z.string().min(1),
  ownerUserId: z.string().optional(),
});

export const upsertSkillSchema = z.object({
  ownerUserId: z.string().optional(),
  agentId: z.string(),
  name: z.string().min(1),
  description: z.string().optional(),
  content: z.string().min(1),
});

export const deleteSkillSchema = z.object({
  ownerUserId: z.string().optional(),
  skillId: z.string().min(1),
});

export const installFromGitHubSchema = z.object({
  repoRef: z.string().min(1).describe("GitHub owner/repo (e.g. 'acme/my-skills')"),
  connectionId: z.string().optional(),
  // cinatra#2092 (S5) — EXPLICIT upload consent for a NONINTERACTIVE install.
  // A programmatic caller has no confirmation dialog, so passing this flag IS
  // the consent act. Omit it (the default) and the installed skills stay
  // upload-ineligible: the derived `allowAnthropicUpload` projection stays
  // false, nothing egresses, and the fail-closed outcome is returned on the
  // result as `uploadConsent`. Only ever effective while the workspace
  // Anthropic opt-in is ON — that outer gate is checked independently.
  consentToAnthropicUpload: z
    .boolean()
    .optional()
    .describe(
      "Explicitly consent to uploading this package's skills (and every skill extension it pulls in) to the Anthropic Skills API. Omitted/false = the skills stay excluded from upload.",
    ),
});

export const uninstallPackageSchema = z.object({
  packageId: z.string().min(1),
});

export const libraryListSchema = z.object({
  // GitHub-installed packages surface under their explicit plugin.json level
  // or fall through to "system" when not declared.
  level: z.enum(["personal", "team", "organization", "system", "agent"]).optional(),
  query: z.string().optional(),
});

export const installedSkillIdSchema = z.object({
  skillId: z.string().min(1),
});

export const resolveForAgentSchema = z.object({
  agentId: z.string().min(1),
  customSkillId: z.string().optional(),
});

export const listInstalledSkillsInputSchema = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

// Request-aware recommendation primitive (cinatra#2041 S3). Advisory + read-only:
// "which of this agent's skills fit THIS task?" scored on the run's intent.
export const recommendForTaskSchema = z.object({
  agentId: z.string().min(1).describe("Agent packageId to recommend skills for."),
  promptText: z.string().optional().describe("The task / prompt text the run will act on — the run intent scored against."),
  declaredProducedTypes: z.array(z.string()).optional().describe("Artifact types the run declares it will produce."),
  targetArtifactKind: z.string().optional().describe("Target artifact kind when known (e.g. 'wordpress:post')."),
  restrictToSkillIds: z.array(z.string()).optional().describe("Restrict candidates to these skill ids (e.g. the agent's assigned set)."),
});

export const upsertInstalledSkillSchema = z.object({
  skillId: z.string().min(1).describe("Existing skill ID to update (e.g. '@cinatra-ai/agent-builder:agent-builder-compiler-agentic')."),
  content: z.string().min(1).describe("Full SKILL.md content including YAML frontmatter (--- name: ... ---)."),
  description: z.string().optional().describe("Short description override. If omitted, the existing description is preserved."),
});

export const createOrUpdateCustomSkillSchema = z.object({
  agentId: z.string().min(1),
  promptEntries: z.array(z.object({
    id: z.string().optional(),
    kind: z.string(),
    prompt: z.string(),
    savedAt: z.string().optional(),
  })),
  skillName: z.string().min(1),
  existingSkillId: z.string().optional(),
  connection: z.object({
    apiKey: z.string().optional(),
    organizationId: z.string().optional(),
    projectId: z.string().optional(),
  }).passthrough().optional(),
});

// Owner resolution helper. The actor's principalId is authoritative;
// caller-supplied `ownerUserId` overrides are rejected when they don't match
// the request actor (prevents IDOR via arbitrary other-user impersonation
// through MCP input). The override is
// honored only when:
//   1. it matches the request actor's principalId (UI re-passing the same id), OR
//   2. no actor is on the request AND BETTER_AUTH_DEV_BYPASS=true (dev/test).
async function resolveOwnerUserId(
  override: string | undefined,
  request: PrimitiveInvocationRequest<unknown>,
): Promise<string> {
  const actor = (request as unknown as { actor?: { principalId?: string } }).actor;
  const trimmed = override && override.trim() ? override : undefined;

  if (trimmed) {
    if (actor?.principalId) {
      if (trimmed !== actor.principalId) {
        throw new Error(
          "MCP skills handler: ownerUserId override does not match request actor.",
        );
      }
      return trimmed;
    }
    // No actor on the request — only allow override under dev-bypass.
    if (process.env.BETTER_AUTH_DEV_BYPASS === "true") {
      return trimmed;
    }
    throw new Error(
      "MCP skills handler: ownerUserId override rejected (no request actor, dev-bypass not enabled).",
    );
  }

  if (actor?.principalId) return actor.principalId;
  if (process.env.BETTER_AUTH_DEV_BYPASS === "true") {
    const constants = await import("../constants");
    return constants.LOCAL_USER_ID;
  }
  throw new Error("MCP skills handler: no ownerUserId / actor.principalId resolvable.");
}

// ---------------------------------------------------------------------------
// Input schemas for the four admin-gated skill-match primitives. Registered in
// registry.ts; exported so the admin server actions in
// src/app/configuration/skills/actions.ts can reuse them for client/server
// validation.
// ---------------------------------------------------------------------------

export const skillMatchScheduleGetSchema = z.object({});

export const skillMatchScheduleSetSchema = z.object({
  enabled: z.boolean(),
  cronExpression: z.string().nullable(),
  timezone: z.string().min(1),
});

export const skillMatchBatchRunNowSchema = z.object({
  /**
   * Cost-estimate flow: when true, returns the estimated pair count and USD
   * cost WITHOUT enqueueing the SKILL_MATCH_BATCH_SUBMIT job. The admin UI
   * shows the modal first, then calls again with `dryRun: false` to confirm.
   */
  dryRun: z.boolean().optional(),
});

export const skillMatchEvaluatePairSchema = z.object({
  agentId: z.string().min(1),
  skillId: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Adapters from the cinatra catalog shapes (PersistedAgent / SkillManifest) to
// the matcher core's AgentForMatching / SkillForMatching. Mirrors the in-jobs
// adapters in `../llm-matching/jobs.ts` so handlers.ts stays self-contained.
// ---------------------------------------------------------------------------

// `adaptAgentForMatching` + `adaptSkillForMatching` are shared by the inline,
// batch, and admin re-evaluate paths so all compute the same SkillForMatching
// shape, including `matchWhenRaw`.

export function createSkillsPrimitiveHandlers() {
  return {
    "skills_catalog_list": async (request: PrimitiveInvocationRequest<unknown>) => {
      try {
        const catalog = await readSkillsCatalogSnapshot();
        const orgId = await resolveOrgIdFromSession(
          request.actor as { orgId?: string | null } | undefined,
        );
        const actorCtx = await actorContextFromMcpRequest(request.actor as PrimitiveActorContext, orgId);
        const visibleSkills = catalog.skills.filter((skill) => {
          try {
            // Use the central resource-ref builder so `organizationId` carries
            // the skill's OWNING org for level:"organization" rows, not the
            // caller's org.
            requireResourceAccess(actorCtx, buildSkillResourceRef({
              id: skill.id ?? skill.name,
              level: skill.level,
              scope: (skill as { scope?: string | null }).scope ?? null,
              // Durable owner (cinatra#1416, AC7): the owner keeps read/list of
              // their OWN shared personal skill regardless of the projected tuple.
              ownerUserId: (skill as { ownerUserId?: string | null }).ownerUserId ?? null,
              // Canonical effective policy (W4): the skill's own accessPolicy
              // else the parent package's. Enforcement reads its union any-match.
              accessPolicy: resolveEffectiveSkillAccessPolicy(skill, catalog.skillPackages ?? []),
            }));
            return true;
          } catch {
            return false;
          }
        });
        // The catalog's `skillPackages` array carries package metadata (name,
        // slug, description, repositoryUrl, readmeContent, licenseText,
        // authors) that leaks package existence even when every embedded skill
        // has been filtered out. Drop packages whose skill set is fully
        // filtered.
        const visibleSkillsByPackageId = new Map<string, number>();
        for (const skill of visibleSkills) {
          const packageId = (skill as { packageId?: string | null }).packageId;
          if (!packageId) continue;
          visibleSkillsByPackageId.set(
            packageId,
            (visibleSkillsByPackageId.get(packageId) ?? 0) + 1,
          );
        }
        const visiblePackages = (catalog.skillPackages ?? []).filter(
          (pkg) => (visibleSkillsByPackageId.get(pkg.packageId) ?? 0) > 0,
        );
        return { ...catalog, skills: visibleSkills, skillPackages: visiblePackages };
      } catch (err) {
        if (err instanceof AuthzError) {
          return { error: err.reason === "hidden" ? "Not available." : "Access denied." };
        }
        throw err;
      }
    },

    "skills_personal_list": async (request: PrimitiveInvocationRequest<unknown>) => {
      // Resolve owner from request actor; dev-bypass fallback applies when
      // actor.principalType is missing or non-human.
      const actor = (request as unknown as { actor?: { principalId?: string } }).actor;
      let ownerUserId = actor?.principalId;
      if (!ownerUserId) {
        if (process.env.BETTER_AUTH_DEV_BYPASS === "true") {
          const constants = await import("../constants");
          ownerUserId = constants.LOCAL_USER_ID;
        } else {
          throw new Error("skills_personal_list: no actor.principalId available.");
        }
      }
      return listCustomSkills(ownerUserId);
    },

    "skills_personal_list_for_agent": async (request: PrimitiveInvocationRequest<unknown>) => {
      const { agentId, ownerUserId } = agentIdSchema.parse(request.input);
      const resolved = await resolveOwnerUserId(ownerUserId, request);
      return listCustomSkillsForAgent({ ownerUserId: resolved, agentId });
    },

    "skills_personal_get": async (request: PrimitiveInvocationRequest<unknown>) => {
      const { skillId, ownerUserId } = skillIdSchema.parse(request.input);
      const resolved = await resolveOwnerUserId(ownerUserId, request);
      return getCustomSkillById({ ownerUserId: resolved, skillId });
    },

    "skills_personal_upsert": async (request: PrimitiveInvocationRequest<unknown>) => {
      const input = upsertSkillSchema.parse(request.input);
      const resolved = await resolveOwnerUserId(input.ownerUserId, request);
      return upsertCustomSkill({ ...input, ownerUserId: resolved });
    },

    "skills_personal_delete": async (request: PrimitiveInvocationRequest<unknown>) => {
      const input = deleteSkillSchema.parse(request.input);
      const resolved = await resolveOwnerUserId(input.ownerUserId, request);
      await deleteCustomSkill({ ...input, ownerUserId: resolved });
      return { ok: true };
    },

    "skills_packages_list": async (request: PrimitiveInvocationRequest<unknown>) => {
      // The raw `listInstalledSkillPackages()` embeds each package's
      // SkillManifest entries WITH their `content` (SKILL.md body). Filter
      // each package's embedded skills through the same per-skill access gate
      // used by the read handlers; drop unauthorized skills. Preserves API
      // shape for authorized rows.
      const orgId = await resolveOrgIdFromSession(
        request.actor as { orgId?: string | null } | undefined,
      );
      const actorCtx = await actorContextFromMcpRequest(
        request.actor as PrimitiveActorContext,
        orgId,
      );
      const packages = await listInstalledSkillPackages();
      return packages
        .map((pkg) => {
          const visibleSkills = (pkg.skills ?? []).filter((s) => {
            try {
              // Use the builder so org-scoped rows carry the skill's owning
              // org, not caller org.
              requireResourceAccess(actorCtx, buildSkillResourceRef({
                id: s.id,
                level: s.level,
                scope: s.scope ?? null,
                // Durable owner (cinatra#1416, AC7): owner keeps read of a shared personal skill.
                ownerUserId: s.ownerUserId ?? null,
                // Effective policy (W4): skill override else this package's.
                accessPolicy: resolveEffectiveSkillAccessPolicy(s, [pkg]),
              }));
              return true;
            } catch {
              return false;
            }
          });
          return {
            ...pkg,
            skills: visibleSkills,
            // Recompute so the count reflects what's actually visible.
            skillCount: visibleSkills.length,
          };
        })
        // Drop fully-filtered packages; bare metadata (readmeContent,
        // licenseText, repo URL, authors) still leaks package existence when
        // nothing is visible.
        .filter((pkg) => (pkg.skills?.length ?? 0) > 0);
    },

    "skills_packages_install_from_github": async (request: PrimitiveInvocationRequest<unknown>) => {
      // This handler installs from GitHub and returns the raw result, which
      // embeds scanned skill rows with SKILL.md `content`. Require an admin so
      // authenticated MCP callers cannot install and read arbitrary
      // GitHub-hosted skill content.
      await requireAdminActor(request.actor as PrimitiveActorContext);
      const { repoRef, connectionId, consentToAnthropicUpload } =
        installFromGitHubSchema.parse(request.input);
      const { installSkillPackageFromGitHub } = await import("../github");
      // cinatra#2092 (S5): snapshot BEFORE the install so the consent closure is
      // exactly what this install produced (root + transitive skill extensions).
      const { snapshotSkillPackageIds } = await import(
        "@/lib/anthropic-skill-config-service"
      );
      const packageIdsBeforeInstall = snapshotSkillPackageIds();
      const result = await installSkillPackageFromGitHub(repoRef, connectionId);

      // Explicit lifecycle rebuild (cinatra#1364): merge the newly-installed
      // package into the catalog NOW instead of on some later implicit read.
      await rebuildSkillsCatalog({ reason: "mcp-skill-package-install" });

      // cinatra#2092 (S5) — FAIL-CLOSED headless consent. Without an explicit
      // `consentToAnthropicUpload: true` no consent row is written, so the
      // derived projection keeps the installed skills upload-INELIGIBLE and
      // nothing egresses. The outcome is RECORDED on the response either way.
      let uploadConsent: {
        granted: boolean;
        reason: string;
        outcome: string;
        scopeKeys: string[];
      };
      try {
        const { resolveInstalledClosure, recordSkillInstallConsent } = await import(
          "@/lib/anthropic-skill-config-service"
        );
        const rootPackageId =
          typeof (result as { packageId?: unknown })?.packageId === "string"
            ? (result as { packageId: string }).packageId
            : "";
        const recorded = recordSkillInstallConsent({
          consent:
            consentToAnthropicUpload === true ? { granted: true } : null,
          closure: resolveInstalledClosure({
            before: packageIdsBeforeInstall,
            rootPackageId,
          }),
          grantedBy:
            typeof (request.actor as { userId?: unknown })?.userId === "string"
              ? ((request.actor as { userId: string }).userId)
              : null,
          // Programmatic: no confirmation surface rendered the closure, so the
          // explicit parameter alone is the act (no digest check).
          interactive: false,
        });
        uploadConsent = {
          granted: recorded.grant,
          reason: recorded.reason,
          outcome: recorded.outcome,
          scopeKeys: recorded.granted,
        };
      } catch (err) {
        console.warn(
          "[skills/mcp] Anthropic upload consent recording failed (skills stay upload-ineligible):",
          err instanceof Error ? err.message : err,
        );
        uploadConsent = {
          granted: false,
          reason: "consent-record-failed",
          outcome:
            "The upload consent could not be recorded — the installed skills stay excluded from upload.",
          scopeKeys: [],
        };
      }

      // Fan out one inline re-evaluation job per newly-installed skill.
      // Failures here MUST NOT abort the install; log and continue. BullMQ
      // deduplicates by jobId so a re-install storm collapses into a single
      // execution per skill.
      const installedSkills = Array.isArray(result?.skills) ? result.skills : [];
      for (const skill of installedSkills) {
        try {
          await enqueueInlineForSkill(skill.id);
        } catch (err) {
          console.warn(
            `[skills/mcp] enqueueInlineForSkill failed for ${skill.id}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
      // Auto-registered agent-level skills too.
      const autoRegisteredAgentSkills = Array.isArray(result?.agentSkills?.registered)
        ? result.agentSkills.registered
        : [];
      for (const skillId of autoRegisteredAgentSkills) {
        try {
          await enqueueInlineForSkill(skillId);
        } catch (err) {
          console.warn(
            `[skills/mcp] enqueueInlineForSkill failed for ${skillId}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
      // cinatra#2092 (S5): the consent outcome rides the response so a
      // programmatic caller can SEE that its install stayed upload-ineligible
      // rather than having to infer it.
      return { ...(result as Record<string, unknown>), uploadConsent };
    },

    "skills_packages_uninstall": async (request: PrimitiveInvocationRequest<unknown>) => {
      // MCP equivalent of the server-action uninstall gate. Without this, any
      // authenticated MCP caller could uninstall any installed skill package.
      await requireAdminActor(request.actor as PrimitiveActorContext);
      const { packageId } = uninstallPackageSchema.parse(request.input);

      // Enumerate the skill IDs BEFORE calling uninstallSkillPackage, which
      // removes them from the catalog. Failures in cleanup MUST NOT abort the
      // uninstall; log and continue.
      const catalogBefore = await readSkillsCatalogSnapshot();
      const skillIdsForCleanup = catalogBefore.skills
        .filter((s) => s.packageId === packageId)
        .map((s) => s.id);

      const removed = await uninstallSkillPackage(packageId);

      if (removed) {
        // cinatra#2092 (S5): revoke the package identity's upload consent
        // BEFORE the rebuild, so a later re-install must ask again instead of
        // inheriting the old grant. The rebuild's own transaction schedules the
        // delayed GC row at grace-window expiry, reclaiming the remote copies
        // with no manual step. Never fatal to the uninstall.
        try {
          const { revokeSkillPackageUploadConsent } = await import(
            "@/lib/anthropic-skill-config-service"
          );
          revokeSkillPackageUploadConsent({ packageId, revokedBy: null });
        } catch (err) {
          console.warn(
            "[skills/mcp] upload-consent revoke on uninstall failed:",
            err instanceof Error ? err.message : err,
          );
        }
        // Explicit lifecycle rebuild (cinatra#1364) — reconcile the catalog
        // after the uninstall's disk + row removal; never abort the uninstall.
        try {
          await rebuildSkillsCatalog({ reason: "mcp-skill-package-uninstall" });
        } catch (err) {
          console.warn(
            "[skills/mcp] catalog rebuild after uninstall failed:",
            err instanceof Error ? err.message : err,
          );
        }
        for (const skillId of skillIdsForCleanup) {
          try {
            await cleanupForSkill(skillId);
          } catch (err) {
            console.warn(
              `[skills/mcp] cleanupForSkill failed for ${skillId}:`,
              err instanceof Error ? err.message : err,
            );
          }
        }
      }
      return { ok: removed };
    },

    "skills_library_list": async (request: PrimitiveInvocationRequest<unknown>) => {
      const input = libraryListSchema.parse(request.input);
      const catalog = await readSkillsCatalogSnapshot();
      let skills = catalog.skills;

      // Apply the same per-row visibility filter as skills_installed_list.
      // System-level skills are hidden from non-admin callers even in the
      // library catalog.
      const orgId = await resolveOrgIdFromSession(
        request.actor as { orgId?: string | null } | undefined,
      );
      const actorCtx = await actorContextFromMcpRequest(request.actor as PrimitiveActorContext, orgId);
      skills = skills.filter((s) => {
        try {
          // Use the auth-policy resource-ref builder for consistent scope.
          requireResourceAccess(actorCtx, buildSkillResourceRef({
            id: s.id,
            level: s.level,
            scope: s.scope ?? null,
            // Durable owner (cinatra#1416, AC7): owner keeps read of a shared personal skill.
            ownerUserId: s.ownerUserId ?? null,
            // Effective policy (W4): skill override else parent package's.
            accessPolicy: resolveEffectiveSkillAccessPolicy(s, catalog.skillPackages ?? []),
          }));
          return true;
        } catch {
          return false;
        }
      });

      if (input.level) {
        skills = skills.filter((s) => s.level === input.level);
      }
      if (input.query) {
        const q = input.query.toLowerCase();
        skills = skills.filter(
          (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
        );
      }
      return skills;
    },

    "skills_installed_get": async (request: PrimitiveInvocationRequest<unknown>) => {
      const { skillId } = installedSkillIdSchema.parse(request.input);
      let skill = await getInstalledSkillById(skillId);
      if (!skill) return null;

      // Gate on actor visibility before returning content.
      try {
        const orgId = await resolveOrgIdFromSession(
          request.actor as { orgId?: string | null } | undefined,
        );
        const actorCtx = await actorContextFromMcpRequest(request.actor as PrimitiveActorContext, orgId);
        // Stamp whether this is an unauthenticated in-CMS widget-chat skill —
        // the AUTHORITATIVE flag (derived from the active extensions'
        // `cinatra.capabilities` keyed `widget-chat.*`, NOT a slug naming
        // convention) that lets `requireResourceAccess` apply the narrow
        // roleless-internal-model carve-out for the unauthenticated widget SSE
        // stream. Any other workspace skill stays org-gated.
        const isWidgetChatSkill = await isWidgetChatSkillId(skill.id);
        // Effective policy (W4): skill override else parent package's.
        const effectivePolicy = resolveEffectiveSkillAccessPolicy(
          skill,
          (await readSkillsCatalogSnapshot()).skillPackages ?? [],
        );
        // Use the auth-policy resource-ref builder for consistent scope.
        const skillRef = buildSkillResourceRef({
          id: skill.id,
          level: skill.level,
          scope: skill.scope ?? null,
          // Durable owner (cinatra#1416, AC7): owner keeps read of a shared personal skill.
          ownerUserId: skill.ownerUserId ?? null,
          isWidgetChatSkill,
          accessPolicy: effectivePolicy,
        });
        requireResourceAccess(actorCtx, skillRef);
        // A3 (cinatra#1363): a non-deliverable (draft/archived/unknown-state)
        // skill is a runtime-delivery leak here — return its content ONLY to a
        // `manage` actor (management-plane restore/rollback/history). A read
        // (runtime) actor gets 404 semantics, identical to a visibility miss.
        // Fail-closed: an unresolved lifecycle state also requires `manage`.
        if (!isMcpSkillRuntimeDeliverable(skill.id)) {
          requireResourceAccess(actorCtx, skillRef, "manage");
        }
      } catch (err) {
        if (err instanceof AuthzError) return null; // 404 semantics — same wire shape as not-found
        throw err;
      }

      // Migrate old DB-only entries that have content but no sourcePath.
      // upsertSkill writes the file to disk and updates the catalog record with sourcePath.
      if (!skill.sourcePath && skill.content) {
        try {
          const migrated = await upsertSkill({
            skillId: skill.id,
            type: skill.level ?? "team",
            packageName: skill.packageName,
            name: skill.name,
            description: skill.description,
            content: skill.content,
            basedOnSkillId: skill.basedOnSkillId,
          });
          skill = { ...skill, ...migrated };
        } catch {
          // Migration failed (fs unavailable, etc.) — return the existing record as-is.
        }
      }

      // If sourcePath is set, re-read content from disk so it's always
      // authoritative (also handles stale inline DB content). Routed through
      // `readSkillContent` so the read goes through the SkillSource-aware
      // entry-point + the strict skill-root containment check. A raw inline
      // existsSync+readFileSync would bypass both, so a
      // payload-injected traversal `sourcePath` could read arbitrary files.
      if (skill.sourcePath) {
        try {
          const diskContent = await readSkillContent(skill);
          skill = { ...skill, content: diskContent };
        } catch (err) {
          const code = (err as NodeJS.ErrnoException)?.code;
          if (code === "ENOENT") {
            return {
              error: `Skill file missing at ${skill.sourcePath}. Re-create or update this skill to restore it.`,
            };
          }
          throw err;
        }
      }

      const { body } = parseFrontmatter(skill.content);
      return { ...skill, body: body.trim() };
    },

    "skills_installed_list": async (request: PrimitiveInvocationRequest<unknown>) => {
      const { cursor, limit: rawLimit } = listInstalledSkillsInputSchema.parse(request.input ?? {});
      const limit = Math.min(rawLimit ?? 50, 200);
      const offset = decodeCursor(cursor);

      // Resolve actor context and filter rows by visibility.
      const orgId = await resolveOrgIdFromSession(
        request.actor as { orgId?: string | null } | undefined,
      );
      const actorCtx = await actorContextFromMcpRequest(request.actor as PrimitiveActorContext, orgId);

      const allSkills = await listInstalledSkills();
      // Resolve package inheritance once for the whole page (W4).
      const installedSkillPackages = (await readSkillsCatalogSnapshot()).skillPackages ?? [];
      // A3 (cinatra#1363): batch-read lifecycle once so the default listing
      // excludes non-deliverable (archived/draft/unknown-state) skills from read
      // actors (fail-closed on a read error — see the per-row gate below).
      const listLifecycle = readSkillLifecycleStates(allSkills.map((s) => s.id));

      // Post-fetch row filter: requireResourceAccess throws on deny; catch silently to exclude.
      const visibleSkills = allSkills.filter((skill) => {
        // Use the auth-policy resource-ref builder for consistent scope.
        const skillRef = buildSkillResourceRef({
          id: skill.id,
          level: skill.level,
          scope: skill.scope ?? null,
          // Durable owner (cinatra#1416, AC7): owner keeps read/delivery of a shared personal skill.
          ownerUserId: skill.ownerUserId ?? null,
          accessPolicy: resolveEffectiveSkillAccessPolicy(skill, installedSkillPackages),
        });
        try {
          requireResourceAccess(actorCtx, skillRef);
        } catch {
          return false;
        }
        // Exclude a non-deliverable (archived/draft/unknown-state) skill from
        // the DEFAULT listing; a `manage` actor still sees it (management-plane).
        // FAIL-CLOSED: a lifecycle-read error makes EVERY skill unresolved ⇒
        // non-deliverable ⇒ manage-only, so a read (runtime) actor never sees an
        // archived/draft row even during a lifecycle-table blip.
        const listDeliverable =
          listLifecycle.ok &&
          isRuntimeDeliverableLifecycleState(
            listLifecycle.states.has(skill.id) ? listLifecycle.states.get(skill.id) : undefined,
          );
        if (!listDeliverable) {
          try {
            requireResourceAccess(actorCtx, skillRef, "manage");
          } catch {
            return false;
          }
        }
        return true;
      });

      const metadataItems = visibleSkills.map((skill) => ({
        id: skill.id,
        name: skill.name,
        slug: skill.slug,
        description: skill.description,
        packageId: skill.packageId,
        packageName: skill.packageName,
        packageSlug: skill.packageSlug,
        sourceUrl: skill.sourceUrl,
        usedBy: skill.usedBy,
        sourcePath: skill.sourcePath,
        basedOnSkillId: skill.basedOnSkillId,
        level: skill.level,
        scope: skill.scope,
      }));
      // Pagination applied AFTER filter so cursor/total counts are visibility-correct.
      const slice = metadataItems.slice(offset, offset + limit);
      return buildListPage(slice, metadataItems.length, offset, limit);
    },

    "skills_matches_refresh": async (request: PrimitiveInvocationRequest<unknown>) => {
      // This handler reads the entire skill catalog + match table and writes
      // the legacy projection. The sibling skill-match admin handlers further
      // down (skills_matches_evaluate_pair, skills_matches_estimate_batch,
      // skills_matches_schedule_*) all gate via requireAdminActor; align this
      // one to the same posture.
      await requireAdminActor(request.actor as PrimitiveActorContext);
      const result = await matchAgentsToSkills();
      return { matchCount: result.matches.length, matchedAt: result.matchedAt };
    },

    "skills_installed_resolve_for_agent": async (request: PrimitiveInvocationRequest<unknown>) => {
      const { agentId, customSkillId } = resolveForAgentSchema.parse(request.input);
      // Thread actor context so custom + workspace skill assignments resolve;
      // getAssignedSkillIdsForAgent only unions custom_skill_assignments when
      // an actor is supplied.
      const orgId = await resolveOrgIdFromSession(
        request.actor as { orgId?: string | null } | undefined,
      );
      const actorCtx = await actorContextFromMcpRequest(
        request.actor as PrimitiveActorContext,
        orgId,
      );
      const rawSkillIds = await getAssignedSkillIdsForAgent(agentId, actorCtx);
      // getAssignedSkillIdsForAgent unconditionally unions all
      // `level === "system"` skill ids, so non-admin chat OBO callers could
      // enumerate admin-hidden system skill ids via this resolver. Content
      // remains protected by skills_installed_get. Post-filter the returned ids
      // through `requireResourceAccess` so the id surface matches the read
      // surface. Fetch the catalog once and gate every id; drop any id whose
      // owning skill rejects access.
      const skillById = new Map(
        (await listInstalledSkills()).map((entry) => [entry.id, entry] as const),
      );
      // Resolve package inheritance once for the id-surface filter (W4).
      const resolveSkillPackages = (await readSkillsCatalogSnapshot()).skillPackages ?? [];
      const skillIds = rawSkillIds.filter((id) => {
        const entry = skillById.get(id);
        // Ids that point to skills no longer in the catalog are dropped
        // defensively — they cannot be resolved to content downstream.
        if (!entry) return false;
        try {
          // Use the auth-policy resource-ref builder for consistent scope.
          requireResourceAccess(actorCtx, buildSkillResourceRef({
            id: entry.id,
            level: entry.level,
            scope: entry.scope ?? null,
            // Durable owner (cinatra#1416, AC7): owner keeps read/delivery of a shared personal skill.
            ownerUserId: entry.ownerUserId ?? null,
            accessPolicy: resolveEffectiveSkillAccessPolicy(entry, resolveSkillPackages),
          }));
          return true;
        } catch {
          return false;
        }
      });
      // resolveCustomSkillContent(customSkillId) returns the SKILL.md body.
      // Resolve the skill record + gate via requireResourceAccess before
      // returning content; silently undefined on deny so existence is not
      // leaked.
      let customSkillContent: string | undefined;
      if (customSkillId) {
        const skill = await getInstalledSkillById(String(customSkillId).trim());
        if (skill) {
          try {
            // Use the auth-policy resource-ref builder for consistent scope.
            const resolveRef = buildSkillResourceRef({
              id: skill.id,
              level: skill.level,
              scope: skill.scope ?? null,
              // Durable owner (cinatra#1416, AC7): owner keeps read/delivery of a shared personal skill.
              ownerUserId: skill.ownerUserId ?? null,
              accessPolicy: resolveEffectiveSkillAccessPolicy(skill, resolveSkillPackages),
            });
            requireResourceAccess(actorCtx, resolveRef);
            // A3 (cinatra#1363): withhold a non-deliverable (draft/archived/
            // unknown-state) custom skill's content from runtime delivery here;
            // only a `manage` actor may resolve it. Fail-closed on an unresolved
            // state. `catch` below already coerces a deny to `undefined`.
            if (!isMcpSkillRuntimeDeliverable(skill.id)) {
              requireResourceAccess(actorCtx, resolveRef, "manage");
            }
            customSkillContent = skill.content;
          } catch {
            customSkillContent = undefined;
          }
        }
      }
      return { skillIds, customSkillContent };
    },

    "skills_personal_skill_create_or_update": async (request: PrimitiveInvocationRequest<unknown>) => {
      const input = createOrUpdateCustomSkillSchema.parse(request.input);
      // Build the actor from the MCP request envelope and thread it into
      // createOrUpdateCustomSkillForAgent so the matched-skill catalog read is
      // gated by requireResourceAccess. Without this, admin-hidden `system`
      // skill content leaks into the LLM generation prompt and the persisted
      // `basedOnSkillIds`.
      const orgId = await resolveOrgIdFromSession(
        request.actor as { orgId?: string | null } | undefined,
      );
      const actorCtx = await actorContextFromMcpRequest(
        request.actor as PrimitiveActorContext,
        orgId,
      );
      // #1360 — forward the OWNER user id. createOrUpdateCustomSkillForAgent
      // REQUIRES input.userId (personal-skills.ts throws without it outside
      // dev-bypass), so without this the MCP create/update path always failed
      // in production. The owner is the authenticated caller — the same
      // identity actorCtx is derived from (actorContextFromMcpRequest sets
      // principalId := actor.userId) — never a caller-supplied input field. An
      // unattributable caller (no userId) leaves it undefined and the resolver
      // fails closed (dev-bypass fills LOCAL_USER_ID; production throws): a
      // personal skill is never created under an anonymous owner.
      const ownerUserId =
        typeof request.actor?.userId === "string" && request.actor.userId.length > 0
          ? request.actor.userId
          : undefined;
      const result = await createOrUpdateCustomSkillForAgent({
        ...(input as Parameters<typeof createOrUpdateCustomSkillForAgent>[0]),
        userId: ownerUserId,
        actor: actorCtx,
      });

      // Re-evaluate matches for the upserted personal skill. Failures here
      // MUST NOT abort the upsert; log and continue.
      const skillId = (result as { id?: string; skillId?: string } | null | undefined)?.id
        ?? (result as { id?: string; skillId?: string } | null | undefined)?.skillId;
      if (skillId) {
        try {
          await enqueueInlineForSkill(skillId);
        } catch (err) {
          console.warn(
            `[skills/mcp] enqueueInlineForSkill failed for personal skill ${skillId}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
      return result;
    },

    "skills_installed_upsert": async (request: PrimitiveInvocationRequest<unknown>) => {
      const { skillId, content, description } = upsertInstalledSkillSchema.parse(request.input);
      const existing = await getInstalledSkillById(skillId);
      if (!existing) {
        return { error: `Skill '${skillId}' not found. Only existing installed skills can be updated via this tool.` };
      }

      // Gate on actor visibility before allowing write. level:"system" skills
      // require platform_admin; all other levels use the same
      // requireResourceAccess guard as the read handlers (owner, org, team,
      // project, workspace). WRITE path uses mode "manage". Workspace skills
      // are READABLE by every workspace user, but only org_admin/org_owner (or
      // platform_admin) may MUTATE them.
      const orgId = await resolveOrgIdFromSession(
        request.actor as { orgId?: string | null } | undefined,
      );
      const actorCtx = await actorContextFromMcpRequest(request.actor as PrimitiveActorContext, orgId);
      try {
        // Use the builder so the org-scoped manage check uses the SKILL's
        // owning org, not the caller's.
        requireResourceAccess(
          actorCtx,
          buildSkillResourceRef({
            id: existing.id,
            level: existing.level,
            scope: existing.scope ?? null,
            // Durable owner + ownership-keyed MANAGE (cinatra#1416, AC2/AC8): on a
            // user-authored skill only the owner (or platform_admin) may MUTATE
            // via skills_installed_upsert; a granted-scope member gets read/use
            // only. Without ownerUserId the durable-owner short-circuit and the
            // owned-skill manage denial in requireResourceAccess cannot fire.
            ownerUserId: existing.ownerUserId ?? null,
            // Effective policy (W4): skill override else parent package's.
            accessPolicy: resolveEffectiveSkillAccessPolicy(
              existing,
              (await readSkillsCatalogSnapshot()).skillPackages ?? [],
            ),
          }),
          "manage",
        );
      } catch (err) {
        if (err instanceof AuthzError) {
          return { error: "Access denied. You do not have permission to update this skill." };
        }
        throw err;
      }

      const updated = await upsertSkill({
        skillId: existing.id,
        type: (existing.level ?? "system") as "system" | "team" | "organization" | "personal",
        packageName: existing.packageName,
        name: existing.name,
        description: description ?? existing.description,
        content,
        prefillText: "-",
      });
      const { body } = parseFrontmatter(updated.content);
      return { ...updated, body: body.trim() };
    },

    // ---------------------------------------------------------------------
    // Request-aware recommendation (cinatra#2041 S3, Point R).
    //
    // "Which of this agent's skills fit THIS task?" — the conversational
    // access to the SAME core scoring the run-start interception uses (AC-5:
    // no parallel implementation). Read-only + advisory: returns ranked skill
    // ids/names/scores + the run-intent features each was scored on. No skill
    // CONTENT is returned, so this exposes only recommendation metadata over
    // the matcher signal the agent already surfaces.
    // ---------------------------------------------------------------------
    "skills_recommend_for_task": async (request: PrimitiveInvocationRequest<unknown>) => {
      const input = recommendForTaskSchema.parse(request.input ?? {});
      const recommendations = await recommendSkillsForAgentTask({
        agentId: input.agentId,
        intent: {
          promptText: input.promptText,
          declaredProducedTypes: input.declaredProducedTypes,
          targetArtifactKind: input.targetArtifactKind,
        },
        restrictToSkillIds: input.restrictToSkillIds,
      });
      return {
        agentId: input.agentId,
        scorerVersion: REQUEST_AWARE_SCORER_VERSION,
        recommendations: recommendations.map((r) => ({
          skillId: r.skillId,
          skillRevisionId: r.skillRevisionId,
          name: r.name,
          score: r.score,
          rank: r.rank,
          recommended: r.recommended,
          scoredFeatures: r.scoredFeatures,
        })),
      };
    },

    // ---------------------------------------------------------------------
    // Admin-gated skill-match handlers.
    //
    // All four handlers call `requireAdminActor(request.actor)` as their
    // FIRST line. Defense-in-depth alongside the page-level admin gate on
    // /configuration/skills.
    // ---------------------------------------------------------------------

    "skills_match_schedule_get": async (request: PrimitiveInvocationRequest<unknown>) => {
      await requireAdminActor(request.actor as PrimitiveActorContext);
      skillMatchScheduleGetSchema.parse(request.input ?? {});
      const schedule = await readSchedule();
      return schedule;
    },

    "skills_match_schedule_set": async (request: PrimitiveInvocationRequest<unknown>) => {
      await requireAdminActor(request.actor as PrimitiveActorContext);
      const input = skillMatchScheduleSetSchema.parse(request.input);

      // Reject malformed cron BEFORE persistence. BullMQ's
      // `upsertJobScheduler` is not the first line of defense; a bad pattern
      // must not land in the DB row where the `try/catch` around
      // `registerSkillMatchScheduleAtBoot()` below could swallow the error,
      // leaving the system in "scheduler scheduled but won't run" state.
      //
      // We only validate when the schedule is being enabled. Disabling does
      // not require a valid expression (the value can be null).
      if (input.enabled && !isValidCronExpression(input.cronExpression)) {
        throw new PrimitiveInvocationError({
          code: "invalid_cron_expression",
          message: `Cron expression "${input.cronExpression ?? "<null>"}" is not a valid 5- or 6-field cron pattern. Examples: "0 3 * * *" (daily 3am), "*/15 * * * *" (every 15min).`,
          retryable: false,
        });
      }

      const updated = await writeSchedule({
        enabled: input.enabled,
        cronExpression: input.cronExpression,
        timezone: input.timezone,
      });
      // Apply immediately so the new cron takes effect without restart.
      // Failures are logged but MUST NOT abort the persisted update.
      try {
        await registerSkillMatchScheduleAtBoot();
      } catch (err) {
        console.warn(
          "[skills_match_schedule_set] scheduler re-registration failed:",
          err instanceof Error ? err.message : err,
        );
      }
      return updated;
    },

    "skills_match_batch_run_now": async (request: PrimitiveInvocationRequest<unknown>) => {
      await requireAdminActor(request.actor as PrimitiveActorContext);
      const input = skillMatchBatchRunNowSchema.parse(request.input ?? {});

      // Build the current pair set so the cost estimate reflects exactly the
      // work the batch transport would do. Batch run uses the installed-agents
      // reader.
      const agents = (await readAgentsForSkillMatching()).map(adaptAgentForMatching);
      const skills = (await listInstalledSkills())
        .filter((s) => s.level !== "agent" && s.level !== "system")
        .map(adaptSkillForMatching);
      const allPairs = agents.flatMap((agent) => skills.map((skill) => ({ agent, skill })));

      // The batch transport skips pairs that rule-short-circuit (match_when:
      // always / agent_id / agent_has_tag). The admin cost estimate +
      // `pairCount` must mirror that so the admin's confirmation modal doesn't
      // quote an inflated USD or a pair count that includes free rule matches.
      const llmPairs = allPairs.filter(
        ({ agent, skill }) => evaluateRuleShortCircuit(agent, skill) === null,
      );
      const ruleShortCircuited = allPairs.length - llmPairs.length;

      if (input.dryRun) {
        return {
          dryRun: true,
          ...estimateBatchCost(llmPairs),
          // Expose the breakdown so the admin UI can surface "N pairs go
          // through LLM, M pairs short-circuit by rule (free)".
          ruleShortCircuited,
          totalPairs: allPairs.length,
        };
      }

      const actor = request.actor as PrimitiveActorContext;
      // PrimitiveActorContext exposes the user identity as `userId` (not
      // `principalId`); used for the audit trail in
      // skill_match_batch_runs.submitted_by.
      const submittedBy = actor.userId ?? "unknown-admin";

      // Per-click distinct jobId so back-to-back admin clicks do NOT coalesce
      // (intentional — a fresh run after data changes must dispatch).
      const jobIdSeed = `${submittedBy}-${Date.now()}`;
      await enqueueBackgroundJob(
        BACKGROUND_JOB_NAMES.SKILL_MATCH_BATCH_SUBMIT,
        { submittedBy },
        { jobId: `skill-match-batch-submit-${jobIdSeed}` },
      );

      return {
        dryRun: false,
        submittedBy,
        pairCount: llmPairs.length,
        ruleShortCircuited,
        totalPairs: allPairs.length,
      };
    },

    "skills_match_evaluate_pair": async (request: PrimitiveInvocationRequest<unknown>) => {
      await requireAdminActor(request.actor as PrimitiveActorContext);
      const input = skillMatchEvaluatePairSchema.parse(request.input);

      // Anchor jobStartedAt BEFORE the catalog + skill reads. If captured after
      // the reads, a concurrent inline evaluation that lands between the
      // snapshot and the upsert can have a `jobStartedAt` strictly newer than
      // this re-evaluate's anchor while still being overwritten by the
      // re-evaluate row. Anchoring first means: if a concurrent newer write
      // lands, this re-evaluate's upsert is rejected as stale, preserving the
      // newer row.
      const jobStartedAt = new Date();

      // Per-pair eval uses the installed-agents reader.
      const agents = await readAgentsForSkillMatching();
      const agent = agents.find((a) => a.packageId === input.agentId);
      if (!agent) {
        throw new PrimitiveInvocationError({
          code: "agent_not_found",
          message: `Agent ${input.agentId} not found.`,
          retryable: false,
        });
      }
      const skill = await getInstalledSkillById(input.skillId);
      if (!skill) {
        throw new PrimitiveInvocationError({
          code: "skill_not_found",
          message: `Skill ${input.skillId} not found.`,
          retryable: false,
        });
      }

      const result = await evaluatePair(
        {
          agent: adaptAgentForMatching(agent),
          skill: adaptSkillForMatching(skill),
        },
        { now: () => new Date(), jobStartedAt },
      );
      return result;
    },
  } as const;
}
