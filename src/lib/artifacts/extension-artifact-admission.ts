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
// WHY THE OWNER PACKAGE IS THE KEY. An artifact type id is `@vendor/package:type`
// — the owning artifact extension names it. So "the types the calling extension
// declares as artifact dependencies" resolves, without a registry round trip, to
// "every artifact type whose owner package is one of the `kind: "artifact"`
// edges on the caller's own `cinatra.dependencies`". A declared edge to
// `@cinatra-ai/blog-post-artifact` admits `@cinatra-ai/blog-post-artifact:post`
// and nothing else — not another vendor's type, not a host-written kind, and
// not "every artifact".

import { createHash } from "node:crypto";

export type ArtifactDependencyAdmission = {
  /** The CALLING extension. */
  packageName: string;
  /** The run's PINNED version — the admission is bound to it. */
  packageVersion: string | null;
  /** The artifact packages the caller declares as dependencies, sorted. */
  admittedPackages: string[];
  /**
   * The digest of what was admitted, at which version — the datum an audit row
   * carries so a later reader can tell WHICH declaration allowed a read.
   */
  declarationDigest: string;
};

/** `@vendor/package:type` -> `@vendor/package`. Null for anything else. */
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
 * run's pinned version. Fail-closed by construction: a manifest with no
 * `kind: "artifact"` edge admits NOTHING, and so does an unreadable one (the
 * caller passes `{}`).
 */
export function resolveArtifactDependencyAdmission(input: {
  packageName: string;
  packageVersion: string | null;
  /** The caller's `cinatra` manifest block. */
  cinatra: Record<string, unknown>;
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
    declarationDigest,
  };
}

/** Does this admission cover this artifact object type? By NAME, never by wildcard. */
export function admitsArtifactType(
  admission: ArtifactDependencyAdmission,
  objectType: string,
): boolean {
  const owner = artifactTypeOwnerPackage(objectType);
  if (owner === null) return false;
  return admission.admittedPackages.includes(owner);
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
