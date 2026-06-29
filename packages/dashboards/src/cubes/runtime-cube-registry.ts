import "server-only";

// Runtime cube registry (cinatra#660 / PR-7).
//
// Cubes historically registered ONLY at static boot: the literal `cubes:[...]`
// array in `platform-singleton.ts`. A runtime-installed extension therefore
// could not contribute a cube without a host rebuild (the old cube-guard
// "requires-rebuild" verdict). This module lifts that boundary for the SAFE
// case — a runtime cube that ALIASES a host-allowlisted base cube under a new
// id with a member SUBSET, supplying NO SQL of its own.
//
// SECURITY MODEL (codex-converged, Option A) — the no-unsigned-code-execution
// invariant is preserved because an extension supplies ONLY:
//   - a cube id (alias),
//   - a `fromTable` that MUST be in the host FROM-allowlist below, and
//   - a SUBSET of that base cube's published member ids.
// The host owns FROM/JOIN/WHERE and every dimension/measure SQL. The alias
// REUSES the base host cube's exact build (via `aliasCinatraCube`), so it
// inherits the base cube's exact tenant predicate (e.g. agent_runs:
// `org_id IN accessibleOrgIds OR run_by = userId`). No extension SQL, no new
// table, no column the host did not already publish.
//
// FROM-ALLOWLIST FLOOR: only the four org-scoped tables whose host
// predicate needs NO pre-computed visibility id-set / platform-admin gate are
// runtime-eligible: agent_runs, projects, teams, organizations. `artifacts`
// (needs SecurityContext.visibleArtifactIds) and `llm_usage` (needs the
// isPlatformAdmin gate) are DELIBERATELY OMITTED — a runtime cube over them is
// rejected — until their exact gates are carried into a runtime allowlist entry
// and tested. See cinatra#660.
//
// SERVE-GATE (CG-5) is layered ON TOP of this registry by both transports: a
// runtime cube only SERVES when an active|locked installed_extension row for
// its source package is addressable to the actor AND its trust state is good
// (see `runtime-cube-serve-gate.ts`). This registry decides which cubes EXIST;
// the serve-gate decides whether a given actor may query a runtime one. The
// drizzle-cube tenant predicate is NEVER bypassed by either layer.

import {
  aliasCinatraCube,
  type RegisteredCube,
} from "@cinatra-ai/sdk-dashboard/adapters/drizzle-cube";

/**
 * The host base-cube ids a runtime cube may alias (the FROM-allowlist). Each
 * entry's exact host predicate is inherited by every alias over it.
 */
export const RUNTIME_CUBE_FROM_ALLOWLIST = [
  "agent_runs",
  "projects",
  "teams",
  "organizations",
] as const;

export type RuntimeCubeFromTable = (typeof RUNTIME_CUBE_FROM_ALLOWLIST)[number];

export function isRuntimeCubeFromTable(t: string): t is RuntimeCubeFromTable {
  return (RUNTIME_CUBE_FROM_ALLOWLIST as readonly string[]).includes(t);
}

/**
 * EVERY bundled (host-owned) cube id — the FROM-allowlist PLUS the cubes whose
 * special visibility gate keeps them OFF the runtime FROM-allowlist (artifacts,
 * llm_usage). A runtime alias id may not shadow ANY of these, even the ones it
 * cannot derive from — a duplicate id would silently shadow the bundled cube
 * when the two arrays merge in the platform. Kept in sync with
 * `platform-singleton.ts BUNDLED_CUBE_NAMES` by the parity assertion in
 * `runtime-cube-registry.test.ts`.
 */
export const ALL_BUNDLED_CUBE_IDS = [
  "agent_runs",
  "projects",
  "teams",
  "organizations",
  "artifacts",
  "llm_usage",
] as const;

function isBundledCubeId(id: string): boolean {
  return (ALL_BUNDLED_CUBE_IDS as readonly string[]).includes(id);
}

/** The owner scope of a runtime cube's source install (for actor-scope reads). */
export type RuntimeCubeOwnerScope = {
  readonly ownerLevel: string;
  readonly ownerId: string | null;
  readonly organizationId: string | null;
};

/**
 * A runtime cube descriptor an extension declares (parsed from
 * `cinatra/cube-descriptors.json`). The extension supplies ONLY these three
 * fields — never SQL.
 */
export type RuntimeCubeDescriptor = {
  /** The alias cube id this descriptor registers (must be unique, not a base id). */
  readonly cubeId: string;
  /** The host base cube this alias derives from — must be FROM-allowlisted. */
  readonly fromTable: RuntimeCubeFromTable;
  /** Subset of the base cube's published member ids exposed under the alias. */
  readonly members: readonly string[];
};

/** A runtime cube descriptor plus the install metadata the registry tracks. */
export type RuntimeCubeRegistration = {
  readonly descriptor: RuntimeCubeDescriptor;
  readonly sourcePackageName: string;
  readonly ownerScope: RuntimeCubeOwnerScope;
  /** Process activation generation at registration time. */
  readonly activationGeneration: number;
};

export type RuntimeCubeValidationResult =
  | { ok: true }
  | { ok: false; code: string; reason: string };

// ─── Process-wide runtime cube state ───────────────────────────────────────
// Keyed by alias cubeId. HMR-safe via globalThis (mirrors the platform
// singleton's HMR handling). Distinct from the platform singleton so a
// reconcile can mutate the runtime set and then force the platform to rebuild.
declare global {
  // eslint-disable-next-line no-var
  var __cinatraRuntimeCubes: Map<string, RuntimeCubeRegistration> | undefined;
}

function runtimeStore(): Map<string, RuntimeCubeRegistration> {
  if (!globalThis.__cinatraRuntimeCubes) {
    globalThis.__cinatraRuntimeCubes = new Map();
  }
  return globalThis.__cinatraRuntimeCubes;
}

/**
 * Validate a parsed runtime cube descriptor against the host allowlist + the
 * base cube's published members. Fail-closed: an unknown table, an empty/blank
 * id, a base-id collision (an alias may not shadow a bundled base cube), an
 * empty member set, or a member not published by the base cube is REJECTED.
 *
 * `publishedMembersOf` returns the published dimension+measure ids for a base
 * table (injected so this stays a pure function over the host catalog).
 */
export function validateRuntimeCubeDescriptor(
  raw: unknown,
  publishedMembersOf: (fromTable: RuntimeCubeFromTable) => readonly string[],
): RuntimeCubeValidationResult {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, code: "cube_descriptor_invalid", reason: "descriptor must be an object" };
  }
  const d = raw as Record<string, unknown>;
  const cubeId = d.cubeId;
  if (typeof cubeId !== "string" || cubeId.trim().length === 0) {
    return { ok: false, code: "cube_id_invalid", reason: "cubeId must be a non-empty string" };
  }
  // Syntax: keep ids to a safe member-name charset (drizzle-cube resolves
  // `<cube>.<member>` by `.`; an id with a dot would corrupt resolution).
  if (!/^[a-z][a-z0-9_]*$/i.test(cubeId)) {
    return {
      ok: false,
      code: "cube_id_invalid",
      reason: `cubeId "${cubeId}" must match /^[a-z][a-z0-9_]*$/i (no dots/spaces)`,
    };
  }
  const fromTable = d.fromTable;
  if (typeof fromTable !== "string" || !isRuntimeCubeFromTable(fromTable)) {
    return {
      ok: false,
      code: "cube_from_not_allowlisted",
      reason: `fromTable must be one of: ${RUNTIME_CUBE_FROM_ALLOWLIST.join(", ")}`,
    };
  }
  // An alias may not shadow ANY bundled cube id — not just the FROM-allowlisted
  // ones it could derive from, but also artifacts/llm_usage (kept off the
  // runtime allowlist). A duplicate id would shadow the bundled cube when the
  // bundled ∪ runtime arrays merge in the platform.
  if (isBundledCubeId(cubeId)) {
    return {
      ok: false,
      code: "cube_id_shadows_base",
      reason: `cubeId "${cubeId}" collides with a bundled cube id`,
    };
  }
  const members = d.members;
  if (!Array.isArray(members) || members.length === 0) {
    return { ok: false, code: "cube_members_empty", reason: "members must be a non-empty array" };
  }
  if (!members.every((m) => typeof m === "string" && m.length > 0)) {
    return { ok: false, code: "cube_members_invalid", reason: "every member must be a non-empty string" };
  }
  const published = new Set(publishedMembersOf(fromTable));
  const unknown = [...new Set(members as string[])].filter((m) => !published.has(m));
  if (unknown.length > 0) {
    return {
      ok: false,
      code: "cube_member_unknown",
      reason: `members not published by base cube "${fromTable}": ${unknown.join(", ")}`,
    };
  }
  return { ok: true };
}

/**
 * Parse + validate a list of raw runtime cube descriptors. Returns the parsed
 * descriptors on success, or the FIRST validation error (fail-closed: a single
 * bad descriptor rejects the whole declaration so an install is all-or-nothing).
 * Also rejects a duplicate cubeId WITHIN the declaration.
 */
export function parseRuntimeCubeDescriptors(
  raw: unknown,
  publishedMembersOf: (fromTable: RuntimeCubeFromTable) => readonly string[],
): { ok: true; descriptors: RuntimeCubeDescriptor[] } | { ok: false; code: string; reason: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, code: "cube_descriptors_invalid", reason: "cube-descriptors.json must be an array" };
  }
  const descriptors: RuntimeCubeDescriptor[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const v = validateRuntimeCubeDescriptor(entry, publishedMembersOf);
    if (!v.ok) return v;
    const d = entry as RuntimeCubeDescriptor;
    if (seen.has(d.cubeId)) {
      return { ok: false, code: "cube_id_duplicate", reason: `duplicate cubeId "${d.cubeId}" in declaration` };
    }
    seen.add(d.cubeId);
    descriptors.push({ cubeId: d.cubeId, fromTable: d.fromTable, members: [...new Set(d.members)] });
  }
  return { ok: true, descriptors };
}

/**
 * Register runtime cube descriptors for a source package. REPLACES any existing
 * registrations for the same package (idempotent re-install) and rejects an
 * alias id already owned by ANOTHER package (cross-package collision). Returns
 * the registered alias ids on success.
 *
 * NOTE: this only mutates the runtime descriptor SET — it does NOT rebuild the
 * platform. The caller (`reconcileRuntimeCubes`) bumps the activation
 * generation and forces the platform + MCP bridge to rebuild so the new cubes
 * compile.
 */
export function registerRuntimeCubes(input: {
  sourcePackageName: string;
  ownerScope: RuntimeCubeOwnerScope;
  descriptors: readonly RuntimeCubeDescriptor[];
  activationGeneration: number;
}): { ok: true; cubeIds: string[] } | { ok: false; code: string; reason: string } {
  const store = runtimeStore();
  // Detect collisions BEFORE mutating: a bundled-id shadow (defense-in-depth —
  // descriptor validation already rejects these) OR another package's alias.
  for (const d of input.descriptors) {
    if (isBundledCubeId(d.cubeId)) {
      return {
        ok: false,
        code: "cube_id_shadows_base",
        reason: `cubeId "${d.cubeId}" collides with a bundled cube id`,
      };
    }
    const existing = store.get(d.cubeId);
    if (existing && existing.sourcePackageName !== input.sourcePackageName) {
      return {
        ok: false,
        code: "cube_id_collision",
        reason: `cubeId "${d.cubeId}" already registered by package "${existing.sourcePackageName}"`,
      };
    }
  }
  // Clear this package's prior registrations (re-install replaces).
  unregisterRuntimeCubesForPackage(input.sourcePackageName);
  for (const descriptor of input.descriptors) {
    store.set(descriptor.cubeId, {
      descriptor,
      sourcePackageName: input.sourcePackageName,
      ownerScope: input.ownerScope,
      activationGeneration: input.activationGeneration,
    });
  }
  return { ok: true, cubeIds: input.descriptors.map((d) => d.cubeId) };
}

/** Unregister every runtime cube contributed by `sourcePackageName` (teardown). */
export function unregisterRuntimeCubesForPackage(sourcePackageName: string): string[] {
  const store = runtimeStore();
  const removed: string[] = [];
  for (const [cubeId, reg] of store) {
    if (reg.sourcePackageName === sourcePackageName) {
      store.delete(cubeId);
      removed.push(cubeId);
    }
  }
  return removed;
}

/** Look up a runtime cube registration by alias id (null when not runtime). */
export function getRuntimeCubeRegistration(cubeId: string): RuntimeCubeRegistration | null {
  return runtimeStore().get(cubeId) ?? null;
}

/** Is `cubeId` a runtime-contributed (aliased) cube? */
export function isRuntimeCube(cubeId: string): boolean {
  return runtimeStore().has(cubeId);
}

/** All current runtime cube registrations (a snapshot). */
export function listRuntimeCubeRegistrations(): RuntimeCubeRegistration[] {
  return [...runtimeStore().values()];
}

/** Runtime alias cube ids currently registered. */
export function listRuntimeCubeIds(): string[] {
  return [...runtimeStore().keys()];
}

/**
 * Build the aliased `RegisteredCube` list for every current runtime
 * registration, given the compiled BASE cubes keyed by their host id. A
 * registration whose base cube is not in `baseCubesById` (e.g. a base table not
 * compiled this process) is SKIPPED defensively — it simply does not appear in
 * the catalog (fail-closed: a runtime cube never registers without its host
 * base). The alias reuses the base cube's host SQL build verbatim.
 */
export function buildRuntimeRegisteredCubes(
  baseCubesById: ReadonlyMap<string, RegisteredCube>,
): RegisteredCube[] {
  const out: RegisteredCube[] = [];
  for (const reg of runtimeStore().values()) {
    const base = baseCubesById.get(reg.descriptor.fromTable);
    if (!base) continue;
    out.push(aliasCinatraCube(base, reg.descriptor.cubeId, reg.descriptor.members));
  }
  return out;
}

/** Test-only — clear the runtime cube set. */
export function __resetRuntimeCubeRegistryForTests(): void {
  globalThis.__cinatraRuntimeCubes = new Map();
}
