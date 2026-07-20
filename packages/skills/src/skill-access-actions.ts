"use server";

// ---------------------------------------------------------------------------
// Skill visibility persistence note:
//
// Skills with organization visibility store "org" (literal) in skills.scope,
// while personal-level skills store ownerUserId. No `level="team"` rows exist
// in the DB. We store visibility by mapping AgentAuthPolicyVisibility back to
// the existing (level, scope) columns:
//
//   "owner"         → level="personal",      scope=userId
//   "org"           → level="organization",  scope="org"
//   "team:<id>"     → level="team",          scope=<id>  (stubbed — no live rows yet)
//   "project:<id>"  → level="project",       scope=<id>
//   "workspace"     → level="workspace",     scope=undefined
//   "admin"         → level="system",        scope=undefined
//
// No SQL migration is required: the existing level + scope columns can hold
// all supported variants without modification.
// ---------------------------------------------------------------------------

import { getAuthSession } from "@/lib/auth-session";
import { getInstalledSkillById } from "./skills-registry";
import { updateSkillVisibility } from "./skills-store";
import type { AgentAuthPolicyVisibility } from "@cinatra-ai/agents";

// ---------------------------------------------------------------------------
// Visibility token validation
// ---------------------------------------------------------------------------

const VISIBILITY_SCALAR = new Set<string>(["owner", "org", "admin", "workspace"]);
const VISIBILITY_PREFIX = ["org:", "team:", "project:"];

function isValidVisibility(v: string): v is AgentAuthPolicyVisibility {
  if (VISIBILITY_SCALAR.has(v)) return true;
  return VISIBILITY_PREFIX.some((p) => v.startsWith(p) && v.length > p.length);
}

// ---------------------------------------------------------------------------
// Server action
// ---------------------------------------------------------------------------

export async function saveSkillVisibility(
  skillId: string,
  visibility: AgentAuthPolicyVisibility,
): Promise<
  | { ok: true }
  | { ok: false; error: "unauthorized" | "not_found" | "forbidden" | "invalid" }
> {
  const session = await getAuthSession();
  if (!session || !session.user?.id) return { ok: false, error: "unauthorized" };

  const decodedSkillId = decodeURIComponent(skillId);
  const skill = await getInstalledSkillById(decodedSkillId);
  if (!skill) return { ok: false, error: "not_found" };

  // Use the central requireResourceAccess("manage") gate, mirroring the
  // skills_installed_upsert MCP handler's posture. Forbidden + missing are
  // collapsed to a single "not_found" wire shape so non-admin callers cannot
  // probe skill existence by ID.
  const { requireActorContext } = await import("@/lib/auth-session");
  const { requireResourceAccess, buildSkillResourceRef } = await import("@cinatra-ai/agents/auth-policy");
  const { resolveEffectiveSkillAccessPolicy } = await import("./skills-store");
  // Pure policy lookup — snapshot read (cinatra#1364).
  const { readSkillsCatalogSnapshot } = await import("./skill-packages");
  const actor = await requireActorContext();
  const catalogSnapshot = await readSkillsCatalogSnapshot();
  const skillRow = catalogSnapshot.skills.find((s) => s.id === skill.id);
  try {
    requireResourceAccess(
      actor,
      buildSkillResourceRef({
        id: skill.id,
        level: skill.level,
        scope: skill.scope ?? null,
        // DURABLE owner identity (cinatra#1416, AC1): the persisted
        // ownerUserId, independent of the (level, scope) projection — a
        // broadened personal skill stays manageable by its owner.
        ownerUserId: skillRow?.ownerUserId ?? null,
        // Canonical effective policy (W4): skill override else parent package's.
        accessPolicy: resolveEffectiveSkillAccessPolicy(
          skill,
          catalogSnapshot.skillPackages ?? [],
        ),
      }),
      "manage",
    );
  } catch {
    // ONE ownership model with the permissions loader / panel actions
    // (cinatra#1416, AC2): skill-level co-owners (and, for package skills,
    // the parent package's installer/co-owners) hold manage even though the
    // kernel ref cannot see co-owner rows. HUMAN sessions only — a delegated
    // OBO actor stays confined to the kernel gate above (no ceiling bypass).
    let managed = false;
    if (
      skillRow &&
      actor.principalType === "HumanUser" &&
      !actor.oboCeiling
    ) {
      const { canManageSkillAccess } = await import("./permissions-page-data");
      managed = await canManageSkillAccess(actor.principalId, false, skillRow);
    }
    if (!managed) {
      // Collapse forbidden + missing — do not leak whether the ID exists.
      return { ok: false, error: "not_found" };
    }
  }

  if (!isValidVisibility(visibility)) return { ok: false, error: "invalid" };

  // Pass the decoded ID to the store, matching the value used for the lookup
  // above. Passing a raw URL parameter to updateSkillVisibility while using the
  // decoded form for getInstalledSkillById causes a mismatch when the skill ID
  // contains percent-encoded characters.
  await updateSkillVisibility(decodedSkillId, visibility);
  return { ok: true };
}
