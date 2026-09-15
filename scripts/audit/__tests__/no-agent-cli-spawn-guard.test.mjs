// Guard: no product module may hand caller-supplied text to an interactive
// agent command line as part of a spawned process.
//
// Why: two orphaned modules under src/lib once shelled out to a locally
// installed agent command line, passing chat text that arrives from a request
// straight through as a process argument. Nothing imported them, so nothing
// caught the shape. Reintroducing that shape — anywhere under src/ or
// packages/ — turns request text into argv for a long-lived interactive tool
// that reads the local filesystem and the local login session of whatever
// account the server runs as.
//
// The guard is STRUCTURAL. It parses every TRACKED source file under src/ and
// packages/ with the TypeScript parser and reports a call when ALL of:
//
//   (a) the callee RESOLVES, inside that file, to a process-spawning binding —
//       a named/aliased/namespaced/destructured import or require of
//       child_process (or of a process-runner package). A method named `spawn`
//       on an unrelated object is NOT a spawner, which is what keeps the guard
//       from reddening the tier on unrelated code; and
//   (b) the command names a denylisted agent CLI — directly, through a
//       single-assignment string constant, through a path or file extension,
//       case-insensitively, or nested behind a shell/launcher wrapper
//       (`sh -c`, `env`, `npx`, …) or inside a shell command string; and
//   (c) the invocation carries at least one non-literal argument — the
//       caller-supplied text.
//
// A fully literal invocation is deliberately not flagged: it carries no caller
// text. Conversely, ANY non-literal argument counts as caller-supplied: the
// guard does no data-flow analysis, and "this variable happens to be trusted"
// is exactly the claim that a static gate cannot check and that the two removed
// modules would have made about themselves. The escape hatch is to build the
// argument list from literals, not to argue about provenance.
//
// Two limits are stated rather than hidden: a command name that cannot be
// resolved to a literal at all (a function return, a config lookup) is not
// flagged, and neither is a spawner reached through a re-export chain in
// another module. Both are beyond a single-file syntactic pass.
//
// The tree file set comes from `git ls-files`, not from a directory walk with a
// skip list: build output is untracked, so tracking is the exact boundary, and
// no legitimate source directory can be lost by sharing a name with one.

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

/** Interactive agent command lines that must never receive caller text. */
const AGENT_CLIS = new Set(["codex", "gemini", "claude", "aider", "cursor"]);

/** Commands that run ANOTHER command named in their own argv. */
const WRAPPER_COMMANDS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ash",
  "env",
  "nice",
  "sudo",
  "xargs",
  "npx",
  "pnpx",
  "bunx",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "dlx",
  "script",
  "stdbuf",
  "nohup",
  "time",
]);

/** Modules whose exports start a process. */
const SPAWNER_MODULES = new Set([
  "child_process",
  "node:child_process",
  "cross-spawn",
  "execa",
  "tinyexec",
]);

/** Exported names that take (command, argvArray, options). */
const ARGV_SPAWNERS = new Set([
  "spawn",
  "spawnSync",
  "execFile",
  "execFileSync",
  "execa",
  "execaSync",
  "execaNode",
  "x",
]);

/** Exported names that take one whole command STRING. */
const SHELL_SPAWNERS = new Set([
  "exec",
  "execSync",
  "execaCommand",
  "execaCommandSync",
  "$",
]);

const SPAWNER_NAMES = new Set([...ARGV_SPAWNERS, ...SHELL_SPAWNERS]);

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

// ---------------------------------------------------------------------------
// File sets
// ---------------------------------------------------------------------------

/** Every TRACKED source file under the given repo-relative roots. */
function trackedSourceFiles(repoRoot, roots) {
  const stdout = execFileSync("git", ["ls-files", "-z", "--", ...roots], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout
    .split("\0")
    .filter((relative) => relative && SOURCE_EXTENSIONS.has(path.extname(relative)))
    .map((relative) => path.join(repoRoot, relative))
    // A tracked path deleted in the working tree spawns nothing.
    .filter((full) => existsSync(full));
}

/**
 * Disk walk, used for the FIXTURE trees only (they are not in git). It skips
 * nothing but the two directories a fixture tree can never legitimately hold,
 * and a directory it cannot read is an error, not an empty subtree.
 */
function walkSourceFiles(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        walk(full);
      } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        found.push(full);
      }
    }
  };
  walk(root);
  return found;
}

// ---------------------------------------------------------------------------
// Literal reading
// ---------------------------------------------------------------------------

function literalText(node) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

/** "/usr/local/bin/Codex.exe" -> "codex" */
function commandBasename(command) {
  const base = String(command).trim().split(/[\\/]/).pop() ?? "";
  return base.replace(/\.(exe|cmd|bat|ps1|js|mjs|cjs)$/i, "").toLowerCase();
}

function moduleSpecifier(node) {
  const text = literalText(node);
  return text === null ? null : text;
}

/** `require("child_process")` or `await import("child_process")` */
function spawnerModuleOfInitializer(node) {
  if (!node) return null;
  if (ts.isAwaitExpression(node)) return spawnerModuleOfInitializer(node.expression);
  if (ts.isParenthesizedExpression(node)) return spawnerModuleOfInitializer(node.expression);
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    const isRequire = ts.isIdentifier(callee) && callee.text === "require";
    const isImport = callee.kind === ts.SyntaxKind.ImportKeyword;
    if (isRequire || isImport) {
      const specifier = moduleSpecifier(node.arguments[0]);
      if (specifier !== null && SPAWNER_MODULES.has(specifier)) return specifier;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-file binding tables
// ---------------------------------------------------------------------------

/**
 * Resolve, for one file:
 *   spawners   local identifier -> canonical spawner name ("spawn", "exec", …)
 *   namespaces local identifier bound to a whole spawner module
 *   strings    single-assignment const -> its literal text (ambiguous names dropped)
 */
function collectBindings(source) {
  const spawners = new Map();
  const namespaces = new Set();
  const strings = new Map();
  const ambiguous = new Set();

  const noteString = (name, value) => {
    if (ambiguous.has(name)) return;
    if (strings.has(name) && strings.get(name) !== value) {
      strings.delete(name);
      ambiguous.add(name);
      return;
    }
    strings.set(name, value);
  };

  const noteSpawnerBinding = (localName, exportedName) => {
    const canonical = SPAWNER_NAMES.has(exportedName) ? exportedName : null;
    if (canonical) spawners.set(localName, canonical);
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node) && node.importClause) {
      const specifier = moduleSpecifier(node.moduleSpecifier);
      if (specifier !== null && SPAWNER_MODULES.has(specifier)) {
        const clause = node.importClause;
        // `import spawn from "cross-spawn"` — the default IS the spawner.
        if (clause.name && specifier === "cross-spawn") spawners.set(clause.name.text, "spawn");
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            noteSpawnerBinding(element.name.text, (element.propertyName ?? element.name).text);
          }
        }
      }
    }

    if (ts.isVariableDeclaration(node) && node.initializer) {
      const fromModule = spawnerModuleOfInitializer(node.initializer);
      if (fromModule !== null) {
        if (ts.isIdentifier(node.name)) namespaces.add(node.name.text);
        if (ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            if (!ts.isIdentifier(element.name)) continue;
            const exported = element.propertyName && ts.isIdentifier(element.propertyName)
              ? element.propertyName.text
              : element.name.text;
            noteSpawnerBinding(element.name.text, exported);
          }
        }
      }

      if (ts.isIdentifier(node.name)) {
        // `const launch = cp.spawn` / `const launch = spawn`
        const initializer = node.initializer;
        if (ts.isPropertyAccessExpression(initializer) && ts.isIdentifier(initializer.expression)) {
          if (namespaces.has(initializer.expression.text)) {
            noteSpawnerBinding(node.name.text, initializer.name.text);
          }
        } else if (ts.isIdentifier(initializer) && spawners.has(initializer.text)) {
          spawners.set(node.name.text, spawners.get(initializer.text));
        }
        // `const cli = "codex"` / `const command = `codex exec ${p}``
        const text = literalText(initializer);
        if (text !== null) noteString(node.name.text, text);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
  return { spawners, namespaces, strings };
}

/** The canonical spawner this callee resolves to, or null. */
function resolveSpawner(expression, bindings) {
  if (ts.isIdentifier(expression)) return bindings.spawners.get(expression.text) ?? null;
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
    if (!bindings.namespaces.has(expression.expression.text)) return null;
    const name = expression.name.text;
    return SPAWNER_NAMES.has(name) ? name : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reading an expression as "literal pieces + did anything dynamic reach it"
// ---------------------------------------------------------------------------

/** @returns {{pieces: string[], dynamic: boolean}} */
function readPieces(node, bindings, depth = 0) {
  const empty = { pieces: [], dynamic: true };
  if (!node || depth > 8) return empty;

  const direct = literalText(node);
  if (direct !== null) return { pieces: [direct], dynamic: false };

  if (ts.isParenthesizedExpression(node)) return readPieces(node.expression, bindings, depth + 1);

  if (ts.isIdentifier(node)) {
    const known = bindings.strings.get(node.text);
    if (known !== undefined) return { pieces: [known], dynamic: false };
    // A const bound to a TEMPLATE keeps its literal spans; see below.
    const template = bindings.templates?.get(node.text);
    if (template) return template;
    return empty;
  }

  if (ts.isTemplateExpression(node)) {
    const pieces = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)];
    return { pieces, dynamic: true };
  }

  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = readPieces(node.left, bindings, depth + 1);
    const right = readPieces(node.right, bindings, depth + 1);
    return { pieces: [...left.pieces, ...right.pieces], dynamic: left.dynamic || right.dynamic };
  }

  return empty;
}

/** Every command-position token in a shell fragment. */
function shellTokens(text) {
  return String(text)
    .split(/[\s;|&()<>]+|&&|\|\|/)
    .filter(Boolean)
    .map((token) => token.replace(/^["']|["']$/g, ""));
}

function denylistedIn(pieces) {
  for (const piece of pieces) {
    for (const token of shellTokens(piece)) {
      const base = commandBasename(token);
      if (AGENT_CLIS.has(base)) return base;
    }
  }
  return null;
}

/** Does this argv expression carry at least one non-literal element? */
function argvCarriesNonLiteral(argvNode, bindings) {
  if (!argvNode) return false;
  if (ts.isArrayLiteralExpression(argvNode)) {
    return argvNode.elements.some((element) => readPieces(element, bindings).dynamic);
  }
  // An argv expression the guard cannot read cannot be proven literal.
  return true;
}

/** The literal pieces of every argv element the guard can read. */
function argvPieces(argvNode, bindings) {
  if (!argvNode || !ts.isArrayLiteralExpression(argvNode)) return [];
  return argvNode.elements.flatMap((element) => readPieces(element, bindings).pieces);
}

// ---------------------------------------------------------------------------
// The detector
// ---------------------------------------------------------------------------

/**
 * Cheap pre-filter: a violation needs a denylisted command name AND a spawner
 * name to appear literally in the text, so a file holding neither is never
 * parsed. Case-insensitive, because the command match is.
 */
function mightContainViolation(sourceText) {
  const lowered = sourceText.toLowerCase();
  // A spawner only counts when it RESOLVES to a spawner-module binding in this
  // same file, so a file that never names such a module can never violate.
  if (![...SPAWNER_MODULES].some((mod) => lowered.includes(mod))) return false;
  if (![...AGENT_CLIS].some((command) => lowered.includes(command))) return false;
  return [...SPAWNER_NAMES].some((fn) => lowered.includes(fn.toLowerCase()));
}

function findViolationsInSource(filePath, sourceText) {
  const violations = [];
  if (!mightContainViolation(sourceText)) return violations;
  const source = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  const bindings = collectBindings(source);
  // A const bound to a template literal keeps its spans for the shell path.
  bindings.templates = new Map();
  const collectTemplates = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isTemplateExpression(node.initializer)
    ) {
      bindings.templates.set(node.name.text, readPieces(node.initializer, bindings));
    }
    ts.forEachChild(node, collectTemplates);
  };
  collectTemplates(source);

  const report = (node, command, call) => {
    violations.push({
      file: filePath,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      command,
      call,
    });
  };

  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const spawner = resolveSpawner(node.expression, bindings);
      const [first, second] = node.arguments;

      if (spawner && ARGV_SPAWNERS.has(spawner)) {
        const commandRead = readPieces(first, bindings);
        const base = commandRead.dynamic ? null : commandBasename(commandRead.pieces.join(""));
        if (base && argvCarriesNonLiteral(second, bindings)) {
          if (AGENT_CLIS.has(base)) {
            report(node, base, spawner);
          } else if (WRAPPER_COMMANDS.has(base)) {
            // `sh -c "codex …"`, `env codex …`, `npx codex …`
            const nested = denylistedIn(argvPieces(second, bindings));
            if (nested) report(node, nested, spawner);
          }
        }
      }

      if (spawner && SHELL_SPAWNERS.has(spawner)) {
        const commandRead = readPieces(first, bindings);
        if (commandRead.dynamic) {
          const named = denylistedIn(commandRead.pieces);
          if (named) report(node, named, spawner);
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return violations;
}

function scanFiles(files) {
  const violations = [];
  for (const filePath of files) {
    violations.push(...findViolationsInSource(filePath, readFileSync(filePath, "utf8")));
  }
  return violations;
}

const scanFixtureTree = (root) => scanFiles(walkSourceFiles(root));

// ---------------------------------------------------------------------------
// The detector actually fires (proved against fixtures, never against the tree)
// ---------------------------------------------------------------------------

function withFixtures(files, assertion) {
  const root = mkdtempSync(path.join(tmpdir(), "agent-cli-guard-"));
  try {
    for (const [name, contents] of Object.entries(files)) {
      const full = path.join(root, name);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, contents, "utf8");
    }
    assertion(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const commandsOf = (violations) => [...new Set(violations.map((v) => v.command))].sort();

describe("agent-CLI spawn detector", () => {
  it("flags the two shapes this change removed", () => {
    withFixtures(
      {
        "codex-shape.ts":
          'import { spawn } from "node:child_process";\n' +
          "export function ask(prompt: string) {\n" +
          '  return spawn("codex", ["exec", "--sandbox", "read-only", prompt]);\n' +
          "}\n",
        "gemini-shape.ts":
          'import { spawn } from "node:child_process";\n' +
          "export function ask(prompt: string) {\n" +
          '  return spawn("gemini", ["--output-format", "json", "--prompt", prompt]);\n' +
          "}\n",
      },
      (root) => expect(commandsOf(scanFixtureTree(root))).toEqual(["codex", "gemini"]),
    );
  });

  it("flags the evasive spellings of the same shape", () => {
    withFixtures(
      {
        // aliased named import
        "alias-import.ts":
          'import { spawn as launch } from "node:child_process";\n' +
          'export const run = (p: string) => launch("codex", ["exec", p]);\n',
        // destructured dynamic import with a rename
        "destructured.mjs":
          'const { spawn: launch } = await import("node:child_process");\n' +
          'export const run = (p) => launch("gemini", ["--prompt", p]);\n',
        // command name behind a const
        "const-command.ts":
          'import { spawn } from "child_process";\n' +
          'const cli = "claude";\n' +
          "export const run = (p: string) => spawn(cli, [p]);\n",
        // namespace binding aliased into a local
        "namespace-alias.ts":
          'import * as cp from "node:child_process";\n' +
          "const launch = cp.spawn;\n" +
          'export const run = (p: string) => launch("aider", ["--message", p]);\n',
        // shell wrapper
        "sh-wrapper.ts":
          'import { spawn } from "node:child_process";\n' +
          "export const run = (p: string) => spawn(\"sh\", [\"-c\", `codex exec ${p}`]);\n",
        // launcher wrapper
        "env-wrapper.ts":
          'import { spawn } from "node:child_process";\n' +
          'export const run = (p: string) => spawn("env", ["gemini", "--prompt", p]);\n',
        // shell string that does not START with the command
        "exec-prefix.ts":
          'import { exec } from "node:child_process";\n' +
          "export const run = (p: string) => exec(`cd /srv && claude --print ${p}`);\n",
        // shell string assembled into a const first
        "exec-const.ts":
          'import { execSync } from "node:child_process";\n' +
          "export const run = (p: string) => {\n" +
          "  const command = `aider --message ${p}`;\n" +
          "  return execSync(command);\n" +
          "};\n",
        // capitalised, with an extension and a path
        "cased-path.ts":
          'import { execFile } from "node:child_process";\n' +
          'export const run = (args: string[]) => execFile("/usr/local/bin/Cursor.exe", args);\n',
        // a source file living under a directory named like build output
        "build/nested.ts":
          'import { spawnSync } from "node:child_process";\n' +
          'export const run = (p: string) => spawnSync("codex", ["exec", p]);\n',
      },
      (root) => {
        const violations = scanFixtureTree(root);
        expect(commandsOf(violations)).toEqual(["aider", "claude", "codex", "cursor", "gemini"]);
        const files = violations.map((v) => path.basename(v.file)).sort();
        expect(files).toEqual([
          "alias-import.ts",
          "cased-path.ts",
          "const-command.ts",
          "destructured.mjs",
          "env-wrapper.ts",
          "exec-const.ts",
          "exec-prefix.ts",
          "namespace-alias.ts",
          "nested.ts",
          "sh-wrapper.ts",
        ]);
      },
    );
  });

  it("does not flag literal invocations, unrelated commands, or lookalike methods", () => {
    withFixtures(
      {
        // every argument literal: no caller text
        "literal-only.ts":
          'import { spawn } from "node:child_process";\n' +
          'export const version = () => spawn("codex", ["--version"]);\n',
        // a different command entirely
        "other-command.ts":
          'import { spawn } from "node:child_process";\n' +
          'export const run = (ref: string) => spawn("git", ["show", ref]);\n',
        // a method named `spawn` on something that is not child_process
        "worker-pool.ts":
          'import { workerPool } from "./pool";\n' +
          'export const run = (opts: object) => workerPool.spawn("codex", opts);\n',
        // a locally declared function that happens to share the name
        "local-spawn.ts":
          "function spawn(name: string, argv: string[]) {\n" +
          "  return { name, argv };\n" +
          "}\n" +
          'export const run = (p: string) => spawn("gemini", [p]);\n',
        // a fully literal shell string
        "literal-shell.ts":
          'import { execSync } from "node:child_process";\n' +
          'export const version = () => execSync("codex --version");\n',
      },
      (root) => expect(scanFixtureTree(root)).toEqual([]),
    );
  });

  it("refuses a tree it cannot read rather than reporting it clean", () => {
    expect(() => scanFixtureTree(path.join(tmpdir(), "agent-cli-guard-does-not-exist"))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// The tree is clean
// ---------------------------------------------------------------------------

describe("no product module spawns an interactive agent CLI with caller text", () => {
  it("finds no denylisted agent-CLI spawn under src/ or packages/", () => {
    const files = trackedSourceFiles(REPO_ROOT, ["src", "packages"]);
    // A silently empty file set would make this assertion vacuous.
    expect(files.length).toBeGreaterThan(1000);
    const rendered = scanFiles(files).map(
      (violation) =>
        `${path.relative(REPO_ROOT, violation.file)}:${violation.line} ${violation.call}("${violation.command}", ...)`,
    );
    expect(rendered).toEqual([]);
  });
});
