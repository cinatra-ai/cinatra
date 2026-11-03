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
// product, so it needs the product's design primitives. Connector and artifact
// packages held BYTE COPIES of those primitives under src/components/ui/ until
// the run-time-shared road of #3471 replaced them; the last copies
// (email-artifacts) went with #3471, and the floor is empty. The gate now
// refuses any copy outright and refuses any declared package it cannot read.
// It pins the border from both sides:
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
//       is the case (a) baseline, not this one;
//   (d) FLOOR COMPARED WITH THE BASE (cinatra#3832) — the committed baseline
//       may not record a copy the base branch's baseline does not: a pull
//       request cannot add its own copy to the floor. The base comes from
//       SELF_RENDERING_BORDER_BASE when a workflow sets it, else from the pull
//       request's base branch; a base that cannot be read fails closed (the
//       shared guard, scripts/audit/lib/floor-base-guard.mjs);
//   (e) NOTHING UNREAD — the census reads every package the root package.json
//       declares (cinatra.devExtensions). A declared package whose directory,
//       package.json, name or known cinatra.kind cannot be read, an empty or
//       unreadable declared set, a missing scope directory, and a file or
//       directory of a self-rendering package that cannot be read are each
//       REFUSED by name. An undeclared directory under the scope that holds a
//       package.json is read the same way: a listing, a package.json or a kind
//       it cannot read is REFUSED by its path. With an empty floor there is no
//       baselined pair left to go stale, so without (e) a tree the gate never
//       read would pass.
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
//   SELF_RENDERING_BORDER_BASE=origin/main node ...   # compare the floor with that revision (default: the pull request's base branch)
//
// Test injection (synthetic trees, the shape scripts/extensions/inventory.mjs
// gives with CINATRA_INVENTORY_EXT_ROOT):
//   SELF_RENDERING_BORDER_EXT_ROOT=<dir holding <scope>/<package>/>
//   SELF_RENDERING_BORDER_BASELINE=<baseline json>
// The declared set is read from the package.json BESIDE the extension tree
// (the repository root for the real tree). It is never set on its own, so no
// variable can narrow the declaration universe independently of the tree.

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
import { compareFloorWithBase, reportFloorGuard } from "../audit/lib/floor-base-guard.mjs";
import { readDevExtensionsConfig } from "../../packages/cli/src/cinatra-dev-extensions.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

const EXT_ROOT =
  process.env.SELF_RENDERING_BORDER_EXT_ROOT || join(REPO_ROOT, "extensions");
const BASELINE_PATH =
  process.env.SELF_RENDERING_BORDER_BASELINE ||
  join(__dirname, "self-rendering-extensions-border.baseline.json");

/** The directory whose package.json declares the set of an extension tree: the one beside it. */
const declaredRootOf = (extRoot) => dirname(resolve(extRoot));

/** Every file-system call of the census goes through this seam (tests inject one). */
const DEFAULT_IO = Object.freeze({ readdirSync, statSync, readFileSync, existsSync });

/** The prefix of every refusal line: a census that could not read what it must. */
export const REFUSED = "[self-rendering-border] REFUSED:";

/** The committed floor, repo-relative (the file the base branch is read at). */
export const FLOOR_FILE = "scripts/extensions/self-rendering-extensions-border.baseline.json";

/** The gate's own base variable (a git revision), when a workflow sets one. */
export const FLOOR_BASE_VAR = "SELF_RENDERING_BORDER_BASE";

/** The extension scope the synced tree materializes under. */
const SCOPE_DIR = "cinatra-ai";

/** The kinds that render their own screens inside the product (decision 407). */
export const SELF_RENDERING_KINDS = new Set(["connector", "artifact"]);

/**
 * Every kind an extension may declare: EXTENSION_KINDS of
 * packages/extensions/src/canonical-types.ts (a test pins the two lists
 * equal). A declared package with any other kind, a case variant or a typo
 * included, is refused, never read as out of scope.
 */
export const KNOWN_KINDS = new Set(["agent", "connector", "artifact", "skill", "workflow"]);

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

/** The error code of a failed file-system call, for a refusal line. */
const codeOf = (err) => err?.code ?? err?.message ?? String(err);

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
 *
 * Nothing is skipped silently: a directory that cannot be listed and an entry
 * that cannot be resolved (a dangling symlink included) are handed to
 * `unreadable(relPath, err)`, which the census turns into a refusal.
 */
function walkFiles(dir, packageDir, { skipDirs = SKIP_DIRS, io = DEFAULT_IO, unreadable }, out = []) {
  let entries;
  try {
    entries = io.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    unreadable(toPosix(relative(packageDir, dir)) || ".", err);
    return out;
  }
  for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (skipDirs.has(entry.name)) continue;
    const abs = join(dir, entry.name);
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (!isDir && !isFile) {
      try {
        const st = io.statSync(abs);
        isDir = st.isDirectory();
        isFile = st.isFile();
      } catch (err) {
        unreadable(toPosix(relative(packageDir, abs)), err);
        continue;
      }
    }
    if (isDir) walkFiles(abs, packageDir, { skipDirs, io, unreadable }, out);
    else if (isFile) out.push(toPosix(relative(packageDir, abs)));
  }
  return out;
}

// A declared name the census can map to a directory: @cinatra-ai/<segment>,
// with no "/" or ".." in the segment (the shape the dev-extension sync takes).
const DECLARED_NAME_RE = /^@cinatra-ai\/([a-z0-9][a-z0-9._-]*)$/;

const isPlainObject = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/**
 * The declared extension set (root package.json cinatra.devExtensions) as
 * [{ name, dir }], or null after a refusal. The declared set is the authority
 * of the census: an empty or unreadable one would make the census vacuous.
 */
function readDeclaredSet(declaredRoot, io, refusals) {
  const config = readDevExtensionsConfig(declaredRoot, io.readFileSync);
  const names = isPlainObject(config) ? Object.keys(config).filter((k) => k.startsWith("@cinatra-ai/")) : [];
  if (names.length === 0) {
    refusals.push(
      `${REFUSED} the declared extension set (package.json cinatra.devExtensions) is empty or unreadable — ` +
        "an empty census would pass vacuously",
    );
    return null;
  }
  for (const name of Object.keys(config)) {
    if (!name.startsWith("@cinatra-ai/")) {
      refusals.push(`${REFUSED} ${name} is declared outside the @cinatra-ai scope this census reads`);
    }
  }
  const declared = [];
  for (const name of names.sort()) {
    const m = DECLARED_NAME_RE.exec(name);
    if (!m) {
      refusals.push(`${REFUSED} ${name} is not a package name this census can map to a directory`);
      continue;
    }
    declared.push({ name, dir: m[1] });
  }
  return declared;
}

/**
 * Read one package.json. Returns { manifest } or { error } — never a silent
 * skip: the caller decides whether an unreadable manifest is a refusal.
 */
function readManifest(manifestPath, io) {
  try {
    const manifest = JSON.parse(io.readFileSync(manifestPath, "utf8"));
    if (!isPlainObject(manifest)) return { error: "not a JSON object" };
    return { manifest };
  } catch (err) {
    return { error: err?.code ?? err?.message ?? String(err) };
  }
}

/**
 * The census: every declared package is read or refused by name, every
 * self-rendering package is walked for copies and for direct reaches, and
 * every file-system call goes through `io`. Undeclared directories under the
 * scope are still scanned, and read with the same allow-list. The declared
 * set defaults to the one beside `extRoot`; only an in-process caller passes
 * `declaredRoot`. Returns `{ packages, copies, coupling, refusals }`.
 */
export function scanBorder({ extRoot = EXT_ROOT, declaredRoot = declaredRootOf(extRoot), io = DEFAULT_IO } = {}) {
  const refusals = [];
  const declared = readDeclaredSet(declaredRoot, io, refusals);
  const scopeDir = join(extRoot, SCOPE_DIR);

  let onDisk = [];
  let scopeReadable = false;
  if (!io.existsSync(scopeDir)) {
    refusals.push(
      `${REFUSED} the extension scope directory ${scopeDir} is missing, so no declared package can be read`,
    );
  } else {
    try {
      onDisk = [...io.readdirSync(scopeDir)].map(String).sort();
      scopeReadable = true;
    } catch (err) {
      refusals.push(`${REFUSED} ${scopeDir}: unreadable (${codeOf(err)})`);
    }
  }

  const packages = [];
  const declaredDirs = new Set();
  for (const { name, dir } of declared ?? []) {
    declaredDirs.add(dir);
    if (!scopeReadable) continue;
    const pkgDir = join(scopeDir, dir);
    const manifestPath = join(pkgDir, "package.json");
    if (!io.existsSync(manifestPath)) {
      refusals.push(`${REFUSED} ${name} is declared but extensions/${SCOPE_DIR}/${dir}/package.json is missing`);
      continue;
    }
    const read = readManifest(manifestPath, io);
    if (read.error) {
      refusals.push(`${REFUSED} ${name}: package.json cannot be read (${read.error})`);
      continue;
    }
    if (read.manifest.name !== name) {
      refusals.push(
        `${REFUSED} ${name} is declared but extensions/${SCOPE_DIR}/${dir}/package.json names ` +
          `${JSON.stringify(read.manifest.name ?? null)}`,
      );
      continue;
    }
    const kind = isPlainObject(read.manifest.cinatra) ? read.manifest.cinatra.kind : undefined;
    if (typeof kind !== "string") {
      refusals.push(`${REFUSED} ${name} has no cinatra.kind`);
      continue;
    }
    if (!KNOWN_KINDS.has(kind)) {
      refusals.push(`${REFUSED} ${name} has an unknown cinatra.kind ${JSON.stringify(kind)}`);
      continue;
    }
    if (SELF_RENDERING_KINDS.has(kind)) packages.push({ name: dir, dir: pkgDir, kind });
  }

  // Undeclared directories under the scope (a stale clone-back leftover, a
  // synthetic tree) are still scanned, as before the declared set existed, and
  // read with the same allow-list as a declared package: only an entry whose
  // listing holds no package.json (a plain file included) is not a package.
  // A listing, a package.json or a kind the census cannot read is refused by
  // the directory's path, never skipped.
  for (const dir of onDisk) {
    if (declaredDirs.has(dir)) continue;
    const pkgDir = join(scopeDir, dir);
    const where = `extensions/${SCOPE_DIR}/${dir}`;
    let entries;
    try {
      entries = [...io.readdirSync(pkgDir)].map(String);
    } catch (err) {
      if (err?.code === "ENOTDIR") continue;
      refusals.push(`${REFUSED} ${where} is not declared and cannot be listed (${codeOf(err)})`);
      continue;
    }
    if (!entries.includes("package.json")) continue;
    const read = readManifest(join(pkgDir, "package.json"), io);
    if (read.error) {
      refusals.push(`${REFUSED} ${where} is not declared and its package.json cannot be read (${read.error})`);
      continue;
    }
    const kind = isPlainObject(read.manifest.cinatra) ? read.manifest.cinatra.kind : undefined;
    if (typeof kind !== "string") {
      refusals.push(`${REFUSED} ${where} is not declared and has no cinatra.kind`);
      continue;
    }
    if (!KNOWN_KINDS.has(kind)) {
      refusals.push(`${REFUSED} ${where} is not declared and has an unknown cinatra.kind ${JSON.stringify(kind)}`);
      continue;
    }
    if (SELF_RENDERING_KINDS.has(kind)) packages.push({ name: dir, dir: pkgDir, kind });
  }
  packages.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const unreadableIn = (pkg) => (rel, err) =>
    refusals.push(`${REFUSED} ${pkg.name}/${rel}: unreadable (${codeOf(err)})`);

  // The map is built from [name, files] entries: a directory name is the
  // tree's, not the census's, so it may be `__proto__`. A plain assignment of
  // that key would call the prototype setter and drop the copy from
  // Object.keys, pairsOf and the written floor; Object.fromEntries defines
  // every name as an own key of a plain object.
  const copyEntries = [];
  for (const pkg of packages) {
    const uiDir = join(pkg.dir, PRIMITIVE_DIR);
    if (!io.existsSync(uiDir)) continue;
    const files = walkFiles(uiDir, pkg.dir, { skipDirs: ALWAYS_SKIP_DIRS, io, unreadable: unreadableIn(pkg) }).sort();
    if (files.length > 0) copyEntries.push([pkg.name, files]);
  }
  const copies = Object.fromEntries(copyEntries);

  const coupling = [];
  for (const pkg of packages) {
    for (const rel of walkFiles(pkg.dir, pkg.dir, { io, unreadable: unreadableIn(pkg) })) {
      if (!CODE_FILE_RE.test(rel)) continue;
      const abs = join(pkg.dir, rel);
      let source;
      try {
        source = io.readFileSync(abs, "utf8");
      } catch (err) {
        unreadableIn(pkg)(rel, err);
        continue;
      }
      const seen = new Set();
      for (const spec of extractImportSpecifiers(source)) {
        const banned = forbiddenImport(spec, abs, pkg.dir);
        if (!banned || seen.has(banned)) continue;
        seen.add(banned);
        coupling.push({ package: pkg.name, file: rel, specifier: banned });
      }
    }
  }
  coupling.sort((a, b) =>
    `${a.package}/${a.file}/${a.specifier}` < `${b.package}/${b.file}/${b.specifier}` ? -1 : 1,
  );

  return { packages, copies, coupling, refusals: [...new Set(refusals)] };
}

/** One census for the exported single-purpose reads: a refusal throws, it never reads as clean. */
function censusOrThrow(extRoot, io) {
  const census = scanBorder({ extRoot, io });
  if (census.refusals.length > 0) throw new Error(census.refusals.join("\n"));
  return census;
}

/** The synced kind:connector / kind:artifact packages under the scope dir. */
export function listSelfRenderingPackages(extRoot = EXT_ROOT, io = DEFAULT_IO) {
  return censusOrThrow(extRoot, io).packages;
}

/** { "<package>": ["src/components/ui/<file>", ...] } for every copy on disk. */
export function scanPrimitiveCopies(extRoot = EXT_ROOT, io = DEFAULT_IO) {
  return censusOrThrow(extRoot, io).copies;
}

/** Direct reaches into the product tree: [{ package, file, specifier }]. */
export function scanDirectCoupling(extRoot = EXT_ROOT, io = DEFAULT_IO) {
  return censusOrThrow(extRoot, io).coupling;
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

/**
 * Parse a floor file's text into its `copies` map, or throw a refusal. The
 * ONE shape read of the baseline, of the head floor and of the base floor: a
 * missing `copies`, one that is not a plain object (an array or null
 * included), or a value that is not an array of strings is refused, never
 * read as an empty floor. `copies: {}` is valid.
 */
export function parseFloor(text, file) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new Error(`${REFUSED} ${file}: not readable JSON (${err?.message ?? err})`);
  }
  const copies = isPlainObject(doc) ? doc.copies : undefined;
  const ok =
    isPlainObject(copies) &&
    Object.values(copies).every((paths) => Array.isArray(paths) && paths.every((p) => typeof p === "string"));
  if (!ok) throw new Error(`${REFUSED} ${file}: "copies" is missing or not an object of string arrays`);
  return copies;
}

/**
 * The floor base guard (cinatra#3832): growth is a (package, path) pair the
 * base branch's baseline does not record. `headFloor` defaults to the floor
 * file in `repoRoot`; the gate passes the floor it actually reads. A head
 * floor that cannot be read fails closed with the refusal as its line.
 */
export function checkFloorAgainstBase({ repoRoot = REPO_ROOT, env = process.env, headFloor } = {}) {
  let head = headFloor;
  if (head === undefined) {
    try {
      head = parseFloor(readFileSync(join(repoRoot, FLOOR_FILE), "utf8"), FLOOR_FILE);
    } catch (err) {
      return { status: "unreadable", ok: false, lines: [err?.message ?? String(err)] };
    }
  }
  return compareFloorWithBase({
    gate: "self-rendering-extensions-border-gate",
    envVar: FLOOR_BASE_VAR,
    floorPath: FLOOR_FILE,
    headFloor: head,
    parse: (text) => parseFloor(text, `${FLOOR_FILE} (base)`),
    grown: (base, current) => diffUnlisted(base, current),
    repoRoot,
    env,
  });
}

/** The committed baseline's copies, null when the file is missing; a bad shape throws a refusal. */
function readBaseline() {
  if (!existsSync(BASELINE_PATH)) return null;
  return parseFloor(readFileSync(BASELINE_PATH, "utf8"), toPosix(relative(REPO_ROOT, BASELINE_PATH)));
}

function writeBaselineFile(copies) {
  const sorted = sortCopies(copies);
  writeFileSync(
    BASELINE_PATH,
    JSON.stringify(
      {
        note:
          "Self-rendering extensions border floor (cinatra-ai/cinatra#3471, epic #2926 — " +
          "the border decision of 2026-09-13: connectors render the setup page themselves, artifacts " +
          "render the artifact view themselves, and the host shares its primitives with " +
          "extension bundles at run time). The floor emptied with #3471 and stays empty: a " +
          "design-primitive copy under src/components/ui/ of a synced kind:connector / " +
          "kind:artifact package fails the gate. " +
          "SHRINK-ONLY: a new copy fails the gate immediately; a removed one makes this file " +
          "stale until it is ratcheted down with " +
          "`node scripts/extensions/self-rendering-extensions-border-gate.mjs --write-baseline` " +
          "(which refuses to write a baseline that grows).",
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

/** Print every refusal line, then exit 1. */
function refuse(lines) {
  lines.forEach((line) => console.error(line));
  process.exit(1);
}

/** The committed baseline, or exit 1 on a bad shape (a missing file is null). */
function readBaselineOrRefuse() {
  try {
    return readBaseline();
  } catch (err) {
    return refuse([err?.message ?? String(err)]);
  }
}

function main() {
  const args = process.argv.slice(2);

  if (args.includes("--write-baseline")) {
    // The census runs first; any refusal writes nothing.
    const census = scanBorder();
    if (census.refusals.length > 0) refuse(census.refusals);
    const current = census.copies;
    const committed = readBaselineOrRefuse();
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

  // Order: the baseline read, then the floor guard, then the census.
  const baseline = readBaselineOrRefuse();
  if (baseline === null) {
    console.error(
      `${HEADER}\n  the baseline ${toPosix(relative(REPO_ROOT, BASELINE_PATH))} is missing; ` +
        "write it with --write-baseline.",
    );
    process.exit(1);
  }

  if (!reportFloorGuard(checkFloorAgainstBase({ headFloor: baseline }))) process.exit(1);

  const census = scanBorder();
  const current = census.copies;
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

  const coupling = census.coupling;
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

  if (census.refusals.length > 0 || problems.length > 0) {
    console.error(HEADER);
    census.refusals.forEach((line) => console.error(line));
    problems.forEach((line) => console.error(line));
    process.exit(1);
  }

  const total = pairsOf(current).length;
  console.log(
    `[self-rendering-extensions-border-gate] OK — ${total} baselined primitive copy/copies across ` +
      `${Object.keys(current).length} package(s) of ${census.packages.length} self-rendering ` +
      "package(s) read; no unlisted copy, no stale entry, no direct reach, nothing unread.",
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
