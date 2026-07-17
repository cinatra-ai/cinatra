// L1 declared-environment spec — the SDK leaf (exec-plane S3, cinatra#1708;
// epic #1705).
//
// The "this agent does not work without tool X" answer: an AGENT declares the
// packages its runs require under `cinatra.execution.environment`, the trusted
// environment builder (@cinatra-ai/execution-plane) turns the declaration into
// an immutable, content-addressed L1 layer, and every later run — and every
// same-recipe agent — mounts it instead of re-installing.
//
// This leaf owns the CANONICAL internal type + the fail-closed parser +
// canonicalization for BOTH declaration sources (epic invariant: one internal
// type, two authoring surfaces):
//   - packaged agents: `cinatra.execution.environment` in package.json,
//     carried RAW on `NormalizedExtensionRecord.executionEnvironment`
//     (agent-kind gated), validated HERE at consumption;
//   - project agents: the in-app agent definition's environment config,
//     normalized through the SAME `parseExecutionEnvironment`.
//
// Fail-closed discipline (deliberately STRICTER than the field-tolerant
// dashboardContribution leaf): an execution environment is a BUILD RECIPE, so
// an unknown key or malformed entry is REJECTED, never silently dropped — a
// silently-ignored declaration would produce a layer missing packages the
// author asked for, which the agent then "fixes" with ad-hoc L2 installs and
// the declaration rots. Nothing in this module executes anything; the
// TRUSTED BUILDER is the only consumer that turns a parsed spec into
// commands, and it does so from the PARSED shape only, never the raw bytes.
//
// Canonicalization is IDENTITY-BEARING: the canonical form (trimmed, deduped,
// sorted) is what the builder hashes into the cache key, so two agents that
// declare the same set in different order share one cache entry (cinatra#1708
// AC1). Keep it deterministic and dependency-free.

/**
 * The canonical L1 declared-environment spec. All three managers are
 * OPTIONAL; an absent/empty manager contributes nothing to the recipe.
 *
 *  - `os`:  OS-level packages (Debian/apt names, optional `=version` pin).
 *           Installed by the TRUSTED BUILDER as root at BUILD time only —
 *           the only place OS-level deps enter besides the L0 base image
 *           (epic D2). No root path exists in a running sandbox.
 *  - `pip`: Python requirement specifiers (PEP 508 name + optional extras +
 *           optional version constraints). Registry installs only — no
 *           direct-URL / VCS / local-path forms (builder egress is
 *           registry-allowlisted, epic D3 trust distinction).
 *  - `npm`: npm package specifiers (`name` / `@scope/name`, optional
 *           `@range`). Registry installs only, same restriction.
 */
export type ExecutionEnvironmentSpec = {
  os?: string[];
  pip?: string[];
  npm?: string[];
};

/** The manager keys, in canonical (emission) order. */
export const EXECUTION_ENVIRONMENT_MANAGERS = ["npm", "os", "pip"] as const;
export type ExecutionEnvironmentManager =
  (typeof EXECUTION_ENVIRONMENT_MANAGERS)[number];

/** Per-list and per-entry bounds (defense against pathological manifests). */
export const EXECUTION_ENVIRONMENT_MAX_ENTRIES_PER_MANAGER = 64;
export const EXECUTION_ENVIRONMENT_MAX_ENTRY_LENGTH = 128;

/**
 * The ONLY extension kind that may declare an execution environment
 * (cinatra#1708: "restricted to AGENT manifests"). Mirrored by the manifest
 * generator's claim resolver and the runtime-loader's record builder — a
 * non-agent manifest's declaration is never carried onto a record, and this
 * parser is the fail-closed backstop for anything that slips through.
 */
export const EXECUTION_ENVIRONMENT_CARRIER_KIND = "agent";

// Per-manager entry grammar. Deliberately ALLOWLISTS a conservative charset —
// entries end up inside builder-rendered install commands, so anything outside
// the grammar (whitespace, shell metacharacters, option-injection dashes,
// path/URL forms) is refused here, not sanitized later.
//  - os: Debian package-name policy (lowercase alnum start; alnum + - . +),
//        optional `=<version>` pin.
//  - pip: PEP-508-ish specifier WITHOUT url/path forms: name, optional
//        [extras], optional version constraints (== != <= >= ~= < > , *).
//  - npm: optional @scope/ prefix, name, optional @<range> suffix (semver
//        range chars, no spaces — use range operators without spaces).
const OS_ENTRY_RE = /^[a-z0-9][a-z0-9+.-]*(=[A-Za-z0-9~+:.-]+)?$/;
const PIP_ENTRY_RE =
  /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9._,-]+\])?((==|!=|<=|>=|~=|<|>)[A-Za-z0-9.*+!,<>=~-]+)?$/;
const NPM_ENTRY_RE =
  /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(@[A-Za-z0-9^~><=.*+|-]+)?$/;

const ENTRY_RES: Record<ExecutionEnvironmentManager, RegExp> = {
  os: OS_ENTRY_RE,
  pip: PIP_ENTRY_RE,
  npm: NPM_ENTRY_RE,
};

/**
 * Poison marker for a PRESENT-but-malformed declaration root (codex S3-r0
 * finding 3; same doctrine as `invalidMigrationsDirDeclared`): a manifest
 * that declared `cinatra.execution` / `…execution.environment` as a
 * NON-OBJECT has ATTEMPTED a declaration — it must never silently collapse
 * to "no environment". The claim resolver carries this sentinel instead, and
 * the fail-closed parser rejects it with a precise error, so the attempt
 * fails loudly at consumption on BOTH loader paths.
 */
export const EXECUTION_ENVIRONMENT_INVALID_DECLARATION_KEY =
  "__invalidExecutionEnvironmentDeclaration";

export type ParseExecutionEnvironmentResult =
  | { ok: true; spec: ExecutionEnvironmentSpec }
  | { ok: false; errors: string[] };

/**
 * Parse + canonicalize a raw declared environment, fail-closed:
 *  - the value must be a plain object;
 *  - ONLY the known manager keys are accepted — an unknown key REJECTS the
 *    whole declaration (a typo must never silently drop packages);
 *  - every entry must be a string inside the manager's grammar and bounds;
 *  - duplicates (after trimming) are tolerated and deduped.
 *
 * On success the returned spec is CANONICAL: trimmed, deduped, sorted, empty
 * managers omitted. `{}` (or all-empty managers) parses to the empty spec —
 * see `isEmptyExecutionEnvironment`.
 */
export function parseExecutionEnvironment(
  value: unknown,
): ParseExecutionEnvironmentResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      errors: ["execution.environment must be a plain object"],
    };
  }
  const raw = value as Record<string, unknown>;
  if (EXECUTION_ENVIRONMENT_INVALID_DECLARATION_KEY in raw) {
    return {
      ok: false,
      errors: [
        "execution.environment was DECLARED but is not a plain object (the claim " +
          "resolver carried the malformed-declaration marker); fix the manifest — " +
          "a present-but-malformed declaration never activates as \"no environment\"",
      ],
    };
  }
  const errors: string[] = [];
  const known = new Set<string>(EXECUTION_ENVIRONMENT_MANAGERS);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) {
      errors.push(
        `execution.environment has unknown key "${key}" (known: ${[...EXECUTION_ENVIRONMENT_MANAGERS].join(", ")}); ` +
          `refusing the whole declaration fail-closed`,
      );
    }
  }
  const spec: ExecutionEnvironmentSpec = {};
  for (const manager of EXECUTION_ENVIRONMENT_MANAGERS) {
    const list = raw[manager];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      errors.push(`execution.environment.${manager} must be an array of strings`);
      continue;
    }
    if (list.length > EXECUTION_ENVIRONMENT_MAX_ENTRIES_PER_MANAGER) {
      errors.push(
        `execution.environment.${manager} exceeds ${EXECUTION_ENVIRONMENT_MAX_ENTRIES_PER_MANAGER} entries`,
      );
      continue;
    }
    const entries: string[] = [];
    for (const item of list) {
      if (typeof item !== "string") {
        errors.push(`execution.environment.${manager} has a non-string entry`);
        continue;
      }
      const entry = item.trim();
      if (entry.length === 0) {
        errors.push(`execution.environment.${manager} has an empty entry`);
        continue;
      }
      if (entry.length > EXECUTION_ENVIRONMENT_MAX_ENTRY_LENGTH) {
        errors.push(
          `execution.environment.${manager} entry exceeds ` +
            `${EXECUTION_ENVIRONMENT_MAX_ENTRY_LENGTH} characters: "${entry.slice(0, 32)}…"`,
        );
        continue;
      }
      if (!ENTRY_RES[manager].test(entry)) {
        errors.push(
          `execution.environment.${manager} entry "${entry}" is outside the ${manager} ` +
            `package-specifier grammar (registry package specifiers only — no URLs, ` +
            `paths, options, whitespace, or shell metacharacters)`,
        );
        continue;
      }
      entries.push(entry);
    }
    if (entries.length > 0) {
      spec[manager] = [...new Set(entries)].sort();
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, spec };
}

/** True when the (canonical) spec declares nothing — no L1 layer needed. */
export function isEmptyExecutionEnvironment(
  spec: ExecutionEnvironmentSpec,
): boolean {
  return EXECUTION_ENVIRONMENT_MANAGERS.every(
    (m) => !spec[m] || spec[m]!.length === 0,
  );
}

/**
 * Deterministic JSON of the CANONICAL spec — the identity string the trusted
 * builder hashes into the environment cache key (with the other recipe
 * inputs). Keys in fixed canonical order, entries already sorted by the
 * parser; re-canonicalizes defensively so a hand-built spec hashes the same
 * as a parsed one.
 */
export function canonicalExecutionEnvironmentJson(
  spec: ExecutionEnvironmentSpec,
): string {
  const out: Record<string, string[]> = {};
  for (const manager of EXECUTION_ENVIRONMENT_MANAGERS) {
    const list = spec[manager];
    if (!list || list.length === 0) continue;
    out[manager] = [...new Set(list.map((e) => e.trim()))].sort();
  }
  return JSON.stringify(out);
}

/**
 * The RAW `cinatra.execution.environment` claim for a record, CARRIER-KIND
 * GATED: only `kind:"agent"` may declare an execution environment, so any
 * other kind resolves null even when a stray declaration is present (same
 * doctrine as the dashboard-contribution claim). The value is carried
 * UNVALIDATED as data — consumers validate through
 * `parseExecutionEnvironment` fail-closed. The manifest generator mirrors
 * this exact semantic in `resolveExecutionEnvironmentClaim` (.mjs); the
 * runtime loader (`recordFromManifest`) applies it via this function's
 * logic on the store manifest.
 */
export function resolveExecutionEnvironmentClaim(
  kind: unknown,
  cinatra: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (kind !== EXECUTION_ENVIRONMENT_CARRIER_KIND) return null;
  if (!cinatra || !("execution" in cinatra)) return null;
  const execution = cinatra.execution;
  if (execution === undefined) return null;
  const poison = { [EXECUTION_ENVIRONMENT_INVALID_DECLARATION_KEY]: true };
  if (
    execution === null ||
    typeof execution !== "object" ||
    Array.isArray(execution)
  ) {
    // `cinatra.execution` DECLARED but malformed — carry the poison marker so
    // the parser rejects it fail-closed (never "no environment").
    return poison;
  }
  const block = execution as Record<string, unknown>;
  if (!("environment" in block) || block.environment === undefined) return null;
  const environment = block.environment;
  if (
    environment === null ||
    typeof environment !== "object" ||
    Array.isArray(environment)
  ) {
    // environment DECLARED but malformed — same fail-closed carry.
    return poison;
  }
  return environment as Record<string, unknown>;
}
