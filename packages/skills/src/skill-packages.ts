import type { SkillPackageDefinition } from "@cinatra-ai/sdk-extensions";
import { AgentAuthPolicySchema } from "@cinatra-ai/agents/auth-policy";
import type { AgentAuthPolicy } from "@cinatra-ai/agents/auth-policy";
// Type-only (erased at runtime, so no import cycle with skills-store).
import type { SkillLevel } from "./skills-store";

// No third-party skill packages ship bundled in the monorepo anymore.
// Operators install skill packages at runtime via the GitHub upload flow at
// /configuration/extensions/upload, which calls
// installSkillPackageFromGitHub() and persists rows in cinatra.skill_packages
// with isCustom: true.
export const installedSkillPackages: SkillPackageDefinition[] = [];

// ---------------------------------------------------------------------------
// Canonical skill access-policy helpers (multi-scope access W4, #1073).
//
// Co-located in this already-graph-reachable skill-package module (rather than a
// new file) so the change adds NO new node to the locked route bundles
// (route-graph ratchet) while keeping skills-store.ts under its size ceiling
// (file-size ratchet). Pure functions, no store/DB coupling.
// ---------------------------------------------------------------------------

/**
 * Preserve a persisted `accessPolicy` blob across catalog normalization. The
 * catalog normalizers previously DROPPED this field, so every canonical-policy
 * reader saw `null` after a `syncInstalledSkillsToDatabase` round-trip and
 * enforcement silently fell back to the lossy `(level, scope)` tuple. Validate
 * through the canonical schema (coercing stored scalar visibility to the
 * one-element array form) and keep the parsed policy; drop only genuinely
 * malformed blobs. `null`/absent → undefined.
 */
export function normalizeStoredAccessPolicy(raw: unknown): AgentAuthPolicy | undefined {
  if (raw == null || typeof raw !== "object") return undefined;
  const parsed = AgentAuthPolicySchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Resolve a skill's EFFECTIVE access policy: the skill's own `accessPolicy`
 * override when set, else the parent package's `accessPolicy`, else null. This
 * is the inheritance rule enforcement must honour (mirrors the read-side default
 * in loadSkillPermissionsContext), so every enforcement/filter site that builds
 * a resource ref threads the result onto `buildSkillResourceRef({ accessPolicy })`
 * — the `(level, scope)` tuple then survives only as a label/index hint.
 *
 * `null` (no override AND no package policy) leaves the ref's `policy` undefined,
 * so `requireResourceAccess` uses the transitional tuple fallback for rows not
 * yet carrying a canonical policy.
 */
export function resolveEffectiveSkillAccessPolicy(
  skill: { packageId?: string; accessPolicy?: AgentAuthPolicy | null },
  // Structural: accepts PersistedSkillPackage[] AND the read-side
  // SkillPackageManifest[] (which projects `packageId` + `accessPolicy` but not
  // the internal row `id`) so every reader can resolve inheritance without a
  // second catalog read.
  skillPackages: readonly {
    id?: string;
    packageId?: string;
    accessPolicy?: AgentAuthPolicy | null;
  }[],
): AgentAuthPolicy | null {
  if (skill.accessPolicy) return skill.accessPolicy;
  const pkg = skill.packageId
    ? skillPackages.find((p) => p.packageId === skill.packageId || p.id === skill.packageId)
    : undefined;
  return pkg?.accessPolicy ?? null;
}

/**
 * Maps an AgentAuthPolicyVisibility token to the (level, scope) columns used by
 * the persisted skill catalog. Lossless round-trip for the supported variant
 * set. The compatibility projection writeSkillAccessPolicy / updateSkillVisibility
 * write alongside the canonical accessPolicy so tuple readers keep working.
 */
export function visibilityToLevelScope(
  visibility: string,
  ownerUserId: string | undefined,
): { level: SkillLevel; scope: string | undefined } {
  if (visibility === "owner") return { level: "personal", scope: ownerUserId };
  if (visibility === "org" || visibility.startsWith("org:")) {
    return { level: "organization", scope: "org" };
  }
  if (visibility.startsWith("team:")) {
    return { level: "team", scope: visibility.slice("team:".length) };
  }
  if (visibility.startsWith("project:")) {
    return { level: "project", scope: visibility.slice("project:".length) };
  }
  if (visibility === "workspace") return { level: "workspace", scope: undefined };
  if (visibility === "admin") return { level: "system", scope: undefined };
  // Fallback — keep personal
  return { level: "personal", scope: ownerUserId };
}
