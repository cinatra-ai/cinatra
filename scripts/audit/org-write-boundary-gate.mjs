#!/usr/bin/env node
// CI gate: the org-write kernel boundary — cinatra#1938 (archive epic S2).
//
// The kernel's enforcement value rests on writers being UNCALLABLE except
// through the guarded entry points. This gate pins three structural rules
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
//       is EMPTY until S4 wires the dispatcher (tests under
//       src/lib/org-write/__tests__/ are exempt by scope rule).
//   R3  single unwrap consumer: a value import of the `guardedBatchQueries`
//       binding outside the kernel itself is legal ONLY in
//       src/lib/org-write/batch-wrapper.ts (the transaction-forcing wrapper).
//
// Zero-baseline gate: there is no ratchet file — the honest surface is empty
// and must stay empty. Scan scope is src/ + packages/ + scripts/ (extensions
// are separate repos already barred from host-internal specifiers by
// extension-import-ban; this gate does not require them cloned).
//
// Usage:
//   node scripts/audit/org-write-boundary-gate.mjs           # check (exit 1 on violations)
//   node scripts/audit/org-write-boundary-gate.mjs --list    # print every scanned edge that touches the kernel surface

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
export const SYSTEM_MINT_ALLOWLIST = new Set([]);

/** R3: the one legal unwrap consumer outside the kernel. */
export const BATCH_UNWRAP_ALLOWLIST = new Set([
  join("src", "lib", "org-write", "batch-wrapper.ts"),
]);

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
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          if (el.isTypeOnly) continue;
          valueBindings.push(el.propertyName?.text ?? el.name.text);
        }
      }
      out.push({ specifier, valueBindings, isValueEdge: true, kind: "export", line });
      continue;
    }
    if (
      ts.isImportEqualsDeclaration(stmt) &&
      !stmt.isTypeOnly &&
      ts.isExternalModuleReference(stmt.moduleReference) &&
      stmt.moduleReference.expression &&
      ts.isStringLiteralLike(stmt.moduleReference.expression)
    ) {
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

function main() {
  const listMode = process.argv.includes("--list");
  const seen = new Set();
  const allViolations = [];
  let scanned = 0;

  for (const root of SCAN_ROOTS) {
    const rootAbs = join(REPO_ROOT, root);
    if (!existsSync(rootAbs)) continue;
    for (const fileAbs of walkFiles(rootAbs)) {
      const fileRel = canonicalRel(fileAbs);
      if (seen.has(fileRel)) continue; // realpath dedupe (symlinked copies)
      seen.add(fileRel);
      if (fileRel === join("scripts", "audit", "org-write-boundary-gate.mjs")) continue;
      const text = readFileSync(fileAbs, "utf-8");
      // Cheap prefilter: only parse files that mention the surface at all.
      if (
        !text.includes("org-write-kernel") &&
        !text.includes("mintSystemWriteAuthority") &&
        !text.includes("guardedBatchQueries")
      ) {
        continue;
      }
      scanned += 1;
      const edges = collectModuleEdges(fileAbs, text);
      if (listMode) {
        for (const e of edges) {
          if (e.specifier.includes("org-write")) {
            console.log(`${fileRel}:${e.line} [${e.kind}${e.isValueEdge ? "" : " type-only"}] ${e.specifier} {${e.valueBindings.join(", ")}}`);
          }
        }
      }
      allViolations.push(...evaluateBoundaryRules(fileRel, edges, makeResolver(fileAbs)));
    }
  }

  if (allViolations.length > 0) {
    console.error(`org-write-boundary-gate: ${allViolations.length} violation(s):`);
    for (const v of allViolations) {
      console.error(
        `  [${v.rule}] ${v.fileRel}:${v.line} ${v.kind} "${v.specifier}"${v.resolved ? ` -> ${v.resolved}` : ""}${v.valueBindings.length ? ` {${v.valueBindings.join(", ")}}` : ""}`,
      );
    }
    process.exit(1);
  }
  console.log(`org-write-boundary-gate: OK (${scanned} surface-touching file(s) parsed, 0 violations)`);
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
