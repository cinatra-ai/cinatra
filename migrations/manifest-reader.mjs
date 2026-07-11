// Shared deterministic union reader for the core-migration ledger (#1335).
//
// The ledger a consumer sees is the UNION of two authoring forms:
//   1. the legacy positional array in `migrations/manifest.json` (`migrations`
//      key) — FROZEN shipped history; new entries are rejected by the schema
//      migration gate, and
//   2. per-migration fragment files `migrations/manifest.d/core__NNNN_<slug>.json`
//      — one file per migration, carrying exactly the legacy entry shape
//      (seq / file / summary / destructive / tables), so two concurrently open
//      migration PRs add DIFFERENT files and never conflict on shared text.
//
// EVERY consumer of the ledger (the schema-migration gate, the upgrade-proof
// ledger cross-check, the per-migration contract tests) computes it through
// this module so all of them agree byte-for-byte. The union contract:
//
//   - concatenate legacy entries + fragments and VALIDATE — never dedupe: a
//     seq present in both the legacy array and a fragment (or in two
//     fragments) is a hard error;
//   - per fragment: filename matches core__NNNN_<slug>.json; entry.seq equals
//     the filename's NNNN; entry.file is `core/<stem>.mjs` where <stem> is the
//     fragment filename stem — fragment stem == module stem (fragments always
//     describe runner modules; the two legacy psql-artifact entries, seq
//     0001/0002, stay in the frozen legacy array permanently);
//   - `seq` and `file` are unique over the whole union; entries are returned
//     sorted by numeric seq (source path is used in error reporting only);
//   - malformed or UNRECOGNIZED files under manifest.d/ are errors, not skips.
//
// Plain runtime ESM, node builtins only: this file rides the `migrations/`
// directory into the production image (the upgrade-proof cross-check imports
// it inside the candidate image) — no TS, no repo imports outside migrations/.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const LEGACY_MANIFEST_FILE = "manifest.json";
export const FRAGMENT_DIR = "manifest.d";
/** Fragment filename contract. Capture 1 = NNNN, capture 2 = slug. */
export const FRAGMENT_FILE_RE = /^core__(\d{4})_([a-z0-9][a-z0-9-]*)\.json$/;

const SEQ_RE = /^\d{4}$/;
/** The exact ledger entry shape (both authoring forms). */
const ENTRY_KEYS = new Set(["seq", "file", "summary", "destructive", "tables"]);

/**
 * Validate one ledger entry's shape (shared by both authoring forms).
 * @param {unknown} entry
 * @param {string} source label for error messages
 * @returns {string[]} problems (empty = valid)
 */
export function validateEntryShape(entry, source) {
  const errors = [];
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return [`${source}: entry must be a single JSON object`];
  }
  const e = /** @type {Record<string, unknown>} */ (entry);
  if (typeof e.seq !== "string" || !SEQ_RE.test(e.seq)) {
    errors.push(`${source}: "seq" must be a 4-digit string (got ${JSON.stringify(e.seq)})`);
  }
  if (typeof e.file !== "string" || e.file.length === 0) {
    errors.push(`${source}: "file" must be a non-empty string`);
  }
  if (typeof e.summary !== "string" || e.summary.trim().length === 0) {
    errors.push(`${source}: "summary" must be a non-empty string`);
  }
  if (typeof e.destructive !== "boolean") {
    errors.push(`${source}: "destructive" must be a boolean`);
  }
  if (!Array.isArray(e.tables) || e.tables.some((t) => typeof t !== "string")) {
    errors.push(`${source}: "tables" must be an array of strings`);
  }
  // Exactly today's entry shape — unknown keys are rejected, not carried
  // (fail-closed: a typo'd key would otherwise silently drop a field).
  for (const k of Object.keys(e)) {
    if (!ENTRY_KEYS.has(k)) errors.push(`${source}: unknown key ${JSON.stringify(k)} (allowed: ${[...ENTRY_KEYS].join(", ")})`);
  }
  return errors;
}

/**
 * Parse + validate ONE fragment file.
 * @param {string} name fragment basename (e.g. "core__0027_add-widgets.json")
 * @param {string} raw file content
 * @returns {{entry: Record<string, unknown>|null, errors: string[]}}
 */
export function parseFragment(name, raw) {
  const source = `${FRAGMENT_DIR}/${name}`;
  const m = name.match(FRAGMENT_FILE_RE);
  if (!m) {
    return {
      entry: null,
      errors: [
        `${source}: unrecognized file under ${FRAGMENT_DIR}/ — every file there must be a per-migration fragment named core__NNNN_<slug>.json (see migrations/README.md)`,
      ],
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { entry: null, errors: [`${source}: not parseable JSON (${err?.message ?? err})`] };
  }
  const errors = validateEntryShape(parsed, source);
  if (errors.length > 0) return { entry: null, errors };
  const stem = name.slice(0, -".json".length);
  if (parsed.seq !== m[1]) {
    errors.push(`${source}: "seq" ${JSON.stringify(parsed.seq)} does not match the filename's sequence number ${m[1]}`);
  }
  const expectedFile = `core/${stem}.mjs`;
  if (parsed.file !== expectedFile) {
    errors.push(
      `${source}: "file" must be ${JSON.stringify(expectedFile)} — the fragment filename stem and the runner-module filename stem are the same by contract (got ${JSON.stringify(parsed.file)})`,
    );
  }
  return { entry: errors.length === 0 ? parsed : null, errors };
}

/**
 * Compute the deterministic ledger union from already-loaded inputs. Pure —
 * the schema-migration gate feeds it base-revision content (git) and
 * post-change content (applied diffs); `readManifestUnion` feeds it the
 * working tree.
 *
 * @param {{legacyEntries: unknown, fragments: Array<{name: string, raw: string}>}} input
 *   `fragments` carries every file found under manifest.d/ (order-independent).
 * @returns {{entries: Array<Record<string, unknown>>, errors: string[]}}
 *   `entries` sorted by numeric seq. `errors` non-empty ⇒ the union is invalid
 *   and MUST NOT be trusted by the consumer.
 */
export function buildManifestUnion({ legacyEntries, fragments }) {
  const errors = [];
  /** @type {Array<{entry: Record<string, unknown>, source: string}>} */
  const collected = [];

  if (!Array.isArray(legacyEntries)) {
    errors.push(`${LEGACY_MANIFEST_FILE}: "migrations" must be a JSON array`);
  } else {
    legacyEntries.forEach((entry, i) => {
      const source = `${LEGACY_MANIFEST_FILE} entry ${i + 1}`;
      const shape = validateEntryShape(entry, source);
      if (shape.length > 0) errors.push(...shape);
      else collected.push({ entry, source });
    });
  }

  // Deterministic fragment order (readdir order is platform-dependent).
  for (const { name, raw } of [...fragments].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const { entry, errors: fragErrors } = parseFragment(name, raw);
    if (fragErrors.length > 0) errors.push(...fragErrors);
    if (entry) collected.push({ entry, source: `${FRAGMENT_DIR}/${name}` });
  }

  // Never dedupe: seq and file are unique over the WHOLE union.
  const bySeq = new Map();
  const byFile = new Map();
  for (const { entry, source } of collected) {
    const prevSeq = bySeq.get(entry.seq);
    if (prevSeq) errors.push(`duplicate seq ${entry.seq}: ${prevSeq} and ${source} both claim it (the ledger never dedupes — renumber one of them)`);
    else bySeq.set(entry.seq, source);
    const prevFile = byFile.get(entry.file);
    if (prevFile) errors.push(`duplicate file ${JSON.stringify(entry.file)}: ${prevFile} and ${source} both declare it`);
    else byFile.set(entry.file, source);
  }

  const entries = collected
    .map(({ entry }) => entry)
    .sort((a, b) => Number(a.seq) - Number(b.seq));
  return { entries, errors };
}

/**
 * Read the ledger union from a migrations/ directory on disk (working tree or
 * production image). A missing manifest.d/ directory means "no fragments yet"
 * — it is created by the first fragment-authoring PR.
 *
 * @param {string} migrationsDir absolute or cwd-relative path to migrations/
 * @returns {{entries: Array<Record<string, unknown>>, errors: string[]}}
 */
export function readManifestUnion(migrationsDir) {
  let legacyEntries = null;
  const errors = [];
  const manifestPath = join(migrationsDir, LEGACY_MANIFEST_FILE);
  try {
    legacyEntries = JSON.parse(readFileSync(manifestPath, "utf8"))?.migrations ?? null;
  } catch (err) {
    errors.push(`${LEGACY_MANIFEST_FILE}: unreadable or not parseable JSON (${err?.message ?? err})`);
  }

  /** @type {Array<{name: string, raw: string}>} */
  const fragments = [];
  const fragmentDir = join(migrationsDir, FRAGMENT_DIR);
  if (existsSync(fragmentDir)) {
    for (const dirent of readdirSync(fragmentDir, { withFileTypes: true })) {
      if (!dirent.isFile()) {
        errors.push(`${FRAGMENT_DIR}/${dirent.name}: not a regular file — ${FRAGMENT_DIR}/ holds per-migration fragment files only`);
        continue;
      }
      fragments.push({ name: dirent.name, raw: readFileSync(join(fragmentDir, dirent.name), "utf8") });
    }
  }

  if (errors.length > 0 && legacyEntries === null) {
    // Still surface fragment-level problems alongside the manifest failure.
    const { errors: unionErrors } = buildManifestUnion({ legacyEntries: [], fragments });
    return { entries: [], errors: [...errors, ...unionErrors] };
  }
  const union = buildManifestUnion({ legacyEntries, fragments });
  return { entries: union.entries, errors: [...errors, ...union.errors] };
}
