#!/usr/bin/env node
// Self-rendering extensions BORDER GATE (cinatra-ai/cinatra#3471, epic #2926 —
// decision 407 of 2026-09-13).
//
// DECISION 407: "connectors render the setup page themselves, artifacts render
// the artifact view themselves", and "the host shares its primitives with
// extension bundles at run time like React does — the only way to keep the
// border between core and self-rendering extensions clean".
//
// WHY A GATE. A self-rendering extension draws its own screens inside the
// product, so it needs the product's design primitives. Today fifteen connector
// packages (plus four more connectors and one artifact package the vendoring
// manifest never listed) hold BYTE COPIES of those primitives under
// `src/components/ui/`: a change to a primitive in the product forces a release
// of every copying package. The run-time-shared road (slice 2 of #3471)
// replaces the copies. Until then this gate pins the border from both sides:
//
//   (a) NO NEW COPY — a file under `src/components/ui/` in a kind:connector or
//       kind:artifact package whose (package, path) pair is not in the
//       committed baseline fails immediately;
//   (b) SHRINK-ONLY — a baseline pair whose file no longer exists fails until
//       the baseline is ratcheted DOWN (`--write-baseline`, which refuses to
//       write a baseline that GROWS), so the recorded floor can never quietly
//       leave headroom a later change grows back into;
//   (c) NO DIRECT REACH — a source file of such a package that imports the
//       product's `@/components/ui/*`, `@/lib/utils` or `src/components/ui`
//       directly fails. A RELATIVE import of the package's own baselined copy
//       is the case (a) baseline, not this one.
//
// kind:agent packages are OUT OF SCOPE here — the agent border has its own gate
// (cinatra-ai/cinatra#3470).
//
// The baseline is the ONLY record of the remaining copies: the vendoring
// manifest in scripts/extensions/vendor-extension-primitives.mjs no longer
// carries connector or artifact packages (decision 407 A), so a primitive
// change no longer forces a release of the copying packages.
//
// Usage:
//   node scripts/extensions/self-rendering-extensions-border-gate.mjs                  # --check (default)
//   node scripts/extensions/self-rendering-extensions-border-gate.mjs --write-baseline # ratchet the floor down
//
// Test injection (synthetic trees, the shape scripts/extensions/inventory.mjs
// gives with CINATRA_INVENTORY_EXT_ROOT):
//   SELF_RENDERING_BORDER_EXT_ROOT=<dir holding <scope>/<package>/>
//   SELF_RENDERING_BORDER_BASELINE=<baseline json>

import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripComments } from "../audit/lib/strip-comments.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

const EXT_ROOT =
  process.env.SELF_RENDERING_BORDER_EXT_ROOT || join(REPO_ROOT, "extensions");
const BASELINE_PATH =
  process.env.SELF_RENDERING_BORDER_BASELINE ||
  join(__dirname, "self-rendering-extensions-border.baseline.json");

/** The extension scope the synced tree materializes under. */
const SCOPE_DIR = "cinatra-ai";

/** The kinds that render their own screens inside the product (decision 407). */
export const SELF_RENDERING_KINDS = new Set(["connector", "artifact"]);

/** The primitive-copy directory, relative to a package root. */
export const PRIMITIVE_DIR = "src/components/ui";

const CODE_FILE_RE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
// Never part of a package's own source tree, at any depth.
const ALWAYS_SKIP_DIRS = new Set(["node_modules", ".git"]);
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
  ".git",
]);

// Static import / export-from, side-effect import, dynamic import(), require().
// Run over COMMENT-STRIPPED source, so prose that merely names a host path (the
// four such comments in the synced tree today) is never read as an edge.
const IMPORT_SPECIFIER_RE =
  /(?:\bfrom\s*|\bimport\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["'`]([^"'`]+)["'`]/g;

// The product's own primitive/utility trees, matched on PATH COMPONENTS: a
// sibling directory such as `src/components/ui-extra` is not the banned one.
const PRODUCT_TREE_RE = /\/src\/(?:components\/ui|lib\/utils)(?:\/|$)/;

const toPosix = (p) => p.split(sep).join("/");

/** Import/require/export-from specifiers in raw source (comments stripped first). */
export function extractImportSpecifiers(rawText) {
  const text = stripComments(rawText);
  const specs = [];
  IMPORT_SPECIFIER_RE.lastIndex = 0;
  let m;
  while ((m = IMPORT_SPECIFIER_RE.exec(text)) !== null) specs.push(m[1]);
  return specs;
}

/**
 * The product's `@/` aliases the border forbids a self-rendering package to
 * import. An explicit code extension is stripped first: this tree sets
 * `allowImportingTsExtensions`, so `@/lib/utils.ts` is the same import as
 * `@/lib/utils` and must not slip past the ban.
 */
export function isForbiddenHostAlias(spec) {
  const bare = spec.replace(CODE_FILE_RE, "");
  return (
    bare === "@/lib/utils" ||
    bare.startsWith("@/lib/utils/") ||
    bare === "@/components/ui" ||
    bare.startsWith("@/components/ui/")
  );
}

/**
 * A relative specifier that leaves the package and lands in the product's own
 * `src/components/ui` / `src/lib/utils`. A relative import of the package's OWN
 * copy stays inside the package and is the baseline case, not this one.
 */
export function escapesIntoProductTree(spec, fileAbs, packageDir) {
  if (!spec.startsWith(".")) return false;
  const resolved = resolve(dirname(fileAbs), spec);
  const escapesPackage = relative(packageDir, resolved).startsWith("..");
  if (!escapesPackage) return false;
  return PRODUCT_TREE_RE.test(toPosix(resolved));
}

/** The banned specifier, or null. Exported so the forms are directly testable. */
export function forbiddenImport(spec, fileAbs, packageDir) {
  if (isForbiddenHostAlias(spec)) return spec;
  if (spec === PRIMITIVE_DIR || spec.startsWith(`${PRIMITIVE_DIR}/`)) return spec;
  if (escapesIntoProductTree(spec, fileAbs, packageDir)) return spec;
  return null;
}

/**
 * Every file under `dir`, recursively, as package-relative posix paths.
 *
 * `skipDirs` is per-walk: the SOURCE walk skips build output (it is not source),
 * while the PRIMITIVE-COPY walk skips only the two directories that are never
 * part of a package's own tree — a copy parked in `src/components/ui/build/`
 * is still a copy and must be recorded.
 *
 * A symlinked entry is resolved with statSync (a Dirent for a symlink is
 * neither isFile() nor isDirectory(), so it would otherwise vanish from both
 * the copy scan and the coupling scan).
 */
function walkFiles(dir, packageDir, skipDirs = SKIP_DIRS, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (skipDirs.has(entry.name)) continue;
    const abs = join(dir, entry.name);
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (!isDir && !isFile) {
      try {
        const st = statSync(abs);
        isDir = st.isDirectory();
        isFile = st.isFile();
      } catch {
        continue;
      }
    }
    if (isDir) walkFiles(abs, packageDir, skipDirs, out);
    else if (isFile) out.push(toPosix(relative(packageDir, abs)));
  }
  return out;
}

/** The synced kind:connector / kind:artifact packages under the scope dir. */
export function listSelfRenderingPackages(extRoot = EXT_ROOT) {
  const scopeDir = join(extRoot, SCOPE_DIR);
  if (!existsSync(scopeDir)) return [];
  const packages = [];
  for (const name of readdirSync(scopeDir).sort()) {
    const dir = join(scopeDir, name);
    const manifestPath = join(dir, "package.json");
    if (!existsSync(manifestPath)) continue;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      continue;
    }
    const kind = manifest?.cinatra?.kind ?? null;
    if (!SELF_RENDERING_KINDS.has(kind)) continue;
    packages.push({ name, dir, kind });
  }
  return packages;
}

/** { "<package>": ["src/components/ui/<file>", ...] } for every copy on disk. */
export function scanPrimitiveCopies(extRoot = EXT_ROOT) {
  const copies = {};
  for (const pkg of listSelfRenderingPackages(extRoot)) {
    const uiDir = join(pkg.dir, PRIMITIVE_DIR);
    if (!existsSync(uiDir)) continue;
    const files = walkFiles(uiDir, pkg.dir, ALWAYS_SKIP_DIRS).sort();
    if (files.length > 0) copies[pkg.name] = files;
  }
  return copies;
}

/** Direct reaches into the product tree: [{ package, file, specifier }]. */
export function scanDirectCoupling(extRoot = EXT_ROOT) {
  const findings = [];
  for (const pkg of listSelfRenderingPackages(extRoot)) {
    for (const rel of walkFiles(pkg.dir, pkg.dir)) {
      if (!CODE_FILE_RE.test(rel)) continue;
      const abs = join(pkg.dir, rel);
      let source;
      try {
        source = readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      const seen = new Set();
      for (const spec of extractImportSpecifiers(source)) {
        const banned = forbiddenImport(spec, abs, pkg.dir);
        if (!banned || seen.has(banned)) continue;
        seen.add(banned);
        findings.push({ package: pkg.name, file: rel, specifier: banned });
      }
    }
  }
  return findings.sort((a, b) =>
    `${a.package}/${a.file}/${a.specifier}` < `${b.package}/${b.file}/${b.specifier}` ? -1 : 1,
  );
}

/** Flatten { pkg: [paths] } to a sorted set of "<pkg> :: <path>" pairs. */
export function pairsOf(copies) {
  const pairs = [];
  for (const [pkg, paths] of Object.entries(copies ?? {})) {
    for (const path of paths) pairs.push(`${pkg} :: ${path}`);
  }
  return pairs.sort();
}

/** Pairs on disk that the committed baseline does not record. */
export function diffUnlisted(baseline, current) {
  const known = new Set(pairsOf(baseline));
  return pairsOf(current).filter((p) => !known.has(p));
}

/** Baseline pairs whose file is gone (the floor may only SHRINK). */
export function diffStale(baseline, current) {
  const live = new Set(pairsOf(current));
  return pairsOf(baseline).filter((p) => !live.has(p));
}

function sortCopies(copies) {
  return Object.fromEntries(
    Object.keys(copies)
      .sort()
      .map((k) => [k, [...copies[k]].sort()]),
  );
}

function readBaseline() {
  if (!existsSync(BASELINE_PATH)) return null;
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8")).copies ?? {};
}

function writeBaselineFile(copies) {
  const sorted = sortCopies(copies);
  writeFileSync(
    BASELINE_PATH,
    JSON.stringify(
      {
        note:
          "Self-rendering extensions border floor (cinatra-ai/cinatra#3471, epic #2926 — " +
          "decision 407 of 2026-09-13: connectors render the setup page themselves, artifacts " +
          "render the artifact view themselves, and the host shares its primitives with " +
          "extension bundles at run time). Each entry is a design-primitive BYTE COPY a synced " +
          "kind:connector / kind:artifact package still carries under src/components/ui/. " +
          "SHRINK-ONLY: a new copy fails the gate immediately; a removed one makes this file " +
          "stale until it is ratcheted down with " +
          "`node scripts/extensions/self-rendering-extensions-border-gate.mjs --write-baseline` " +
          "(which refuses to write a baseline that grows). The floor empties as packages move " +
          "to the run-time-shared primitives (slice 2 of #3471).",
        copies: sorted,
      },
      null,
      2,
    ) + "\n",
  );
  return pairsOf(sorted).length;
}

const HEADER =
  "[self-rendering-extensions-border-gate] FAIL — the border between core and self-rendering " +
  "extensions (decision 407 of 2026-09-13, cinatra-ai/cinatra#3471):";

function main() {
  const args = process.argv.slice(2);
  const current = scanPrimitiveCopies();

  if (args.includes("--write-baseline")) {
    const committed = readBaseline();
    if (committed) {
      const grown = diffUnlisted(committed, current);
      if (grown.length > 0) {
        console.error(
          `${HEADER}\n  refusing to write a GROWN baseline — the floor is shrink-only. Draw the ` +
            "screen from the primitives the product shares at run time instead of copying them:",
        );
        grown.forEach((p) => console.error("  + " + p));
        process.exit(1);
      }
    }
    const total = writeBaselineFile(current);
    console.log(
      `[self-rendering-extensions-border-gate] baseline written — ${total} primitive copy/copies ` +
        `across ${Object.keys(current).length} package(s).`,
    );
    return;
  }

  const baseline = readBaseline();
  if (baseline === null) {
    console.error(
      `${HEADER}\n  the baseline ${toPosix(relative(REPO_ROOT, BASELINE_PATH))} is missing; ` +
        "write it with --write-baseline.",
    );
    process.exit(1);
  }

  const problems = [];

  const unlisted = diffUnlisted(baseline, current);
  if (unlisted.length > 0) {
    problems.push(
      "  (a) UNLISTED primitive copy — a kind:connector / kind:artifact package carries a file " +
        "under src/components/ui/ that the baseline does not record. A self-rendering extension " +
        "draws its own screen from the primitives the host shares at run time; it does not take a " +
        "new copy:",
    );
    unlisted.forEach((p) => problems.push("  + " + p));
  }

  const stale = diffStale(baseline, current);
  if (stale.length > 0) {
    problems.push(
      "  (b) STALE baseline entry — the recorded copy is gone. The floor is shrink-only: ratchet " +
        "it down with `node scripts/extensions/self-rendering-extensions-border-gate.mjs " +
        "--write-baseline` so the headroom cannot be grown back into:",
    );
    stale.forEach((p) => problems.push("  - " + p));
  }

  const coupling = scanDirectCoupling();
  if (coupling.length > 0) {
    problems.push(
      "  (c) DIRECT REACH into the product — a kind:connector / kind:artifact source file imports " +
        "the product's @/components/ui/*, @/lib/utils or src/components/ui. That is the coupling " +
        "the border forbids (a relative import of the package's own copy is the baseline case):",
    );
    coupling.forEach((f) =>
      problems.push(`  ! ${f.package} :: ${f.file} imports ${f.specifier}`),
    );
  }

  if (problems.length > 0) {
    console.error(HEADER);
    problems.forEach((line) => console.error(line));
    process.exit(1);
  }

  const total = pairsOf(current).length;
  console.log(
    `[self-rendering-extensions-border-gate] OK — ${total} baselined primitive copy/copies across ` +
      `${Object.keys(current).length} package(s); no unlisted copy, no stale entry, no direct reach.`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
