// ---------------------------------------------------------------------------
// lifecycle-repair-producer-registry (cinatra#2047 defect D-1, epic #2037 S2)
//
// The CORE-side half of the "which producers declare a lifecycle" question.
//
// Epic #2037 compiles an agent's lifecycle declaration onto
// `agent_templates.lifecycle_config` from its manifest, trigger-style
// (the compile helpers in `@/lib/lifecycle/lifecycle-policy`). That covers every
// producer whose repair
// implementation ships INSIDE its own package. It does NOT cover the epic's
// FIRST repairing producer: S2 (#2040) put the blog pipeline's repair
// implementation in CORE (`blog-post-repair-producer.ts`) precisely because the
// materializer + the repair-response ingress are core modules — so the blog
// agent's own package cannot honestly declare a capability core implements.
//
// This registry is that declaration: a small, explicit, core-owned overlay of
// `{ packageName -> CompiledManifestLifecycle }` projected onto the matching
// installed templates (`lifecycle-config-projection`). It is NOT a parallel
// storage path — the projected value lands on the SAME
// `agent_templates.lifecycle_config` column the manifest path writes and the
// SAME readers (`resolveRepairCapable`, `parseCompiledManifest`) consume.
//
// Precedence: the core overlay wins per KEY over a manifest declaration for the
// same package (a core-implemented capability is not overridable by a manifest
// edit); every other manifest key carries forward (`mergeLifecycle`).
// ---------------------------------------------------------------------------

// PURE by construction: no db, no `server-only`, no artifact/materializer graph.
// The blog producer module (which DOES pull the materializer graph) re-exports
// `BLOG_POST_LIFECYCLE` from here, so the declaration and the implementation stay
// one source of truth without the projection having to load the implementation.

import type { CompiledManifestLifecycle } from "@/lib/lifecycle/lifecycle-policy";

/** The compiled lifecycle declaration for the blog pipeline — it PRODUCES blog
 * post body artifacts and CAN REPAIR them, so the `changes_requested` route
 * dispatches the repair to the producer instead of escalating to a human. */
export const BLOG_POST_LIFECYCLE: CompiledManifestLifecycle = {
  producedTypes: ["artifact-blog-post-body"],
  repairCapable: true,
};

export interface CoreLifecycleProducer {
  /** The installed package whose `agent_templates` row receives the overlay. */
  packageName: string;
  /** The lifecycle declaration core makes on that producer's behalf. */
  lifecycle: CompiledManifestLifecycle;
  /** Why core (not the package manifest) carries this declaration. */
  rationale: string;
}

/**
 * Every producer whose lifecycle declaration is core-owned. Deliberately a short,
 * explicit list — a package that can declare its own lifecycle MUST do so through
 * its manifest (`cinatra.lifecycle`), not by being added here.
 */
export const CORE_LIFECYCLE_PRODUCERS: readonly CoreLifecycleProducer[] = [
  {
    packageName: "@cinatra-ai/blog-draft-writer-agent",
    lifecycle: BLOG_POST_LIFECYCLE,
    rationale:
      "epic #2037 S2's first repairing producer — the repair implementation " +
      "(blog-post-repair-producer) and the body materializer are CORE modules, so " +
      "the declaration is core-owned.",
  },
] as const;

/** The core overlay for one package, or null when the package is not core-declared. */
export function coreLifecycleForPackage(packageName: string | null | undefined): CompiledManifestLifecycle | null {
  if (!packageName) return null;
  const hit = CORE_LIFECYCLE_PRODUCERS.find((p) => p.packageName === packageName);
  return hit ? hit.lifecycle : null;
}
