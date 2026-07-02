// Structured `consumes:` contract — the declared-side input to the dependency
// closure VALIDATOR (engineering#422 PR-1).
//
// STATUS: additive (the SDK manifest ABI is additive-until-freeze; see
// `manifest.ts`). This module is a SELF-CONTAINED leaf contract: it imports no
// host core and carries no cross-package edge, exactly like `dependencies.ts`
// and the `produces` reader (`@cinatra-ai/extensions` `agent-produces-reader.ts`),
// so it can be parsed/validated without a registry or verdaccio roundtrip.
//
// WHY IT EXISTS
// -------------
// Today every dependency gate checks only that the edges an extension DECLARES
// (`cinatra.dependencies`) resolve. Nothing checks the converse: that an
// extension which USES a cross-extension primitive actually DECLARED an edge to
// the package that owns it. An agent that calls (for example)
// `blog_post_publish_linkedin_publish` while declaring `cinatra.dependencies: []`
// installs and boots cleanly, then fails at RUN time — an UNDER-declaration the
// install closure cannot see, because the only record of the used primitive is
// the agent's free-text ApiNode system prompt.
//
// `consumes` makes the used-primitive set MACHINE-READABLE so the closure
// validator can resolve each consumed primitive to its owning package (via the
// ownership registry — supplied by the host/CI, not by the SDK) and assert the
// matching `cinatra.dependencies` edge is present with adequate semantics.
//
// SHAPE
// -----
// `consumes: ConsumedPrimitive[]`, each `{ primitive, requirement }`:
//  - `primitive` — the cross-extension capability/tool name the extension calls
//    (e.g. `blog_post_publish_linkedin_publish`, `artifact_representation_get`).
//    NOT a package name: the validator maps primitive → owning package through
//    the ownership registry.
//  - `requirement` — `required` (the extension's normal capability cannot work
//    without it → the resolved owner must be a REQUIRED-blocking declared edge)
//    or `optional` (a degraded path exists → the owner may be declared optional,
//    or, when the registry marks the primitive host-injected/self-facade, need
//    not be declared at all).
//
// A `consumes` entry is a CLAIM the validator checks against the registry +
// `cinatra.dependencies`; it is NEVER trusted as the dependency itself.

import { DEPENDENCY_REQUIREMENTS, type DependencyRequirement } from "./dependencies";

/**
 * A single primitive an extension declares that it consumes at runtime.
 *
 * `primitive` is the cross-extension capability/tool identifier (the same name
 * the provider registers — e.g. a connector's `src/mcp/registry.ts` tool name,
 * or an artifact primitive like `artifact_representation_get`). The owning
 * package is resolved by the validator, not declared here.
 */
export type ConsumedPrimitive = {
  primitive: string;
  requirement: DependencyRequirement;
};

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Structural validation of ONE `consumes` entry. Returns the list of problems
 * (empty = valid). Exported so the validator and any persistence boundary
 * re-validate the SAME shape (mirrors `validateExtensionDependencyShape`).
 */
export function validateConsumedPrimitiveShape(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return ["entry is not an object"];
  }
  const v = value as Record<string, unknown>;
  const problems: string[] = [];
  if (!isNonEmptyString(v.primitive)) {
    problems.push("primitive must be a non-empty string");
  }
  if (!(DEPENDENCY_REQUIREMENTS as readonly string[]).includes(v.requirement as string)) {
    problems.push(`requirement must be one of ${DEPENDENCY_REQUIREMENTS.join("|")}`);
  }
  return problems;
}

export class ConsumesManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsumesManifestError";
  }
}

/**
 * Parse the `cinatra.consumes` declarations out of a manifest object.
 *
 * Absence rule mirrors `parseManifestDependencyEdges`: only an ABSENT key
 * (`undefined`) means "not declared". An explicit `null` is MALFORMED and
 * fail-loud — "consumes nothing" is spelled `[]`, never `null`; silently
 * reading `null` as absent would let a generator bug erase the consumed set and
 * blind the under-declaration check (the exact failure mode this field closes).
 *
 * A malformed entry, a non-array value, or a duplicate primitive is fail-loud
 * (`ConsumesManifestError`): a silently-dropped consumed primitive would weaken
 * the closure validator the same way a silently-dropped dependency edge does.
 */
export function parseConsumedPrimitives(
  manifest: unknown,
  opts?: { packageName?: string },
): ConsumedPrimitive[] {
  const pkgName =
    opts?.packageName ??
    ((manifest as { name?: unknown } | null | undefined)?.name as string | undefined);
  const label = pkgName ?? "(unknown package)";
  const cinatra = (manifest as { cinatra?: unknown } | null | undefined)?.cinatra;
  const raw = (cinatra as { consumes?: unknown } | null | undefined)?.consumes;

  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new ConsumesManifestError(
      `${label}: cinatra.consumes must be an array (got ${raw === null ? "null" : typeof raw}); declare "consumes nothing" as [].`,
    );
  }

  const out: ConsumedPrimitive[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const problems = validateConsumedPrimitiveShape(entry);
    if (problems.length > 0) {
      throw new ConsumesManifestError(
        `${label}: malformed cinatra.consumes entry ${JSON.stringify(entry)} — ${problems.join("; ")}.`,
      );
    }
    const c = entry as ConsumedPrimitive;
    if (seen.has(c.primitive)) {
      throw new ConsumesManifestError(
        `${label}: duplicate cinatra.consumes entry for primitive ${c.primitive}.`,
      );
    }
    seen.add(c.primitive);
    out.push({ primitive: c.primitive, requirement: c.requirement });
  }
  return out;
}
