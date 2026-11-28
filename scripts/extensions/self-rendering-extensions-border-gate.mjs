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
//       read would pass;
//   (f) NO REVIEW CONTROL IN A DISPLAY (cinatra#3080 item 7) — a source file of
//       a kind:artifact package (its tests excepted) whose code, comments
//       stripped and string and JSX text kept, holds the word Regenerate,
//       Approve or Reject (any case, whole word) or the address of the host's
//       review decision route (`lifecycle-views/decide`) fails. A display draws
//       the work only: the review floor (Comment, Regenerate, Continue) is the
//       review card's, and a display has no host code to call it with (the
//       extension import ban), so the one way left is drawing such a control
//       and posting to that route from the display's own code. A file is a test
//       when it sits under a `test`, `tests` or `__tests__` directory or is
//       named `*.test.*` / `*.spec.*`: a pack's own tests assert the absence of
//       these words and so must name them;
//   (g) NO SHARING PANELS (cinatra#3968) — the application supplies the Sharing
//       tab of a connection; a package never draws it. Unlike (a)-(f), this rule
//       reads every package of every known kind (agent, connector, artifact,
//       skill, workflow), with the same walk and the same fail-closed reads. A
//       source file of such a package (its tests excepted, as in (f)) that
//       imports the SDK's sharing panels, `@cinatra-ai/sdk-ui/connector-sharing-panels`,
//       fails unless the floor's `sharingPanelImports` list records its
//       "<package> :: <file>" pair. That list started empty, is SHRINK-ONLY like
//       the copies (a recorded pair whose import is gone is stale) and is
//       compared with the base by the same guard as (d). The SDK's exports map
//       lists that subpath exactly and has no pattern, so no other specifier
//       (a deeper path, an explicit extension) resolves to the module; only the
//       exact specifier is matched. The package root `@cinatra-ai/sdk-ui` does
//       not re-export the panels. A RELATIVE specifier that lands on the panel
//       source `sdk-ui/src/connector-sharing-panels` outside the package (the
//       workspace's packages/sdk-ui) or under a node_modules folder is the same
//       import and is matched too. Imports are read with the TypeScript parser:
//       `import … from`, a side-effect `import`, `import type`, `export … from`,
//       `import x = require(…)`, `import(…)` and `require(…)` with a literal
//       argument (any quote form, a template without substitution included),
//       and the `import(…)` type. A type-only import counts, as it does in the
//       extension import ban's census: it couples the package to the module and
//       breaks when the export goes. A source file that does not parse is
//       REFUSED by name. LIMITS: a specifier built at run time (a template with
//       a substitution, a variable, string escapes) or a re-export through a
//       module name of the package's own (a bundler alias) is deliberate
//       disguise and is not followed. A pack that reaches the panels through a
//       host `@/` module is refused by the extension import ban and by the
//       conformance check's `imports.core-internal`; a pack that copies the
//       panel component into its own source is not this rule's subject.
//
// kind:agent, kind:skill and kind:workflow packages are OUT OF SCOPE of (a)-(f)
// — the agent border has its own gate (cinatra-ai/cinatra#3470); only (g) reads
// them.
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
import ts from "typescript";

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
/** (f) The words and the address a display may not draw or call. */
export const REVIEW_CONTROL_RE = /\b(?:regenerate|approve|reject)\b|lifecycle-views\/decide/gi;

/** (f) A package-relative path that is one of the package's own tests. */
export function isPackageTestFile(rel) {
  const posix = rel.split(sep).join("/");
  return /(?:^|\/)(?:tests?|__tests__)\//.test(posix) || /\.(?:test|spec)\.[a-z]+$/i.test(posix);
}

/** (f) The review words and addresses found in one display source file, lower-cased and sorted. */
export function reviewControlWords(rawText) {
  const found = stripComments(rawText).match(REVIEW_CONTROL_RE) ?? [];
  return [...new Set(found.map((w) => w.toLowerCase()))].sort();
}

/** (g) The SDK module that draws the Sharing tab: the application's, never a package's. */
export const SHARING_PANELS_SPECIFIER = "@cinatra-ai/sdk-ui/connector-sharing-panels";

/** (g) The floor key of the recorded "<package> :: <file>" pairs. */
export const SHARING_FLOOR_KEY = "sharingPanelImports";

/** The parser's script kind for a code file's extension. */
function scriptKindOf(rel) {
  if (/\.tsx$/.test(rel)) return ts.ScriptKind.TSX;
  if (/\.jsx$/.test(rel)) return ts.ScriptKind.JSX;
  if (/\.[mc]?ts$/.test(rel)) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

/** A string literal or a template without a substitution: a specifier written out. */
const isLiteralSpecifier = (node) => node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));

/**
 * (g) Every module specifier a code file loads, read with the TypeScript
 * parser: import and export-from declarations (type-only included),
 * `import x = require(…)`, `import(…)` and `require(…)` calls with a literal
 * argument, and the `import(…)` type. Comments and strings are never read as
 * an import. Throws when the file does not parse.
 */
export function moduleSpecifiersOf(rel, text) {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, scriptKindOf(rel));
  const diag = sf.parseDiagnostics ?? [];
  if (diag.length > 0) {
    const d = diag[0];
    throw new Error(`does not parse (${ts.flattenDiagnosticMessageText(d.messageText, " ")} at offset ${d.start})`);
  }
  const specs = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && isLiteralSpecifier(node.moduleSpecifier)) {
      specs.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      isLiteralSpecifier(node.moduleReference.expression)
    ) {
      specs.push(node.moduleReference.expression.text);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
      isLiteralSpecifier(node.arguments[0])
    ) {
      specs.push(node.arguments[0].text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && isLiteralSpecifier(node.argument.literal)) {
      specs.push(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return specs;
}

// (g) The panel source file, with any code extension stripped, as a resolved path's tail.
const PANEL_SOURCE_TAIL = "/sdk-ui/src/connector-sharing-panels";

/**
 * (g) True when a specifier of the file at `fileAbs` loads the SDK's sharing
 * panels: the exact package specifier, or a relative path to the panel source
 * that leaves the package or passes through a node_modules folder.
 */
export function loadsSharingPanels(spec, fileAbs, packageDir) {
  if (spec === SHARING_PANELS_SPECIFIER) return true;
  if (!spec.startsWith(".")) return false;
  const resolved = toPosix(resolve(dirname(fileAbs), spec)).replace(CODE_FILE_RE, "");
  if (!resolved.endsWith(PANEL_SOURCE_TAIL)) return false;
  return relative(packageDir, resolve(dirname(fileAbs), spec)).startsWith("..") || resolved.includes("/node_modules/");
}

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
  const allPackages = [];
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
    allPackages.push({ name: dir, dir: pkgDir, kind });
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
    allPackages.push({ name: dir, dir: pkgDir, kind });
    if (SELF_RENDERING_KINDS.has(kind)) packages.push({ name: dir, dir: pkgDir, kind });
  }
  allPackages.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
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
  const reviewControls = [];
  const sharingPanelImports = [];
  let sharingFilesRead = 0;
  // One walk per package of every kind: (a)-(f) judge only the self-rendering
  // ones, (g) judges all of them.
  for (const pkg of allPackages) {
    const selfRendering = SELF_RENDERING_KINDS.has(pkg.kind);
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
      for (const spec of selfRendering ? extractImportSpecifiers(source) : []) {
        const banned = forbiddenImport(spec, abs, pkg.dir);
        if (!banned || seen.has(banned)) continue;
        seen.add(banned);
        coupling.push({ package: pkg.name, file: rel, specifier: banned });
      }
      if (selfRendering && pkg.kind === "artifact" && !isPackageTestFile(rel)) {
        const words = reviewControlWords(source);
        if (words.length > 0) reviewControls.push({ package: pkg.name, file: rel, words });
      }
      if (!isPackageTestFile(rel)) {
        sharingFilesRead += 1;
        let specs;
        try {
          specs = moduleSpecifiersOf(rel, source);
        } catch (err) {
          refusals.push(`${REFUSED} ${pkg.name}/${rel}: ${err?.message ?? err}`);
          continue;
        }
        if (specs.some((spec) => loadsSharingPanels(spec, abs, pkg.dir))) sharingPanelImports.push(`${pkg.name} :: ${rel}`);
      }
    }
  }
  sharingPanelImports.sort();
  reviewControls.sort((a, b) => (`${a.package}/${a.file}` < `${b.package}/${b.file}` ? -1 : 1));
  coupling.sort((a, b) =>
    `${a.package}/${a.file}/${a.specifier}` < `${b.package}/${b.file}/${b.specifier}` ? -1 : 1,
  );

  return {
    packages,
    copies,
    coupling,
    reviewControls,
    sharingPanelImports,
    sharingScope: { packages: allPackages.length, files: sharingFilesRead },
    refusals: [...new Set(refusals)],
  };
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
 * (g) Parse a floor file's text into its recorded sharing-panel imports, or
 * throw a refusal. A floor without the key records none (the floor before
 * cinatra#3968, and the strictest reading); a key that is not an array of
 * strings is refused, never read as empty.
 */
export function parseSharingFloor(text, file) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new Error(`${REFUSED} ${file}: not readable JSON (${err?.message ?? err})`);
  }
  if (!isPlainObject(doc) || !Object.hasOwn(doc, SHARING_FLOOR_KEY)) return [];
  const list = doc[SHARING_FLOOR_KEY];
  if (!Array.isArray(list) || !list.every((p) => typeof p === "string")) {
    throw new Error(`${REFUSED} ${file}: "${SHARING_FLOOR_KEY}" is not an array of strings`);
  }
  return [...list].sort();
}

/** (g) Recorded pairs a newer list holds that an older one does not. */
const sharingGrowth = (older, newer) => {
  const known = new Set(older);
  return newer.filter((p) => !known.has(p));
};

/**
 * The floor base guard (cinatra#3832): growth is a (package, path) pair the
 * base branch's baseline does not record. `headFloor` defaults to the floor
 * file in `repoRoot`; the gate passes the floor it actually reads. A head
 * floor that cannot be read fails closed with the refusal as its line.
 */
export function checkFloorAgainstBase({ repoRoot = REPO_ROOT, env = process.env, headFloor, headSharing } = {}) {
  let copies = headFloor;
  let sharing = headSharing;
  if (copies === undefined || sharing === undefined) {
    try {
      const text = readFileSync(join(repoRoot, FLOOR_FILE), "utf8");
      if (copies === undefined) copies = parseFloor(text, FLOOR_FILE);
      if (sharing === undefined) sharing = parseSharingFloor(text, FLOOR_FILE);
    } catch (err) {
      return { status: "unreadable", ok: false, lines: [err?.message ?? String(err)] };
    }
  }
  return compareFloorWithBase({
    gate: "self-rendering-extensions-border-gate",
    envVar: FLOOR_BASE_VAR,
    floorPath: FLOOR_FILE,
    headFloor: { copies, sharing },
    parse: (text) => ({
      copies: parseFloor(text, `${FLOOR_FILE} (base)`),
      sharing: parseSharingFloor(text, `${FLOOR_FILE} (base)`),
    }),
    grown: (base, current) => [
      ...diffUnlisted(base.copies, current.copies),
      ...sharingGrowth(base.sharing, current.sharing).map((p) => `${SHARING_FLOOR_KEY}: ${p}`),
    ],
    repoRoot,
    env,
  });
}

/**
 * The committed baseline as { copies, sharing }, null when the file is missing;
 * a bad shape throws a refusal.
 */
function readBaseline() {
  if (!existsSync(BASELINE_PATH)) return null;
  const text = readFileSync(BASELINE_PATH, "utf8");
  const file = toPosix(relative(REPO_ROOT, BASELINE_PATH));
  return { copies: parseFloor(text, file), sharing: parseSharingFloor(text, file) };
}

function writeBaselineFile(copies, sharing) {
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
          "(which refuses to write a baseline that grows). " +
          "sharingPanelImports (cinatra#3968) records the \"<package> :: <file>\" pairs, in a package of " +
          "any kind, whose source " +
          "imports @cinatra-ai/sdk-ui/connector-sharing-panels; it started empty and is shrink-only " +
          "in the same way.",
        copies: sorted,
        [SHARING_FLOOR_KEY]: [...sharing].sort(),
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
      const grown = [
        ...diffUnlisted(committed.copies, current),
        ...sharingGrowth(committed.sharing, census.sharingPanelImports).map((p) => `${SHARING_FLOOR_KEY}: ${p}`),
      ];
      if (grown.length > 0) {
        console.error(
          `${HEADER}\n  refusing to write a GROWN baseline — the floor is shrink-only. Draw the ` +
            "screen from the primitives the product shares at run time instead of copying them, and " +
            "leave the Sharing tab to the application:",
        );
        grown.forEach((p) => console.error("  + " + p));
        process.exit(1);
      }
    }
    const total = writeBaselineFile(current, census.sharingPanelImports);
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

  if (!reportFloorGuard(checkFloorAgainstBase({ headFloor: baseline.copies, headSharing: baseline.sharing }))) {
    process.exit(1);
  }

  const census = scanBorder();
  const current = census.copies;
  const problems = [];

  const unlisted = diffUnlisted(baseline.copies, current);
  if (unlisted.length > 0) {
    problems.push(
      "  (a) UNLISTED primitive copy — a kind:connector / kind:artifact package carries a file " +
        "under src/components/ui/ that the baseline does not record. A self-rendering extension " +
        "draws its own screen from the primitives the host shares at run time; it does not take a " +
        "new copy:",
    );
    unlisted.forEach((p) => problems.push("  + " + p));
  }

  const stale = diffStale(baseline.copies, current);
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

  if (census.reviewControls.length > 0) {
    problems.push(
      "  (f) REVIEW CONTROL IN A DISPLAY (cinatra#3080 item 7) — a kind:artifact source file names " +
        "Regenerate, Approve or Reject, or the review decision route. A display draws the work " +
        "only; the review floor belongs to the review card:",
    );
    census.reviewControls.forEach((f) =>
      problems.push(`  ! ${f.package} :: ${f.file} names ${f.words.join(", ")}`),
    );
  }

  const unlistedSharing = sharingGrowth(baseline.sharing, census.sharingPanelImports);
  if (unlistedSharing.length > 0) {
    problems.push(
      "  (g) SHARING PANELS IMPORTED (cinatra#3968) — a source file of an extension package (any kind) " +
        `imports ${SHARING_PANELS_SPECIFIER}. The application supplies the Sharing tab; a package ` +
        "renders its own setup page and never draws the Sharing panel:",
    );
    unlistedSharing.forEach((p) => problems.push(`  ! ${p} imports the SDK's sharing panels (${SHARING_PANELS_SPECIFIER})`));
  }

  const staleSharing = sharingGrowth(census.sharingPanelImports, baseline.sharing);
  if (staleSharing.length > 0) {
    problems.push(
      `  (g) STALE ${SHARING_FLOOR_KEY} entry — the recorded import is gone. The list is shrink-only: ` +
        "ratchet it down with `node scripts/extensions/self-rendering-extensions-border-gate.mjs --write-baseline`:",
    );
    staleSharing.forEach((p) => problems.push("  - " + p));
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
      "package(s) read; no unlisted copy, no stale entry, no direct reach, no review control " +
      "in a display, no sharing-panel import outside the recorded list, nothing unread; " +
      `rules (a)-(f) read ${census.packages.length} connector/artifact package(s); rule (g) read ` +
      `${census.sharingScope.packages} package(s) of every kind, ${census.sharingScope.files} source file(s).`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
