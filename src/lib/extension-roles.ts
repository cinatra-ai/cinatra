// Extension ROLE resolution for OPTIONAL-surface roles (cinatra#151 Stage 6).
//
// Host code never names a concrete extension package for a duty: extensions
// advertise ROLES in their manifests (`cinatra.roles`, kind-agnostic), the
// generator validates global single-claimant fail-closed and emits the
// role -> package map into the generated tree
// (src/lib/generated/agent-bindings.ts).
//
// This module is the consumption point for roles whose claimants are
// guardedOptional extensions — ABSENT from reduced universes (the prod
// 8-image) as a NORMAL state:
//   - `resolveExtensionRole` returns undefined on absence (callers degrade,
//     e.g. the blog dashboard URL falls back to the dashboards index);
//   - `requireExtensionRole` throws a DESCRIPTIVE error on absence (callers
//     whose operation is meaningless without the claimant, e.g. the blog
//     artifact materializers — better a loud, actionable failure than
//     silently writing a semantic assertion naming a non-present type).
//
// systemExtension-backed AGENT roles keep their dedicated fail-loud
// resolver in packages/agents/src/agent-roles.ts (absence there is a
// build/packaging defect, never a degraded state). Roles resolve from
// BUILD-time presence (the generated maps): a package installed at RUNTIME
// does not bind here — the blog host surfaces target the full-universe
// deployment, documented as a named limitation of this stage.

import { GENERATED_AGENT_ROLE_BINDINGS } from "@/lib/generated/agent-bindings";

/** Optional-surface roles host code resolves. Literal role names are
 * HOST-NEUTRAL vocabulary (a role is not a package name). */
export type OptionalExtensionRole =
  | "artifact-blog-post-body"
  | "artifact-blog-idea-summary"
  | "artifact-blog-image"
  | "blog-operator-dashboard";

/** Resolve a role's single claimant package, or undefined when no present
 * extension claims it (a NORMAL state in reduced universes). */
export function resolveExtensionRole(role: OptionalExtensionRole): string | undefined {
  const pkg = GENERATED_AGENT_ROLE_BINDINGS[role];
  return typeof pkg === "string" && pkg.length > 0 ? pkg : undefined;
}

/** Resolve a role's single claimant package, fail-loud with a descriptive,
 * actionable error when absent. */
export function requireExtensionRole(role: OptionalExtensionRole): string {
  const pkg = resolveExtensionRole(role);
  if (pkg) return pkg;
  throw new Error(
    `[extension-roles] no present extension claims the role "${role}". Roles are ` +
      `declared via \`cinatra.roles\` in an extension's package.json and reach the ` +
      `host through the generated bindings (src/lib/generated/agent-bindings.ts). ` +
      `This role's claimant is an OPTIONAL extension — it is absent from this ` +
      `universe (expected on the required-only image) or the generated bindings ` +
      `are stale — re-run: node scripts/extensions/generate-extension-manifest.mjs`,
  );
}
