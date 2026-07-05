#!/usr/bin/env node
// Vendor-token core gate (cinatra#973 — epic cinatra-ai/cinatra#978).
//
// DOCTRINE (epic #978): core owns integration MECHANISM, never integration
// VENDOR CODE. The pinned-empty lexeme gates (core-extension-import-ban,
// core-extension-instance-coupling-ban) block core from importing/naming
// extension PACKAGES — but nothing failed a PR that added a new
// vendor-specific FILE, ROUTE SEGMENT, or IMPORT EDGE in core that names the
// vendor directly rather than its extension package (PR #969 proved the gap:
// a vendor-literal route mirroring a superseded twin passed every gate).
//
// WHAT THIS GATE SCANS. Core source under `src/` + `packages/` for the frozen
// VENDOR_TOKENS set, in exactly the three surfaces the gap analysis named:
//   - FILE PATHS (filenames AND directory/route segments — a Next.js route
//     dir like `src/app/api/webhooks/<vendor>/` is a path segment hit for
//     every file under it);
//   - IMPORT SPECIFIERS (static import/export-from, side-effect imports,
//     dynamic `import()`, `require()`) after lexical comment stripping.
// It deliberately does NOT scan arbitrary string/JSX/prompt literals — the
// instance-coupling gate owns extension-package lexemes there, and vendor
// WORDS in UI copy ("Publish to WordPress") are not code coupling.
//
// SHAPE. The same shrink-only no-new-rot ratchet the repo uses elsewhere
// (exdev-rename-gate, host-peer-value-import-ban): a committed baseline
// enumerates TODAY'S residual vendor floor (the epic #978 clusters — the
// vendor API-client layer, vendor-literal routes/pages, the blog vendor
// lifecycles, the wp-drupal wire-contract residue, dev-auto-setup blocks).
// The floor only ever SHRINKS:
//   - a NEW vendor-token occurrence (new key, or a grown count on an existing
//     key) fails CI immediately;
//   - a REMOVED occurrence makes the committed baseline STALE and fails CI
//     until `--write-baseline` ratchets the floor down (no silent headroom a
//     later PR could grow back into);
//   - `--write-baseline` REFUSES to write a baseline that grows any key vs
//     the committed one;
//   - the VENDOR_TOKEN_BASE monotonic guard refuses a committed baseline that
//     grew vs the base branch (no regenerate-to-pass), failing CLOSED on
//     flag-like or unresolvable refs.
// There is no data path (baseline, regenerate, env) that can raise the floor;
// only a reviewed change to this gate and its tests can alter the semantics.
//
// SANCTIONED SURFACES (enumerated in scripts/audit/extension-coupling-gates.md,
// per the epic #978 categories (a)-(e)) are excluded from the scan:
//   - the generator-emitted manifest tree (the EXPLICIT file list shared with
//     the coupling gates — never a directory prefix);
//   - `packages/sdk-extensions/` (frozen ABI type contracts, e.g. the
//     google-oauth-connection / nango-system wire contracts; its own gates
//     pin that surface);
//   - `packages/connectors-catalog/` (the ONE sanctioned hand-maintained
//     slug -> packageId identity catalog);
//   - `packages/agents/src/reserved-workspace-slugs.ts` (reserved-slug
//     identity data);
//   - tests/mocks and docs (`*.md`) — category (d), the surfaces that police
//     and document the boundary.
// The dev/required extension locks live at the repo root and `docker/`
// fixtures outside the scan roots, so they need no carve-out here.
//
// TOKEN SET. Frozen, grounded in the epic #978 residual clusters. NOT in the
// set (explicit non-goal, mirroring the epic): `nango` (the sanctioned
// credential-broker MECHANISM — the model the epic points core AT) and the
// LLM-provider names (`openai`/`anthropic`/`gemini` — the packages/llm
// provider layer plus its /configuration + /setup surfaces are core-owned
// model mechanism, not connector vendor code; extension-package coupling
// there is still policed by the pinned-empty lexeme gates). Growing or
// shrinking the token set is a reviewed change to this file and its tests.
//
// Usage:
//   node scripts/audit/vendor-token-core-gate.mjs                  # --check (default)
//   node scripts/audit/vendor-token-core-gate.mjs --write-baseline # ratchet the floor down
//   VENDOR_TOKEN_BASE=<ref> node ...   # also fail if the committed baseline GREW vs <ref>

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripComments } from "./lib/strip-comments.mjs";
import { PERMANENT_EXEMPT_FILES } from "./lib/extension-reference-classification.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const BASELINE_PATH = join(__dirname, "vendor-token-core-gate.baseline.json");

const SCAN_ROOTS = ["src/", "packages/"];

// The frozen vendor token set (see the TOKEN SET note above). Tokens shorter
// than SUBSTRING_MIN_LEN match path/specifier sub-tokens EXACTLY (so `wp`
// matches `wp-drupal-contract.ts` but never the `wp` inside `swap`); longer
// tokens also match as a SUBSTRING of a segment (so `wordpress` catches a
// squashed `wordpressapi.ts` evasion).
export const VENDOR_TOKENS = Object.freeze([
  "wordpress",
  "wp",
  "drupal",
  "linkedin",
  "github",
  "youtube",
  "resend",
  "google",
  "twenty",
  "apollo",
]);
const SUBSTRING_MIN_LEN = 5;

// Sanctioned-surface exclusions — enumerated (with rationale) in
// scripts/audit/extension-coupling-gates.md. Prefixes are directory scopes;
// files are exact.
export const EXCLUDED_PREFIXES = Object.freeze([
  "packages/sdk-extensions/",
  "packages/connectors-catalog/",
]);
export const EXCLUDED_FILES = new Set([
  "packages/agents/src/reserved-workspace-slugs.ts",
]);

// Sanctioned IMPORT SPECIFIERS (exact) / specifier prefixes. These are the
// enumerated third-party-package edges that are NOT vendor integration code:
//   - `next/font/google` — the Next.js framework font loader;
//   - `@google/genai` — the LLM-provider SDK consumed by the core-owned
//     packages/llm provider layer (the epic #978 LLM non-goal: LLM providers
//     are core mechanism, not connector vendor code);
//   - `@icons-pack/react-simple-icons/` — brand LOGOS (presentation identity
//     data, the same spirit as the identity-surface exempt class — never
//     logic).
// Everything else keeps counting: a vendor-named FILE added next to these
// imports still fails. Growing these sets is a reviewed change to this gate.
export const SANCTIONED_IMPORT_SPECIFIERS = new Set([
  "next/font/google",
  "@google/genai",
]);
export const SANCTIONED_IMPORT_SPECIFIER_PREFIXES = Object.freeze([
  "@icons-pack/react-simple-icons/",
]);

/** Is an import specifier a sanctioned third-party edge? Exported for tests. */
export function isSanctionedSpecifier(spec) {
  return (
    SANCTIONED_IMPORT_SPECIFIERS.has(spec) ||
    SANCTIONED_IMPORT_SPECIFIER_PREFIXES.some((p) => spec.startsWith(p))
  );
}

const TEST_PATH_RE =
  /(?:\.(?:test|spec)\.[mc]?[tj]sx?$|\/__tests__\/|\/__mocks__\/|\/tests?\/)/;
const CODE_FILE_RE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

// Static import / export-from, side-effect import, dynamic import(), require().
// Single/double-quoted specifiers only (a template-literal specifier is not a
// resolvable static edge).
const IMPORT_SPECIFIER_RE =
  /(?:\bfrom\s*|\bimport\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;

/** Is `rel` excluded as a sanctioned surface / test / doc? Exported for tests. */
export function isExemptFile(rel) {
  return (
    PERMANENT_EXEMPT_FILES.has(rel) ||
    EXCLUDED_FILES.has(rel) ||
    EXCLUDED_PREFIXES.some((p) => rel.startsWith(p)) ||
    TEST_PATH_RE.test(rel) ||
    rel.endsWith(".md")
  );
}

/**
 * Split a path segment / specifier segment into lowercase sub-tokens on
 * non-alphanumeric AND camelCase boundaries (`wordpressApi` -> ["wordpress",
 * "api"]). Exported for tests.
 */
export function subTokens(segment) {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Does one path/specifier segment carry the vendor token? Exported for tests. */
export function segmentMatchesToken(segment, token) {
  const lower = segment.toLowerCase();
  if (token.length >= SUBSTRING_MIN_LEN && lower.includes(token)) return true;
  return subTokens(segment).includes(token);
}

/** Vendor tokens present in a slash-separated path/specifier, with per-token segment counts. */
export function tokenHits(pathLike, tokens = VENDOR_TOKENS) {
  const segments = pathLike.split("/").filter(Boolean);
  const hits = new Map();
  for (const token of tokens) {
    let n = 0;
    for (const seg of segments) if (segmentMatchesToken(seg, token)) n += 1;
    if (n > 0) hits.set(token, n);
  }
  return hits;
}

/** Import/require/export-from specifiers in comment-stripped source. Exported for tests. */
export function extractImportSpecifiers(source) {
  const specs = [];
  IMPORT_SPECIFIER_RE.lastIndex = 0;
  let m;
  while ((m = IMPORT_SPECIFIER_RE.exec(source)) !== null) specs.push(m[1]);
  return specs;
}

function listFiles(repoRoot = REPO_ROOT) {
  const out = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...SCAN_ROOTS],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return out.split("\0").filter(Boolean);
}

/**
 * Scan core for vendor-token occurrences. Returns
 * { [`<file> :: path :: <token>` | `<file> :: import :: <specifier>`]: count }.
 * `files` is injectable for tests (repo-relative, forward-slash).
 */
export function scanVendorTokens(repoRoot = REPO_ROOT, files = listFiles(repoRoot)) {
  const occ = {};
  for (const rel of files) {
    if (isExemptFile(rel)) continue;
    // `git ls-files --cached` still lists a file DELETED from the worktree but
    // not yet committed — scan the worktree truth so a removal shows up as a
    // stale baseline entry immediately, not only after the commit.
    if (!existsSync(join(repoRoot, rel))) continue;

    // Surface 1+2: filename + directory/route segments.
    for (const [token, count] of tokenHits(rel)) {
      occ[`${rel} :: path :: ${token}`] = count;
    }

    // Surface 3: import specifiers (code files only).
    if (!CODE_FILE_RE.test(rel)) continue;
    let source;
    try {
      source = readFileSync(join(repoRoot, rel), "utf8");
    } catch {
      continue;
    }
    const specCounts = new Map();
    for (const spec of extractImportSpecifiers(stripComments(source))) {
      if (isSanctionedSpecifier(spec)) continue;
      if (tokenHits(spec).size === 0) continue;
      specCounts.set(spec, (specCounts.get(spec) ?? 0) + 1);
    }
    for (const [spec, count] of specCounts) {
      occ[`${rel} :: import :: ${spec}`] = count;
    }
  }
  return occ;
}

function sortKeys(o) {
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
}

/** Keys whose CURRENT count exceeds the baseline count, or are entirely new. */
export function diffGrown(baseline, current) {
  const grown = [];
  for (const [k, c] of Object.entries(current)) {
    const base = baseline[k] ?? 0;
    if (c > base) grown.push(`${k} (${base} -> ${c})`);
  }
  return grown.sort();
}

/** Baseline keys whose CURRENT count fell below the baseline count (stale floor). */
export function diffShrunk(baseline, current) {
  const shrunk = [];
  for (const [k, c] of Object.entries(baseline)) {
    const cur = current[k] ?? 0;
    if (cur < c) shrunk.push(`${k} (${c} -> ${cur})`);
  }
  return shrunk.sort();
}

function writeBaselineFile(occurrences) {
  const total = Object.values(occurrences).reduce((a, b) => a + b, 0);
  writeFileSync(
    BASELINE_PATH,
    JSON.stringify(
      {
        note:
          "Vendor-token core-gate residual floor (cinatra#973 — epic cinatra-ai/cinatra#978: " +
          "core owns integration MECHANISM, never vendor CODE). Each key is a CURRENT tolerated " +
          "vendor-token occurrence in core (src/ + packages/) — a vendor-named file/route " +
          "path segment or a vendor-named import specifier — outside the sanctioned surfaces " +
          "enumerated in scripts/audit/extension-coupling-gates.md. SHRINK-ONLY: regenerate with " +
          "`node scripts/audit/vendor-token-core-gate.mjs --write-baseline` (it refuses growth); " +
          "the floor ratchets down as the epic waves evict each cluster into its owning extension.",
        occurrences: sortKeys(occurrences),
      },
      null,
      2,
    ) + "\n",
  );
  return total;
}

function main() {
  const args = process.argv.slice(2);
  const current = scanVendorTokens();
  const totalOcc = Object.values(current).reduce((a, b) => a + b, 0);
  const totalFiles = new Set(Object.keys(current).map((k) => k.split(" :: ")[0])).size;

  if (args.includes("--write-baseline")) {
    // SHRINK-ONLY: refuse to write a baseline that grows any key vs the
    // committed one. Move the vendor-specific code into its owning extension
    // (connector repos materialize under extensions/<scope>/<name> in dev)
    // instead of re-baselining it.
    if (existsSync(BASELINE_PATH)) {
      const committed = JSON.parse(readFileSync(BASELINE_PATH, "utf8")).occurrences ?? {};
      const grown = diffGrown(committed, current);
      if (grown.length) {
        console.error(
          `[vendor-token-core-gate] FAIL — refusing to write a GROWN baseline (the floor is shrink-only; ` +
            `evict the vendor-specific code into its owning extension instead of re-baselining it — epic cinatra-ai/cinatra#978):`,
        );
        grown.forEach((e) => console.error("  + " + e));
        process.exit(1);
      }
    }
    const total = writeBaselineFile(current);
    console.log(
      `[vendor-token-core-gate] baseline written — ${total} occurrence(s) across ${totalFiles} file(s).`,
    );
    return;
  }

  if (!existsSync(BASELINE_PATH)) {
    console.error("[vendor-token-core-gate] FAIL — no baseline. Run with --write-baseline first.");
    process.exit(1);
  }
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")).occurrences ?? {};

  // Monotonic guard: the committed baseline must be a subset of the base
  // branch's (it may only shrink — no regenerate-to-pass). Fails CLOSED on
  // flag-like or unresolvable refs.
  const baseRef = process.env.VENDOR_TOKEN_BASE;
  if (baseRef) {
    if (baseRef.startsWith("-")) {
      console.error(`[vendor-token-core-gate] FAIL — VENDOR_TOKEN_BASE="${baseRef}" is flag-like.`);
      process.exit(1);
    }
    let refResolves = false;
    try {
      execFileSync("git", ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`], {
        cwd: REPO_ROOT,
        stdio: ["ignore", "ignore", "ignore"],
      });
      refResolves = true;
    } catch {
      refResolves = false;
    }
    if (!refResolves) {
      console.error(
        `[vendor-token-core-gate] FAIL — VENDOR_TOKEN_BASE="${baseRef}" did not resolve ` +
          `(shallow checkout / misconfig?). Failing closed. Ensure the base ref is fetched (fetch-depth: 0).`,
      );
      process.exit(1);
    }
    let baseText = null;
    try {
      baseText = execFileSync(
        "git",
        ["show", `${baseRef}:scripts/audit/vendor-token-core-gate.baseline.json`],
        { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
    } catch {
      baseText = null; // ref resolves but file absent → introducing PR, no constraint
    }
    if (baseText) {
      const grew = diffGrown(JSON.parse(baseText).occurrences ?? {}, baseline);
      if (grew.length) {
        console.error(
          `[vendor-token-core-gate] FAIL — committed baseline GREW vs ${baseRef} ` +
            `(shrink-only: the residual floor only ratchets down — no regenerate can raise it):`,
        );
        grew.forEach((e) => console.error("  + " + e));
        process.exit(1);
      }
    }
  }

  const grown = diffGrown(baseline, current);
  if (grown.length) {
    console.error(
      `[vendor-token-core-gate] FAIL — ${grown.length} NEW vendor-token occurrence(s) in core:`,
    );
    grown.forEach((e) => console.error("  + " + e));
    console.error("");
    console.error(
      "Core owns integration MECHANISM, never vendor CODE (epic cinatra-ai/cinatra#978).\n" +
        "Do not add vendor-specific files, route segments, or import edges under src/ or\n" +
        "packages/: move the code into its owning extension (connector repos materialize\n" +
        "as editable workspace source under extensions/<scope>/<name> in dev — same\n" +
        "checkout, same `pnpm dev`), and reach it through the manifest/registry/capability\n" +
        "mechanism (the nango-system model: register at activation, resolve lazily,\n" +
        "fail-loud degradation). A genuinely sanctioned identity surface must be\n" +
        "enumerated in scripts/audit/extension-coupling-gates.md via a reviewed change to\n" +
        "this gate — the committed baseline cannot grow.",
    );
    process.exit(1);
  }

  const stale = diffShrunk(baseline, current);
  if (stale.length) {
    console.error(
      `[vendor-token-core-gate] FAIL — ${stale.length} STALE baseline entr${stale.length === 1 ? "y" : "ies"} ` +
        `(the floor shrank — ratchet it down so the headroom cannot be re-spent):\n` +
        `  node scripts/audit/vendor-token-core-gate.mjs --write-baseline`,
    );
    stale.forEach((e) => console.error("  - " + e));
    process.exit(1);
  }

  console.log(
    `[vendor-token-core-gate] OK — ${totalOcc} tolerated vendor-token occurrence(s) across ${totalFiles} file(s); 0 new ` +
      `(shrink-only residual floor — epic cinatra-ai/cinatra#978; sanctioned surfaces enumerated in scripts/audit/extension-coupling-gates.md).`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
