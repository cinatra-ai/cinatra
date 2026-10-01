import "server-only";

// DEPENDENCY-SCOPED ARTIFACT READS: what a flow may read, and on whose word
// (cinatra#3031, epic #3023 W7; plan (C) enabler 0.26, epic ruling on #2817).
//
// "the passthrough admits the list, the get and a new content read — the text
// of a representation up to a cap — only for types the calling extension
// declares as artifact dependencies — an admission bound to the declaration and
// the version, the shape the delegated chat's perimeter already has — bound to
// the organisation of the run, size-capped and audited."
//
// THE SHAPE #2817 ESTABLISHED, reused here rather than re-invented: the
// admission is a RECORD derived from ONE declaration at ONE resolved version,
// it admits by NAME and never by wildcard, and every failure to resolve it
// DENIES. There is deliberately no "if the type is a core one, allow" branch:
// a second admission source is exactly what that issue removed.
//
// WHERE A TYPE'S OWNER COMES FROM (cinatra#3597). An artifact type id LOOKS like
// `@vendor/package:type`, but that shape is a naming convention and not a
// registration: five shipped artifact packages register types whose id namespace
// is not their package name (`@cinatra-ai/linkedin-artifacts` registers
// `@cinatra-ai/linkedin:post-draft`, the email artifacts register the
// `@cinatra-ai/email:*` work products, and so on). So the owner of a type is
// read from the type's REGISTRATION — the winning claim of the run's own
// organisation chain, whose `extensionPackage` is the package that installed the
// type — and never guessed from the id. "The types the calling extension
// declares as artifact dependencies" therefore resolves to "every type whose
// WINNING claim names one of the `kind: "artifact"` edges on the caller's own
// `cinatra.dependencies`", and a type no active winning claim names an owner for
// is admitted to NOBODY: the fail-closed half, stated as behaviour.
//
// WHAT IS DELIBERATELY NOT FOLDED IN. The owner resolution applies no projection
// filter and no intersection with the in-process type registry. A claim's
// projection disposition governs how a row is PROJECTED, and the registry
// governs what THIS process can render; neither says who OWNS the type, and
// either one folded in here would refuse a declared pack's own type for a reason
// the declaration never spoke about.

import { createHash } from "node:crypto";

import { resolveClaimWinner, type ArbitrableClaim } from "@cinatra-ai/objects/claims";

import { readArtifactTypeClaimsForOrg } from "@/lib/objects/artifact-claim-store";

export type ArtifactDependencyAdmission = {
  /** The CALLING extension. */
  packageName: string;
  /** The run's PINNED version — the admission is bound to it. */
  packageVersion: string | null;
  /** The artifact packages the caller declares as dependencies, sorted. */
  admittedPackages: string[];
  /**
   * The type ids those packages OWN in the run's organisation, per the WINNING
   * claim of each claimed type — sorted. This, and not the id's shape, is what
   * a read is admitted against.
   */
  admittedTypes: string[];
  /**
   * The digest of what was admitted, at which version — the datum an audit row
   * carries so a later reader can tell WHICH declaration allowed a read.
   */
  declarationDigest: string;
};

/**
 * `@vendor/package:type` -> `@vendor/package`. Null for anything else.
 *
 * A PURE naming helper that decides nothing: the admission reads an owner from
 * the registration (see the header), never from this split.
 */
export function artifactTypeOwnerPackage(objectType: string): string | null {
  const s = String(objectType ?? "");
  const idx = s.lastIndexOf(":");
  if (idx <= 0) return null;
  const owner = s.slice(0, idx);
  return /^@[^/\s]+\/[^/\s:]+$/.test(owner) ? owner : null;
}

type DependencyEdge = {
  packageName?: unknown;
  kind?: unknown;
  versionConstraint?: unknown;
  requirement?: unknown;
};

/**
 * Derive the admission from the calling extension's own manifest block at the
 * run's pinned version, and resolve the type ids the declared packages own from
 * the organisation's claim registry. Fail-closed by construction: a manifest
 * with no `kind: "artifact"` edge admits NOTHING, an unreadable one (the caller
 * passes `{}`) admits nothing, and a type no winning claim attributes to a
 * declared package is admitted to nobody.
 *
 * `readClaims` is the one injection point — the unit suites drive the real
 * resolution without a database; the default is the shipped store read.
 */
export function resolveArtifactDependencyAdmission(input: {
  packageName: string;
  packageVersion: string | null;
  /** The caller's `cinatra` manifest block. */
  cinatra: Record<string, unknown>;
  /** The run's ORGANISATION — the claim chain the owners are read from. */
  orgId: string;
  /** The org's claim chain (default: the shipped claim-registry read). */
  readClaims?: (orgId: string) => readonly ArbitrableClaim[];
}): ArtifactDependencyAdmission {
  const raw = input.cinatra.dependencies;
  const admitted = new Set<string>();
  const constraints: string[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw as DependencyEdge[]) {
      if (!entry || typeof entry !== "object") continue;
      if (entry.kind !== "artifact") continue;
      const name = entry.packageName;
      if (typeof name !== "string" || !/^@[^/\s]+\/[^/\s]+$/.test(name)) continue;
      admitted.add(name);
      constraints.push(`${name}@${JSON.stringify(entry.versionConstraint ?? null)}`);
    }
  }
  const admittedPackages = [...admitted].sort();
  const admittedTypes: string[] = [];
  if (admittedPackages.length > 0) {
    const claims = (input.readClaims ?? readArtifactTypeClaimsForOrg)(input.orgId);
    for (const objectTypeId of new Set(claims.map((c) => c.objectTypeId))) {
      const winner = resolveClaimWinner(claims, { orgId: input.orgId, objectTypeId });
      if (winner === null) continue;
      if (!admitted.has(winner.extensionPackage)) continue;
      admittedTypes.push(objectTypeId);
    }
    admittedTypes.sort();
  }
  const declarationDigest = createHash("sha256")
    .update(
      JSON.stringify({
        caller: input.packageName,
        version: input.packageVersion,
        edges: constraints.sort(),
      }),
    )
    .digest("hex");
  return {
    packageName: input.packageName,
    packageVersion: input.packageVersion,
    admittedPackages,
    admittedTypes,
    declarationDigest,
  };
}

/** Does this admission cover this artifact object type? By NAME, never by wildcard. */
export function admitsArtifactType(
  admission: ArtifactDependencyAdmission,
  objectType: string,
): boolean {
  return admission.admittedTypes.includes(objectType);
}

/** The admitted subset of a candidate type set — the listing's own filter. */
export function admittedArtifactTypes(
  admission: ArtifactDependencyAdmission,
  candidateTypes: Iterable<string>,
): string[] {
  const out: string[] = [];
  for (const t of candidateTypes) if (admitsArtifactType(admission, t)) out.push(t);
  return out.sort();
}

export class ArtifactAdmissionRefusal extends Error {
  readonly reason = "artifact-type-not-a-declared-dependency";
  readonly objectType: string;
  constructor(admission: ArtifactDependencyAdmission, objectType: string) {
    super(
      `artifact reads: ${admission.packageName} does not declare "${objectType}" as an artifact ` +
        `dependency — it declares [${admission.admittedPackages.join(", ") || "none"}], and the ` +
        `admission is bound to that declaration at version ${admission.packageVersion ?? "(unpinned)"}`,
    );
    this.name = "ArtifactAdmissionRefusal";
    this.objectType = objectType;
  }
}
