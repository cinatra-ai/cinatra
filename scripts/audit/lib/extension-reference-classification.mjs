// Shared classification taxonomy for named-extension references in core.
//
// Every reference core makes to a specific extension package NAME (or
// `extensions/<scope>/<name>/` path) falls into exactly one class. The three
// extension-coupling gates (`core-extension-instance-coupling-ban`,
// `core-extension-import-ban`, `extension-import-ban`) report against this one
// taxonomy so "how much coupling is left, and of what kind?" has a single
// auditable answer. See `scripts/audit/extension-coupling-gates.md` for the
// per-gate counts and the strict end-state target.
//
// Classes:
//
//   - "runtime-coupling"  — core selects/loads/branches on a specific
//     extension at runtime (named imports, loader maps, provider registration,
//     prompt/dispatch literals). This is the architecture debt the runtime
//     cutover removes; the DEFAULT class for any counted reference.
//
//   - "mechanical"        — re-export facades, hand-written inventories/
//     catalogs, and dev-name lists. Not runtime selection, but still
//     named-instance coupling; removed or consolidated by the
//     mechanical-cleanup pass (#35 drove every counted mechanical occurrence
//     to ZERO — the class is kept so any reappearance is classified honestly,
//     and it fails the gates like everything else). Counted and ratcheted
//     exactly like runtime-coupling — NEVER exempt.
//
//   - "permanent-exempt"  — never counted. STRICT, owner-ruled set (the flip on
//     cinatra-ai/cinatra#36): the generated manifest tree — the
//     generator-emitted `src/lib/generated/**` files as ONE class — plus the
//     documented data-contract-ID allowlist below. Nothing else: no facades,
//     no inventories, no dev-lists.

export const CLASSIFICATIONS = Object.freeze([
  "runtime-coupling",
  "mechanical",
  "permanent-exempt",
]);

// ---------------------------------------------------------------------------
// The STRICT permanent-exempt FILE set.
//
// ONLY the generator-emitted file list — the exact files
// `scripts/extensions/generate-extension-manifest.mjs` emits (the shared
// GENERATED_MANIFEST_FILES list; a test pins set == emitted set). Names there
// are generator output — the legitimate data-driven install list — not
// hand-coupling. The owner ruling on cinatra-ai/cinatra#36 made the
// generator-emitted set the ONE permanent-exempt class (the sibling generated
// maps are part of it, not a separate concession). The set lives under
// src/lib/generated/ (the former package-local emission
// packages/objects/src/generated/artifact-floor.ts was retired with
// @cinatra-ai/default-artifact, epic cinatra#1785 wave A5). Two integrity
// guards keep the exemption honest:
//   - it is an EXPLICIT file list, never a directory prefix — a hand-added
//     extra file under src/lib/generated/ (or any generated/ dir) is counted
//     (default class runtime-coupling → NEW key → hard fail);
//   - the listed files themselves are pinned to the generator's byte-exact
//     output by the FAIL-CLOSED `generate-extension-manifest.mjs --check` CI
//     step (a hand-edit of a generated file fails CI).
// Growing this set requires an owner ruling.
// ---------------------------------------------------------------------------
import { GENERATED_MANIFEST_FILES } from "../../extensions/generated-manifest-files.mjs";

export const PERMANENT_EXEMPT_FILES = new Set(GENERATED_MANIFEST_FILES);

// ---------------------------------------------------------------------------
// The documented data-contract-ID allowlist.
//
// A data-contract ID is a STABLE string identifier whose value happens to
// embed an extension package name (e.g. a persisted artifact-kind or skill
// contract key like "@scope/some-skills:some-capability"). When such an ID is
// a frozen serialization/compatibility contract — NOT runtime selection of an
// extension — it may be permanently exempted HERE, and only here.
//
// RULES (enforced by the gate + tests):
//   - every entry MUST carry a non-empty written justification explaining why
//     the ID is a stable contract rather than runtime selection;
//   - entries are added ONLY with an owner ruling;
//   - the set is self-policing: an entry whose ID no longer occurs anywhere in
//     scanned core source is STALE and hard-fails the gate until removed;
//   - the gate reports allowlisted occurrences SEPARATELY from counted ones,
//     so they are always distinguishable from baseline coupling.
//
// Shape: Map<contractId, justification>. Holds exactly ONE owner-ruled entry
// (the dashboard object-type contract id; see below) — the mechanism shipped
// ahead of its first entry and this is that first entry. NOTE
// (the zero-tolerance flip (#36)): the residual frozen-floor coupling (the nango facade deferral per
// the #35 ruling, the host's eager connector import surface) is NOT
// allowlisted here — none of it is a data-contract ID. It stays COUNTED in
// the pinned, shrink-only baselines.
//
// IDENTITY SURFACE (identity-surface ruling): this allowlist
// exempts only ids that embed a REAL extension package name (the shape +
// stale self-checks enforce that). The owner-sanctioned identity surfaces
// (env-var names, role-typed capability ids shared via a single SDK constant,
// the connector slug catalog, the `@cinatra-ai/<ns>:<id>` object-type ids) embed
// VIRTUAL scopes / object-type namespaces — NOT real extension dirs — so they
// are neither counted by this gate nor allowlist candidates; they are written
// down as the documented exempt class in scripts/audit/extension-coupling-gates.md
// ("Identity-surface exempt class") and the dangerous subset is guarded by the
// stateless scripts/audit/identity-coupling-gate.mjs. This Map stays minimal:
// an entry is minted ONLY when an owner ruling names a frozen contract id that
// embeds a real extension name.
//
// ENTRY 1 — "@cinatra-ai/dashboard-artifact:dashboard" (the DASHBOARD_OBJECT_TYPE
// constant in src/lib/dashboards/dashboard-artifact-twin-writer.ts). Owner
// ruling 2026-07-22 (groganz) — option A (allowlist the id) — recorded on
// PR https://github.com/cinatra-ai/cinatra/pull/1971 (#1894 B1b twin writer).
// Owner rationale, verbatim: "dashboards are the only artifact that depend on
// them being rendered by core. We might later take the rendering out of core,
// but not now." The id is the FROZEN persisted object-type key for the
// host-owned dashboard twin — a stable serialization/compatibility contract,
// not runtime selection of the extension (the shape check confirms it embeds
// the package name only behind the non-specifier `:` boundary; the stale check
// keeps it honest — it is removed the moment the constant stops occurring).
// ---------------------------------------------------------------------------
export const DATA_CONTRACT_ID_ALLOWLIST = new Map([
  [
    "@cinatra-ai/dashboard-artifact:dashboard",
    // Owner ruling (2026-07-22, groganz), PR #1971: frozen
    // persisted object-type contract id (DASHBOARD_OBJECT_TYPE) for the
    // host-owned dashboard twin — a stable serialization key, NOT runtime
    // selection of the extension. Rationale (verbatim): "dashboards are the
    // only artifact that depend on them being rendered by core. We might later
    // take the rendering out of core, but not now."
    "Owner ruling (2026-07-22, groganz), PR #1971: frozen persisted object-type contract id (DASHBOARD_OBJECT_TYPE) for the host-owned dashboard twin — a stable serialization key, not runtime selection of the extension. Rationale (verbatim): dashboards are the only artifact that depend on them being rendered by core. We might later take the rendering out of core, but not now.",
  ],
]);

// ---------------------------------------------------------------------------
// Mechanical reference sites (repo-relative path -> rationale).
//
// Facades / inventories / catalogs / dev-lists. These are COUNTED in the
// baselines (never exempt); the class only tells the cleanup work apart from
// runtime-coupling work. Default for any file NOT listed here is
// "runtime-coupling". The mechanical-cleanup phase (#35) drove every counted mechanical occurrence to zero;
// the entries below are kept as classification metadata (each names a real
// inventory/catalog site that would be mechanical if it ever referenced an
// extension again — and would hard-fail the zero-tolerance gates as a NEW
// key). The generated manifest derivatives that used to be listed here are
// now part of the permanent-exempt generated tree (owner ruling on #36).
// ---------------------------------------------------------------------------
export const MECHANICAL_FILES = new Map([
  [
    "packages/extensions/src/system-extension-inventory.ts",
    "hand-written inventory of locked system packages",
  ],
  [
    "src/lib/objects/surface-inventory.ts",
    "hand-authored objects-surface inventory (test/coverage bookkeeping, not runtime selection)",
  ],
  [
    "packages/connectors-catalog/src/descriptors.mjs",
    "hand-written connector descriptor catalog (pure data consumed by CLI + server registry)",
  ],
]);

/**
 * Classify a repo-relative file for the extension-coupling taxonomy.
 * `permanent-exempt` files are never counted by the gates; everything else is
 * counted and ratcheted regardless of class.
 */
export function classifyFile(rel) {
  if (PERMANENT_EXEMPT_FILES.has(rel)) return "permanent-exempt";
  if (MECHANICAL_FILES.has(rel)) return "mechanical";
  return "runtime-coupling";
}

/**
 * The ONLY characters a data-contract ID may contain. This alphabet is
 * deliberately identical to the boundary character class used by
 * `maskAllowlistedIds` in core-extension-instance-coupling-ban.mjs
 * (`[A-Za-z0-9_.:/@-]`): because every valid ID consists solely of boundary
 * characters, any longer ID that shares an allowlisted prefix must continue
 * with a boundary character — which the masking lookahead rejects — so
 * prefix-masking is impossible BY CONSTRUCTION. An ID containing a character
 * outside this alphabet (e.g. `#`, `+`, `~`, `?`) could be prefix-masked past
 * that character and is therefore rejected as a structural defect.
 */
export const DATA_CONTRACT_ID_ALPHABET_RE = /^[A-Za-z0-9_.:/@-]+$/;

/**
 * Structural defects in a data-contract-ID allowlist: every entry must carry a
 * non-empty written justification AND consist solely of the documented ID
 * alphabet (see DATA_CONTRACT_ID_ALPHABET_RE — required for boundary-exact
 * masking). Returns offending IDs (empty = OK).
 */
export function allowlistDefects(allowlist = DATA_CONTRACT_ID_ALLOWLIST) {
  const bad = [];
  for (const [id, justification] of allowlist) {
    if (typeof justification !== "string" || justification.trim().length === 0) {
      bad.push(id);
      continue;
    }
    if (typeof id !== "string" || !DATA_CONTRACT_ID_ALPHABET_RE.test(id)) bad.push(id);
  }
  return bad.sort();
}

/**
 * Self-policing staleness check: allowlist entries whose contract ID no longer
 * occurs anywhere in the scanned source must be REMOVED (a stale entry could
 * silently re-bless a later reintroduction). `allowlistHits` is the
 * Map<contractId, occurrenceCount> the scanner accumulated; entries with zero
 * hits are stale. Returns the stale IDs (empty = OK).
 */
export function staleAllowlistEntries(allowlistHits, allowlist = DATA_CONTRACT_ID_ALLOWLIST) {
  const stale = [];
  for (const id of allowlist.keys()) {
    if (!allowlistHits || !(allowlistHits.get(id) > 0)) stale.push(id);
  }
  return stale.sort();
}

/**
 * Per-class summary of a flat occurrence map whose keys start with the
 * repo-relative file path (`<file> :: ...`). Returns
 * `{ [class]: { files, keys, occurrences } }` for the countable classes.
 */
export function summarizeByClassification(occurrences) {
  const summary = {
    "runtime-coupling": { files: new Set(), keys: 0, occurrences: 0 },
    mechanical: { files: new Set(), keys: 0, occurrences: 0 },
  };
  for (const [key, count] of Object.entries(occurrences)) {
    const file = key.split(" :: ")[0];
    const cls = classifyFile(file);
    const bucket = summary[cls];
    if (!bucket) continue; // permanent-exempt files never appear in occurrence maps
    bucket.files.add(file);
    bucket.keys += 1;
    bucket.occurrences += count;
  }
  return Object.fromEntries(
    Object.entries(summary).map(([cls, { files, keys, occurrences }]) => [
      cls,
      { files: files.size, keys, occurrences },
    ]),
  );
}
