// Pure, IO-free core for SIGNED MATERIALIZATION PLANS (cinatra#181 — library
// dependency closure, host side).
//
// A materialization plan is the publish-time LOCKED description of an
// extension's npm LIBRARY dependency closure: exact node identities,
// parent→child edges, the exact `node_modules` placement path for every node
// (incl. duplicate-version nesting), and a per-node sha512 SRI. The marketplace
// computes it from the package's committed lockfile and SIGNS `closureHash`
// (the sha512 over the canonical plan bytes) into the v2 signature payload
// (`src/lib/extension-signature.ts`); the host installer executes the plan
// VERBATIM — pure unpack-to-path operations, zero install-time resolver
// decisions.
//
// This module mirrors the established `extension-package-store-core.ts` split:
// everything here is deterministic, has NO filesystem/network/`server-only`
// dependency, and is exhaustively unit-testable. The server-only EXECUTOR
// (fetch/extract/place — a later stage of the lane) composes these helpers.
//
// Responsibilities:
//   - STRICT transport parse (`parseMaterializationPlan`): all fields
//     required, extra fields refused, placement-path grammar validated,
//     duplicate node identities / duplicate dependency names refused,
//     unreachable nodes refused, every edge NODE-RESOLUTION-VALID;
//   - CANONICALIZATION (`canonicalMaterializationPlanBytes`): object keys
//     sorted (UTF-16 code-unit order — the validated grammar is ASCII, so
//     this equals bytewise), `nodes` sorted by `placementPath`, dependency
//     arrays sorted by `name`, zero whitespace, UTF-8 — the cross-side byte
//     contract (the committed fixtures under
//     `src/lib/__tests__/fixtures/materialization-plan/` are normative);
//   - `closureHash` (`computeClosureHash`): lowercase-hex sha512 over the
//     canonical bytes; the host always RE-canonicalizes parsed transport JSON
//     before hashing (transport-encoding agnostic);
//   - execution-order projection (parents before children by placement
//     nesting) and the gate-input projection (root dependency names).
//
// SINGLE IDENTITY PER NODE (PR-2 merge-safe round): a node's `node_modules`
// placement name IS its registry package name — `npm:` ALIASED dependencies
// (placement name != registry identity) are NOT expressible in this format
// and are refused at build time (closure-mode builder) and at plan
// computation (signer side). A future format version may add a separate
// registry-identity field if aliases ever become necessary.

import { createHash } from "node:crypto";

import { HOST_PROVIDED_PACKAGES } from "@/lib/extension-package-store-core";

// ---------------------------------------------------------------------------
// Format + caps (fail-closed, test-pinned)
// ---------------------------------------------------------------------------

export const MATERIALIZATION_PLAN_FORMAT = "cinatra-materialization-plan/v1";

/** Packument field the plan travels in (next to `dist.cinatraSignature`). */
export const MATERIALIZATION_PLAN_PACKUMENT_FIELD = "cinatraMaterializationPlan";

/** Hard parse caps — a plan beyond either is refused, never truncated. */
export const MAX_PLAN_NODES = 500;
export const MAX_PLAN_CANONICAL_BYTES = 1024 * 1024; // 1 MiB

// ---------------------------------------------------------------------------
// Shapes (ALL fields required — no optionals, no nulls)
// ---------------------------------------------------------------------------

/** One edge: a dependency NAME resolved to the placed node that satisfies it. */
export type MaterializationPlanDependencyRef = {
  name: string;
  /** The `placementPath` of the node satisfying this edge (node identity). */
  placementPath: string;
};

export type MaterializationPlanNode = {
  name: string;
  version: string;
  /** sha512 SRI (`sha512-<base64>`) of the node's EXACT tarball bytes. */
  integrity: string;
  /**
   * Node identity: the exact POSIX path UNDER THE EXTENSION PACKAGE DIR where
   * this node's tree is placed (`node_modules/...`, nesting legal). The same
   * `name@version` placed at two paths = two nodes.
   */
  placementPath: string;
  /** This node's own runtime dependency edges (sorted by name canonically). */
  dependencies: MaterializationPlanDependencyRef[];
};

export type MaterializationPlan = {
  format: typeof MATERIALIZATION_PLAN_FORMAT;
  package: { name: string; version: string };
  /** The EXTENSION's own dependency edges (roots: `node_modules/<name>`). */
  rootDependencies: MaterializationPlanDependencyRef[];
  nodes: MaterializationPlanNode[];
};

/** Thrown for EVERY parse/validation refusal — callers fail closed. */
export class MaterializationPlanError extends Error {
  constructor(message: string) {
    super(`[materialization-plan] ${message}`);
    this.name = "MaterializationPlanError";
  }
}

// ---------------------------------------------------------------------------
// Strict parse + validation
// ---------------------------------------------------------------------------

/** npm package-name grammar (scoped or not) — ASCII by construction. */
const NPM_PACKAGE_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/** Exact published version: plain semver, no ranges/tags (locked plan). */
const EXACT_VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z-.]+)?(\+[0-9A-Za-z-.]+)?$/;

/**
 * STRICT single-sha512 SRI (review r0 finding 1): exactly `sha512-` + the
 * canonical base64 of a 64-byte digest — 86 base64 chars + `==`, no
 * whitespace, no multi-hash, no short digests. The permissive multi-hash
 * `parseSri` (store-core) is the TARBALL-side parser; plan integrity is a
 * byte contract and must admit exactly one rendering, so the signer and the
 * host can never diverge on what they hashed.
 */
const STRICT_SHA512_SRI_RE = /^sha512-[A-Za-z0-9+/]{86}==$/;

export function isStrictSha512Sri(integrity: string): boolean {
  if (typeof integrity !== "string" || !STRICT_SHA512_SRI_RE.test(integrity)) return false;
  const b64 = integrity.slice("sha512-".length);
  const decoded = Buffer.from(b64, "base64");
  // canonical-rendering round-trip: refuses non-zero trailing bits.
  return decoded.length === 64 && decoded.toString("base64") === b64;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(obj: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(obj).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((k, i) => k !== expected[i])) {
    throw new MaterializationPlanError(
      `${label} must have exactly the fields {${expected.join(", ")}} — got {${actual.join(", ")}} ` +
        `(all fields required, extra fields refused)`,
    );
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new MaterializationPlanError(`${label} must be a non-empty string`);
  }
  return value;
}

/**
 * Parse + validate one `placementPath`. Grammar (the FULL path — not just
 * segment hygiene): a chain of `node_modules/<packageName>` components, i.e.
 *   `node_modules/<pkg>(/node_modules/<pkg>)*`
 * where `<pkg>` is a valid (possibly scoped) npm package name. This implies:
 * POSIX separators only, starts with `node_modules/`, no `.`/`..`/empty
 * segments, no backslashes/NUL/percent-encoding (npm names exclude them), and
 * the resolved target stays inside the package dir by construction. Returns
 * the chain of package names, outermost first.
 */
export function parsePlacementPath(placementPath: string, label: string): string[] {
  if (typeof placementPath !== "string" || placementPath.length === 0) {
    throw new MaterializationPlanError(`${label}: placementPath must be a non-empty string`);
  }
  const segments = placementPath.split("/");
  const chain: string[] = [];
  let i = 0;
  while (i < segments.length) {
    if (segments[i] !== "node_modules") {
      throw new MaterializationPlanError(
        `${label}: placementPath "${placementPath}" is not a node_modules chain ` +
          `(expected "node_modules" at segment ${i}, got "${segments[i]}")`,
      );
    }
    i += 1;
    const first = segments[i];
    if (first === undefined) {
      throw new MaterializationPlanError(
        `${label}: placementPath "${placementPath}" ends at a bare node_modules segment`,
      );
    }
    let pkgName: string;
    if (first.startsWith("@")) {
      const second = segments[i + 1];
      if (second === undefined) {
        throw new MaterializationPlanError(
          `${label}: placementPath "${placementPath}" has a scope segment "${first}" without a name`,
        );
      }
      pkgName = `${first}/${second}`;
      i += 2;
    } else {
      pkgName = first;
      i += 1;
    }
    if (!NPM_PACKAGE_NAME_RE.test(pkgName)) {
      throw new MaterializationPlanError(
        `${label}: placementPath "${placementPath}" contains an invalid package segment "${pkgName}"`,
      );
    }
    chain.push(pkgName);
  }
  if (chain.length === 0) {
    throw new MaterializationPlanError(`${label}: placementPath "${placementPath}" is empty`);
  }
  return chain;
}

/** Placement depth = number of `node_modules` nestings (1 for a root dep). */
export function placementDepth(placementPath: string): number {
  return parsePlacementPath(placementPath, "placementDepth").length;
}

function parseDependencyRef(value: unknown, label: string): MaterializationPlanDependencyRef {
  if (!isPlainObject(value)) {
    throw new MaterializationPlanError(`${label} must be an object`);
  }
  assertExactKeys(value, ["name", "placementPath"], label);
  const name = requireString(value.name, `${label}.name`);
  if (!NPM_PACKAGE_NAME_RE.test(name)) {
    throw new MaterializationPlanError(`${label}.name "${name}" is not a valid npm package name`);
  }
  const placementPath = requireString(value.placementPath, `${label}.placementPath`);
  const chain = parsePlacementPath(placementPath, label);
  if (chain[chain.length - 1] !== name) {
    throw new MaterializationPlanError(
      `${label}: placementPath "${placementPath}" does not end in the package name "${name}"`,
    );
  }
  return { name, placementPath };
}

function parseDependencyRefList(
  value: unknown,
  label: string,
): MaterializationPlanDependencyRef[] {
  if (!Array.isArray(value)) {
    throw new MaterializationPlanError(`${label} must be an array`);
  }
  const refs = value.map((v, i) => parseDependencyRef(v, `${label}[${i}]`));
  const seen = new Set<string>();
  for (const ref of refs) {
    if (seen.has(ref.name)) {
      throw new MaterializationPlanError(
        `${label}: duplicate dependency name "${ref.name}" within one dependency set`,
      );
    }
    seen.add(ref.name);
  }
  return refs;
}

/**
 * Node's `node_modules` walk-up from a package dir placement: the candidate
 * dirs a bare specifier resolves against are the placement itself, each
 * ancestor PACKAGE dir in its chain, and the extension package root. An edge
 * is NODE-RESOLUTION-VALID iff the child's placementPath equals
 * `<candidate>/node_modules/<child.name>` for one of those candidates — i.e.
 * hoisted/deduped placements are legal, arbitrary cross-tree references are
 * not. Pure validation; the host NEVER resolves anything itself.
 */
function nodeResolutionCandidates(parentPlacementPath: string | null, childName: string): string[] {
  if (parentPlacementPath === null) {
    // The extension package root: roots live at exactly `node_modules/<name>`.
    return [`node_modules/${childName}`];
  }
  const segments = parentPlacementPath.split("/");
  const candidates: string[] = [];
  // Walk package-dir prefixes: the full placement, then strip one
  // `node_modules/<pkg>` component at a time (scope-aware), down to "".
  let prefixSegments = [...segments];
  for (;;) {
    const prefix = prefixSegments.join("/");
    candidates.push(prefix.length === 0 ? `node_modules/${childName}` : `${prefix}/node_modules/${childName}`);
    if (prefixSegments.length === 0) break;
    // strip the trailing package component: `node_modules` + 1 or 2 segments.
    const tailIsScoped = prefixSegments.length >= 3 && prefixSegments[prefixSegments.length - 2].startsWith("@");
    prefixSegments = prefixSegments.slice(0, prefixSegments.length - (tailIsScoped ? 3 : 2));
  }
  return candidates;
}

/**
 * STRICT transport parse: `value` is the raw JSON value read from the
 * packument's `cinatraMaterializationPlan` field. Refuses (throws
 * `MaterializationPlanError`) on ANY deviation:
 *   - wrong/missing format marker, missing/extra fields anywhere;
 *   - invalid names/versions, non-sha512 integrity;
 *   - invalid placementPath grammar, name-tail mismatch;
 *   - duplicate placementPath (node identity), duplicate dependency NAMES
 *     within any dependency set;
 *   - a dependency ref whose placementPath names no node, or whose name
 *     differs from the referenced node's name;
 *   - an edge that is not NODE-RESOLUTION-VALID (see above);
 *   - a node not reachable from `rootDependencies` via edges;
 *   - a HOST-PROVIDED peer as a plan node (host ABI peers are never closure
 *     libraries);
 *   - node-count / canonical-byte caps.
 * Transport ORDER is free — canonicalization sorts; validation is
 * order-independent.
 */
export function parseMaterializationPlan(value: unknown): MaterializationPlan {
  if (!isPlainObject(value)) {
    throw new MaterializationPlanError("plan must be a JSON object");
  }
  assertExactKeys(value, ["format", "package", "rootDependencies", "nodes"], "plan");
  if (value.format !== MATERIALIZATION_PLAN_FORMAT) {
    throw new MaterializationPlanError(
      `unsupported format ${JSON.stringify(value.format)} (expected "${MATERIALIZATION_PLAN_FORMAT}")`,
    );
  }
  if (!isPlainObject(value.package)) {
    throw new MaterializationPlanError("plan.package must be an object");
  }
  assertExactKeys(value.package, ["name", "version"], "plan.package");
  const pkgName = requireString(value.package.name, "plan.package.name");
  if (!NPM_PACKAGE_NAME_RE.test(pkgName)) {
    throw new MaterializationPlanError(`plan.package.name "${pkgName}" is not a valid npm package name`);
  }
  const pkgVersion = requireString(value.package.version, "plan.package.version");
  if (!EXACT_VERSION_RE.test(pkgVersion)) {
    throw new MaterializationPlanError(`plan.package.version "${pkgVersion}" is not an exact version`);
  }

  if (!Array.isArray(value.nodes)) {
    throw new MaterializationPlanError("plan.nodes must be an array");
  }
  if (value.nodes.length > MAX_PLAN_NODES) {
    throw new MaterializationPlanError(
      `plan has ${value.nodes.length} nodes — the cap is ${MAX_PLAN_NODES} (fail-closed)`,
    );
  }

  const nodes: MaterializationPlanNode[] = value.nodes.map((raw, i) => {
    const label = `plan.nodes[${i}]`;
    if (!isPlainObject(raw)) {
      throw new MaterializationPlanError(`${label} must be an object`);
    }
    assertExactKeys(raw, ["name", "version", "integrity", "placementPath", "dependencies"], label);
    const name = requireString(raw.name, `${label}.name`);
    if (!NPM_PACKAGE_NAME_RE.test(name)) {
      throw new MaterializationPlanError(`${label}.name "${name}" is not a valid npm package name`);
    }
    if (HOST_PROVIDED_PACKAGES.has(name)) {
      throw new MaterializationPlanError(
        `${label}: "${name}" is a HOST-PROVIDED peer — host ABI peers are never closure libraries`,
      );
    }
    const version = requireString(raw.version, `${label}.version`);
    if (!EXACT_VERSION_RE.test(version)) {
      throw new MaterializationPlanError(`${label}.version "${version}" is not an exact version`);
    }
    const integrity = requireString(raw.integrity, `${label}.integrity`);
    if (!isStrictSha512Sri(integrity)) {
      throw new MaterializationPlanError(
        `${label}.integrity must be a single sha512 SRI in canonical rendering ` +
          `(\`sha512-\` + 88 base64 chars of a 64-byte digest; got ${JSON.stringify(integrity)})`,
      );
    }
    const placementPath = requireString(raw.placementPath, `${label}.placementPath`);
    const chain = parsePlacementPath(placementPath, label);
    if (chain[chain.length - 1] !== name) {
      throw new MaterializationPlanError(
        `${label}: placementPath "${placementPath}" does not end in the package name "${name}"`,
      );
    }
    const dependencies = parseDependencyRefList(raw.dependencies, `${label}.dependencies`);
    return { name, version, integrity, placementPath, dependencies };
  });

  // Node identity: placementPath unique.
  const byPlacement = new Map<string, MaterializationPlanNode>();
  for (const node of nodes) {
    if (byPlacement.has(node.placementPath)) {
      throw new MaterializationPlanError(
        `duplicate node placementPath "${node.placementPath}" (node identity must be unique)`,
      );
    }
    byPlacement.set(node.placementPath, node);
  }

  const rootDependencies = parseDependencyRefList(value.rootDependencies, "plan.rootDependencies");

  // Edge validation: referenced node exists, names agree, NODE-RESOLUTION-VALID.
  const validateEdges = (
    refs: readonly MaterializationPlanDependencyRef[],
    parentPlacementPath: string | null,
    label: string,
  ): void => {
    for (const ref of refs) {
      const target = byPlacement.get(ref.placementPath);
      if (!target) {
        throw new MaterializationPlanError(
          `${label}: dependency "${ref.name}" references placementPath "${ref.placementPath}" which names no node`,
        );
      }
      if (target.name !== ref.name) {
        throw new MaterializationPlanError(
          `${label}: dependency "${ref.name}" references node "${target.name}" at "${ref.placementPath}" (name mismatch)`,
        );
      }
      const candidates = nodeResolutionCandidates(parentPlacementPath, ref.name);
      if (!candidates.includes(ref.placementPath)) {
        throw new MaterializationPlanError(
          `${label}: edge to "${ref.name}" at "${ref.placementPath}" is not Node-resolution-valid from ` +
            `${parentPlacementPath === null ? "the package root" : `"${parentPlacementPath}"`} ` +
            `(legal candidates: ${candidates.join(", ")})`,
        );
      }
    }
  };

  validateEdges(rootDependencies, null, "plan.rootDependencies");
  for (const node of nodes) {
    validateEdges(node.dependencies, node.placementPath, `plan node "${node.placementPath}"`);
  }

  // Reachability: every node must be reachable from rootDependencies.
  const reachable = new Set<string>();
  const queue = rootDependencies.map((r) => r.placementPath);
  while (queue.length > 0) {
    const p = queue.shift() as string;
    if (reachable.has(p)) continue;
    reachable.add(p);
    const node = byPlacement.get(p);
    if (node) queue.push(...node.dependencies.map((d) => d.placementPath));
  }
  for (const node of nodes) {
    if (!reachable.has(node.placementPath)) {
      throw new MaterializationPlanError(
        `node "${node.placementPath}" is not reachable from rootDependencies (orphan nodes refused)`,
      );
    }
  }

  const plan: MaterializationPlan = {
    format: MATERIALIZATION_PLAN_FORMAT,
    package: { name: pkgName, version: pkgVersion },
    rootDependencies,
    nodes,
  };

  // Canonical-byte cap — computed over the RE-canonicalized plan, fail-closed.
  const canonical = canonicalMaterializationPlanBytes(plan);
  if (canonical.byteLength > MAX_PLAN_CANONICAL_BYTES) {
    throw new MaterializationPlanError(
      `canonical plan is ${canonical.byteLength} bytes — the cap is ${MAX_PLAN_CANONICAL_BYTES} (fail-closed)`,
    );
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Canonicalization + closureHash (the cross-side byte contract)
// ---------------------------------------------------------------------------

function canonicalRef(ref: MaterializationPlanDependencyRef): Record<string, string> {
  // Keys in sorted order: name < placementPath.
  return { name: ref.name, placementPath: ref.placementPath };
}

/**
 * The CANONICAL BYTES of a plan: object keys in sorted (UTF-16 code-unit)
 * order, `nodes` sorted by `placementPath` (ASCII grammar ⇒ code-unit order
 * == bytewise), every dependency array sorted by `name`, zero whitespace,
 * UTF-8. The committed fixture `plan.canonical.bytes` pins these bytes for
 * the publish-time signer.
 */
export function canonicalMaterializationPlanBytes(plan: MaterializationPlan): Uint8Array {
  const canonical = {
    // Top-level keys in sorted order: format < nodes < package < rootDependencies.
    format: plan.format,
    nodes: [...plan.nodes]
      .sort((a, b) => (a.placementPath < b.placementPath ? -1 : a.placementPath > b.placementPath ? 1 : 0))
      .map((n) => ({
        // Node keys in sorted order: dependencies < integrity < name < placementPath < version.
        dependencies: [...n.dependencies]
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
          .map(canonicalRef),
        integrity: n.integrity,
        name: n.name,
        placementPath: n.placementPath,
        version: n.version,
      })),
    package: { name: plan.package.name, version: plan.package.version },
    rootDependencies: [...plan.rootDependencies]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map(canonicalRef),
  };
  return new TextEncoder().encode(JSON.stringify(canonical));
}

/** Lowercase-hex sha512 over the canonical plan bytes — the signed binding. */
export function computeClosureHash(plan: MaterializationPlan): string {
  return createHash("sha512").update(canonicalMaterializationPlanBytes(plan)).digest("hex");
}

/** Shape gate for a closureHash value (128 lowercase hex chars). */
export const CLOSURE_HASH_RE = /^[0-9a-f]{128}$/;

// ---------------------------------------------------------------------------
// Projections for the executor + the install gate
// ---------------------------------------------------------------------------

/**
 * VERBATIM execution order: parents before children by placement nesting —
 * a node whose placement dir contains another node's placement is created
 * first. Depth-then-path sort (a parent's chain is strictly shorter and a
 * prefix of its children's), deterministic across hosts.
 */
export function planExecutionOrder(plan: MaterializationPlan): MaterializationPlanNode[] {
  return [...plan.nodes].sort((a, b) => {
    const da = a.placementPath.split("/node_modules/").length;
    const db = b.placementPath.split("/node_modules/").length;
    if (da !== db) return da - db;
    return a.placementPath < b.placementPath ? -1 : a.placementPath > b.placementPath ? 1 : 0;
  });
}

/**
 * Gate-input projection: the set of dependency NAMES the plan's roots cover.
 * The evolved bundled-deps gate requires every declared dependency to be
 * bundled XOR in this set (and every member of this set to be declared).
 */
export function planRootDependencyNames(plan: MaterializationPlan): ReadonlySet<string> {
  return new Set(plan.rootDependencies.map((r) => r.name));
}
