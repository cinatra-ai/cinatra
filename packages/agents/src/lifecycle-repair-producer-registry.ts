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

import { readRegenerateEntry, type CompiledManifestLifecycle } from "@/lib/lifecycle/lifecycle-policy";

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

// ---------------------------------------------------------------------------
// readProducingStepNoteInput (cinatra#3080, acceptance item 4)
//
// Kept in this pure module, which the review store already imports. It reads
// a compiled declaration the caller has already loaded; it does no I/O.
//
// THE ONE QUESTION REGENERATE ASKS of the revision under review: which step
// produced it, and which text input of that step does the reviewer's Note
// fill? The decision of 2026-10-13 settles the answer's shape. A step may
// declare, optionally, the one text input that the Note fills (for a picture,
// its prompt). Regenerate re-runs that step with the Note in exactly that
// input. A review whose producing step declares no such input refuses
// Regenerate with a plain reason. Comment and Continue work as usual.
//
// THE DECLARATION IS THE ARTIFACT-SCOPED REGENERATE ENTRY (cinatra#4264, the
// strict `cinatra.lifecycle.regenerate` field of `agentLifecycleDeclarationSchema`
// in `verdaccio/package-contract.ts`, compiled onto
// `agent_templates.lifecycle_config` and read with `readRegenerateEntry`). Per
// artifact-filing node it names the producing `step` and that step's
// `noteInput`; the compile check proves the step feeds the node and that the
// note input is fed by one start output and nothing else. The entry is chosen by
// the node that FILED the reviewed revision (`readVerifiedFilingNode` below,
// the runtime's signed step id on the materialization ledger), the same
// re-derivation the Regenerate dispatch makes, so a Regenerate this read admits
// is one that dispatch can run.
//
// Nothing else counts. Not `repairFindingsInput` (cinatra#4424): that names the
// ROOT input a dispatched repair run gets the findings in, for the whole
// template, and says nothing about which step made this revision. Not the
// agent-level `repairCapable` boolean: that flag says the agent can answer a
// typed repair request, not which input the Note goes into. Reading either as if
// it did is the proxy the decision rules out.
// ---------------------------------------------------------------------------

/** The Regenerate declaration of the node that filed the reviewed revision. */
export interface ProducingStepNoteInput {
  /** The node that filed the reviewed revision (the entry's key). */
  artifactNode: string;
  /** The producing step a Regenerate reruns. */
  step: string;
  /** The text input of that step the reviewer's Note fills. */
  noteInput: string;
}

/**
 * The Regenerate entry the producing template declares for the node that filed
 * the reviewed revision, or null when there is none. `lifecycle` is the
 * producing run's template's compiled lifecycle declaration
 * (`agent_templates.lifecycle_config`, read fail-soft; its `regenerate` list is
 * read all-or-nothing); `artifactNode` is the verified filing node
 * (`readVerifiedFilingNode`), null when it is not proven. Callers treat null as
 * "Regenerate is not available on this review".
 */
export function readProducingStepNoteInput(
  lifecycle: Pick<CompiledManifestLifecycle, "regenerate"> | null | undefined,
  artifactNode: string | null | undefined,
): ProducingStepNoteInput | null {
  if (typeof artifactNode !== "string" || artifactNode.length === 0) return null;
  const entry = readRegenerateEntry(lifecycle, artifactNode);
  if (!entry) return null;
  return { artifactNode, step: entry.step, noteInput: entry.noteInput };
}

/**
 * The node that filed a revision, from the `verified_step_id` values of the
 * finalized `materialize_tool` ledger rows of (org, producing run, artifact,
 * revision): exactly one row carrying a non-empty id, else null. No row, a row
 * whose filing step the runtime did not verify, or two rows (read with a limit
 * of 2) are all "not proven", and Regenerate is refused.
 */
export function readVerifiedFilingNode(verifiedSteps: ReadonlyArray<string | null | undefined>): string | null {
  if (verifiedSteps.length !== 1) return null;
  const node = verifiedSteps[0];
  return typeof node === "string" && node.length > 0 ? node : null;
}
