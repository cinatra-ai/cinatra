#!/usr/bin/env node
// CI gate: the host-peer VALUE-import ban — the "parity ratchet" half of the
// model-B host-peer runtime-resolution rule.
//
// A runtime-loaded extension's `cinatra.serverEntry` import graph must keep
// host-internal SDK peers (@cinatra-ai/sdk-extensions / sdk-ui / mcp-client)
// type-only (erased at compile) or take the value via the injected `ctx`. A
// runtime VALUE import of a host peer is the hazard the prod `file://` loader
// CANNOT resolve — the bare specifier has no entry in the store dir's
// node_modules and the bundled-deps gate forbids bundling one, so it would
// either ERR_MODULE_NOT_FOUND or load a SECOND SDK instance and break ABI
// identity. The materialize-time gate (src/lib/extension-package-store.ts) is
// the runtime enforcement; THIS gate front-runs it in CI so the hazard never
// reaches a published tarball.
//
// SCOPE: only files genuinely REACHABLE from each extension's
// `cinatra.serverEntry` graph count — an `actions.ts` invoked solely through
// the host action endpoint (never imported by `register(ctx)`) is NOT in the
// graph the `file://` loader imports, so flagging it would be a false positive.
// The gate traces the ACTUAL static import graph from serverEntry over the
// extension's own relative source files; it never enters node_modules and never
// follows a bare third-party specifier (bundled runtime deps are legitimate and
// out of scope — the rule is solely about host-internal peers, never bundled).
//
// NO-NEW-ROT RATCHET: a committed baseline records the CURRENT reachable
// host-peer value-import surface; CI fails only on a hit NOT in the baseline.
// The surface can only SHRINK. The honest baseline today is EMPTY (every
// declared serverEntry imports the host peer type-only and routes values via
// `ctx`); regenerate with `--write-baseline` (it should only ever shrink).
//
// Usage:
//   node scripts/audit/host-peer-value-import-ban.mjs                  # check (exit 1 on NEW hits)
//   node scripts/audit/host-peer-value-import-ban.mjs --write-baseline # regenerate the baseline (shrink-only in CI)
//   node scripts/audit/host-peer-value-import-ban.mjs --strict         # also fail on stale baseline entries
//   HOST_PEER_BAN_BASE=<ref> node ...                                  # also fail if the baseline GREW vs <ref>

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative, normalize, isAbsolute, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// This gate is plain `.mjs`, so it `import`s `typescript` directly (a project
// dependency) and runs the SAME parser-based classifier as the materialize-time
// core helper (src/lib/extension-package-store-core.ts). A parser — not a
// regex/lexer — is the decisive fix for `import { type as t }` (a value import
// of an export named `type`), template-literal `${import("…")}` interpolations,
// and regex literals. The unit tests assert form-coverage parity with the core.
import ts from "typescript";
import { assertExtensionsPresent } from "./lib/assert-extensions-cloned.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = join(__dirname, "host-peer-value-import-ban.baseline.json");

// The CANONICAL host-internal SDK peer set — MUST stay in sync with
// `HOST_PROVIDED_PACKAGES` in src/lib/extension-package-store-core.ts and the
// host-internal set in `.pnpmfile.cjs`. (Drift across these is a known hazard;
// a future ratchet could assert parity — out of scope here.)
export const HOST_PEERS = new Set([
  "@cinatra-ai/sdk-extensions",
  "@cinatra-ai/sdk-ui",
  "@cinatra-ai/mcp-client",
]);

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js", ".jsx"];

// ---------------------------------------------------------------------------
// Pure scanner — the SAME parser-based classifier as
// src/lib/extension-package-store-core.ts `parseModuleImports` /
// `scanHostPeerValueImports` (the materialize-time gate's helpers). Kept as a
// parallel JS copy because this gate is a standalone `.mjs` that cannot import
// the TS source; both build on the TypeScript parser, and the unit tests assert
// form-coverage parity. (`stripComments` is unused now that a real parser
// handles comments — retained as an export for backward compatibility with any
// downstream caller + the existing unit test.)
// ---------------------------------------------------------------------------

export function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

export function basePackageOf(spec) {
  if (typeof spec !== "string" || spec.length === 0) return null;
  if (spec.startsWith(".") || spec.startsWith("/")) return null;
  if (spec.startsWith("@")) {
    const parts = spec.split("/");
    if (parts.length < 2) return null;
    return parts[0] + "/" + parts[1];
  }
  return spec.split("/")[0];
}

function scriptKindForFile(fileName) {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (lower.endsWith(".ts") || lower.endsWith(".mts") || lower.endsWith(".cts")) return ts.ScriptKind.TS;
  if (lower.endsWith(".jsx")) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

function namedBindingText(propertyName, localName) {
  return propertyName && propertyName !== localName ? `${propertyName} as ${localName}` : localName;
}

/** The shared import classifier — the SAME logic as
 * src/lib/extension-package-store-core.ts#parseModuleImports, built on the
 * TypeScript parser. Returns `{ specifier, valueBindings, isValueEdge, kind,
 * line }[]`. Used by BOTH the host-peer value filter AND the import-graph
 * value-edge follow decision. Per-specifier `element.isTypeOnly` is the accurate
 * type/value signal (so `import { type as t }` is a value import of an export
 * named `type`); call expressions are walked tree-wide, covering dynamic
 * `import()` / `require()` / `module.require()` inside template-literal
 * interpolations; regex literals are never confused for imports. */
export function parseModuleImports(sourceText, fileName = "module.ts") {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    false,
    scriptKindForFile(fileName),
  );
  const out = [];
  const lineOf = (node) => ts.getLineAndCharacterOfPosition(sourceFile, node.getStart(sourceFile)).line + 1;

  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt)) {
      if (!ts.isStringLiteralLike(stmt.moduleSpecifier)) continue;
      const specifier = stmt.moduleSpecifier.text;
      const line = lineOf(stmt);
      const clause = stmt.importClause;
      if (!clause) {
        out.push({ specifier, valueBindings: [], isValueEdge: true, kind: "bare", line });
        continue;
      }
      if (clause.isTypeOnly) {
        out.push({ specifier, valueBindings: [], isValueEdge: false, kind: "import", line });
        continue;
      }
      const valueBindings = [];
      if (clause.name) valueBindings.push(clause.name.text);
      const named = clause.namedBindings;
      if (named && ts.isNamespaceImport(named)) {
        valueBindings.push(`* as ${named.name.text}`);
      } else if (named && ts.isNamedImports(named)) {
        for (const el of named.elements) {
          if (el.isTypeOnly) continue;
          valueBindings.push(namedBindingText(el.propertyName?.text, el.name.text));
        }
      }
      // A non-`import type` declaration ALWAYS preserves a runtime module edge
      // under verbatimModuleSyntax / Node type-stripping (`import { type X }` /
      // `import {}` emit `import {} from "x"`). Only declaration `import type` is erased.
      out.push({ specifier, valueBindings, isValueEdge: true, kind: "import", line });
      continue;
    }

    if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteralLike(stmt.moduleSpecifier)) {
      const specifier = stmt.moduleSpecifier.text;
      const line = lineOf(stmt);
      if (stmt.isTypeOnly) {
        out.push({ specifier, valueBindings: [], isValueEdge: false, kind: "export", line });
        continue;
      }
      const exportClause = stmt.exportClause;
      const valueBindings = [];
      if (exportClause && ts.isNamedExports(exportClause)) {
        for (const el of exportClause.elements) {
          if (el.isTypeOnly) continue;
          valueBindings.push(namedBindingText(el.propertyName?.text, el.name.text));
        }
        // A non-`export type` named re-export ALWAYS preserves a runtime edge.
        out.push({ specifier, valueBindings, isValueEdge: true, kind: "export", line });
        continue;
      }
      out.push({ specifier, valueBindings: [], isValueEdge: true, kind: "export", line });
      continue;
    }

    if (
      ts.isImportEqualsDeclaration(stmt) &&
      ts.isExternalModuleReference(stmt.moduleReference) &&
      stmt.moduleReference.expression &&
      ts.isStringLiteralLike(stmt.moduleReference.expression)
    ) {
      if (stmt.isTypeOnly) continue;
      out.push({
        specifier: stmt.moduleReference.expression.text,
        valueBindings: [stmt.name.text],
        isValueEdge: true,
        kind: "require",
        line: lineOf(stmt),
      });
    }
  }

  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const arg0 = node.arguments[0];
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      // A bare `require("x")` OR a `module.require("x")` member call — both are
      // CommonJS value imports. The latter is a PropertyAccessExpression callee
      // `<module>.require`.
      const isRequire =
        (ts.isIdentifier(callee) && callee.text === "require") ||
        (ts.isPropertyAccessExpression(callee) &&
          callee.name.text === "require" &&
          ts.isIdentifier(callee.expression) &&
          callee.expression.text === "module");
      if ((isDynamicImport || isRequire) && arg0 && ts.isStringLiteralLike(arg0)) {
        out.push({
          specifier: arg0.text,
          valueBindings: [],
          isValueEdge: true,
          kind: isRequire ? "require" : "dynamic",
          line: lineOf(node),
        });
      }
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);

  return out;
}

/** Classify every host-peer import in `sourceText`; return the VALUE-bound ones
 * as `{ peer, bindings, line }`. Thin filter over `parseModuleImports`.
 * `fileName` is forwarded so the parser derives the correct ScriptKind — a
 * `.tsx`/`.jsx` graph file's JSX-embedded value import is otherwise missed (a
 * fail-open gap). Graph walkers MUST pass the real on-disk path. */
export function scanHostPeerValueImports(sourceText, hostPeers = HOST_PEERS, fileName = "module.ts") {
  const hits = [];
  for (const imp of parseModuleImports(sourceText, fileName)) {
    if (!imp.isValueEdge) continue;
    const base = basePackageOf(imp.specifier);
    if (base === null || !hostPeers.has(base)) continue;
    hits.push({ peer: base, bindings: imp.valueBindings, line: imp.line });
  }
  return hits;
}

/** Distinct RELATIVE specifiers (`./x`, `../y`) referenced in `source`. Retained
 * for diagnostics + the unit test; the graph trace now follows VALUE edges via
 * `parseModuleImports` (not this comment-only regex). */
export function relativeImportSpecifiers(source) {
  const out = new Set();
  for (const imp of parseModuleImports(source)) {
    if (imp.specifier.startsWith("./") || imp.specifier.startsWith("../")) out.add(imp.specifier);
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Graph trace (over the extension's OWN files, never into node_modules)
// ---------------------------------------------------------------------------

function safeJoinInside(rootDir, rel) {
  const cleaned = rel.replace(/^\.\//, "");
  if (cleaned.startsWith("/") || isAbsolute(cleaned)) return null;
  const abs = normalize(join(rootDir, cleaned));
  const rootResolved = normalize(rootDir);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + sep)) return null;
  return abs;
}

/** Resolve an `exports` map KEY (`"./register"`, `"."`) to its relative target,
 * picking the import/default/require condition for a conditional entry. */
function resolveExportsSubpath(exportsMap, key) {
  if (!exportsMap || typeof exportsMap !== "object" || Array.isArray(exportsMap)) return null;
  const target = exportsMap[key];
  if (typeof target === "string") return target;
  if (target && typeof target === "object") {
    const picked = target.import ?? target.default ?? target.require;
    if (typeof picked === "string") return picked;
  }
  return null;
}

/** Resolve `cinatra.serverEntry` (direct path OR an `exports` map key) to an
 * absolute source file inside `extDir`, or null when absent/unsafe/missing. */
export function resolveServerEntryFile(extDir, pkgJson) {
  const cinatra = pkgJson && typeof pkgJson.cinatra === "object" ? pkgJson.cinatra : null;
  const serverEntry = cinatra && typeof cinatra.serverEntry === "string" ? cinatra.serverEntry : null;
  if (!serverEntry) return null;
  const rel = resolveExportsSubpath(pkgJson.exports, serverEntry) ?? serverEntry;
  const base = safeJoinInside(extDir, rel);
  if (!base) return null;
  if (fileIsRegular(base)) return base;
  for (const ext of SOURCE_EXTENSIONS) if (fileIsRegular(base + ext)) return base + ext;
  return null;
}

/** Resolve a bare specifier that self-references the package's OWN name
 * (`@scope/ext` or `@scope/ext/sub`) to an absolute file inside `extDir`, via
 * the `exports` map (Node self-resolves the package's own name). Returns null
 * for a TRUE third-party specifier or an undeclared/unsafe subpath. */
function resolveSelfPackageImport(extDir, exportsMap, selfName, spec) {
  const base = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
  if (base !== selfName) return null;
  const subpath = spec === selfName ? "." : "." + spec.slice(selfName.length);
  const rel = resolveExportsSubpath(exportsMap, subpath);
  if (!rel) return null;
  const abs = safeJoinInside(extDir, rel);
  if (!abs) return null;
  if (fileIsRegular(abs)) return abs;
  for (const ext of SOURCE_EXTENSIONS) if (fileIsRegular(abs + ext)) return abs + ext;
  return null;
}

function fileIsRegular(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function resolveRelativeImport(extDir, fromAbs, rel) {
  const baseRel = relative(extDir, dirname(fromAbs));
  const joined = safeJoinInside(extDir, join(baseRel || ".", rel));
  if (!joined) return null;
  const candidates = [joined];
  for (const ext of SOURCE_EXTENSIONS) candidates.push(joined + ext);
  for (const ext of SOURCE_EXTENSIONS) candidates.push(join(joined, `index${ext}`));
  for (const c of candidates) if (fileIsRegular(c)) return c;
  return null;
}

/** Trace `extDir`'s serverEntry graph; return the sorted host-peer value-import
 * hit descriptors (`<relFile> :: <peer> (<bindings>) L<line>`). Empty when the
 * extension has no serverEntry or no reachable value import. */
export function scanExtensionGraph(extDir, pkgJson) {
  const entry = resolveServerEntryFile(extDir, pkgJson);
  if (!entry) return [];
  const selfName = pkgJson && typeof pkgJson.name === "string" ? pkgJson.name : null;
  const exportsMap = pkgJson ? pkgJson.exports : undefined;
  const visited = new Set();
  const queue = [entry];
  const hits = new Set();
  while (queue.length > 0) {
    const fileAbs = queue.shift();
    if (visited.has(fileAbs)) continue;
    visited.add(fileAbs);
    let source;
    try {
      source = readFileSync(fileAbs, "utf8");
    } catch (error) {
      // A file that resolved INTO the graph but cannot be read is a HARD failure
      // — same fail-loud contract as the materialize core's
      // `assertNoHostPeerValueImports` (the CI/core divergence fix). Silently
      // skipping it would let a possibly-hazardous host-peer value import slip
      // past the gate. (The no-serverEntry / serverEntry-points-at-missing-file
      // cases never enter this loop — `resolveServerEntryFile` returns null for
      // them — so those stay graceful skips.)
      const relFile = relative(extDir, fileAbs);
      throw new Error(
        `[host-peer-value-import-ban] a file that resolved INTO the serverEntry import graph ` +
          `cannot be read (${relFile}): ${error instanceof Error ? error.message : String(error)}. ` +
          `Failing closed — the host-peer value-import gate cannot certify an unreadable graph file.`,
      );
    }
    // Pass the real on-disk path so the parser derives the correct ScriptKind
    // (a `.tsx`/`.jsx` graph file's JSX-embedded value import is otherwise
    // missed — a fail-open gap).
    for (const h of scanHostPeerValueImports(source, HOST_PEERS, fileAbs)) {
      const relFile = relative(extDir, fileAbs);
      const bindings = h.bindings.length > 0 ? h.bindings.join(",") : "side-effect";
      hits.add(`${relFile} :: ${h.peer} (${bindings}) L${h.line}`);
    }
    // Follow only VALUE edges (type-only edges have no runtime presence):
    // relative specifiers + self-package subpaths. Third-party bare specifiers +
    // node_modules are out of scope. Thread the real path so the parser uses the
    // correct ScriptKind for `.tsx`/`.jsx`.
    for (const imp of parseModuleImports(source, fileAbs)) {
      if (!imp.isValueEdge) continue;
      const spec = imp.specifier;
      let next = null;
      if (spec.startsWith("./") || spec.startsWith("../")) {
        next = resolveRelativeImport(extDir, fileAbs, spec);
      } else if (selfName) {
        next = resolveSelfPackageImport(extDir, exportsMap, selfName, spec);
      }
      if (next && !visited.has(next)) queue.push(next);
    }
  }
  return [...hits].sort();
}

// ---------------------------------------------------------------------------
// Surface + diff (no-new-rot ratchet)
// ---------------------------------------------------------------------------

/** Walk `extensions/<scope>/<slug>/` and return `{ "<pkgName>": [hit, …] }` for
 * every extension whose serverEntry graph carries a host-peer value import. */
export function currentSurface(repoRoot) {
  const extRoot = join(repoRoot, "extensions");
  const surface = {};
  if (!existsSync(extRoot)) return surface;
  for (const scope of readdirSync(extRoot)) {
    const scopeDir = join(extRoot, scope);
    try {
      if (!statSync(scopeDir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const slug of readdirSync(scopeDir)) {
      const extDir = join(scopeDir, slug);
      const pjPath = join(extDir, "package.json");
      if (!existsSync(pjPath)) continue;
      let pkgJson;
      try {
        pkgJson = JSON.parse(readFileSync(pjPath, "utf8"));
      } catch {
        continue;
      }
      const name = typeof pkgJson.name === "string" ? pkgJson.name : `${scope}/${slug}`;
      const hits = scanExtensionGraph(extDir, pkgJson);
      if (hits.length) surface[name] = hits;
    }
  }
  return surface;
}

function stable(obj) {
  return JSON.stringify(obj, null, 2) + "\n";
}

function flatten(map) {
  const out = new Set();
  for (const ext of Object.keys(map)) for (const hit of map[ext]) out.add(JSON.stringify([ext, hit]));
  return out;
}

function show(jsonKey) {
  const pair = JSON.parse(jsonKey);
  return pair[0] + " :: " + pair[1];
}

/** Pure diff — `newViolations` = hits present now but NOT in the baseline (fail
 * CI); `stale` = baseline entries no longer present (resolved — remove them). */
export function diffSurface(baseline, current) {
  const base = flatten(baseline.surface ?? {});
  const cur = flatten(current);
  const newViolations = [];
  for (const k of cur) if (!base.has(k)) newViolations.push(show(k));
  const stale = [];
  for (const k of base) if (!cur.has(k)) stale.push(show(k));
  return { newViolations, stale };
}

/** Monotonic-ratchet guard: the committed baseline must be a SUBSET of the
 * base-branch baseline (it may only shrink). Returns the entries it ADDED. */
export function baselineGrowth(baseBaseline, committedBaseline) {
  const baseSet = flatten(baseBaseline.surface ?? {});
  const grown = [];
  for (const k of flatten(committedBaseline.surface ?? {})) if (!baseSet.has(k)) grown.push(show(k));
  return grown;
}

async function main() {
  const args = process.argv.slice(2);
  const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

  // Fail-closed (source-relocation cutover): without the cloned-back tree the
  // scan finds 0 extensions and the gate would pass vacuously.
  assertExtensionsPresent(repoRoot, "host-peer-value-import-ban");

  const current = currentSurface(repoRoot);

  if (args.includes("--write-baseline")) {
    const doc = {
      note:
        "host-peer VALUE-import no-new-rot baseline. Records the CURRENT reachable host-peer value-import surface (per extension, the host-peer VALUE imports reachable from `cinatra.serverEntry`'s static import graph — NOT files reachable only via the host action endpoint). The rule (model B): an extension's serverEntry graph must keep @cinatra-ai/sdk-extensions / sdk-ui / mcp-client type-only (erased at compile) or take the value via the injected `ctx`. Regenerate with `node scripts/audit/host-peer-value-import-ban.mjs --write-baseline` (the surface only ever SHRINKS). The honest baseline is EMPTY today — every declared serverEntry routes host-peer values via `ctx`.",
      surface: current,
    };
    writeFileSync(BASELINE_PATH, stable(doc));
    console.log("[host-peer-value-import-ban] baseline written.");
    return;
  }

  if (!existsSync(BASELINE_PATH)) {
    console.error("[host-peer-value-import-ban] FAIL — no baseline. Run with --write-baseline first.");
    process.exit(1);
  }
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));

  // Monotonic-ratchet guard (closes the "regenerate baseline to pass" bypass).
  const baseRef = process.env.HOST_PEER_BAN_BASE;
  if (baseRef && baseRef.startsWith("-")) {
    console.error(
      `[host-peer-value-import-ban] FAIL — HOST_PEER_BAN_BASE="${baseRef}" begins with "-" (flag-like); ` +
        `refusing to feed a flag-like value to git. Fix the CI base-ref configuration.`,
    );
    process.exit(1);
  } else if (baseRef) {
    let refResolves = false;
    try {
      execFileSync("git", ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`], {
        stdio: ["ignore", "ignore", "ignore"],
      });
      refResolves = true;
    } catch {
      refResolves = false;
    }
    if (!refResolves) {
      console.error(
        `[host-peer-value-import-ban] FAIL — HOST_PEER_BAN_BASE="${baseRef}" did not resolve ` +
          `(shallow checkout / misconfig?). The monotonic baseline-growth guard cannot run; failing closed. ` +
          `Ensure the base ref is fetched (e.g. fetch-depth: 0).`,
      );
      process.exit(1);
    }
    let baseText = null;
    try {
      baseText = execFileSync(
        "git",
        ["show", `${baseRef}:scripts/audit/host-peer-value-import-ban.baseline.json`],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
    } catch {
      baseText = null; // ref resolves but file absent → introducing PR, no constraint
    }
    if (baseText) {
      const grew = baselineGrowth(JSON.parse(baseText), baseline);
      if (grew.length) {
        console.error(
          "[host-peer-value-import-ban] FAIL — the committed baseline GREW vs " +
            baseRef +
            " (the host-peer value-import surface may only shrink; you cannot baseline a new value import):",
        );
        for (const g of grew) console.error("  + " + g);
        process.exit(1);
      }
    }
  }

  const { newViolations, stale } = diffSurface(baseline, current);
  const baseCount = flatten(baseline.surface ?? {}).size;

  if (newViolations.length) {
    console.error("[host-peer-value-import-ban] FAIL — NEW host-peer VALUE import in a serverEntry graph (not in the baseline):");
    for (const v of newViolations) console.error("  + " + v);
    console.error(
      "\nAn extension's serverEntry import graph must keep @cinatra-ai/sdk-extensions / sdk-ui /\n" +
        "mcp-client TYPE-ONLY (`import type`, erased at compile) or take the value via the injected\n" +
        "`ctx`. A runtime VALUE import of a host peer cannot be resolved by the prod file:// loader\n" +
        "(the bare specifier is never bundled) and would break ABI identity. Route the value through\n" +
        "`ctx`, or make the import type-only. If this is a legitimate temporary step, regenerate the\n" +
        "baseline with `node scripts/audit/host-peer-value-import-ban.mjs --write-baseline` (it only shrinks).",
    );
    process.exit(1);
  }

  if (stale.length) {
    const strict = args.includes("--strict");
    const header =
      "[host-peer-value-import-ban] " +
      (strict ? "FAIL" : "NOTE") +
      " — " +
      stale.length +
      " baseline entr" +
      (stale.length === 1 ? "y is" : "ies are") +
      " stale (resolved — remove via --write-baseline):";
    const body = stale.map((s) => "  - " + s).join("\n");
    if (strict) {
      console.error(header + "\n" + body);
      process.exit(1);
    }
    console.log(header + "\n" + body);
  }

  console.log(
    "[host-peer-value-import-ban] OK — no NEW host-peer value imports in any serverEntry graph. Baseline: " +
      baseCount +
      " entr" +
      (baseCount === 1 ? "y" : "ies") +
      ". Keep it at 0 (route host-peer values via ctx; import the host SDK type-only).",
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
