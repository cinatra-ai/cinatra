#!/usr/bin/env node
/**
 * G4 addendum — the VARIABLE-URL dynamic-import ratchet (epic #1620 M1 Slice A —
 * cinatra#1630, plan §2.4 / §5.3-G4, Codex R3/G4).
 *
 * The main-realm dynamic loader is the ONE sanctioned runtime seam that does a
 * variable-URL `import(runtimeURL)` (the whole point: a RUNTIME URL bypasses
 * Turbopack's literal-import constraint and keeps the generated-map static-import
 * carve-out structurally intact). This ratchet forbids a variable-URL `import()`
 * ANYWHERE ELSE in `src/**`, so no other site can smuggle in an
 * arbitrary/computed dynamic import under the loader's cover.
 *
 * AST-BASED (the `typescript` compiler API, never a regex — a literal
 * `import()` is routinely wrapped across lines, which a regex misreads): a
 * dynamic import is a `CallExpression` whose expression is the `import` keyword;
 * its argument is ALLOWED only when it is a string literal or a
 * no-substitution template literal. Any other argument (an identifier, a
 * property access, a template with substitutions, a call) is a VARIABLE-URL
 * import and is a finding — UNLESS the file is the single sanctioned loader
 * seam.
 *
 * Zero-tolerance: there is NO baseline. The sanctioned allowlist is exactly the
 * client loader file. Node-builtins + `typescript` only. Offline.
 *   exit 0 = clean, 1 = findings, 2 = scanner error.
 *
 * Usage:
 *   node scripts/audit/no-variable-url-dynamic-import.mjs           # gate (CI)
 *   node scripts/audit/no-variable-url-dynamic-import.mjs --report  # list findings
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const SCAN_ROOT = join(REPO_ROOT, "src");

/**
 * The sanctioned variable-URL `import()` seams (repo-relative, POSIX). Each is a
 * RUNTIME-STORE loader that imports an admitted, content-addressed, host-verified
 * bundle by its store file URL — the deliberate `import(pathToFileURL(...).href)`
 * pattern that bypasses Turbopack's literal-import constraint:
 *   - the SERVER runtime-package loaders (the pre-existing seam that mounts
 *     materialized server entries from the content-addressed store);
 *   - the CLIENT loader seam this slice adds (the main-realm dynamic renderer
 *     `import(digestPinnedUrl)` — plan §2.4/G4).
 * Adding a NEW variable-URL import ANYWHERE ELSE fails this ratchet.
 */
export const SANCTIONED_VARIABLE_URL_IMPORT_FILES = Object.freeze([
  // Server-side runtime-store loaders (pre-existing sanctioned seam).
  "src/lib/extension-runtime-activate.ts",
  "src/lib/runtime-package-loader.ts",
  "src/lib/widget-stream-agents.server.ts",
  // The main-realm dynamic renderer client loader (this slice).
  "src/app/artifacts/[id]/dynamic-renderer-loader.tsx",
]);

const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

function isScannableFile(name) {
  if (name.endsWith(".d.ts")) return false;
  const dot = name.lastIndexOf(".");
  return dot > 0 && SCAN_EXTENSIONS.has(name.slice(dot));
}

function isExcludedDir(name) {
  return name === "node_modules" || name === "__tests__" || name === "generated";
}

/** Walk a dir tree, yielding scannable source file absolute paths. */
export function* walkSourceFiles(root) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = join(root, e.name);
    if (e.isDirectory()) {
      if (isExcludedDir(e.name)) continue;
      yield* walkSourceFiles(abs);
    } else if (e.isFile() && isScannableFile(e.name)) {
      yield abs;
    }
  }
}

/** True iff a dynamic-import argument node is a permitted LITERAL specifier. */
function isLiteralSpecifier(arg) {
  return arg !== undefined && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg));
}

/**
 * Detect variable-URL dynamic imports in a source file. Returns an array of
 * `{ line, snippet }` findings (0 = clean). Pure — takes text + a display path.
 */
export function detectVariableUrlDynamicImports(sourceText, displayPath) {
  const sf = ts.createSourceFile(displayPath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const arg = node.arguments[0];
      if (!isLiteralSpecifier(arg)) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        findings.push({
          line: line + 1,
          snippet: node.getText(sf).slice(0, 120).replace(/\s+/g, " "),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

/** Scan `src/**`; returns findings for files NOT on the sanctioned allowlist. */
export function scanRepo(root = SCAN_ROOT) {
  const sanctioned = new Set(SANCTIONED_VARIABLE_URL_IMPORT_FILES);
  const results = [];
  for (const abs of walkSourceFiles(root)) {
    const rel = relative(REPO_ROOT, abs).split("\\").join("/");
    if (sanctioned.has(rel)) continue;
    const findings = detectVariableUrlDynamicImports(readFileSync(abs, "utf8"), rel);
    for (const f of findings) results.push({ file: rel, ...f });
  }
  return results;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  try {
    const findings = scanRepo();
    if (findings.length === 0) {
      process.stdout.write(
        `[no-variable-url-dynamic-import] clean — the only sanctioned variable-URL import() is ${SANCTIONED_VARIABLE_URL_IMPORT_FILES.join(", ")}.\n`,
      );
      process.exit(0);
    }
    process.stderr.write(
      `[no-variable-url-dynamic-import] ${findings.length} forbidden variable-URL import() site(s) ` +
        `(only the sanctioned client loader seam may use a runtime-URL import — plan §2.4/G4):\n`,
    );
    for (const f of findings) process.stderr.write(`  ${f.file}:${f.line}  ${f.snippet}\n`);
    process.exit(1);
  } catch (err) {
    process.stderr.write(`[no-variable-url-dynamic-import] scanner error: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(2);
  }
}
