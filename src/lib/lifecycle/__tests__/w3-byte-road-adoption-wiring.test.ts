import { readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

// WAVE 3 OF `PLAN: Agents Lifecycle (D) — Review` (cinatra#3091, epic #3087) —
// THE ADOPTION IS WIRED, NOT MERELY AVAILABLE.
//
// The plan, section 6.7: "wave 3 is the displays' adoption of them, not their
// construction."
//
// An enabler with no caller is the exact state this wave exists to end, so the
// bar this file holds is a COUNTED one: the byte minter must have a real caller
// in the product tree, and the island reader must reach it. A future edit that
// quietly un-wires it fails here rather than at a blank panel inside somebody
// else's website. (The CMS picture pair's broker minter, the plan's other
// wave 3 adoption, lost its caller with the pair itself: a pinned capture pair
// is not drawn anywhere, cinatra#3862 leg 8.)

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === "__tests__") continue;
      walk(abs, out);
      continue;
    }
    if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      if (entry.includes(".test.")) continue;
      out.push(abs);
    }
  }
  return out;
}

const PRODUCT_FILES = walk(path.join(ROOT, "src"));

function callersOf(symbol: string): string[] {
  const needle = new RegExp(`\\b${symbol}\\s*\\(`);
  return PRODUCT_FILES.filter((abs) => {
    const src = readFileSync(abs, "utf8");
    if (!needle.test(src)) return false;
    // The module that DEFINES the symbol is not a caller of it.
    return !new RegExp(`export (async )?function ${symbol}\\b`).test(src);
  }).map((abs) => path.relative(ROOT, abs));
}

// ---------------------------------------------------------------------------
// REFERENCES, RESOLVED (not a bare call text). `callersOf` above sees only
// `name(` in `src/`; it misses a call from `packages/*/src` or an extension, an
// import under another name, a namespace call and a re-export chain. This
// resolver follows the symbol through imports and re-exports across every
// runtime product root and answers which files name it at all.
// ---------------------------------------------------------------------------

const TREE_SKIP = new Set(["node_modules", ".next", "dist", "build", "coverage", "__tests__"]);

function walkSources(dir: string, out: string[] = []): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (TREE_SKIP.has(name)) continue;
    const abs = path.join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) walkSources(abs, out);
    else if (/\.(?:[cm]?[jt]sx?)$/.test(name) && !/\.(?:test|spec)\./.test(name) && !name.endsWith(".d.ts")) out.push(abs);
  }
  return out;
}

/** Every runtime product root: `src`, `packages/<pkg>/src`, and each extension
 *  checked out under `extensions/<vendor>/<name>` (absent in a bare clone). */
function productRoots(): string[] {
  const roots = [path.join(ROOT, "src")];
  const list = (d: string) => {
    try {
      return readdirSync(d);
    } catch {
      return [];
    }
  };
  for (const pkg of list(path.join(ROOT, "packages"))) roots.push(path.join(ROOT, "packages", pkg, "src"));
  for (const vendor of list(path.join(ROOT, "extensions"))) {
    for (const ext of list(path.join(ROOT, "extensions", vendor))) roots.push(path.join(ROOT, "extensions", vendor, ext));
  }
  return roots;
}

const EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/** The files a module specifier can mean. Relative and `@/` specifiers resolve
 *  exactly; any other specifier (a package subpath) resolves to every file
 *  whose last path segment matches, which can only over-report. */
function resolveSpecifier(from: string, spec: string, files: ReadonlySet<string>): string[] {
  const stripped = spec.replace(/\.(?:[cm]?js|jsx)$/, "");
  const bases: string[] = [];
  if (spec.startsWith(".")) bases.push(path.posix.join(path.posix.dirname(from), stripped));
  else if (spec.startsWith("@/")) bases.push(path.posix.join("src", stripped.slice(2)));
  const out = new Set<string>();
  for (const base of bases) {
    for (const ext of EXTS) {
      if (files.has(base + ext)) out.add(base + ext);
      if (files.has(`${base}/index${ext}`)) out.add(`${base}/index${ext}`);
    }
  }
  if (bases.length === 0) {
    const last = stripped.split("/").pop() as string;
    for (const file of files) {
      const noExt = file.replace(/\.[^./]+$/, "");
      if (noExt.endsWith(`/${last}`) || noExt.endsWith(`/${last}/index`)) out.add(file);
    }
  }
  return [...out];
}

interface Exposure {
  names: Set<string>; // export names bound to the symbol itself
  spaces: Set<string>; // export names bound to a namespace that holds it
}

/**
 * The files that name `symbol` apart from `definingFile`: every file that
 * imports it (under any local name), reads it from a namespace import or a
 * namespace that escapes, re-exports it (`export { x as y } from`, `export *`,
 * `export * as ns`, or an import re-exported later), or loads its module
 * dynamically. Re-export chains are followed to a fixed point. `files` maps a
 * repo-relative posix path to its source text.
 */
function filesNamingSymbol(files: Readonly<Record<string, string>>, symbol: string, definingFile: string): string[] {
  const all = new Set(Object.keys(files));
  const exposure = new Map<string, Exposure>([[definingFile, { names: new Set([symbol]), spaces: new Set() }]]);
  const naming = new Set<string>();
  const parsed = new Map<string, ts.SourceFile>();
  const parse = (file: string) => {
    let sf = parsed.get(file);
    if (!sf) {
      sf = ts.createSourceFile(file, files[file], ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      parsed.set(file, sf);
    }
    return sf;
  };
  const targetsOf = (file: string, spec: string) => resolveSpecifier(file, spec, all).filter((t) => exposure.has(t));

  for (let changed = true, round = 0; changed && round < 50; round++) {
    changed = false;
    const expose = (file: string, kind: "names" | "spaces", name: string) => {
      const e = exposure.get(file) ?? { names: new Set<string>(), spaces: new Set<string>() };
      exposure.set(file, e);
      if (!e[kind].has(name)) {
        e[kind].add(name);
        changed = true;
      }
      if (!naming.has(file)) {
        naming.add(file);
        changed = true;
      }
    };
    for (const file of all) {
      if (file === definingFile) continue;
      const sf = parse(file);
      const boundNames = new Set<string>(); // local names bound to the symbol
      const boundSpaces = new Map<string, string[]>(); // local namespace -> exposing targets
      for (const st of sf.statements) {
        if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
          const targets = targetsOf(file, st.moduleSpecifier.text);
          const clause = st.importClause;
          if (!clause || targets.length === 0) continue;
          const nb = clause.namedBindings;
          if (nb && ts.isNamespaceImport(nb)) boundSpaces.set(nb.name.text, targets);
          if (nb && ts.isNamedImports(nb)) {
            for (const el of nb.elements) {
              const imported = (el.propertyName ?? el.name).text;
              for (const t of targets) {
                const e = exposure.get(t) as Exposure;
                if (e.names.has(imported)) {
                  boundNames.add(el.name.text);
                  if (!naming.has(file)) { naming.add(file); changed = true; }
                }
                if (e.spaces.has(imported)) boundSpaces.set(el.name.text, []); // which module it holds is not tracked: any use counts
              }
            }
          }
        }
      }
      for (const st of sf.statements) {
        if (!ts.isExportDeclaration(st)) continue;
        const spec = st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : null;
        const ec = st.exportClause;
        if (spec !== null) {
          for (const t of targetsOf(file, spec)) {
            const e = exposure.get(t) as Exposure;
            if (!ec) {
              for (const n of [...e.names]) expose(file, "names", n);
              for (const n of [...e.spaces]) expose(file, "spaces", n);
            } else if (ts.isNamespaceExport(ec)) expose(file, "spaces", ec.name.text);
            else {
              for (const el of ec.elements) {
                const from = (el.propertyName ?? el.name).text;
                if (e.names.has(from)) expose(file, "names", el.name.text);
                if (e.spaces.has(from)) expose(file, "spaces", el.name.text);
              }
            }
          }
        } else if (ec && ts.isNamedExports(ec)) {
          for (const el of ec.elements) {
            const local = (el.propertyName ?? el.name).text;
            if (boundNames.has(local)) expose(file, "names", el.name.text);
            if (boundSpaces.has(local)) expose(file, "spaces", el.name.text);
          }
        }
      }
      // A namespace read: `ns.symbol(...)`, `ns["symbol"]`, or `ns` handed on
      // (any use that is not a property read of some other export).
      const visit = (node: ts.Node) => {
        if (ts.isIdentifier(node) && boundSpaces.has(node.text) && !ts.isImportSpecifier(node.parent) && !ts.isNamespaceImport(node.parent) && !ts.isExportSpecifier(node.parent)) {
          const parent = node.parent;
          const targets = boundSpaces.get(node.text) as string[];
          let hit = true;
          if (targets.length === 0) hit = true;
          else if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
            hit = targets.some((t) => (exposure.get(t) as Exposure).names.has(parent.name.text));
          } else if (ts.isElementAccessExpression(parent) && parent.expression === node && ts.isStringLiteralLike(parent.argumentExpression)) {
            hit = targets.some((t) => (exposure.get(t) as Exposure).names.has((parent.argumentExpression as ts.StringLiteral).text));
          }
          if (hit && !naming.has(file)) { naming.add(file); changed = true; }
        }
        // A dynamic `import("…")` or `require("…")` of an exposing module.
        if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0])) {
          const callee = node.expression;
          if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require")) {
            if (targetsOf(file, node.arguments[0].text).length > 0 && !naming.has(file)) { naming.add(file); changed = true; }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
  }
  naming.delete(definingFile);
  return [...naming].sort();
}

/** The module that defined the broker minter. The review surface stopped
 *  drawing a capture pair (cinatra#3862 l8b), and the second part of leg 8
 *  deleted the minter with its module and the capture store. */
const MINTER_DEFINITION = "src/lib/lifecycle/widget-capture-egress.ts";

describe("wave 3 — the byte capability finally has a caller", () => {
  it("mints island byte capabilities from the product tree, not only from a test", () => {
    const callers = callersOf("mintReviewIslandByteCapability");
    expect(callers.length).toBeGreaterThan(0);
  });

  it("routes the island reader's media bytes through the minter this wave adds", () => {
    const prepare = readFileSync(
      path.join(ROOT, "src/app/artifacts/[id]/review-target-prepare.ts"),
      "utf8",
    );
    expect(prepare).toContain("byteMinter");
    // The snapshot must carry a byte REFERENCE, not a second copy of the
    // session address: the field the new props version added.
    expect(prepare).toMatch(/bytes:\s*\{|bytes,/);
  });

  it("hands the island road down from the surface loader to the preparation ports", () => {
    const ports = readFileSync(
      path.join(ROOT, "src/app/artifacts/[id]/review-gate-ports.ts"),
      "utf8",
    );
    expect(ports).toContain("roads");
    const island = readFileSync(
      path.join(ROOT, "src/app/lifecycle/review-island/page.tsx"),
      "utf8",
    );
    expect(island).toContain("islandReviewSurfaceRoads");
  });
});

describe("wave 3 — the CMS picture pair's broker minter has no caller", () => {
  // red-first-expect: expected [ Array(1) ] to deeply equal []
  it("is called nowhere in the product tree", () => {
    expect(callersOf("buildBrokerCapturePair")).toEqual([]);
  });

  // red-first-expect: expected [ Array(1) ] to deeply equal []
  it("is named by no file of any runtime product root, however it is imported or re-exported", () => {
    const files: Record<string, string> = {};
    for (const root of productRoots()) {
      for (const abs of walkSources(root)) files[path.relative(ROOT, abs).split(path.sep).join("/")] = readFileSync(abs, "utf8");
    }
    // The scan must reach the roads that once called it; the defining module is gone.
    expect(Object.keys(files)).toContain("src/app/artifacts/[id]/review-surface-roads.ts");
    expect(Object.keys(files)).not.toContain(MINTER_DEFINITION);
    expect(filesNamingSymbol(files, "buildBrokerCapturePair", MINTER_DEFINITION)).toEqual([]);
    expect(Object.keys(files).filter((f) => files[f].includes("buildBrokerCapturePair"))).toEqual([]);
  });

  describe("the resolver's controls (in-memory fixtures, no product file)", () => {
    const DEF = "src/lib/egress.ts";
    const defSource = "export function buildBrokerCapturePair() { return null; }\n";
    const run = (extra: Record<string, string>) => filesNamingSymbol({ [DEF]: defSource, ...extra }, "buildBrokerCapturePair", DEF);

    it("finds nothing in a tree that never imports the symbol", () => {
      expect(run({ "src/a.ts": "import { other } from './egress';\nother();\n", "packages/p/src/b.ts": "export const x = 1;\n" })).toEqual([]);
    });
    it("finds a plain import", () => {
      expect(run({ "src/a.ts": "import { buildBrokerCapturePair } from '@/lib/egress';\nbuildBrokerCapturePair();\n" })).toEqual(["src/a.ts"]);
    });
    it("finds an aliased import", () => {
      expect(run({ "src/a.ts": "import { buildBrokerCapturePair as mint } from './lib/egress';\nmint();\n" })).toEqual(["src/a.ts"]);
    });
    it("finds a namespace call, and a namespace handed on", () => {
      expect(run({ "src/a.ts": "import * as egress from './lib/egress';\negress.buildBrokerCapturePair();\n" })).toEqual(["src/a.ts"]);
      expect(run({ "src/a.ts": "import * as egress from './lib/egress';\nuse(egress);\n" })).toEqual(["src/a.ts"]);
      expect(run({ "src/a.ts": "import * as egress from './lib/egress';\negress.somethingElse();\n" })).toEqual([]);
    });
    it("finds a call from another package through a package subpath", () => {
      expect(run({ "packages/p/src/b.ts": "import { buildBrokerCapturePair } from '@cinatra-ai/host/egress';\n" })).toEqual(["packages/p/src/b.ts"]);
    });
    it("follows a re-export chain to the file that imports from the re-exporter", () => {
      expect(
        run({
          "src/lib/barrel.ts": "export { buildBrokerCapturePair as mint } from './egress';\n",
          "src/lib/barrel2.ts": "export * from './barrel';\n",
          "src/lib/barrel3.ts": "export * as everything from './barrel2';\n",
          "src/c.ts": "import { mint } from './lib/barrel2';\nmint();\n",
          "src/d.ts": "import { everything } from './lib/barrel3';\neverything.mint();\n",
          "src/e.ts": "import { buildBrokerCapturePair as m } from './lib/egress';\nexport { m as run };\n",
          "src/f.ts": "import { run } from './e';\nrun();\n",
        }),
      ).toEqual(["src/c.ts", "src/d.ts", "src/e.ts", "src/f.ts", "src/lib/barrel.ts", "src/lib/barrel2.ts", "src/lib/barrel3.ts"]);
    });
    it("finds a dynamic import of the module", () => {
      expect(run({ "src/a.ts": "export const load = () => import('./lib/egress');\n" })).toEqual(["src/a.ts"]);
    });
  });

  // red-first-expect: not to contain 'buildBrokerCapturePair'
  it("is not reached from the review surface loader", () => {
    const roads = readFileSync(
      path.join(ROOT, "src/app/artifacts/[id]/review-surface-roads.ts"),
      "utf8",
    );
    expect(roads).not.toContain("buildBrokerCapturePair");
  });
});

describe("wave 3 — the three browser fetchers are handed their content", () => {
  it("the review card's props builder reaches the content channel instead of naming it unwired", () => {
    const roads = readFileSync(
      path.join(ROOT, "src/app/artifacts/[id]/review-surface-roads.ts"),
      "utf8",
    );
    expect(roads).toContain("buildArtifactContentProjection");
  });

  it("the content channel's own host ports exist and are the only reader of the pinned bytes", () => {
    const ports = readFileSync(
      path.join(ROOT, "src/lib/artifacts/artifact-content-channel-ports.ts"),
      "utf8",
    );
    expect(ports).toContain("readPinnedSubstance");
    // The port reads bytes ON THE SERVER and hands back a CAPPED string; it must
    // never hand back a buffer, which is how a byte would reach a snapshot.
    expect(ports).not.toMatch(/return\s*\{\s*class:\s*"text",\s*text:\s*buf\b/);
  });
});

describe("wave 3 — the island road never falls back to a cookie-only address", () => {
  it("the island page supplies a principal for the byte road it paints under", () => {
    const island = readFileSync(
      path.join(ROOT, "src/app/lifecycle/review-island/page.tsx"),
      "utf8",
    );
    expect(island).toContain("islandReviewSurfaceRoads");
  });

  it("the island credential resolver hands its caller the live principal it proved", () => {
    const serving = readFileSync(
      path.join(ROOT, "src/lib/lifecycle/review-island-serving.ts"),
      "utf8",
    );
    expect(serving).toMatch(/principal/);
  });
});
