// ---------------------------------------------------------------------------
// lifecycle-repair-producer-registry (cinatra#2047 defect D-1, epic #2037 S2)
//
// The CORE-side half of "which productions are repair-capable".
//
// Epic #2037 compiles an agent's lifecycle declaration onto
// `agent_templates.lifecycle_config` from its own manifest, trigger-style (the
// compile helpers in `@/lib/lifecycle/lifecycle-policy`). That covers every
// producer whose repair implementation ships INSIDE its own package. It does NOT
// cover the epic's FIRST repairing producer: S2 (#2040) put that repair
// implementation in CORE (`blog-post-repair-producer`) precisely because the
// materializer and the repair-response ingress are core modules — so no package
// manifest can honestly declare a capability core implements.
//
// KEYED ON THE PRODUCED ARTIFACT ROLE, NEVER ON A PACKAGE. Core implements the
// repair for a TYPE of artifact, so the capability belongs to that type, and a
// role is HOST-NEUTRAL vocabulary (`src/lib/extension-roles.ts`: "a role is not a
// package name") resolved to its single claimant through the generated manifest
// bindings at call time. Core therefore never names an extension instance — the
// `core-extension-instance-coupling-ban` gate's zero floor holds — and ANY agent
// that produces the role's artifact type becomes repair-capable, not one blessed
// package.
//
// PURE by construction: no db, no `server-only`, no artifact/materializer graph.
// The blog producer module (which DOES pull the materializer graph) re-exports
// `BLOG_POST_LIFECYCLE` from here, so the declaration and the implementation stay
// one source of truth without a consumer having to load the implementation.
// ---------------------------------------------------------------------------

import type { CompiledManifestLifecycle } from "@/lib/lifecycle/lifecycle-policy";

/** The produced-artifact ROLES core itself implements a typed repair for. A role
 * here means: "when a reviewer requests changes on an artifact of this role's
 * type, core can carry out the repair", so the `changes_requested` route
 * dispatches to the producer instead of escalating to a human.
 *
 * Host-neutral role names only. A producer that implements its OWN repair
 * declares it in its manifest (`cinatra.lifecycle.repairCapable`) instead — this
 * list is exclusively for capabilities CORE implements. */
export const CORE_REPAIRABLE_PRODUCED_ROLES = ["artifact-blog-post-body"] as const;

export type CoreRepairableProducedRole = (typeof CORE_REPAIRABLE_PRODUCED_ROLES)[number];

/** The compiled lifecycle declaration for the blog pipeline — it PRODUCES blog
 * post body artifacts and CAN REPAIR them. `producedTypes` carries the ROLE, the
 * same host-neutral vocabulary the blog materializer resolves through. */
export const BLOG_POST_LIFECYCLE: CompiledManifestLifecycle = {
  producedTypes: ["artifact-blog-post-body"],
  repairCapable: true,
};

/**
 * Does CORE implement the typed repair for this artifact's object type?
 *
 * `objectType` is a namespaced object-type id (`@scope/package:local-id`); the
 * claimant of each core-repairable ROLE is resolved by the caller-supplied
 * `resolveRole` (the generated role bindings), so the only literal in core is the
 * role name. An unresolvable role (a reduced universe shipping no claimant) is
 * simply not repair-capable — the route then escalates, the correct fail-soft
 * answer.
 *
 * PURE: no I/O, fully injectable, so the capability is unit-testable without the
 * generated bindings.
 */
export function coreRepairsObjectType(
  objectType: string | null | undefined,
  resolveRole: (role: CoreRepairableProducedRole) => string | undefined,
): boolean {
  if (!objectType) return false;
  const colon = objectType.indexOf(":");
  if (colon <= 0) return false;
  const claimingPackage = objectType.slice(0, colon);
  for (const role of CORE_REPAIRABLE_PRODUCED_ROLES) {
    let claimant: string | undefined;
    try {
      claimant = resolveRole(role);
    } catch {
      claimant = undefined;
    }
    if (claimant && claimant === claimingPackage) return true;
  }
  return false;
}
