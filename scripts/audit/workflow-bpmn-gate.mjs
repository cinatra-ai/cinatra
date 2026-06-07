// Cinatra BPMN Profile 1.0 install gate.
//
// Every workflow extension (`package.json#cinatra.kind === "workflow"`) MUST ship
// exactly one canonical `cinatra/workflow.bpmn` sidecar, declare an integer
// `cinatra.workflowVersion`, carry NO inline `cinatra.workflow` JSON definition,
// and that sidecar must parse + validate against Profile 1.0 + compile to a
// lossless WorkflowSpec. Fails CLOSED (exit 1) on ANY violation.
//
// Two discovery modes:
//   • Monorepo (default): scan every `extensions/<scope>/<slug>/` package by
//     `cinatra.kind` filter — NOT a raw `extensions/*/cinatra/workflow.bpmn` glob.
//   • Single extracted repo (`--package-root <dir>`): validate exactly one
//     already-extracted workflow package rooted at <dir> (its `package.json`
//     plus the `cinatra/workflow.bpmn` sidecar). `--extensions-root <dir>` keeps
//     the monorepo scan but points it at a non-default extensions tree.
//
// Run under tsx so it can import the TypeScript BPMN source directly:
//   node --import tsx scripts/audit/workflow-bpmn-gate.mjs
//   node --import tsx scripts/audit/workflow-bpmn-gate.mjs --package-root ../some-extracted-workflow

import { readFile, readdir } from "node:fs/promises";
import { join, dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseWorkflowBpmnSidecar, validateWorkflowSpecAgainstBpmnProfile } from "../../packages/workflows/src/bpmn/index.ts";
import { validateWorkflowExtensionPackage } from "../../packages/workflows/src/manifest.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_EXTENSIONS_ROOT = join(REPO_ROOT, "extensions");

/**
 * Parse the opt-in flags. Returns `{ packageRoot, extensionsRoot }` where at most
 * one is set; absence of both selects the default monorepo `extensions/` scan.
 * Throws on a flag with a missing value so the gate fails loud, not silent.
 */
export function parseGateArgs(argv) {
  let packageRoot = null;
  let extensionsRoot = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--package-root" || arg === "--extensions-root") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a directory path`);
      }
      if (arg === "--package-root") packageRoot = resolve(value);
      else extensionsRoot = resolve(value);
      i++;
    } else if (arg.startsWith("--package-root=")) {
      packageRoot = resolve(arg.slice("--package-root=".length));
    } else if (arg.startsWith("--extensions-root=")) {
      extensionsRoot = resolve(arg.slice("--extensions-root=".length));
    }
  }
  if (packageRoot && extensionsRoot) {
    throw new Error("--package-root and --extensions-root are mutually exclusive");
  }
  return { packageRoot, extensionsRoot };
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/** Discover every `<extensionsRoot>/<scope>/<slug>/package.json` declaring kind:"workflow". */
async function discoverWorkflowExtensions(extensionsRoot) {
  const found = [];
  let scopes;
  try {
    scopes = await readdir(extensionsRoot, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const scope of scopes) {
    if (!scope.isDirectory()) continue;
    const scopeDir = join(extensionsRoot, scope.name);
    let slugs;
    try {
      slugs = await readdir(scopeDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const slug of slugs) {
      if (!slug.isDirectory()) continue;
      const packageRoot = join(scopeDir, slug.name);
      const pkg = await readJson(join(packageRoot, "package.json"));
      if (pkg?.cinatra?.kind === "workflow") {
        found.push({ name: pkg.name ?? `${scope.name}/${slug.name}`, packageRoot, pkg });
      }
    }
  }
  return found;
}

/**
 * Load a single already-extracted workflow package at `packageRoot`. The package
 * MUST exist and declare `cinatra.kind === "workflow"` — anything else is a loud
 * failure (this mode is explicitly opt-in for an extracted workflow repo).
 */
async function loadSingleWorkflowPackage(packageRoot) {
  const pkg = await readJson(join(packageRoot, "package.json"));
  if (!pkg) {
    throw new Error(`no readable package.json at ${packageRoot}`);
  }
  if (pkg?.cinatra?.kind !== "workflow") {
    throw new Error(`package at ${packageRoot} is not cinatra.kind:"workflow" (got ${JSON.stringify(pkg?.cinatra?.kind)})`);
  }
  return { name: pkg.name ?? basename(packageRoot), packageRoot, pkg };
}

/** Run the three Profile-1.0 checks against one resolved workflow package. */
async function validateOne(ext) {
  const failures = [];

  // 1. package.json shape: kind, integer workflowVersion, no inline workflow, no extra keys.
  const shape = validateWorkflowExtensionPackage(ext.pkg);
  if (!shape.valid) {
    for (const e of shape.errors) failures.push({ package: ext.name, detail: e });
  }

  // 2. sidecar: exactly one cinatra/workflow.bpmn that parses + validates + compiles.
  const parsed = await parseWorkflowBpmnSidecar({ packageRoot: ext.packageRoot, pkgCinatra: ext.pkg.cinatra ?? {} });
  if (!parsed.ok) {
    for (const e of parsed.errors) failures.push({ package: ext.name, code: e.code, detail: e.detail });
    return failures;
  }

  // 3. emitted spec is Profile-1.0 lossless.
  const loss = validateWorkflowSpecAgainstBpmnProfile(parsed.manifest.definition);
  if (!loss.ok) {
    for (const e of loss.errors) {
      failures.push({ package: ext.name, code: e.code, detail: `${e.field}${e.taskKey ? ` (${e.taskKey})` : ""}: ${e.reason}` });
    }
  }
  return failures;
}

/**
 * Run the gate. Pure-ish: returns `{ ok, failures, exts }` and never calls
 * `process.exit` so it can be driven from tests. The CLI wrapper below maps the
 * result onto the process exit code + console output.
 */
export async function runWorkflowBpmnGate({ packageRoot = null, extensionsRoot = null } = {}) {
  let exts;
  if (packageRoot) {
    exts = [await loadSingleWorkflowPackage(packageRoot)];
  } else {
    exts = await discoverWorkflowExtensions(extensionsRoot ?? DEFAULT_EXTENSIONS_ROOT);
  }

  const failures = [];
  for (const ext of exts) {
    failures.push(...(await validateOne(ext)));
  }
  return { ok: failures.length === 0, failures, exts };
}

async function main() {
  const { packageRoot, extensionsRoot } = parseGateArgs(process.argv.slice(2));
  const { ok, failures, exts } = await runWorkflowBpmnGate({ packageRoot, extensionsRoot });

  if (!ok) {
    console.error(`\n✗ workflow-bpmn-gate: ${failures.length} violation(s) across ${exts.length} workflow extension(s):\n`);
    for (const f of failures) {
      console.error(`  • [${f.package}]${f.code ? ` ${f.code}` : ""}: ${f.detail}`);
    }
    console.error("");
    process.exit(1);
  }

  console.log(`✓ workflow-bpmn-gate: ${exts.length} workflow extension(s) pass Cinatra BPMN Profile 1.0.`);
}

// Only run the CLI when invoked directly (not when imported by a test).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
