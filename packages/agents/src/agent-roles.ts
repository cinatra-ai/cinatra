// Agent ROLE resolution (cinatra#151 Stage 5b).
//
// Host code never names a concrete agent package for a duty/lane: agents
// advertise ROLES in their manifests (`cinatra.roles`), the generator
// validates global uniqueness fail-closed and emits the role -> package map
// into the generated tree (src/lib/generated/agent-bindings.ts). This module
// is the FAIL-LOUD consumption point: every role the host requires is backed
// by a `cinatra.systemExtensions` member (present in EVERY universe by the
// required lock), so a missing role binding is a build/packaging defect —
// never a normal degraded state. The descriptive error names the role and
// the regeneration step (the Stage 1 fail-loud precedent).

import { GENERATED_AGENT_ROLE_BINDINGS } from "@/lib/generated/agent-bindings";

/** Role names host code may require. Literal role names are HOST-NEUTRAL
 * vocabulary (a role is not a package name). */
export type KnownAgentRole =
  | "agent-security-reviewer"
  | "agent-code-reviewer"
  | "agent-planner"
  | "agent-author";

/**
 * Resolve the single claimant package for a role, fail-loud.
 *
 * @throws when no present package claims the role — for systemExtension-backed
 * roles this can only mean the generated bindings are stale or the system
 * set is broken (both CI-pinned states), so the error is descriptive and
 * actionable rather than a silent fallback.
 */
export function requireAgentRole(role: KnownAgentRole): string {
  const pkg = GENERATED_AGENT_ROLE_BINDINGS[role];
  if (typeof pkg === "string" && pkg.length > 0) return pkg;
  throw new Error(
    `[agent-roles] no package claims the role "${role}". Roles are declared via ` +
      `\`cinatra.roles\` in an agent's package.json and reach the host through the ` +
      `generated bindings (src/lib/generated/agent-bindings.ts). Every host-required ` +
      `role is backed by a cinatra.systemExtensions member, so this is a stale ` +
      `generation or a broken system set — re-run: node scripts/extensions/generate-extension-manifest.mjs`,
  );
}

/**
 * Directory slug of a role's package under the agent install tree
 * (`<installRoot>/<scope>/<slug>/...`) — derived from the role-bound package
 * name, replacing the retired hand-maintained slug maps.
 */
export function agentRoleDirSlug(role: KnownAgentRole): string {
  const pkg = requireAgentRole(role);
  const slug = pkg.split("/")[1];
  if (!slug) {
    throw new Error(
      `[agent-roles] role "${role}" resolves to "${pkg}", which is not a scoped package name`,
    );
  }
  return slug;
}
