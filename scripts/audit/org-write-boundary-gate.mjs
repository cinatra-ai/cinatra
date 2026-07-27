#!/usr/bin/env node
// CI gate: the org-write kernel boundary — cinatra#1938 (archive epic S2).
//
// The kernel's enforcement value rests on writers being UNCALLABLE except
// through the guarded entry points. This gate pins four structural rules
// over the real import graph (TypeScript compiler API — the same parser-based
// classifier discipline as host-peer-value-import-ban.mjs, covering static
// imports, runtime re-exports, `import()`, `require()` and
// `module.require()`; declaration `import type` / `export type` are erased
// and exempt):
//
//   R1  kernel-internals: outside packages/org-write-kernel/, the ONLY legal
//       specifier for the kernel is the bare package root
//       "@cinatra-ai/org-write-kernel" — deep subpaths and relative paths
//       that RESOLVE into the package (realpath-canonicalized, so a symlink
//       cannot dodge the prefix check) are violations.
//   R2  system-mint restriction: a value import of the
//       `mintSystemWriteAuthority` binding is dispatcher-only. The allowlist
//       carries the wave-1 lifecycle hooks + the wave-2 agent-run mint (tests
//       under src/lib/org-write/__tests__/ are exempt by scope rule).
//   R3  single unwrap consumer: a value import of the `guardedBatchQueries`
//       binding outside the kernel itself is legal ONLY in
//       src/lib/org-write/batch-wrapper.ts (the transaction-forcing wrapper).
//   R5  named-consumer allowlist (cinatra#1939 wave 2, §5.2): a value import
//       that NAMES an agent-run system-dispatch mint wrapper is restricted to
//       its three sanctioned job-file consumers. Opaque access to that module is
//       already covered by R2's org-write net; R5 closes the
//       named/aliased/re-exported path. (The runManagementAuthority named-
//       consumer rule was REMOVED with the mint itself — owner ruling 2026-07-26,
//       ruling 2: cross-org run management is unsupported.)
//   R4  registry-driven writer import ban (cinatra#1939 wave 3, Decision 4):
//       the R5 named-consumer machinery generalized from ONE hand-written rule
//       to rules DERIVED from src/lib/org-write/write-registry.ts. Each row with
//       `importBanned:true` bans importing that writer entry point outside its
//       enumerated `allowedImporters` (empty allowlist = total ban). The gate
//       STATICALLY PARSES the registry (literal object data; `dashboardsWriter()`
//       helper calls are expanded from their literal arguments) — any row/field
//       it cannot read as a literal is a HARD GATE FAILURE, never an omitted
//       rule (fail-closed). Every specifier resolves through
//       `ts.resolveModuleName` + realpath against the repo tsconfig (paths
//       aliases AND workspace-package exports handled by the real resolver),
//       compared to the row's `module`. A transitive re-export closure poisons
//       any barrel whose value re-export chain reaches a banned (module,
//       binding), so a root-specifier import of a re-exported banned writer is
//       caught AND the barrel itself is a violation. Opaque access
//       (namespace/bare/dynamic/require/CJS) to a banned module fails closed
//       unless the file is in the union of that module's rows' allowlists. Test
//       files are exempt (the runtime authority requirement still binds them
//       through the kernel fakes). The registry is the single source of truth;
//       the write-registry lockstep test pins the gate's extraction against it.
//
// Zero-baseline gate for R1/R2/R3/R5: there is no ratchet file — the honest
// surface is empty and must stay empty. R4's baseline IS the registry. Scan
// scope is src/ + packages/ + scripts/ (extensions are separate repos already
// barred from host-internal specifiers by extension-import-ban; this gate does
// not require them cloned).
//
// Usage:
//   node scripts/audit/org-write-boundary-gate.mjs               # check (exit 1 on violations)
//   node scripts/audit/org-write-boundary-gate.mjs --list        # print every scanned edge that touches the kernel surface
//   node scripts/audit/org-write-boundary-gate.mjs --emit-r4-rules # print the parsed R4 rules as JSON (lockstep test consumes this)
//   node scripts/audit/org-write-boundary-gate.mjs --r4-report    # print, per registered writer, every current importer (allowlist-derivation aid)

import { readFileSync, readdirSync, statSync, realpathSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

export const KERNEL_PACKAGE = "@cinatra-ai/org-write-kernel";
export const KERNEL_DIR_REL = join("packages", "org-write-kernel");

/** R2: dispatcher-only importers of mintSystemWriteAuthority. S4 adds the
 *  dispatcher module here as a deliberate, reviewed design event. */
export const SYSTEM_MINT_ALLOWLIST = new Set([
  // The extension archive/restore lifecycle hook — mints the content-only
  // "extension-dashboard-lifecycle" purpose (cinatra#1939 wave 1).
  join("src", "lib", "dashboards", "extension-dashboard-lifecycle.ts"),
  // The contribution-adoption reconciler — mints the content-only
  // "dashboard-contribution-reconciler" purpose (cinatra#1939 wave 1).
  join("src", "lib", "dashboards", "reconcile-contribution-adoptions.ts"),
  // The boot phase — mints the content-only "dashboard-twin-backfill"
  // purpose per org for the artifact-twin backfill (cinatra#1939 wave 1).
  join("src", "lib", "boot", "phases", "core-boot.ts"),
  // The agent-run system-dispatch mint — the SOLE importer of
  // mintSystemWriteAuthority for the "agent-run-dispatch" purpose; exposes the
  // three context-named wrappers (cinatra#1939 wave 2). Its OWN consumers are
  // restricted separately by RUN_DISPATCH_MINT_CONSUMER_ALLOWLIST below.
  join("src", "lib", "org-write", "agent-run-authority-mint.ts"),
]);

/** R3: the one legal unwrap consumer outside the kernel. */
export const BATCH_UNWRAP_ALLOWLIST = new Set([
  join("src", "lib", "org-write", "batch-wrapper.ts"),
]);

/** R5 (cinatra#1939 wave 2, §5.2): the three job contexts allowed to NAME the
 *  agent-run system-dispatch mint wrappers. Being the sole minting site is not
 *  being the sole authorized caller — the wrappers grant org-wide run caps and
 *  are otherwise freely importable, so their consumers are restricted here. */
export const RUN_DISPATCH_MINT_CONSUMER_ALLOWLIST = new Set([
  join("packages", "agents", "src", "execution.ts"),
  join("packages", "agents", "src", "trigger-release-job.ts"),
  join("src", "lib", "host-content-editor-dispatch.ts"),
]);

/**
 * R5 named-consumer rules. The R2 mechanism already fail-closes the OPAQUE
 * forms (namespace / bare / dynamic import() / require()) across the whole
 * @/lib/org-write/ surface; these rules add the missing NAMED-import
 * restriction so a freely-importable wrapper helper can only be named by its
 * sanctioned consumers. The SAME classifier as R2 does the heavy lifting:
 * aliased names resolve to the ORIGINAL imported name and re-exports are value
 * edges, so alias / re-export / path-variant are all caught here.
 */
const NAMED_CONSUMER_RULES = [
  {
    rule: "R5-run-dispatch-mint",
    bindings: new Set([
      "mintAgentRunExecutionAuthority",
      "mintTriggerReleaseAuthority",
      "mintContentEditorDispatchAuthority",
    ]),
    moduleRel: join("src", "lib", "org-write", "agent-run-authority-mint.ts"),
    aliasSpecifier: "@/lib/org-write/agent-run-authority-mint",
    allowlist: RUN_DISPATCH_MINT_CONSUMER_ALLOWLIST,
    testsExempt: false,
  },
];

const SCAN_ROOTS = ["src", "packages", "scripts"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".next", "__generated__"]);

function scriptKindForFile(fileName) {
  if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (fileName.endsWith(".mts")) return ts.ScriptKind.TS;
  if (fileName.endsWith(".mjs") || fileName.endsWith(".js")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * Parse one file into module edges: {specifier, valueBindings, isValueEdge,
 * kind, line}. Same coverage as the host-peer gate's classifier.
 */
export function collectModuleEdges(fileName, sourceText) {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    scriptKindForFile(fileName),
  );
  const out = [];
  const lineOf = (node) =>
    ts.getLineAndCharacterOfPosition(sourceFile, node.getStart(sourceFile)).line + 1;

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
          valueBindings.push(el.propertyName?.text ?? el.name.text);
        }
      }
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
      const valueBindings = [];
      // Exported names run PARALLEL to valueBindings: for `export { a as b }`,
      // valueBindings holds the SOURCE name `a` (matched against the target
      // module's banned export) and exportedNames holds `b` (the name this file
      // re-exposes, under which the R4 closure poisons it) — so an ALIASED
      // re-export of a banned writer cannot leak past the closure.
      const exportedNames = [];
      // `export * as ns from S` re-exposes S's WHOLE namespace under a single
      // name `ns` (`barrel.ns.bannedWriter`) — a named import of `ns` is opaque
      // access to S. Captured so the closure can poison (barrel, ns) rather than
      // mis-modelling it as `export *` (which would poison per-binding names that
      // the barrel does not actually expose).
      let namespaceReexport;
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          if (el.isTypeOnly) continue;
          valueBindings.push(el.propertyName?.text ?? el.name.text);
          exportedNames.push(el.name.text);
        }
      } else if (stmt.exportClause && ts.isNamespaceExport(stmt.exportClause)) {
        namespaceReexport = stmt.exportClause.name.text;
      }
      out.push({ specifier, valueBindings, exportedNames, namespaceReexport, isValueEdge: true, kind: "export", line });
      continue;
    }
    if (
      ts.isImportEqualsDeclaration(stmt) &&
      !stmt.isTypeOnly &&
      ts.isExternalModuleReference(stmt.moduleReference) &&
      stmt.moduleReference.expression &&
      ts.isStringLiteralLike(stmt.moduleReference.expression)
    ) {
      // `import X = require("Y")` binds X to the WHOLE module (a namespace
      // alias) — opaque access (empty valueBindings), like `import * as X`.
      out.push({
        specifier: stmt.moduleReference.expression.text,
        valueBindings: [],
        isValueEdge: true,
        kind: "require",
        line: lineOf(stmt),
      });
    }
  }

  // `const { a, b } = await import(spec)` / `const { a } = require(spec)` names
  // exactly the bindings a, b — treat it as a NAMED value edge so a destructured
  // dynamic import is as precise as a static one. A namespace binding
  // (`const m = await import(spec)`), a rest element, a computed property, or any
  // other use returns null → the edge stays OPAQUE (fail-closed: it can reach
  // every export).
  const dynamicNamedBindings = (callNode) => {
    let p = callNode.parent;
    if (p && ts.isAwaitExpression(p)) p = p.parent;
    if (
      !p ||
      !ts.isVariableDeclaration(p) ||
      !p.initializer ||
      !ts.isObjectBindingPattern(p.name)
    ) {
      return null;
    }
    const names = [];
    for (const el of p.name.elements) {
      if (el.dotDotDotToken) return null; // `...rest` grabs everything else
      const src = el.propertyName ?? el.name;
      if (!ts.isIdentifier(src)) return null; // computed / string key
      names.push(src.text);
    }
    return names;
  };

  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const arg0 = node.arguments[0];
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire =
        (ts.isIdentifier(callee) && callee.text === "require") ||
        (ts.isPropertyAccessExpression(callee) &&
          callee.name.text === "require" &&
          ts.isIdentifier(callee.expression) &&
          callee.expression.text === "module");
      if ((isDynamicImport || isRequire) && arg0 && ts.isStringLiteralLike(arg0)) {
        out.push({
          specifier: arg0.text,
          valueBindings: dynamicNamedBindings(node) ?? [],
          isValueEdge: true,
          kind: isRequire ? "require" : "dynamic",
          line: lineOf(node),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return out;
}

/**
 * Evaluate the three boundary rules for one file's edges.
 *
 * `fileRel` MUST already be repo-relative and realpath-canonicalized by the
 * caller (`canonicalRel`) — the rules trust it. `resolveSpecifier(spec)`
 * returns the repo-relative REALPATH a relative specifier lands on (or null
 * for bare/package specifiers), so symlinked detours into the kernel are
 * seen as kernel paths.
 */
export function evaluateBoundaryRules(fileRel, edges, resolveSpecifier) {
  const violations = [];
  const insideKernel = fileRel.startsWith(KERNEL_DIR_REL + sep) || fileRel === KERNEL_DIR_REL;
  const isOrgWriteTest = fileRel.startsWith(join("src", "lib", "org-write", "__tests__") + sep);

  for (const edge of edges) {
    if (!edge.isValueEdge) continue;

    // R1 — kernel internals reachable only via the package root. ONE
    // sanctioned subpath: "/testing" (the kernel-aware test fakes,
    // cinatra#1939 S3) is importable from TEST FILES ONLY — a production
    // file importing it is still a violation (test fakes must never answer
    // real queries).
    const isTestFile = /(^|\/)__tests__\//.test(fileRel) || /\.test\.[cm]?tsx?$/.test(fileRel);
    if (!insideKernel) {
      if (edge.specifier.startsWith(KERNEL_PACKAGE + "/")) {
        if (!(edge.specifier === KERNEL_PACKAGE + "/testing" && isTestFile)) {
          violations.push({ rule: "R1-deep-subpath", fileRel, ...edge });
        }
      } else if (edge.specifier.startsWith(".")) {
        const resolved = resolveSpecifier(edge.specifier);
        if (resolved && (resolved.startsWith(KERNEL_DIR_REL + sep))) {
          violations.push({ rule: "R1-relative-reach", fileRel, ...edge, resolved });
        }
      }
    }

    const touchesKernelRoot = edge.specifier === KERNEL_PACKAGE;
    const touchesAuthority =
      (edge.specifier.startsWith(".") &&
        (resolveSpecifier(edge.specifier) ?? "").startsWith(join("src", "lib", "org-write") + sep)) ||
      edge.specifier.includes("org-write/authority") ||
      edge.specifier === "@/lib/org-write" ||
      edge.specifier.startsWith("@/lib/org-write/");

    // OPAQUE access forms: a namespace import, a bindingless
    // bare import, a require() or a dynamic import() grants access to EVERY
    // export — including the restricted ones — without naming them. For the
    // restricted modules these are violations unless the file is allowlisted:
    // fail-closed beats convenient.
    const isOpaqueAccess =
      edge.valueBindings.length === 0 ||
      edge.valueBindings.some((b) => b.startsWith("* as "));

    // R2 — mintSystemWriteAuthority is dispatcher-only.
    if (
      !isOrgWriteTest &&
      touchesAuthority &&
      !SYSTEM_MINT_ALLOWLIST.has(fileRel) &&
      (edge.valueBindings.includes("mintSystemWriteAuthority") || isOpaqueAccess)
    ) {
      violations.push({
        rule: isOpaqueAccess ? "R2-system-mint-opaque" : "R2-system-mint",
        fileRel,
        ...edge,
      });
    }

    // R3 — guardedBatchQueries has ONE consumer outside the kernel.
    // The R1-sanctioned "/testing" edge from a TEST FILE is exempt even in
    // its opaque (dynamic-import) form: vi.mock factories can only reach the
    // fakes via `await import(...)` (vitest hoists factories above static
    // imports), and the testing module does not export guardedBatchQueries —
    // flagging it here would contradict R1's own sanction.
    const isSanctionedTestingImport =
      edge.specifier === KERNEL_PACKAGE + "/testing" && isTestFile;
    if (
      !insideKernel &&
      !isOrgWriteTest &&
      !isSanctionedTestingImport &&
      (touchesKernelRoot || edge.specifier.startsWith(KERNEL_PACKAGE)) &&
      !BATCH_UNWRAP_ALLOWLIST.has(fileRel) &&
      (edge.valueBindings.includes("guardedBatchQueries") || isOpaqueAccess)
    ) {
      violations.push({
        rule: isOpaqueAccess ? "R3-batch-unwrap-opaque" : "R3-batch-unwrap",
        fileRel,
        ...edge,
      });
    }

    // R5 — named-consumer allowlists (§5.2, cinatra#1939 wave 2). The OPAQUE
    // forms (namespace / bare / dynamic import() / require()) are already
    // fail-closed by R2's org-write net above; this adds the NAMED-import
    // restriction — named, aliased (resolves to the original name), re-exported
    // (a value edge) and path-variant (relative resolving into the module) —
    // so a freely-importable wrapper helper can only be NAMED by its sanctioned
    // consumers.
    for (const spec of NAMED_CONSUMER_RULES) {
      if (isOrgWriteTest) continue; // org-write __tests__ exempt (mirrors R2)
      if (spec.testsExempt && isTestFile) continue; // "+ their tests" (§5.2)
      if (spec.allowlist.has(fileRel)) continue; // sanctioned consumer
      const touchesSpecModule =
        edge.specifier === spec.aliasSpecifier ||
        (edge.specifier.startsWith(".") &&
          resolveSpecifier(edge.specifier) === spec.moduleRel);
      if (!touchesSpecModule) continue;
      if (edge.valueBindings.some((b) => spec.bindings.has(b))) {
        violations.push({ rule: spec.rule, fileRel, ...edge });
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Filesystem walk (realpath-canonicalized)
// ---------------------------------------------------------------------------

function canonicalRel(absPath) {
  try {
    return relative(REPO_ROOT, realpathSync(absPath));
  } catch {
    return relative(REPO_ROOT, absPath);
  }
}

function* walkFiles(rootAbs) {
  const entries = readdirSync(rootAbs, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const abs = join(rootAbs, entry.name);
    if (entry.isDirectory() || (entry.isSymbolicLink() && statSafe(abs)?.isDirectory())) {
      yield* walkFiles(abs);
    } else if (/\.(ts|tsx|mts|mjs)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      yield abs;
    }
  }
}

function statSafe(p) {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

function makeResolver(fileAbs) {
  return (spec) => {
    if (!spec.startsWith(".")) return null;
    const base = resolve(dirname(fileAbs), spec);
    for (const candidate of [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      `${base}.mts`,
      `${base}.mjs`,
      join(base, "index.ts"),
      join(base, "index.tsx"),
    ]) {
      if (existsSync(candidate) && statSafe(candidate)?.isFile()) {
        return canonicalRel(candidate);
      }
    }
    return null;
  };
}

// ---------------------------------------------------------------------------
// R4 — registry-driven writer import ban (cinatra#1939 wave 3, Decision 4)
// ---------------------------------------------------------------------------

export const REGISTRY_REL = join("src", "lib", "org-write", "write-registry.ts");

const R4_FIX_HINT =
  "this writer is inside the org-write perimeter; a new caller is a design event — " +
  "add the file to its allowedImporters row in write-registry.ts (reviewed) or route " +
  "through the writer's guarded caller";

/** A repo-relative path is a test file (R4-exempt: the runtime authority
 *  requirement still binds tests through the kernel fakes). */
export function isTestFileRel(fileRel) {
  return (
    /(^|\/)__tests__\//.test(fileRel) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(fileRel)
  );
}

class R4RegistryParseError extends Error {}

/**
 * Statically parse write-registry.ts and extract the R4 rows. The registry is
 * literal object data; `dashboardsWriter(...)` helper calls are expanded by
 * reading their literal arguments (`module` = the DASHBOARDS_MODULE string
 * const). ANY registry row the parser cannot read as a literal — a spread
 * element, a call to an unrecognized helper, a computed/non-literal `module`,
 * `exportName`, `importBanned`, `allowedImporters` or `importBanExemption` — is
 * a HARD FAILURE (throws). A dropped rule would silently un-ban a writer and
 * invalidate the coverage proof, so the parser fails
 * closed rather than omitting.
 *
 * Returns [{ module, exportName, importBanned, allowedImporters?, importBanExemption? }].
 */
export function extractR4Rules(registryText) {
  const sf = ts.createSourceFile(
    "write-registry.ts",
    registryText,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    ts.ScriptKind.TS,
  );
  const lineOf = (n) =>
    ts.getLineAndCharacterOfPosition(sf, n.getStart(sf)).line + 1;

  // Top-level `const X = "literal"` — resolves the DASHBOARDS_MODULE constant.
  const stringConsts = new Map();
  let registryArray = null;
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const d of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || !d.initializer) continue;
      if (ts.isStringLiteralLike(d.initializer)) {
        stringConsts.set(d.name.text, d.initializer.text);
      }
      if (d.name.text === "ORG_WRITE_REGISTRY") {
        let init = d.initializer;
        while (ts.isAsExpression(init) || ts.isSatisfiesExpression(init)) {
          init = init.expression;
        }
        if (ts.isArrayLiteralExpression(init)) registryArray = init;
      }
    }
  }
  if (!registryArray) {
    throw new R4RegistryParseError(
      "ORG_WRITE_REGISTRY array literal not found — registry shape changed",
    );
  }

  const asString = (n, ctx) => {
    if (!n || !ts.isStringLiteralLike(n)) {
      throw new R4RegistryParseError(`non-literal ${ctx} at L${n ? lineOf(n) : "?"}`);
    }
    return n.text;
  };
  // A string literal OR a bare identifier referencing a top-level string const
  // (the rows write `module: DASHBOARDS_MODULE`). Anything else fails closed.
  const asStringOrConst = (n, ctx) => {
    if (n && ts.isIdentifier(n) && stringConsts.has(n.text)) {
      return stringConsts.get(n.text);
    }
    return asString(n, ctx);
  };
  const asBool = (n, ctx) => {
    if (n && n.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (n && n.kind === ts.SyntaxKind.FalseKeyword) return false;
    throw new R4RegistryParseError(`non-literal ${ctx} at L${n ? lineOf(n) : "?"}`);
  };
  const asStringArray = (n, ctx) => {
    if (!n || !ts.isArrayLiteralExpression(n)) {
      throw new R4RegistryParseError(`non-literal ${ctx} at L${n ? lineOf(n) : "?"}`);
    }
    return n.elements.map((e) => asString(e, `${ctx} element`));
  };
  const asExemption = (n) => {
    if (!n || !ts.isObjectLiteralExpression(n)) {
      throw new R4RegistryParseError(`non-literal importBanExemption at L${n ? lineOf(n) : "?"}`);
    }
    let issue, reason;
    for (const p of n.properties) {
      if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) {
        throw new R4RegistryParseError(`non-literal importBanExemption member at L${lineOf(p)}`);
      }
      if (p.name.text === "issue") {
        if (!ts.isNumericLiteral(p.initializer)) {
          throw new R4RegistryParseError(`non-literal importBanExemption.issue at L${lineOf(p)}`);
        }
        issue = Number(p.initializer.text);
      } else if (p.name.text === "reason") {
        reason = asString(p.initializer, "importBanExemption.reason");
      }
    }
    if (typeof issue !== "number" || typeof reason !== "string") {
      throw new R4RegistryParseError(`incomplete importBanExemption at L${lineOf(n)}`);
    }
    return { issue, reason };
  };
  // Reads module / exportName / importBanned / allowedImporters /
  // importBanExemption out of an object literal (a registry row body, or a
  // dashboardsWriter `ban` argument). Only literal-readable fields are returned;
  // `importBanned` is NOT defaulted — a row that omits it is rejected by the
  // caller (fail-closed; a defaulted `false` would silently un-ban).
  const readBanFields = (obj) => {
    const out = {};
    for (const p of obj.properties) {
      if (ts.isSpreadAssignment(p)) {
        throw new R4RegistryParseError(`spread in registry row at L${lineOf(p)}`);
      }
      if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) {
        // Shorthand / computed / accessor properties defeat literal extraction.
        throw new R4RegistryParseError(`non-literal registry property at L${lineOf(p)}`);
      }
      const key = p.name.text;
      if (key === "module") out.module = asStringOrConst(p.initializer, "module");
      else if (key === "exportName") out.exportName = asString(p.initializer, "exportName");
      else if (key === "importBanned") out.importBanned = asBool(p.initializer, "importBanned");
      else if (key === "allowedImporters") out.allowedImporters = asStringArray(p.initializer, "allowedImporters");
      else if (key === "importBanExemption") out.importBanExemption = asExemption(p.initializer);
      // Every OTHER field (capability, orgIdExtractor, storageReferences,
      // cascadeOwnership, writeSites, conditionalCapabilities) may legally use
      // spreads/consts INSIDE its own value — we never read them, so they can't
      // drop a rule.
    }
    return out;
  };
  const requireLiteralBan = (row, where) => {
    if (typeof row.importBanned !== "boolean") {
      throw new R4RegistryParseError(`registry row missing literal importBanned (${where})`);
    }
  };

  const rows = [];
  for (const el of registryArray.elements) {
    if (ts.isObjectLiteralExpression(el)) {
      const row = readBanFields(el);
      if (typeof row.module !== "string" || typeof row.exportName !== "string") {
        throw new R4RegistryParseError(`registry row missing literal module/exportName at L${lineOf(el)}`);
      }
      requireLiteralBan(row, `L${lineOf(el)}`);
      rows.push(row);
    } else if (
      ts.isCallExpression(el) &&
      ts.isIdentifier(el.expression) &&
      el.expression.text === "dashboardsWriter"
    ) {
      const dashModule = stringConsts.get("DASHBOARDS_MODULE");
      if (!dashModule) {
        throw new R4RegistryParseError("DASHBOARDS_MODULE string const not found");
      }
      const exportName = asString(el.arguments[0], "dashboardsWriter exportName");
      const banArg = el.arguments[4];
      if (!banArg || !ts.isObjectLiteralExpression(banArg)) {
        throw new R4RegistryParseError(`dashboardsWriter("${exportName}") missing literal ban argument at L${lineOf(el)}`);
      }
      const ban = readBanFields(banArg);
      requireLiteralBan(ban, `dashboardsWriter("${exportName}")`);
      rows.push({ module: dashModule, exportName, ...ban });
    } else {
      throw new R4RegistryParseError(`non-literal registry row at L${lineOf(el)}`);
    }
  }
  return rows;
}

/** Build a `(specifier, containingFileAbs) => repoRelativeModule|null` resolver
 *  that uses the real TypeScript resolver against the repo tsconfig — paths
 *  aliases AND workspace-package `exports`/subpaths are handled by ts, then
 *  realpath-canonicalized so symlinked / exports-map detours cannot dodge the
 *  `module` comparison. node_modules / out-of-repo resolutions return null. */
export function makeTsResolver(repoRoot = REPO_ROOT) {
  const configPath = join(repoRoot, "tsconfig.json");
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  // Fail-closed on a missing/unreadable/malformed tsconfig. A swallowed error
  // here yields default options with NO `paths`, so every aliased specifier
  // resolves to null and its OPAQUE-access edges (namespace / bare / dynamic /
  // require) are silently skipped — the gate would go green for the wrong
  // reason. Surface both TS error channels, exactly as main() already fails
  // closed on an unreadable registry.
  if (configFile.error) {
    throw new Error(
      `org-write-boundary-gate: cannot read ${configPath} (fail-closed) — ${ts.flattenDiagnosticMessageText(configFile.error.messageText, " ")}`,
    );
  }
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, repoRoot);
  // TS18002 (empty files list) / TS18003 (no inputs found) describe the compile
  // FILE LIST, not module resolution — irrelevant to a resolver that never
  // compiles. Any OTHER diagnostic (bad `extends`, invalid `paths`, a bogus
  // option value, …) means the compilerOptions the resolver trusts are
  // unreliable → fail closed.
  const optionErrors = parsed.errors.filter((d) => d.code !== 18002 && d.code !== 18003);
  if (optionErrors.length > 0) {
    throw new Error(
      `org-write-boundary-gate: invalid tsconfig (fail-closed) — ${optionErrors
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "))
        .join("; ")}`,
    );
  }
  const options = parsed.options;
  const cache = ts.createModuleResolutionCache(repoRoot, (x) => x, options);
  return (specifier, containingFileAbs) => {
    const r = ts.resolveModuleName(specifier, containingFileAbs, options, ts.sys, cache);
    const resolved = r.resolvedModule?.resolvedFileName;
    if (!resolved) return null;
    let rel;
    try {
      rel = relative(repoRoot, realpathSync(resolved));
    } catch {
      rel = relative(repoRoot, resolved);
    }
    if (rel.startsWith("..")) return null; // outside the repo
    if (rel.split(sep).includes("node_modules")) return null;
    return rel;
  };
}

/**
 * Evaluate the R4 writer-import ban over the whole module graph. Pure — the
 * caller supplies the parsed edges and a resolver, so this is unit-testable
 * with in-memory fixtures.
 *
 * @param bannedRows [{ module, exportName, allowedImporters:[...] }] — the
 *   importBanned rows (repo-relative `module`, repo-relative allowlist entries).
 * @param files      [{ fileRel, edges }] — edges from collectModuleEdges.
 * @param resolve    (fromFileRel, specifier) => repoRelativeModule | null.
 */
export function evaluateR4(bannedRows, files, resolve) {
  const SEP = " ";
  const keyOf = (mod, binding) => mod + SEP + binding;

  // Poisoned set: (module|barrel, binding) -> { originModule, originBinding, allow:Set }.
  // Seeded from the banned rows; propagated to fixpoint over re-export edges.
  const poisoned = new Map();
  for (const r of bannedRows) {
    poisoned.set(keyOf(r.module, r.exportName), {
      originModule: r.module,
      originBinding: r.exportName,
      allow: new Set(r.allowedImporters ?? []),
    });
  }

  // Transitive re-export closure: a file whose value re-export chain reaches a
  // banned (module, binding) becomes itself a banned SOURCE for that binding.
  let changed = true;
  while (changed) {
    changed = false;
    for (const { fileRel, edges } of files) {
      for (const e of edges) {
        if (e.kind !== "export" || !e.isValueEdge) continue; // re-exports only
        if (e.namespaceReexport) continue; // handled in the namespace-bundle pass
        const target = resolve(fileRel, e.specifier);
        if (!target) continue;
        const sources = e.valueBindings.filter((b) => !b.startsWith("* as "));
        // `export * from` re-exports EVERY binding of the target under its own
        // name — fail-closed: poison every banned binding of the target here.
        const isStar =
          e.valueBindings.length === 0 || sources.length !== e.valueBindings.length;
        // poison (fileRel, exportedName) when (target, sourceName) is banned —
        // exportedName may differ from sourceName under aliasing.
        const propagate = (sourceName, exportedName) => {
          const src = poisoned.get(keyOf(target, sourceName));
          if (!src) return;
          const nk = keyOf(fileRel, exportedName);
          if (poisoned.has(nk)) return;
          poisoned.set(nk, {
            originModule: src.originModule,
            originBinding: src.originBinding,
            allow: src.allow,
          });
          changed = true;
        };
        if (isStar) {
          // `export *` re-exposes each binding under its OWN name.
          for (const [k] of poisoned) {
            const [mod, binding] = k.split(SEP);
            if (mod === target) propagate(binding, binding);
          }
        } else {
          const exported = e.exportedNames ?? e.valueBindings;
          for (let i = 0; i < e.valueBindings.length; i++) {
            const s = e.valueBindings[i];
            if (s.startsWith("* as ")) continue;
            propagate(s, exported[i] ?? s);
          }
        }
      }
    }
  }

  // Namespace-bundle re-exports (`export * as ns from S`): a named import of `ns`
  // is opaque access to S, so poison (barrel, ns) with the INTERSECTION of S's
  // banned rows' allowlists — importing the bundle requires clearance for every
  // banned writer it carries, exactly as a direct opaque import of S would
  // Run once over the settled poison set. (Chained namespace
  // re-exports are not followed — the re-exporting barrel is still flagged as an
  // opaque violation, so nothing silently un-bans.)
  for (const { fileRel, edges } of files) {
    for (const e of edges) {
      if (e.kind !== "export" || !e.isValueEdge || !e.namespaceReexport) continue;
      const target = resolve(fileRel, e.specifier);
      if (!target) continue;
      const metas = [];
      for (const [k, meta] of poisoned) {
        if (k.startsWith(target + SEP)) metas.push(meta);
      }
      if (metas.length === 0) continue;
      let allow = null;
      for (const m of metas) {
        allow = allow === null ? new Set(m.allow) : new Set([...allow].filter((f) => m.allow.has(f)));
      }
      poisoned.set(keyOf(fileRel, e.namespaceReexport), {
        originModule: target,
        originBinding: `* as ${e.namespaceReexport}`,
        allow: allow ?? new Set(),
      });
    }
  }

  // Owner-package prefixes for the fail-closed "unresolvable specifier that
  // textually names an owning package" net.
  const ownerPrefixes = new Set();
  for (const r of bannedRows) {
    if (r.module.startsWith("packages" + sep)) {
      ownerPrefixes.add("@cinatra-ai/" + r.module.split(sep)[1]);
    } else if (r.module.startsWith("src" + sep)) {
      ownerPrefixes.add("@/");
    }
  }
  const bannedNames = new Set(bannedRows.map((r) => r.exportName));

  const violations = [];
  for (const { fileRel, edges } of files) {
    if (isTestFileRel(fileRel)) continue; // R4-exempt
    for (const e of edges) {
      if (!e.isValueEdge) continue;
      const target = resolve(fileRel, e.specifier);
      // A value edge NAMES bindings (static import/re-export, or a destructured
      // dynamic import()/require()) OR is OPAQUE — namespace (`* as`),
      // bindingless bare import, namespace-bound dynamic import()/require(), or
      // CJS import-equals (all now carry empty valueBindings).
      const named = e.valueBindings.filter((b) => !b.startsWith("* as "));
      const isOpaque =
        e.valueBindings.length === 0 ||
        e.valueBindings.some((b) => b.startsWith("* as "));

      if (target) {
        for (const b of named) {
          const meta = poisoned.get(keyOf(target, b));
          if (meta && !meta.allow.has(fileRel)) {
            violations.push({
              rule: "R4-writer-import",
              fileRel,
              specifier: e.specifier,
              line: e.line,
              kind: e.kind,
              writer: `${meta.originModule}#${meta.originBinding}`,
            });
          }
        }
        // Opaque net (namespace / bare / dynamic / require / CJS) — an opaque
        // reference grants access to EVERY export, so it can reach a banned
        // writer without naming it. Fail-closed on any module that carries a
        // banned/poisoned binding, whether an ORIGIN writer module OR a poisoned
        // re-export barrel (R2/R3 discipline generalized). Because
        // opaque access reaches ALL of that module's banned writers, the file
        // must be allowlisted for EVERY one of them (intersection, not union —
        // an allowlist entry for one writer must not silently unlock its
        // module-mates via a namespace import).
        if (isOpaque) {
          const hits = [];
          for (const [k, meta] of poisoned) {
            if (k.startsWith(target + SEP)) hits.push(meta);
          }
          if (hits.length && !hits.every((m) => m.allow.has(fileRel))) {
            violations.push({
              rule: "R4-writer-import-opaque",
              fileRel,
              specifier: e.specifier,
              line: e.line,
              kind: e.kind,
              writer: [...new Set(hits.map((m) => `${m.originModule}#${m.originBinding}`))].sort().join(", "),
            });
          }
        }
      } else if (!e.specifier.startsWith(".") && named.length > 0) {
        // Unresolvable package specifier that TEXTUALLY names an owning package
        // AND NAMES a banned writer → fail-closed. Scoped
        // to named imports of a banned binding: an unresolvable OPAQUE specifier
        // cannot be shown to target a banned module (it targets some unlisted
        // subpath), so flagging it would be noise, not coverage.
        const namesOwner = [...ownerPrefixes].some(
          (p) => e.specifier === p || e.specifier.startsWith(p.endsWith("/") ? p : p + "/"),
        );
        if (namesOwner) {
          for (const b of named) {
            if (bannedNames.has(b)) {
              violations.push({
                rule: "R4-writer-import",
                fileRel,
                specifier: e.specifier,
                line: e.line,
                kind: e.kind,
                writer: `?#${b}`,
              });
            }
          }
        }
      }
    }
  }
  return violations;
}

function main() {
  const listMode = process.argv.includes("--list");
  const emitR4Mode = process.argv.includes("--emit-r4-rules");
  const r4ReportMode = process.argv.includes("--r4-report");

  // --- Parse the registry (fail-closed: an unreadable row exits 1) ---
  let r4rows;
  try {
    r4rows = extractR4Rules(readFileSync(join(REPO_ROOT, REGISTRY_REL), "utf-8"));
  } catch (err) {
    console.error(
      `org-write-boundary-gate: R4 registry parse FAILED (fail-closed): ${err.message}`,
    );
    process.exit(1);
  }

  if (emitR4Mode) {
    // Deterministic JSON — the write-registry lockstep test compares this
    // against the executed registry so parser drift cannot silently un-ban.
    const out = r4rows
      .map((r) => ({
        module: r.module,
        exportName: r.exportName,
        importBanned: r.importBanned,
        allowedImporters: r.allowedImporters ? [...r.allowedImporters].sort() : null,
        importBanExemption: r.importBanExemption ?? null,
      }))
      .sort((a, b) => (a.module + "#" + a.exportName).localeCompare(b.module + "#" + b.exportName));
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  const resolveAbs = makeTsResolver();
  const resolveRel = (fromRel, spec) => resolveAbs(spec, join(REPO_ROOT, fromRel));

  // --- Walk once; collect edges for EVERY file (R4 needs the full re-export
  //     graph), and run the legacy R1/R2/R3/R5 rules on the surface-touching
  //     subset (unchanged prefilter → unchanged behavior). ---
  const seen = new Set();
  const r4files = [];
  const legacyViolations = [];
  for (const root of SCAN_ROOTS) {
    const rootAbs = join(REPO_ROOT, root);
    if (!existsSync(rootAbs)) continue;
    for (const fileAbs of walkFiles(rootAbs)) {
      const fileRel = canonicalRel(fileAbs);
      if (seen.has(fileRel)) continue; // realpath dedupe (symlinked copies)
      seen.add(fileRel);
      if (fileRel === join("scripts", "audit", "org-write-boundary-gate.mjs")) continue;
      const text = readFileSync(fileAbs, "utf-8");
      const edges = collectModuleEdges(fileAbs, text);
      r4files.push({ fileRel, edges });
      if (
        text.includes("org-write-kernel") ||
        text.includes("mintSystemWriteAuthority") ||
        text.includes("guardedBatchQueries")
      ) {
        if (listMode) {
          for (const e of edges) {
            if (e.specifier.includes("org-write")) {
              console.log(`${fileRel}:${e.line} [${e.kind}${e.isValueEdge ? "" : " type-only"}] ${e.specifier} {${e.valueBindings.join(", ")}}`);
            }
          }
        }
        legacyViolations.push(...evaluateBoundaryRules(fileRel, edges, makeResolver(fileAbs)));
      }
    }
  }

  if (r4ReportMode) {
    // Treat EVERY registered writer as banned-with-empty-allowlist and report
    // its current importers — the allowlist-derivation aid the design calls
    // "mechanically derived from the gate's --list output, reviewed once".
    const allAsBanned = r4rows.map((r) => ({
      module: r.module,
      exportName: r.exportName,
      allowedImporters: [],
    }));
    const report = {};
    for (const v of evaluateR4(allAsBanned, r4files, resolveRel)) {
      (report[v.writer] ??= new Set()).add(v.fileRel);
    }
    const out = {};
    for (const w of Object.keys(report).sort()) out[w] = [...report[w]].sort();
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  const bannedRows = r4rows
    .filter((r) => r.importBanned)
    .map((r) => ({
      module: r.module,
      exportName: r.exportName,
      allowedImporters: r.allowedImporters ?? [],
    }));
  const r4Violations = evaluateR4(bannedRows, r4files, resolveRel);

  const allViolations = [...legacyViolations, ...r4Violations];
  if (allViolations.length > 0) {
    console.error(`org-write-boundary-gate: ${allViolations.length} violation(s):`);
    for (const v of allViolations) {
      console.error(
        `  [${v.rule}] ${v.fileRel}:${v.line} ${v.kind} "${v.specifier}"${v.resolved ? ` -> ${v.resolved}` : ""}${v.writer ? ` (writer ${v.writer})` : ""}${v.valueBindings?.length ? ` {${v.valueBindings.join(", ")}}` : ""}`,
      );
    }
    if (r4Violations.length > 0) {
      console.error(`\norg-write-boundary-gate: R4 — ${R4_FIX_HINT}`);
    }
    process.exit(1);
  }
  console.log(
    `org-write-boundary-gate: OK (${seen.size} file(s) scanned; R4 ${bannedRows.length} banned / ${r4rows.length} registry rows; 0 violations)`,
  );
}

const isMain = (() => {
  try {
    return import.meta.url === new URL(`file://${realpathSync(process.argv[1])}`).href
      || resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (isMain) main();
