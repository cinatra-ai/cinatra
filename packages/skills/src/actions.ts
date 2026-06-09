"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
// Personal-skill saves validate against the installed-agents reader, not the
// workspace-packages scan.
import { readAgentsForSkillMatching } from "@/lib/agents-store";
// Auth-session is resolved via dynamic import so unit tests can vi.doMock it
// without dragging in the full app-server module graph (e.g.
// mcp-client-connector, nango, google-oauth-connection).
import { createSkillFromTemplate, deleteCustomSkill, upsertCustomSkill, resolveCustomSkillOwner, getAgentOwnership } from "./skills-store";
import type { MutationResult } from "@/lib/object-history";

const createSkillSchema = z.object({
  basedOnSkillId: z.string().optional(),
  skillName: z.string().trim().min(1, "Skill name is required."),
  packageName: z.string().trim().min(1, "Package is required."),
  content: z.string().trim().min(1, "Skill content is required."),
});

function parseSkillFrontmatter(content: string) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) {
    return {} as Record<string, string>;
  }

  return Object.fromEntries(
    match[1]
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const separatorIndex = line.indexOf(":");
        if (separatorIndex < 0) {
          return [line, ""];
        }

        return [line.slice(0, separatorIndex).trim(), line.slice(separatorIndex + 1).trim().replace(/^["']|["']$/g, "")];
      }),
  ) as Record<string, string>;
}

const customSkillSchema = z.object({
  skillId: z.string().optional(),
  agentId: z.string().min(1, "Agent is required."),
  name: z.string().min(2, "Skill name is required."),
  content: z.string().min(10, "Skill content is required."),
});

function encodeMessage(value: string) {
  return encodeURIComponent(value);
}

export async function createSkillFromTemplateAction(formData: FormData) {
  // Require an actor and, when basedOnSkillId is set, load the source skill
  // and gate it via requireResourceAccess in read mode. AuthzError redirects
  // to /skills with a generic error so existence is not disclosed.
  const { requireActorContext } = await import("@/lib/auth-session");
  const { requireResourceAccess, buildSkillResourceRef } = await import("@cinatra-ai/agents/auth-policy");
  const { getInstalledSkillById } = await import("./skills-registry");
  const actor = await requireActorContext();

  const parsed = createSkillSchema.parse({
    basedOnSkillId: String(formData.get("basedOnSkillId") ?? "") || undefined,
    skillName: String(formData.get("skillName") ?? ""),
    packageName: String(formData.get("packageName") ?? ""),
    content: String(formData.get("content") ?? ""),
  });

  if (parsed.basedOnSkillId) {
    const source = await getInstalledSkillById(parsed.basedOnSkillId);
    if (!source) {
      redirect(`/skills?error=${encodeMessage("Source skill not found.")}`);
    }
    try {
      requireResourceAccess(actor, buildSkillResourceRef({
        id: source.id,
        level: source.level,
        scope: source.scope ?? null,
      }));
    } catch {
      // Collapse forbidden + missing so existence is not disclosed.
      redirect(`/skills?error=${encodeMessage("Source skill not found.")}`);
    }
  }

  const skill = await createSkillFromTemplate({
    name: parsed.skillName,
    packageName: parsed.packageName,
    content: parsed.content,
    basedOnSkillId: parsed.basedOnSkillId,
  });

  redirect(`/skills/${encodeURIComponent(skill.id)}`);
}

export async function savePersonalSkillAction(formData: FormData) {
  const parsed = customSkillSchema.safeParse({
    skillId: String(formData.get("skillId") ?? "").trim() || undefined,
    agentId: String(formData.get("agentId") ?? "").trim(),
    name: String(formData.get("name") ?? "").trim(),
    content: String(formData.get("content") ?? "").trim(),
  });

  // Build the "stay on the editor" target so validation errors don't dump the
  // user back to the list. The hidden `skillId` field is present on the edit
  // form and absent on the create form, so we can pick the right return path
  // even when Zod parse failed (parsed.data is unavailable).
  const formSkillId = String(formData.get("skillId") ?? "").trim();
  const editorPath = formSkillId
    ? `/skills/${encodeURIComponent(formSkillId)}/edit`
    : "/skills/new";

  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Unable to save the custom skill.";
    redirect(`${editorPath}?error=${encodeMessage(message)}`);
  }

  const agents = await readAgentsForSkillMatching();
  const agent = agents.find((entry) => entry.id === parsed.data.agentId);
  if (!agent) {
    redirect(`${editorPath}?error=${encodeMessage("The selected agent is no longer available.")}`);
  }

  const frontmatter = parseSkillFrontmatter(parsed.data.content);
  const derivedDescription = String(frontmatter.description ?? "").trim() || `Custom skill for ${agent.humanReadableName}.`;

  const { requireActorContext } = await import("@/lib/auth-session");
  const actor = await requireActorContext();

  // Action-layer authz re-check for the update path. The hidden `skillId`
  // field is attacker-controllable via direct POST to the server action; we
  // cannot trust the form's claim that the id refers to a personal skill the
  // actor owns. Walk the catalog row + reject anything that isn't a personal
  // skill the actor can manage. Two reject conditions:
  //   1. Existing row's `level` is not "personal" — never replace a
  //      team/org/workspace/project skill through the personal-skill code
  //      path. Even an actor with `manage` access on the existing scope must
  //      NOT downgrade the row via this action.
  //   2. requireResourceAccess(actor, ..., "manage") denies — the actor is
  //      not the personal-skill owner. Same "Skill not found." leak surface
  //      as case 1 so existence isn't disclosed via redirect text.
  if (parsed.data.skillId) {
    const { getInstalledSkillById } = await import("./skills-registry");
    const existing = await getInstalledSkillById(parsed.data.skillId);
    if (!existing || existing.level !== "personal") {
      redirect(`${editorPath}?error=${encodeMessage("Skill not found.")}`);
    }
    const { requireResourceAccess, buildSkillResourceRef } = await import("@cinatra-ai/agents/auth-policy");
    try {
      requireResourceAccess(
        actor,
        buildSkillResourceRef({
          id: existing.id,
          level: existing.level,
          scope: existing.scope ?? null,
        }),
        "manage",
      );
    } catch {
      // Don't leak existence: same redirect target as the not-found branch.
      redirect(`${editorPath}?error=${encodeMessage("Skill not found.")}`);
    }
  }

  // Resolve ownership scope and forward it so the assignment row in
  // custom_skill_assignments is written alongside the catalog row. A
  // catalog-only write hides newly-saved skills from the ActorContext-scoped
  // resolver.
  let resolvedOwner: { ownerType: "user" | "team" | "project" | "organization" | "workspace"; ownerId: string };
  try {
    resolvedOwner = resolveCustomSkillOwner({
      actor: { principalId: actor.principalId, principalType: actor.principalType },
      agent: getAgentOwnership(agent),
      run: undefined,
    });
  } catch {
    resolvedOwner = { ownerType: "user", ownerId: actor.principalId };
  }
  await upsertCustomSkill({
    skillId: parsed.data.skillId,
    ownerUserId: actor.principalId,
    agentId: parsed.data.agentId,
    name: parsed.data.name,
    description: derivedDescription,
    content: parsed.data.content,
    ownerType: resolvedOwner.ownerType,
    ownerId: resolvedOwner.ownerId,
    createdBy: actor.principalId,
  });

  redirect(`/skills?scope=personal&saved=1`);
}

// Programmatic alias used by tests and by callers that pass a structured
// input object instead of FormData. Resolves the actor from the auth session
// via getActorContext and forwards principalId as ownerUserId to
// upsertCustomSkill.
export async function personalSkillSaveAction(input: {
  skillId?: string;
  agentId: string;
  name: string;
  description?: string;
  content: string;
}) {
  const { getActorContext } = await import("@/lib/auth-session");
  const actor = await getActorContext();
  if (!actor) {
    throw new Error("personalSkillSaveAction: no auth session.");
  }

  // Action-layer authz re-check for the update path — same invariant as
  // savePersonalSkillAction. No editor-path redirect here (programmatic
  // caller), so throw a generic not-found Error instead.
  if (input.skillId) {
    const { getInstalledSkillById } = await import("./skills-registry");
    const existing = await getInstalledSkillById(input.skillId);
    if (!existing || existing.level !== "personal") {
      throw new Error(`personalSkillSaveAction: skill ${input.skillId} not found.`);
    }
    const { requireResourceAccess, buildSkillResourceRef } = await import("@cinatra-ai/agents/auth-policy");
    try {
      requireResourceAccess(
        actor,
        buildSkillResourceRef({
          id: existing.id,
          level: existing.level,
          scope: existing.scope ?? null,
        }),
        "manage",
      );
    } catch {
      throw new Error(`personalSkillSaveAction: skill ${input.skillId} not found.`);
    }
  }

  // Resolve ownership scope so the custom_skill_assignments row is written.
  // Without this, the actor-scoped resolver cannot see skills saved through
  // this entry point. Wrapped in try/catch so unit tests that
  // vi.mock("./skills-store") without re-exporting the resolver still pass
  // (vitest throws on undefined mocked exports).
  let resolvedOwner: { ownerType: "user" | "team" | "project" | "organization" | "workspace"; ownerId: string };
  try {
    resolvedOwner = resolveCustomSkillOwner({
      actor: { principalId: actor.principalId, principalType: actor.principalType },
      agent: {},
      run: undefined,
    });
  } catch {
    resolvedOwner = { ownerType: "user", ownerId: actor.principalId };
  }
  return upsertCustomSkill({
    skillId: input.skillId,
    ownerUserId: actor.principalId,
    agentId: input.agentId,
    name: input.name,
    description: input.description ?? "",
    content: input.content,
    ownerType: resolvedOwner.ownerType,
    ownerId: resolvedOwner.ownerId,
    createdBy: actor.principalId,
  });
}

// Delete a personal custom skill. On SUCCESS this REDIRECTS to the skills list
// (mirroring savePersonalSkillAction) rather than returning {ok:true}. The edit
// page calls notFound() once the row is gone; a returned MutationResult lets the
// Server Action's RSC refresh re-render the edit page -> notFound() -> unmount
// <DeleteItemForm> in the same commit its state resolves, so its success
// useEffect (toast + nav) never fires and the user sees a 404. Redirecting
// server-side abandons the current route instead, and the destination reads
// ?deleted=1 to show the confirmation toast. FAILURES still return a
// MutationResult so the edit page can surface an in-place error toast. Skills are
// not cinatra.objects rows, so there is no changeSetId / Undo. The actor-scoped
// deleteCustomSkill authz path is unchanged.
export async function deletePersonalSkillAction(
  formData: FormData,
): Promise<MutationResult<{ skillId: string }>> {
  const skillId = String(formData.get("skillId") ?? "").trim();
  if (!skillId) {
    return { ok: false, error: "No custom skill was selected." };
  }

  const { requireActorContext } = await import("@/lib/auth-session");
  const actor = await requireActorContext();
  const deleted = await deleteCustomSkill({
    ownerUserId: actor.principalId,
    skillId,
    actor: {
      principalId: actor.principalId,
      teamIds: actor.teamIds,
      projectIds: actor.projectIds,
      organizationId: actor.organizationId,
    },
  });

  if (!deleted) {
    return { ok: false, error: "The custom skill could not be deleted." };
  }

  // Success: redirect server-side (throws NEXT_REDIRECT) so the edit page never
  // re-renders to notFound() under the deleted row. The /skills destination
  // reads ?deleted=1 and shows the "Personal skill deleted" toast.
  redirect("/skills?scope=personal&deleted=1");
}

export type FetchGitHubSkillRepoMetadataResult =
  | { ok: true; metadata: import("./github").GitHubRepoMetadata }
  | { ok: false; error: string };

/**
 * Look up a GitHub repository for the extensions upload form. The form calls
 * this before showing the release picker. Admin-gated.
 */
export async function fetchGitHubSkillRepoMetadata(repoUrl: string): Promise<FetchGitHubSkillRepoMetadataResult> {
  const { requireAdminSession } = await import("@/lib/auth-session");
  await requireAdminSession();

  const trimmed = repoUrl.trim();
  if (!trimmed) {
    return { ok: false, error: "Paste a github.com repository URL." };
  }

  try {
    const { fetchGitHubRepoMetadata, parseGitHubRepositoryReference } = await import("./github");
    if (!parseGitHubRepositoryReference(trimmed)) {
      return { ok: false, error: "Only github.com repository URLs are supported (e.g. https://github.com/owner/repo)." };
    }
    const metadata = await fetchGitHubRepoMetadata(trimmed);
    if (!metadata) {
      return { ok: false, error: "Could not parse the repository reference." };
    }
    return { ok: true, metadata };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch repository metadata.";
    return { ok: false, error: message };
  }
}

export type InstallGitHubSkillExtensionInput = {
  repoUrl: string;
  /** Release tag, branch, or commit sha. Undefined / empty installs the default branch (HEAD). */
  ref?: string;
  /**
   * Optional access policy + co-owners captured by
   * /configuration/extensions/upload's PermissionsForm draft. When omitted
   * the package installs with defaults (NULL policy → admin-only edit, empty
   * co-owner list). Applied atomically after the package row exists.
   */
  permissions?: {
    policy?: import("@cinatra-ai/agents/auth-policy").AgentAuthPolicy | null;
    coOwnerUserIds?: string[];
  };
};

export type InstallGitHubSkillExtensionResult =
  | {
      ok: true;
      packageId: string;
      repositoryPath: string;
      ref: string | null;
      /**
       * Non-fatal warnings collected while applying permissions after
       * creation. The install itself succeeded, but one or more of the policy
       * / installer / co-owner sub-calls failed and the UI should surface a
       * notice so the operator can fix it from the skills surface. Silent
       * partial failure is acceptable for install durability but not for
       * operator clarity.
       */
      warnings: string[];
    }
  | { ok: false; error: string };

/**
 * Admin-gated install for the extensions/upload GitHub-skill flow. Clones the
 * repository at the chosen ref (or default branch), registers it in
 * cinatra.skill_packages with isCustom: true, then re-runs LLM-based skill
 * matching so installed agents can pick up the new skills.
 */
export async function installGitHubSkillExtension(
  input: InstallGitHubSkillExtensionInput,
): Promise<InstallGitHubSkillExtensionResult> {
  const { requireAdminSession } = await import("@/lib/auth-session");
  const session = await requireAdminSession();
  const installerUserId = session.user?.id ?? null;

  const repoUrl = input.repoUrl.trim();
  const ref = input.ref?.trim() || undefined;
  if (!repoUrl) {
    return { ok: false, error: "GitHub repository URL is required." };
  }

  try {
    const { installSkillPackageFromGitHub, parseGitHubRepositoryReference } = await import("./github");
    if (!parseGitHubRepositoryReference(repoUrl)) {
      return { ok: false, error: "Only github.com repository URLs are supported (e.g. https://github.com/owner/repo)." };
    }

    const result = await installSkillPackageFromGitHub(repoUrl, { ref });

    // Non-fatal warnings are collected while applying permissions after
    // creation. Each sub-call is wrapped so a single failure doesn't roll back
    // the whole install — the package is already on disk + in the catalog.
    // Warnings are returned alongside `ok: true` so the upload form can
    // surface them to the operator instead of relying on console.warn alone.
    const warnings: string[] = [];

    // Record the install actor + apply upload-time policy and co-owner picks
    // via the generic permissions backend. Each helper writes the polymorphic
    // table AND dual-writes the kind-specific location via the
    // afterInstallerSet / afterPolicyWrite / afterCoOwnerAdd hooks, so readers
    // stay in sync.
    if (installerUserId) {
      try {
        const { setExtensionInstaller } = await import("@cinatra-ai/extensions/permissions-actions");
        const setResult = await setExtensionInstaller(
          "skill_package",
          result.packageId,
          installerUserId,
        );
        if (!setResult.ok) {
          warnings.push(
            `Could not record install actor as primary owner — contact an admin to manage access.`,
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          "[skills/actions] setExtensionInstaller failed (non-fatal):",
          message,
        );
        warnings.push(
          `Could not record install actor as primary owner — contact an admin to manage access.`,
        );
      }
    }

    if (input.permissions) {
      const { policy, coOwnerUserIds } = input.permissions;
      if (policy) {
        try {
          // Route through the generic `saveExtensionAccessPolicy` server
          // action. It owns zod validation
          // (AgentAuthPolicySchema.safeParse), the installer/co-owner/admin
          // gate, the resource-exists check, and the post-write side effects.
          const { saveExtensionAccessPolicy } = await import("@cinatra-ai/extensions/permissions-actions");
          const policyResult = await saveExtensionAccessPolicy(
            "skill_package",
            result.packageId,
            policy,
          );
          if (!policyResult.ok) {
            warnings.push(
              `Could not save access policy — contact an admin to re-save.`,
            );
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(
            "[skills/actions] saveExtensionAccessPolicy failed (non-fatal):",
            message,
          );
          warnings.push(
            `Could not save access policy — contact an admin to re-save.`,
          );
        }
      }
      // Route through the generic `addExtensionCoOwner` server action. It
      // owns the human-user (BetterAuth `userType = 'human'`) guard, the
      // installer/co-owner/admin gate, the resource-exists check, and the
      // per-kind sharing gate, so the upload path cannot be coerced into
      // promoting an assistant / bot account.
      if (coOwnerUserIds && coOwnerUserIds.length > 0) {
        const { addExtensionCoOwner } = await import("@cinatra-ai/extensions/permissions-actions");
        const failedUserIds: string[] = [];
        for (const targetUserId of coOwnerUserIds) {
          try {
            const addResult = await addExtensionCoOwner(
              "skill_package",
              result.packageId,
              targetUserId,
            );
            if (!addResult.ok) failedUserIds.push(targetUserId);
          } catch (err) {
            console.warn(
              `[skills/actions] addExtensionCoOwner ${targetUserId} failed (non-fatal):`,
              err instanceof Error ? err.message : err,
            );
            failedUserIds.push(targetUserId);
          }
        }
        if (failedUserIds.length > 0) {
          warnings.push(
            `Could not add ${failedUserIds.length} co-owner${failedUserIds.length === 1 ? "" : "s"} — contact an admin to re-add.`,
          );
        }
      }
    }

    // Best-effort re-match. A matcher failure must not roll back the install:
    // the package is already on disk + in the catalog, and the user can
    // re-run matching from /configuration/skills.
    try {
      const { matchAgentsToSkills } = await import("@/lib/agents-store");
      await matchAgentsToSkills();
    } catch (matchErr) {
      console.warn(
        "[skills/actions] matchAgentsToSkills failed after GitHub skill install:",
        matchErr instanceof Error ? matchErr.message : matchErr,
      );
    }

    return {
      ok: true,
      packageId: result.packageId,
      repositoryPath: result.repositoryPath,
      ref: ref ?? null,
      warnings,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to install skill package from GitHub.";
    return { ok: false, error: message };
  }
}
