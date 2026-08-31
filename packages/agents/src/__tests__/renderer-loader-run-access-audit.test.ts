/**
 * Renderer-loader authorization audit (cinatra#3050, acceptance criterion 4).
 *
 * The defect this pins shut: a field renderer draws a STEP OF A RUN, so its
 * data loader must be authorized by that RUN's access. The list picker's loader
 * instead opened with `requireAdminSession()`, which REDIRECTS a caller without
 * the `admin` role to `/not-authorized` — the run's own non-administrator owner
 * was thrown off their own run the moment it reached that step.
 *
 * The audit walks EVERY entry of the generated agent bindings
 * (`src/lib/generated/agent-bindings.ts`), resolves each entry's `kind` through
 * the host's renderer kind table (`register-default-renderers.ts`) to the
 * component that actually mounts, and fails when the module closure a
 * host-shipped component reaches — the renderer plus every module it imports by
 * relative path inside this package, which is where its server actions live —
 * mentions `requireAdminSession`.
 *
 * SCOPE, stated honestly: kinds whose component migrated into an extension
 * resolve here to the `SchemaFieldRenderer` floor and mount through the
 * extension wrapper; their loaders live in the extension package and are not
 * reachable from this repository's source tree, so the audit covers the
 * HOST-SHIPPED components. That is exactly the set the bundled agents' steps
 * mount out of this package, and the set the defect lived in.
 *
 * Purely static — no DB, no React, no module evaluation.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_SRC = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(HERE, "../../../..");
const REGISTER = path.join(AGENTS_SRC, "register-default-renderers.ts");
const GENERATED_BINDINGS = path.join(
  REPO_ROOT,
  "src/lib/generated/agent-bindings.ts",
);

/** The gate a renderer-owned loader must never reach for. */
const FORBIDDEN_GATE = "requireAdminSession";

function read(file: string): string {
  return fs.readFileSync(file, "utf8");
}

/**
 * Strip comments before scanning. The audit is about what the CODE imports and
 * calls; a comment that NAMES the retired gate to explain why it is gone is
 * documentation, not a reach for it.
 */
function code(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/([^:"'`])\/\/.*$/gm, "$1");
}

/** Resolve a relative import specifier to a real file, or null. */
function resolveRelative(fromFile: string, spec: string): string | null {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
    base,
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

function relativeImportSpecifiers(source: string): string[] {
  return [...source.matchAll(/from\s+"(\.[^"]*)"/g)].map((m) => m[1]);
}

/** name -> module file, for every relative import in register-default-renderers. */
function importedComponentModules(): Map<string, string> {
  const src = read(REGISTER);
  const map = new Map<string, string>();
  for (const m of src.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"(\.[^"]*)"/g)) {
    const file = resolveRelative(REGISTER, m[2]);
    if (!file) continue;
    for (const raw of m[1].split(",")) {
      const name = raw.replace(/\btype\b/, "").split(/\s+as\s+/)[0].trim();
      if (name) map.set(name, file);
    }
  }
  return map;
}

/** kind -> the component identifier the kind table mounts for it. */
function kindTable(): Map<string, string> {
  const src = read(REGISTER);
  const table = new Map<string, string>();
  for (const m of src.matchAll(
    /(?:"([A-Za-z0-9_-]+)"|([A-Za-z_][A-Za-z0-9_]*))\s*:\s*\{\s*(?:\/\/[^\n]*\n\s*)*renderer:\s*([A-Za-z_][A-Za-z0-9_]*)/g,
  )) {
    table.set(m[1] ?? m[2], m[3]);
  }
  return table;
}

/** Every `kind` declared by the generated agent bindings. */
function generatedBindingKinds(): string[] {
  const src = read(GENERATED_BINDINGS);
  return [...new Set([...src.matchAll(/\bkind:\s*"([^"]+)"/g)].map((m) => m[1]))].sort();
}

/**
 * The module closure a component reaches by RELATIVE import inside this
 * package — the renderer plus its own server actions and their helpers.
 */
function closureOf(entry: string): string[] {
  const seen = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    for (const spec of relativeImportSpecifiers(read(file))) {
      const resolved = resolveRelative(file, spec);
      if (!resolved) continue;
      if (!resolved.startsWith(AGENTS_SRC)) continue;
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      queue.push(resolved);
    }
  }
  return [...seen];
}

describe("renderer-owned loaders are authorized by the run, not by a platform-admin session", () => {
  const components = importedComponentModules();
  const kinds = kindTable();
  const bindingKinds = generatedBindingKinds();

  it("every generated binding kind resolves through the host renderer kind table", () => {
    expect(bindingKinds.length).toBeGreaterThan(0);
    const unresolved = bindingKinds.filter((k) => !kinds.has(k));
    expect(unresolved).toEqual([]);
  });

  it("no renderer-owned loader reaches for requireAdminSession", () => {
    const offenders: string[] = [];
    const audited: string[] = [];

    for (const kind of bindingKinds) {
      const componentName = kinds.get(kind);
      if (!componentName) continue;
      const entry = components.get(componentName);
      // A kind whose component migrated into an extension has no host module
      // to audit — see the scope note in this file's header.
      if (!entry) continue;
      audited.push(kind);
      for (const file of closureOf(entry)) {
        if (code(file).includes(FORBIDDEN_GATE)) {
          offenders.push(`${kind} -> ${path.relative(REPO_ROOT, file)}`);
        }
      }
    }

    // The audit must actually have something to say.
    expect(audited.length).toBeGreaterThan(0);
    expect([...new Set(offenders)].sort()).toEqual([]);
  });
});
