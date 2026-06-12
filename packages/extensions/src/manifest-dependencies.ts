// Manifest dependency-edge reader — the DUAL-READ vocabulary seam (#180).
//
// The canonical declaration is `cinatra.dependencies: ExtensionDependency[]`
// (canonical-types.ts). A LEGACY agent-kind artifact may instead (or also)
// carry `cinatra.agentDependencies: Record<packageName, semverRange>` — the
// npm-style map the historical agent tree installer consumed. This module is
// the single reader every install path uses to turn a verified manifest into
// the edges persisted on the canonical `installed_extension` row, so an older
// published artifact that only carries `agentDependencies` never persists a
// silent `[]`.
//
// Rules (issue #180 item 9, dual-read phase — hard removal of the legacy key
// is a later follow-up):
//   - `cinatra.dependencies` present → it WINS (the canonical vocabulary).
//   - only `cinatra.agentDependencies` present → each entry is PROJECTED to a
//     `{ edgeType: "runtime", requirement: "required", versionConstraint:
//     { kind: "semver-range", range } }` edge (the semantics the legacy
//     auto-installer enforced). `kind` is deliberately OMITTED on projected
//     edges — the legacy map never declared the target's kind, and guessing
//     "agent" would persist a wrong kind for any historical map that named a
//     non-agent package.
//   - BOTH present → they must AGREE: every legacy name must appear in the
//     canonical array as an install-blocking edge (`requirement: "required"`,
//     `edgeType: "runtime" | "install-time"`). A legacy name missing from the
//     canonical array, or declared there with weaker semantics
//     (optional / peer), is a CONFLICT → fail-loud (`ManifestDependencyError`,
//     code CONFLICT). Canonical-only EXTRA edges are NOT a conflict (the
//     canonical vocabulary is richer — mirrors the CI deps-gate, which pins
//     edgeType+requirement for derived edges but never ranges). Version
//     ranges are NOT compared: the canonical entry's constraint wins
//     (real first-party manifests legitimately declare `*` canonically next
//     to a `^x.y.z` legacy map).
//   - a malformed canonical entry (wrong shape / unknown edgeType /
//     requirement / versionConstraint / kind, or a self-edge) → fail-loud
//     (code MALFORMED). Install-time validation is strict by design: a
//     malformed edge silently dropped would weaken every downstream closure
//     gate that consumes the persisted row.
import "server-only";

import type { ExtensionDependency } from "./canonical-types";
import {
  DEPENDENCY_EDGE_TYPES,
  DEPENDENCY_REQUIREMENTS,
  EXTENSION_KINDS,
} from "./canonical-types";

export class ManifestDependencyError extends Error {
  constructor(
    public readonly code: "MALFORMED" | "CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "ManifestDependencyError";
  }
}

export type ManifestDependencyReadResult = {
  edges: ExtensionDependency[];
  /** Which vocabulary produced the edges (for diagnostics / deprecation telemetry). */
  source: "canonical" | "legacy-agent" | "none";
};

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** Structural validation of one canonical `cinatra.dependencies` entry.
 *  Returns the list of problems (empty = valid). Exported so the sanctioned
 *  canonical-row writer (`recordExtensionDependencies`) re-validates the same
 *  shape at the persistence boundary. */
export function validateExtensionDependencyShape(
  value: unknown,
  ownPackageName?: string,
): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return ["entry is not an object"];
  }
  const v = value as Record<string, unknown>;
  const problems: string[] = [];
  if (!isNonEmptyString(v.packageName)) problems.push("packageName must be a non-empty string");
  else if (ownPackageName && v.packageName === ownPackageName) problems.push("self-edge (a package cannot depend on itself)");
  if (!(DEPENDENCY_EDGE_TYPES as readonly string[]).includes(v.edgeType as string)) {
    problems.push(`edgeType must be one of ${DEPENDENCY_EDGE_TYPES.join("|")}`);
  }
  if (!(DEPENDENCY_REQUIREMENTS as readonly string[]).includes(v.requirement as string)) {
    problems.push(`requirement must be one of ${DEPENDENCY_REQUIREMENTS.join("|")}`);
  }
  if (v.kind !== undefined && !(EXTENSION_KINDS as readonly string[]).includes(v.kind as string)) {
    problems.push(`kind, when present, must be one of ${EXTENSION_KINDS.join("|")}`);
  }
  const vc = v.versionConstraint as Record<string, unknown> | undefined;
  if (!vc || typeof vc !== "object") {
    problems.push("versionConstraint must be an object");
  } else if (vc.kind === "semver-range") {
    if (!isNonEmptyString(vc.range)) problems.push("versionConstraint.range must be a non-empty string");
  } else if (vc.kind === "exact") {
    if (!isNonEmptyString(vc.version)) problems.push("versionConstraint.version must be a non-empty string");
  } else if (vc.kind === "git-ref") {
    if (!isNonEmptyString(vc.ref)) problems.push("versionConstraint.ref must be a non-empty string");
  } else {
    problems.push("versionConstraint.kind must be one of semver-range|exact|git-ref");
  }
  return problems;
}

/**
 * Parse the dependency edges out of a (verified) package manifest object.
 * Fail-loud (`ManifestDependencyError`) on a malformed canonical entry or a
 * canonical-vs-legacy conflict — never returns a silently-dropped edge.
 */
export function parseManifestDependencyEdges(
  manifest: unknown,
  opts?: { packageName?: string },
): ManifestDependencyReadResult {
  const pkgName =
    opts?.packageName ??
    ((manifest as { name?: unknown } | null | undefined)?.name as string | undefined);
  const label = pkgName ?? "(unknown package)";
  const cinatra = (manifest as { cinatra?: unknown } | null | undefined)?.cinatra;
  const canonicalRaw = (cinatra as { dependencies?: unknown } | null | undefined)?.dependencies;
  const legacyRaw = (cinatra as { agentDependencies?: unknown } | null | undefined)
    ?.agentDependencies;

  // -- canonical -----------------------------------------------------------
  // Only an ABSENT key (`undefined`) means "not declared". An explicit `null`
  // is MALFORMED, fail-loud: "no dependencies" is spelled `[]`, and silently
  // reading `null` as absent would let a generator bug erase a manifest's
  // edges without a trace (the same silent-[] failure mode this module exists
  // to prevent).
  let canonical: ExtensionDependency[] | null = null;
  if (canonicalRaw !== undefined) {
    if (!Array.isArray(canonicalRaw)) {
      throw new ManifestDependencyError(
        "MALFORMED",
        `${label}: cinatra.dependencies must be an array (got ${canonicalRaw === null ? "null" : typeof canonicalRaw}); declare "no dependencies" as [].`,
      );
    }
    const edges: ExtensionDependency[] = [];
    const seen = new Set<string>();
    for (const entry of canonicalRaw) {
      const problems = validateExtensionDependencyShape(entry, pkgName);
      if (problems.length > 0) {
        throw new ManifestDependencyError(
          "MALFORMED",
          `${label}: malformed cinatra.dependencies entry ${JSON.stringify(entry)} — ${problems.join("; ")}.`,
        );
      }
      const dep = entry as ExtensionDependency;
      if (seen.has(dep.packageName)) {
        throw new ManifestDependencyError(
          "MALFORMED",
          `${label}: duplicate cinatra.dependencies entry for ${dep.packageName}.`,
        );
      }
      seen.add(dep.packageName);
      edges.push(dep);
    }
    canonical = edges;
  }

  // -- legacy --------------------------------------------------------------
  // Same absence rule as the canonical key: explicit `null` is MALFORMED
  // ("no dependencies" on the legacy vocabulary is `{}` or simply omitting
  // the key), never silently read as absent.
  let legacy: Map<string, string> | null = null;
  if (legacyRaw !== undefined) {
    if (legacyRaw === null || typeof legacyRaw !== "object" || Array.isArray(legacyRaw)) {
      throw new ManifestDependencyError(
        "MALFORMED",
        `${label}: cinatra.agentDependencies must be a { name: range } map (got ${legacyRaw === null ? "null" : Array.isArray(legacyRaw) ? "array" : typeof legacyRaw}).`,
      );
    }
    legacy = new Map();
    for (const [name, range] of Object.entries(legacyRaw as Record<string, unknown>)) {
      if (!isNonEmptyString(name) || !isNonEmptyString(range)) {
        throw new ManifestDependencyError(
          "MALFORMED",
          `${label}: malformed cinatra.agentDependencies entry ${JSON.stringify({ [name]: range })} — both name and range must be non-empty strings.`,
        );
      }
      if (pkgName && name === pkgName) {
        throw new ManifestDependencyError(
          "MALFORMED",
          `${label}: cinatra.agentDependencies self-edge (a package cannot depend on itself).`,
        );
      }
      legacy.set(name, range);
    }
  }

  // -- resolve -------------------------------------------------------------
  if (canonical !== null && legacy !== null && legacy.size > 0) {
    // BOTH present → they must agree (canonical wins, but a legacy edge the
    // canonical array dropped or weakened is a conflict, fail-loud).
    const byName = new Map(canonical.map((d) => [d.packageName, d]));
    const conflicts: string[] = [];
    for (const name of legacy.keys()) {
      const c = byName.get(name);
      if (!c) {
        conflicts.push(`${name} is declared in cinatra.agentDependencies but missing from cinatra.dependencies`);
        continue;
      }
      if (c.requirement !== "required" || c.edgeType === "peer") {
        conflicts.push(
          `${name} is a required runtime edge in cinatra.agentDependencies but declared ` +
            `${c.edgeType}/${c.requirement} in cinatra.dependencies`,
        );
      }
    }
    if (conflicts.length > 0) {
      throw new ManifestDependencyError(
        "CONFLICT",
        `${label}: cinatra.dependencies and legacy cinatra.agentDependencies disagree — ` +
          `${conflicts.join("; ")}. Fix the manifest (the canonical cinatra.dependencies ` +
          `array is the source of truth; the legacy map may only restate a subset of its ` +
          `required runtime/install-time edges).`,
      );
    }
  }

  if (canonical !== null) {
    return { edges: canonical, source: "canonical" };
  }
  if (legacy !== null && legacy.size > 0) {
    const edges: ExtensionDependency[] = [...legacy.entries()].map(([packageName, range]) => ({
      packageName,
      edgeType: "runtime",
      versionConstraint: { kind: "semver-range", range },
      requirement: "required",
    }));
    return { edges, source: "legacy-agent" };
  }
  return { edges: [], source: "none" };
}

/**
 * Read the dependency edges from a MATERIALIZED package store dir's
 * `package.json` (the SRI-verified bytes — same trust basis as
 * `readRequestedPorts` / the host-compat gate). Fail-loud on an unreadable /
 * unparsable manifest: the materializer just wrote it, so a missing or broken
 * `package.json` here is a real integrity problem, never a "no deps" case.
 */
export async function readManifestDependencyEdgesFromStore(
  storeDir: string,
): Promise<ManifestDependencyReadResult> {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  let raw: string;
  try {
    raw = await readFile(join(storeDir, "package.json"), "utf8");
  } catch (e) {
    throw new ManifestDependencyError(
      "MALFORMED",
      `package.json could not be read from the materialized store dir ${storeDir}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(raw);
  } catch (e) {
    throw new ManifestDependencyError(
      "MALFORMED",
      `package.json in ${storeDir} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return parseManifestDependencyEdges(manifest);
}

/** A canonical-row write target resolved by {@link resolveLiveCanonicalEdgeTargets}. */
export type CanonicalEdgeTarget = { id: string; packageName: string };

/**
 * READ PHASE: resolve the LIVE (`active | locked`) canonical rows the edges
 * will be written to. FAIL-LOUD on an unreachable canonical store (the read
 * failure THROWS): the agent path is a MATERIALIZING install path — a
 * "warn + skip" would let a transient store failure finalize an install whose
 * canonical rows keep the dispatcher's silent `dependencies: []` seed
 * forever, the exact invariant violation #180 exists to close.
 *
 * Split from the WRITE phase so a materializing caller can run this read
 * EARLY — before any of its own durable writes (agent template/version rows)
 * — keeping the fail-loud refusal fully INERT; the write then lands at the
 * caller's finalize seam against the pre-resolved targets.
 *
 * Org scoping: when `organizationId` is provided (`null` = platform scope)
 * only the rows at that exact scope are targeted; when it is UNDEFINED every
 * live row for the package is targeted — the agent tree installer does not
 * carry org identity today, and the edges are a fact of the (package,
 * version) manifest, so refreshing every live row is strictly better than
 * leaving any at `[]`. ZERO live rows is the legitimate no-op (a direct agent
 * install that never went through the dispatcher has no canonical row).
 */
export async function resolveLiveCanonicalEdgeTargets(input: {
  packageName: string;
  organizationId?: string | null;
}): Promise<CanonicalEdgeTarget[]> {
  const { readInstalledExtensionsByPackageName } = await import("./canonical-store");
  const rows = await readInstalledExtensionsByPackageName(input.packageName);
  return rows
    .filter(
      (r) =>
        (r.status === "active" || r.status === "locked") &&
        (input.organizationId === undefined ||
          (r.organizationId ?? null) === (input.organizationId ?? null)),
    )
    .map((r) => ({ id: r.id, packageName: r.packageName }));
}

/**
 * WRITE PHASE: persist the edges onto pre-resolved canonical rows (see
 * {@link resolveLiveCanonicalEdgeTargets}). A FAILED write throws — the
 * persistence invariant is not best-effort once the row exists.
 */
export async function writeDependencyEdgesToCanonicalRows(
  targets: readonly CanonicalEdgeTarget[],
  edges: ExtensionDependency[],
): Promise<{ patchedRowIds: string[] }> {
  if (targets.length === 0) return { patchedRowIds: [] };
  const { recordExtensionDependencies } = await import("./lifecycle-primitive");
  const patchedRowIds: string[] = [];
  for (const row of targets) {
    await recordExtensionDependencies(row.id, edges, {
      actor: { source: "runtime-installer" },
      reason: `manifest dependency edges @ install`,
    });
    patchedRowIds.push(row.id);
  }
  return { patchedRowIds };
}

/**
 * One-shot read+write composition (#180 PR-1) — for callers with no durable
 * writes of their own between the read and the write. A MATERIALIZING caller
 * with its own writes (the agent installer) must use the SPLIT phases instead:
 * `resolveLiveCanonicalEdgeTargets` EARLY (fail-loud while still inert), then
 * `writeDependencyEdgesToCanonicalRows` at its finalize seam.
 */
export async function persistDependencyEdgesOnCanonicalRows(input: {
  packageName: string;
  edges: ExtensionDependency[];
  organizationId?: string | null;
}): Promise<{ patchedRowIds: string[] }> {
  const targets = await resolveLiveCanonicalEdgeTargets({
    packageName: input.packageName,
    ...(input.organizationId !== undefined ? { organizationId: input.organizationId } : {}),
  });
  return writeDependencyEdgesToCanonicalRows(targets, input.edges);
}
