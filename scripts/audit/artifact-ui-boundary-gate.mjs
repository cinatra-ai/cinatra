#!/usr/bin/env node
/**
 * G1 — artifact-UI type-identity boundary gate (epic #1620, issue #1624 S6).
 *
 * Makes the corrected core/extension artifact-UI boundary CI-enforced and
 * permanent: core owns dispatch, shell, and the never-blank floor; an artifact
 * extension owns its type's VIEW. The violation predicate (normative, per the
 * issue) is "any production-core dependency, comparison, lookup, import, or data
 * transformation keyed by a CONCRETE extension-owned presentation identity for
 * type-specific presentation" — artifact/object type ids, representation forms,
 * HITL field-renderer binding ids, and chat renderable-view viewTypes. Core must
 * treat identity as an OPAQUE input to generic dispatch.
 *
 * This is an AST/type-aware gate (the `typescript` compiler API, not a regex)
 * plus a shrink-only versioned JSON baseline. Every current keying arm is
 * enumerated in the baseline with a disposition:
 *   - MIGRATE (owner+wave): the arm moves INTO its claimant extension in an
 *     S4/S7/S8/S9 wave; removing it (and its baseline entry) SHRINKS the gate.
 *   - DEFER (owner+wave): a known-deferred family (markdown / mermaid) that
 *     stays core-owned until its centrally-specified unblock condition; it
 *     carries the wave that will finally shrink it.
 *   - STAY (rationale, NO owner/wave): legitimately core-owned — an allowlist
 *     disposition, not a migration debt.
 *
 * Ratchet semantics (mirrors the sibling no-new-rot gates —
 * core-extension-import-ban, file-size-ratchet):
 *   - LIVE findings (this scan) must equal the PR baseline EXACTLY: a live arm
 *     absent from the baseline is UNKNOWN → FAIL (a net-new core→identity
 *     coupling); a baseline entry with no live arm is STALE → FAIL (a migrated /
 *     moved arm must drop its baseline entry in the same PR). Duplicate
 *     fingerprints FAIL. Each entry's fingerprint is DERIVED from its fields, so
 *     a hand-edited entry that no longer authenticates FAILS.
 *   - Base-ref ratchet (ARTIFACT_UI_BOUNDARY_BASE): the committed baseline's
 *     fingerprint set must be a SUBSET of the base branch's — it may only ever
 *     SHRINK. Adding ANY entry vs the base is the regenerate-to-pass bypass and
 *     FAILS (the shrink-only invariant). The introducing PR (no baseline at the
 *     base ref) carries no constraint. Fail-closed on an unresolvable ref.
 *   - Fixtures / tests / generated maps are excluded (generated maps are
 *     authenticated by their own `generate-extension-manifest --check` drift check).
 *
 * Node-builtins + `typescript` only. Offline. Exit 0 = clean, 1 = findings,
 * 2 = scanner error.
 *
 * Usage:
 *   node scripts/audit/artifact-ui-boundary-gate.mjs                 # gate (CI)
 *   node scripts/audit/artifact-ui-boundary-gate.mjs --report        # live arms vs baseline
 *   node scripts/audit/artifact-ui-boundary-gate.mjs --write-baseline # (re)seed — preserves dispositions, refreshes lines; a shrink-only ratchet down
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import tsDefault from "typescript";

import {
  detectFindingsInSource,
  fingerprintOf,
  DEFAULT_HITL_BINDING_IDS,
} from "./lib/artifact-presentation-identity.mjs";

const ts = tsDefault;
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const BASELINE_PATH = join(__dirname, "artifact-ui-boundary-gate.baseline.json");

/** The gate's own authoring guidance — named in every failure so the message is
 * first-class authoring help (AC-6). The S10 public authoring pack (#1627) adds
 * the wider narrative; this in-repo doc is the always-present anchor. */
export const DOCS_URL =
  "scripts/audit/artifact-ui-boundary-gate.md (authoring pack: docs.cinatra.ai/extensions/artifact-ui/boundary — S10 #1627)";

const VALID_DISPOSITIONS = new Set(["MIGRATE", "DEFER", "STAY"]);

// Scan roots: ALL core packages (no per-package exemption) — the host app and
// every workspace package's `src`. `packages/*/src` is globbed so a new core
// package is covered automatically.
function scanRoots() {
  const roots = [join(REPO_ROOT, "src")];
  const pkgsDir = join(REPO_ROOT, "packages");
  if (existsSync(pkgsDir)) {
    for (const pkg of readdirSync(pkgsDir)) {
      const src = join(pkgsDir, pkg, "src");
      if (existsSync(src) && statSync(src).isDirectory()) roots.push(src);
    }
  }
  return roots;
}

const SCANNABLE_RE = /\.(ts|tsx|mts|cts)$/;
const TEST_FILE_RE = /\.(test|spec)\.[tj]sx?$/;

/** Fixtures / tests / generated / build output are out of scope. Generated maps
 * carry identity but are authenticated by their manifest drift check, not this one. */
function isExcluded(rel) {
  return (
    /(^|\/)(__tests__|__fixtures__|__mocks__|node_modules|\.next|dist)(\/|$)/.test(rel) ||
    TEST_FILE_RE.test(rel) ||
    /\.d\.ts$/.test(rel) ||
    /\.stories\.[tj]sx?$/.test(rel) ||
    /(^|\/)generated(\/|$)/.test(rel) ||
    rel.startsWith("src/lib/generated/") ||
    rel.startsWith("src/app/design-fixtures/")
  );
}

function walk(dir, acc) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === ".next" || entry === "dist") continue;
      walk(full, acc);
    } else if (SCANNABLE_RE.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

/** Scan every in-scope core file and return all live findings (sorted). */
export function scanLiveFindings(bindingIds = DEFAULT_HITL_BINDING_IDS) {
  const findings = [];
  for (const root of scanRoots()) {
    for (const abs of walk(root, [])) {
      const rel = relative(REPO_ROOT, abs).split("\\").join("/");
      if (isExcluded(rel)) continue;
      const text = readFileSync(abs, "utf8");
      // Cheap pre-filter: only parse files that mention a keyable token shape.
      if (!/["'`]/.test(text)) continue;
      for (const f of detectFindingsInSource(rel, text, ts, bindingIds)) findings.push(f);
    }
  }
  return findings.sort(
    (a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.fingerprint.localeCompare(b.fingerprint),
  );
}

// ---------------------------------------------------------------------------
// Pure baseline helpers (unit-tested in __tests__/artifact-ui-boundary-gate.test.mjs)
// ---------------------------------------------------------------------------

/** The stable identity fields of a finding/entry (everything the fingerprint is
 * derived from). Used to re-derive + authenticate a baseline entry's fingerprint. */
export function coreFields(o) {
  return {
    path: o.path,
    identityClass: o.identityClass,
    canonicalIdentity: o.canonicalIdentity,
    keyingKind: o.keyingKind,
    occurrence: o.occurrence,
  };
}

/** Re-derive the fingerprint from an entry's own fields (authenticity check). */
export function deriveFingerprint(entry) {
  return fingerprintOf(coreFields(entry));
}

/**
 * Validate a baseline document's structure + per-entry invariants. Returns
 * sorted problem strings (empty = valid). Pure.
 */
export function validateBaseline(baseline) {
  const problems = [];
  const entries = baseline?.entries;
  if (!Array.isArray(entries)) return ["baseline has no `entries` array"];
  const seen = new Set();
  for (const e of entries) {
    const at = `${e?.path ?? "?"} [${e?.canonicalIdentity ?? "?"}]`;
    if (!e || typeof e !== "object") {
      problems.push(`malformed entry near ${at}`);
      continue;
    }
    if (!VALID_DISPOSITIONS.has(e.disposition)) {
      problems.push(`${at}: disposition must be one of MIGRATE|DEFER|STAY (got ${JSON.stringify(e.disposition)})`);
    }
    const hasOwnerWave = Boolean(e.owner) && Boolean(e.wave);
    if (e.disposition === "MIGRATE" || e.disposition === "DEFER") {
      if (!hasOwnerWave) problems.push(`${at}: ${e.disposition} entries require both owner and wave`);
    } else if (e.disposition === "STAY") {
      // STAY is an allowlist disposition — NO owner/wave, a rationale is required.
      if (e.owner || e.wave) problems.push(`${at}: STAY entries must NOT carry owner/wave (allowlist disposition)`);
      if (!e.rationale) problems.push(`${at}: STAY entries require a rationale`);
    }
    if (typeof e.fingerprint !== "string" || !e.fingerprint) {
      problems.push(`${at}: missing fingerprint`);
    } else {
      const derived = deriveFingerprint(e);
      if (derived !== e.fingerprint) {
        problems.push(`${at}: fingerprint ${e.fingerprint} does not authenticate (derived ${derived}) — do not hand-edit identity fields`);
      }
      if (seen.has(e.fingerprint)) problems.push(`${at}: duplicate fingerprint ${e.fingerprint}`);
      seen.add(e.fingerprint);
    }
  }
  return problems.sort();
}

/** Set-diff live findings vs baseline entries by fingerprint. Pure. */
export function diffFindings(liveFindings, baselineEntries) {
  const live = new Map(liveFindings.map((f) => [f.fingerprint, f]));
  const base = new Map(baselineEntries.map((e) => [e.fingerprint, e]));
  const unknown = [...live.values()].filter((f) => !base.has(f.fingerprint));
  const stale = [...base.values()].filter((e) => !live.has(e.fingerprint));
  return {
    unknown: unknown.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line),
    stale: stale.sort((a, b) => a.path.localeCompare(b.path)),
  };
}

/** Base-ref shrink-only: committed fingerprints that are NOT in the base
 * baseline (growth / regenerate-to-pass). Pure. */
export function baselineGrowth(baseEntries, committedEntries) {
  const base = new Set((baseEntries ?? []).map((e) => e.fingerprint));
  return committedEntries
    .filter((e) => !base.has(e.fingerprint))
    .map((e) => ({ fingerprint: e.fingerprint, path: e.path, canonicalIdentity: e.canonicalIdentity }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return null;
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
}

function describe(f) {
  return `${f.path}:${f.line}  ${f.canonicalIdentity} (${f.identityClass}, ${f.keyingKind})`;
}

function sortEntries(entries) {
  return [...entries].sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.canonicalIdentity.localeCompare(b.canonicalIdentity) ||
      a.keyingKind.localeCompare(b.keyingKind) ||
      a.occurrence - b.occurrence,
  );
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function writeBaseline(live, existing) {
  // Preserve dispositions/owner/wave/rationale for arms that already exist
  // (re-seed after a migration keeps annotations); NEW arms are written
  // UNCLASSIFIED so the gate fails until a human dispositions them.
  const byFp = new Map((existing?.entries ?? []).map((e) => [e.fingerprint, e]));
  const entries = sortEntries(
    live.map((f) => {
      const prev = byFp.get(f.fingerprint);
      const base = {
        fingerprint: f.fingerprint,
        ruleId: f.ruleId,
        path: f.path,
        canonicalIdentity: f.canonicalIdentity,
        identityClass: f.identityClass,
        keyingKind: f.keyingKind,
        occurrence: f.occurrence,
        line: f.line,
      };
      if (prev) {
        return {
          ...base,
          disposition: prev.disposition ?? "UNCLASSIFIED",
          ...(prev.owner ? { owner: prev.owner } : {}),
          ...(prev.wave ? { wave: prev.wave } : {}),
          ...(prev.rationale ? { rationale: prev.rationale } : {}),
        };
      }
      return { ...base, disposition: "UNCLASSIFIED", rationale: "TODO: disposition MIGRATE(owner,wave) | DEFER(owner,wave) | STAY(rationale)" };
    }),
  );
  const doc = {
    note:
      "G1 artifact-UI type-identity boundary baseline (epic #1620 / #1624 S6). SHRINK-ONLY: each entry is a current CORE site that keys a decision on a concrete extension-owned presentation identity. Every entry carries a disposition — MIGRATE (owner+wave; moves into the claimant extension in an S4/S7/S8/S9 wave), DEFER (owner+wave; a deferred family held core-side), or STAY (rationale; legitimately core-owned). LIVE findings must equal this set exactly; the committed set may only shrink vs the base branch. Regenerate with `node scripts/audit/artifact-ui-boundary-gate.mjs --write-baseline` (preserves dispositions). See scripts/audit/artifact-ui-boundary-gate.md.",
    version: 1,
    ruleId: "artifact-ui/presentation-identity-keying",
    entries,
  };
  writeFileSync(BASELINE_PATH, JSON.stringify(doc, null, 2) + "\n");
  return entries.length;
}

function main() {
  const args = process.argv.slice(2);
  let live;
  try {
    live = scanLiveFindings();
  } catch (err) {
    console.error(`[artifact-ui-boundary] scanner error: ${err?.stack ?? err}`);
    process.exit(2);
  }

  if (args.includes("--write-baseline")) {
    const n = writeBaseline(live, loadBaseline());
    console.log(`[artifact-ui-boundary] wrote baseline: ${n} arm(s). Disposition any UNCLASSIFIED entries, then re-run the gate.`);
    return;
  }

  const baseline = loadBaseline();
  if (!baseline) {
    console.error("[artifact-ui-boundary] FAIL — no baseline. Run with --write-baseline first (introducing PR), then disposition the arms.");
    process.exit(1);
  }
  const entries = baseline.entries ?? [];

  if (args.includes("--report")) {
    console.log(`[artifact-ui-boundary] ${live.length} live arm(s); ${entries.length} baseline entry/entries.`);
    const byDisp = {};
    for (const e of entries) byDisp[e.disposition] = (byDisp[e.disposition] ?? 0) + 1;
    console.log(`  dispositions: ${JSON.stringify(byDisp)}`);
    for (const f of live) console.log(`  ${describe(f)}  [${baseline.entries?.find((e) => e.fingerprint === f.fingerprint)?.disposition ?? "UNKNOWN"}]`);
    return;
  }

  // 1. Structural + disposition validity (unclassified / bad owner-wave / bad
  // fingerprint / duplicates).
  const problems = validateBaseline(baseline);
  if (problems.length) {
    console.error(`[artifact-ui-boundary] FAIL — baseline invalid (${problems.length}):`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error(`\nAuthoring guidance: ${DOCS_URL}`);
    process.exit(1);
  }

  // 2. Base-ref shrink-only ratchet.
  const baseRef = process.env.ARTIFACT_UI_BOUNDARY_BASE;
  if (baseRef) {
    if (baseRef.startsWith("-")) {
      console.error(`[artifact-ui-boundary] FAIL — ARTIFACT_UI_BOUNDARY_BASE="${baseRef}" is flag-like.`);
      process.exit(1);
    }
    let refResolves = false;
    try {
      execFileSync("git", ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`], { cwd: REPO_ROOT, stdio: ["ignore", "ignore", "ignore"] });
      refResolves = true;
    } catch {
      refResolves = false;
    }
    if (!refResolves) {
      console.error(`[artifact-ui-boundary] FAIL — ARTIFACT_UI_BOUNDARY_BASE="${baseRef}" did not resolve (shallow checkout / misconfig?). Failing closed — fetch the base ref (fetch-depth: 0).`);
      process.exit(1);
    }
    let baseText = null;
    try {
      baseText = execFileSync("git", ["show", `${baseRef}:scripts/audit/artifact-ui-boundary-gate.baseline.json`], { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      baseText = null; // ref resolves but file absent → introducing PR, no constraint
    }
    if (baseText) {
      const grew = baselineGrowth(JSON.parse(baseText).entries ?? [], entries);
      if (grew.length) {
        console.error(`[artifact-ui-boundary] FAIL — committed baseline GREW vs ${baseRef} (shrink-only: a new core→identity coupling cannot be baselined in, it must be authored inside the claimant extension):`);
        grew.forEach((g) => console.error(`  + ${g.path}  ${g.canonicalIdentity}  [${g.fingerprint}]`));
        console.error(`\nAuthoring guidance: ${DOCS_URL}`);
        process.exit(1);
      }
    }
  }

  // 3. Exact-match ratchet: live == baseline.
  const { unknown, stale } = diffFindings(live, entries);
  if (unknown.length === 0 && stale.length === 0) {
    console.log(`[artifact-ui-boundary] OK — ${live.length} core presentation-identity arm(s) all baselined (${entries.length} entry/entries; the boundary holds and only shrinks).`);
    process.exit(0);
  }
  if (unknown.length) {
    console.error(`[artifact-ui-boundary] FAIL — ${unknown.length} UNKNOWN core→identity keying arm(s) not in the baseline (core must treat identity as opaque — resolve through the dispatch seam / generated map, or move the view into the claimant extension):`);
    for (const f of unknown) console.error(`  + ${describe(f)}`);
  }
  if (stale.length) {
    console.error(`[artifact-ui-boundary] FAIL — ${stale.length} STALE baseline entry/entries with no live arm (a migrated/moved arm must drop its baseline entry in the SAME PR — the ratchet only shrinks):`);
    for (const e of stale) console.error(`  - ${e.path}  ${e.canonicalIdentity} (${e.identityClass}, ${e.keyingKind})  [${e.disposition}]`);
  }
  console.error(`\nAuthoring guidance: ${DOCS_URL}`);
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
