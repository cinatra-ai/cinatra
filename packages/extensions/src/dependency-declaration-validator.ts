// Declared-vs-used dependency CLOSURE VALIDATOR (engineering#422 PR-1).
//
// The existing closure engine (`dependency-closure.ts`) answers "do the edges
// this extension DECLARED resolve?". This validator answers the converse the
// install closure is blind to: "does the extension that USES a cross-extension
// primitive actually DECLARE an edge to the package that owns it?".
//
// An UNDER-declared extension (uses `linkedin_post_publish` while declaring
// `cinatra.dependencies: []`) installs and boots cleanly, then fails at run
// time. This validator catches that statically by:
//   1. taking the extension's STRUCTURED consumed primitives
//      (`cinatra.consumes`, parsed by `@cinatra-ai/sdk-extensions`),
//   2. resolving each primitive → owning package + that owner's kind through
//      the OWNERSHIP REGISTRY (a lookup supplied by the host/CI — the registry
//      DATA lives in the private engineering repo, PR-2; this module is pure
//      over the lookup so it unit-tests without it), and
//   3. diffing the EXPECTED declared-edge set against the actual
//      `cinatra.dependencies`.
//
// It is PURE + deterministic + non-throwing (returns a structured report) so a
// per-repo CI gate (PR-3) and the central pre-promotion sweep (PR-2) both
// consume the same verdict.
//
// FINDINGS (each fail-the-gate unless noted):
//  - MISSING_REQUIRED_DECLARATION — a REQUIRED consumed primitive's owning
//    package has NO install-blocking declared edge (the core under-declaration).
//  - MISSING_OPTIONAL_DECLARATION — an OPTIONAL consumed primitive's owner is
//    not declared at all (declare it optional, or mark the primitive
//    host-injected/self-facade in the registry).
//  - UNKNOWN_PRIMITIVE — a consumed primitive resolves to NO registry owner
//    (typo, or a provider that never registered it): the validator cannot prove
//    the closure, so it fails closed.
//  - REQUIREMENT_MISMATCH — the owner IS declared, but as a weaker edge
//    (optional/peer) than a REQUIRED consumed primitive needs.
//  - STALE_DECLARATION — a declared install-blocking edge whose package owns
//    NONE of the consumed primitives and is not otherwise justified (advisory:
//    over-declaration; the gate MAY warn rather than fail — see `severity`).
//
// Self-facade / host-injected primitives (the depender's own self-MCP surface,
// or a host-provided primitive like a gmail→google-oauth host injection) carry
// NO cross-extension edge: the registry marks them so they are SKIPPED, never
// reported as under-declared.

import type { ExtensionDependency, ExtensionKind, DependencyRequirement } from "./canonical-types";

// NOTE: this module is a PURE LEAF — it must stay importable from a plain node
// CI script / the central sweep (PR-2/PR-3), so it deliberately does NOT import
// `./dependency-closure` (which carries `server-only`). The install-blocking
// predicate is restated here, byte-identical to `isInstallBlockingEdge`
// (required runtime/install-time; peer is never install-blocking). A drift test
// asserts the two stay in lockstep.
function isInstallBlockingEdge(dep: ExtensionDependency): boolean {
  return dep.requirement === "required" && dep.edgeType !== "peer";
}

/** A structured consumed-primitive declaration (mirror of the SDK
 *  `ConsumedPrimitive`; restated locally to avoid a cross-package value import,
 *  matching the `agent-produces-reader` byte-mirror convention). */
export type ConsumedPrimitiveInput = {
  primitive: string;
  requirement: DependencyRequirement;
};

/**
 * What the ownership registry resolves a consumed primitive to.
 *
 *  - `owningPackage` — the package that OWNS (registers/provides) the primitive,
 *    or null when the primitive carries NO cross-extension edge.
 *  - `ownerType` — how the primitive is provided:
 *      `extension`     — a normal cross-extension primitive owned by
 *                        `owningPackage` → must be a declared dependency edge.
 *      `host-injected` — provided by the host (e.g. a host-injected OAuth
 *                        primitive) → no declared edge required (SKIPPED).
 *      `self-facade`   — the depender's own self-MCP facade surface → no
 *                        cross-extension edge (SKIPPED). `owningPackage` is the
 *                        depender itself (or null).
 *  - `kind` — the owning extension's kind (carried onto the expected edge).
 */
export type PrimitiveOwnership =
  | { ownerType: "extension"; owningPackage: string; kind?: ExtensionKind }
  | { ownerType: "host-injected"; owningPackage?: null }
  | { ownerType: "self-facade"; owningPackage?: string | null };

/** Resolve a consumed primitive to its owner. Returns `undefined` when the
 *  registry has NO record of the primitive (→ UNKNOWN_PRIMITIVE, fail-closed). */
export type OwnershipLookup = (primitive: string) => PrimitiveOwnership | undefined;

export type DeclarationFindingCode =
  | "MISSING_REQUIRED_DECLARATION"
  | "MISSING_OPTIONAL_DECLARATION"
  | "UNKNOWN_PRIMITIVE"
  | "REQUIREMENT_MISMATCH"
  | "STALE_DECLARATION";

export type DeclarationFinding = {
  code: DeclarationFindingCode;
  /** "error" fails the gate; "warning" is advisory (over-declaration only). */
  severity: "error" | "warning";
  /** The consumed primitive that triggered the finding (absent for STALE_DECLARATION). */
  primitive?: string;
  /** The owning package the primitive resolved to (absent for UNKNOWN_PRIMITIVE). */
  owningPackage?: string;
  message: string;
};

export type DeclarationValidationResult = {
  /** True when there are NO error-severity findings. */
  ok: boolean;
  findings: DeclarationFinding[];
  /** The package names the consumed primitives resolved to as REQUIRED owners
   *  (the EXPECTED install-blocking declared set) — for diagnostics + the sweep. */
  expectedRequiredPackages: string[];
};

export type ValidateDeclarationsInput = {
  /** The extension being validated (for self-facade owner identity + messages). */
  packageName: string;
  /** Structured consumed primitives (`cinatra.consumes`). */
  consumes: readonly ConsumedPrimitiveInput[];
  /** The extension's declared `cinatra.dependencies` edges. */
  declaredDependencies: readonly ExtensionDependency[];
  /** Resolve a primitive → its owner. */
  ownership: OwnershipLookup;
  /** When true, STALE_DECLARATION (over-declaration) is an ERROR; default
   *  false (warning). Over-declaration is closure-safe (the edge resolves), so
   *  it defaults to advisory; a strict repo can opt in. */
  failOnStaleDeclaration?: boolean;
};

/**
 * Validate that an extension's declared `cinatra.dependencies` COVER its
 * structured consumed primitives. Pure + non-throwing.
 */
export function validateDependencyDeclarations(
  input: ValidateDeclarationsInput,
): DeclarationValidationResult {
  const findings: DeclarationFinding[] = [];

  // Index the declared edges by owning package.
  const declaredByPackage = new Map<string, ExtensionDependency>();
  for (const dep of input.declaredDependencies) {
    // First edge per package wins for the lookup; a duplicate is the manifest
    // reader's concern (it fails-loud), not this validator's.
    if (!declaredByPackage.has(dep.packageName)) declaredByPackage.set(dep.packageName, dep);
  }

  // The set of packages the consumed primitives JUSTIFY (so STALE_DECLARATION
  // can spot a declared edge no consumed primitive backs).
  const justifiedPackages = new Set<string>();
  // Highest requirement demanded for each owning package across all primitives
  // (a package is "required-justified" if ANY required primitive resolves to it).
  const requiredOwners = new Set<string>();

  for (const c of input.consumes) {
    const owner = input.ownership(c.primitive);

    if (owner === undefined) {
      findings.push({
        code: "UNKNOWN_PRIMITIVE",
        severity: "error",
        primitive: c.primitive,
        message:
          `${input.packageName}: consumes primitive "${c.primitive}" which resolves to NO ` +
          `registered owner. Either the primitive name is wrong, or no installed extension ` +
          `provides it — the closure cannot be proven, so this fails closed.`,
      });
      continue;
    }

    // Host-injected and self-facade primitives carry no cross-extension edge.
    if (owner.ownerType === "host-injected" || owner.ownerType === "self-facade") {
      // A self-facade owner that names the depender itself justifies nothing
      // external; nothing to declare. Skip.
      continue;
    }

    const owningPackage = owner.owningPackage;

    // A primitive owned by the depender itself is a self-edge — never declared.
    if (owningPackage === input.packageName) continue;

    justifiedPackages.add(owningPackage);
    if (c.requirement === "required") requiredOwners.add(owningPackage);

    const declared = declaredByPackage.get(owningPackage);

    if (!declared) {
      if (c.requirement === "required") {
        findings.push({
          code: "MISSING_REQUIRED_DECLARATION",
          severity: "error",
          primitive: c.primitive,
          owningPackage,
          message:
            `${input.packageName}: consumes REQUIRED primitive "${c.primitive}" owned by ` +
            `${owningPackage}, but declares NO dependency edge to it. Add a required ` +
            `runtime/install-time edge to ${owningPackage} in cinatra.dependencies.`,
        });
      } else {
        findings.push({
          code: "MISSING_OPTIONAL_DECLARATION",
          severity: "error",
          primitive: c.primitive,
          owningPackage,
          message:
            `${input.packageName}: consumes OPTIONAL primitive "${c.primitive}" owned by ` +
            `${owningPackage}, but declares NO dependency edge to it. Add an optional edge ` +
            `to ${owningPackage} in cinatra.dependencies (or, if it is host-injected/self-facade, ` +
            `fix the ownership registry).`,
        });
      }
      continue;
    }

    // The owner IS declared — for a REQUIRED consumed primitive the edge must
    // be install-blocking (required runtime/install-time). A weaker edge
    // (optional / peer) would let the closure "pass" while the run still
    // depends on the package at run-start.
    if (c.requirement === "required" && !isInstallBlockingEdge(declared)) {
      findings.push({
        code: "REQUIREMENT_MISMATCH",
        severity: "error",
        primitive: c.primitive,
        owningPackage,
        message:
          `${input.packageName}: consumes REQUIRED primitive "${c.primitive}" owned by ` +
          `${owningPackage}, but its declared edge is ${declared.edgeType}/${declared.requirement} ` +
          `(not install-blocking). Declare it as a required runtime/install-time edge.`,
      });
    }
  }

  // STALE_DECLARATION: an install-blocking declared edge no consumed primitive
  // justifies. Only flag install-blocking edges (a deliberately-declared
  // optional/peer edge is a legitimate coexistence/degraded hint, not stale).
  // Advisory by default (over-declaration is closure-safe).
  for (const dep of input.declaredDependencies) {
    if (dep.packageName === input.packageName) continue; // self-edge: not this validator's concern
    if (!isInstallBlockingEdge(dep)) continue;
    if (justifiedPackages.has(dep.packageName)) continue;
    findings.push({
      code: "STALE_DECLARATION",
      severity: input.failOnStaleDeclaration ? "error" : "warning",
      owningPackage: dep.packageName,
      message:
        `${input.packageName}: declares a required edge to ${dep.packageName}, but no consumed ` +
        `primitive (cinatra.consumes) resolves to it. Remove the stale edge or declare the ` +
        `primitive that needs it.`,
    });
  }

  const ok = findings.every((f) => f.severity !== "error");
  return {
    ok,
    findings,
    expectedRequiredPackages: [...requiredOwners].sort(),
  };
}
