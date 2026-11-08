// THE PUBLISH-PACK NAMES BORDER (cinatra#4150, acceptance item 7).
//
// Core must not name a publish pack. A publish pack is an installed agent pack
// whose flow (`cinatra/oas.json`) marks a node `metadata.cinatra.publishes: true`. Product code
// under `src/` and `packages/` may not name, for such a pack:
//   - its package name,
//   - the gate step id the host derives for one of its publishing nodes
//     (`cinatra_publish_gate__<node id>`),
//   - the id or the kind of a renderer its package.json declares.
//
// The scope and the exclusions are those of the core/extension border gate
// (scripts/ci/core-extension-border-gate.mjs, docs/internals/contracts/
// core-extension-border.md): the same product roots, the same skipped
// directories and file shapes, the same generated-map path, and the same
// comment masking. The names are read from the installed pack manifests under
// `extensions/`, never typed here.
//
// RED-FIRST: this is a guard, so on the base it passes. Its red is a planted
// name: the fixture cases below plant each kind of name in a temporary product
// tree and the scan must report it, and must stay silent for a masked comment,
// a test file, a fixture directory and the generated map.
//
// The repository case needs the materialized `extensions/` tree (`node
// scripts/ci/sync-dev-extensions.mjs --pinned`), which lays packs out as
// `extensions/<scope without @>/<name>/` (for example `extensions/cinatra-ai/`).
// Without the tree the case is skipped, unless CINATRA_REQUIRE_EXTENSIONS=1 is
// set: a job or kit that ran the sync sets it, and then a missing tree FAILS
// the case instead of skipping it, so the guard cannot pass vacuously.
//
// ORDER: while a pack declares the flag and still declares its renderer, the
// renderer kinds `linkedin-draft-review` (register-default-renderers.ts:188) and
// `wordpress-draft-confirm` (:233) are named in product code and this test goes
// red. The pack changes delete those renderers in the same pack PRs, and the
// core lock bump must drop the two keys with them.

import { afterEach, describe, expect, it } from "vitest";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const GATE_PATH = path.join(REPO_ROOT, "scripts", "ci", "core-extension-border-gate.mjs");

type Gate = {
  PRODUCT_ROOTS: string[];
  walkProductFiles: (dir: string, acc?: string[], repoRoot?: string | null) => string[];
  maskComments: (text: string) => string;
};
const gate = (await import(pathToFileURL(GATE_PATH).href)) as unknown as Gate;

const GATE_PREFIX = "cinatra_publish_gate__";

export type PublishPack = {
  packageName: string;
  nodeIds: string[];
  rendererIds: string[];
  rendererKinds: string[];
};

type FlowNode = {
  id?: unknown;
  component_type: string;
  metadata?: { cinatra?: { publishes?: unknown } };
};
type PackageJson = {
  name?: unknown;
  cinatra?: { fieldRenderers?: unknown };
};
type FieldRenderer = { id?: unknown; kind?: unknown } | null;

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

function collectNodes(value: unknown, out: FlowNode[] = []): FlowNode[] {
  if (Array.isArray(value)) {
    for (const v of value) collectNodes(v, out);
  } else if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (typeof o.component_type === "string") out.push(o as unknown as FlowNode);
    for (const v of Object.values(o)) collectNodes(v, out);
  }
  return out;
}

/** Every installed agent pack under `<root>/extensions/<scope>/<name>/` that has a flow. */
export function readAgentPacks(root: string): { pack: PublishPack | null; packageName: string }[] {
  const extRoot = path.join(root, "extensions");
  const out: { pack: PublishPack | null; packageName: string }[] = [];
  if (!existsSync(extRoot)) return out;
  for (const scope of readdirSync(extRoot, { withFileTypes: true })) {
    if (!scope.isDirectory()) continue;
    for (const dir of readdirSync(path.join(extRoot, scope.name), { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const pkgFile = path.join(extRoot, scope.name, dir.name, "package.json");
      const oasFile = path.join(extRoot, scope.name, dir.name, "cinatra", "oas.json");
      if (!existsSync(pkgFile) || !existsSync(oasFile)) continue;
      const pkg = readJson(pkgFile) as PackageJson;
      const nodes = collectNodes(readJson(oasFile)).filter((n) => n.metadata?.cinatra?.publishes === true && typeof n.id === "string");
      const renderers: FieldRenderer[] = Array.isArray(pkg?.cinatra?.fieldRenderers) ? (pkg.cinatra?.fieldRenderers as FieldRenderer[]) : [];
      out.push({
        packageName: String(pkg.name),
        pack:
          nodes.length === 0
            ? null
            : {
                packageName: String(pkg.name),
                nodeIds: nodes.map((n) => String(n.id)),
                rendererIds: renderers.map((r) => r?.id).filter((x): x is string => typeof x === "string"),
                rendererKinds: renderers.map((r) => r?.kind).filter((x): x is string => typeof x === "string"),
              },
      });
    }
  }
  return out;
}

export function publishPacksOf(root: string): PublishPack[] {
  return readAgentPacks(root)
    .map((r) => r.pack)
    .filter((p): p is PublishPack => p !== null);
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The spellings a publish pack must not have in product code, with what each is. */
export function namesOf(packs: PublishPack[]): { name: string; what: string; re: RegExp }[] {
  const names: { name: string; what: string }[] = [];
  for (const p of packs) {
    names.push({ name: p.packageName, what: `package name of ${p.packageName}` });
    for (const id of p.nodeIds) names.push({ name: `${GATE_PREFIX}${id}`, what: `gate step id of ${p.packageName}` });
    for (const id of p.rendererIds) names.push({ name: id, what: `renderer id of ${p.packageName}` });
    for (const k of p.rendererKinds) names.push({ name: k, what: `renderer kind of ${p.packageName}` });
  }
  const seen = new Set<string>();
  return names
    .filter((n) => (seen.has(n.name) ? false : (seen.add(n.name), true)))
    .map((n) => ({ ...n, re: new RegExp(`(?<![A-Za-z0-9_@/-])${esc(n.name)}(?![A-Za-z0-9_-])`) }));
}

export type Hit = { file: string; line: number; what: string };

/** Scan the gate's product roots under `root` for the names; comments are masked first. */
export function scanProductFor(root: string, packs: PublishPack[]): Hit[] {
  const names = namesOf(packs);
  const hits: Hit[] = [];
  for (const productRoot of gate.PRODUCT_ROOTS) {
    for (const file of gate.walkProductFiles(path.join(root, productRoot), [], root)) {
      const text = gate.maskComments(readFileSync(file, "utf8"));
      const lines = text.split("\n");
      for (const n of names) {
        lines.forEach((l, i) => {
          if (n.re.test(l)) hits.push({ file: path.relative(root, file).split(path.sep).join("/"), line: i + 1, what: n.what });
        });
      }
    }
  }
  return hits;
}

const tmpRoots: string[] = [];
afterEach(() => {
  for (const d of tmpRoots.splice(0)) rmSync(d, { recursive: true, force: true });
});

function put(root: string, rel: string, body: string) {
  const f = path.join(root, rel);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, body);
}

function fixtureRoot(opts: { publishes: boolean }): string {
  const root = mkdtempSync(path.join(tmpdir(), "a15-"));
  tmpRoots.push(root);
  put(
    root,
    "extensions/@cinatra-ai/demo-publish-agent/package.json",
    JSON.stringify({
      name: "@cinatra-ai/demo-publish-agent",
      cinatra: {
        fieldRenderers: [
          { id: "@cinatra-ai/demo-publish-agent:confirm-card", kind: "demo-confirm-card", midRunHitl: true },
        ],
      },
    }),
  );
  put(
    root,
    "extensions/@cinatra-ai/demo-publish-agent/cinatra/oas.json",
    JSON.stringify({
      component_type: "Flow",
      nodes: [
        { component_type: "StartNode", id: "start" },
        { component_type: "ApiNode", id: "send_it", metadata: { cinatra: { publishes: opts.publishes } } },
      ],
    }),
  );
  put(root, "extensions/@cinatra-ai/other-agent/package.json", JSON.stringify({ name: "@cinatra-ai/other-agent" }));
  return root;
}

describe("A15 fixtures: each kind of name is found, each exclusion stays silent", () => {
  const PLANTS: [string, string, string][] = [
    ["package name", 'export const p = "@cinatra-ai/demo-publish-agent";\n', "package name of"],
    ["gate step id", 'export const g = "cinatra_publish_gate__send_it";\n', "gate step id of"],
    ["renderer id", 'export const r = "@cinatra-ai/demo-publish-agent:confirm-card";\n', "renderer id of"],
    ["renderer kind", 'export const k = { "demo-confirm-card": 1 };\n', "renderer kind of"],
  ];

  it("finds nothing in a clean tree", () => {
    const root = fixtureRoot({ publishes: true });
    put(root, "src/lib/clean.ts", 'export const x = "@cinatra-ai/other-agent";\n');
    expect(scanProductFor(root, publishPacksOf(root))).toEqual([]);
  });

  for (const [label, body, what] of PLANTS) {
    it(`reports a planted ${label} in src/ and in packages/`, () => {
      const root = fixtureRoot({ publishes: true });
      put(root, "src/lib/planted.ts", body);
      put(root, "packages/x/src/planted.tsx", body);
      const hits = scanProductFor(root, publishPacksOf(root));
      // A renderer id also contains the package name, so a file may carry two hits.
      expect([...new Set(hits.map((h) => h.file))].sort()).toEqual(["packages/x/src/planted.tsx", "src/lib/planted.ts"]);
      expect(hits.some((h) => h.what.startsWith(what))).toBe(true);
    });
  }

  it("does not read a sibling name as the pack (boundary)", () => {
    const root = fixtureRoot({ publishes: true });
    put(root, "src/lib/near.ts", 'export const x = "@cinatra-ai/demo-publish-agent-extra";\n');
    expect(scanProductFor(root, publishPacksOf(root))).toEqual([]);
  });

  it("keeps the border gate's exclusions: comments, tests, fixtures, mocks, generated map, declarations", () => {
    const root = fixtureRoot({ publishes: true });
    const n = '"@cinatra-ai/demo-publish-agent"';
    put(root, "src/lib/commented.ts", `// ${n}\n/* ${n} */\nexport const ok = 1;\n`);
    put(root, "src/lib/__tests__/a.test.ts", `export const t = ${n};\n`);
    put(root, "src/lib/thing.test.ts", `export const t = ${n};\n`);
    put(root, "src/lib/__fixtures__/f.ts", `export const f = ${n};\n`);
    put(root, "src/lib/__mocks__/m.ts", `export const m = ${n};\n`);
    put(root, "src/lib/generated/map.ts", `export const g = ${n};\n`);
    put(root, "src/lib/types.d.ts", `export declare const d: ${n};\n`);
    put(root, "extensions/@cinatra-ai/demo-publish-agent/src/own.ts", `export const o = ${n};\n`);
    expect(scanProductFor(root, publishPacksOf(root))).toEqual([]);
  });

  it("a top-level publishes key is not the flag: only metadata.cinatra.publishes counts", () => {
    const root = fixtureRoot({ publishes: false });
    put(
      root,
      "extensions/@cinatra-ai/demo-publish-agent/cinatra/oas.json",
      JSON.stringify({ component_type: "Flow", nodes: [{ component_type: "ApiNode", id: "send_it", publishes: true }] }),
    );
    put(root, "src/lib/planted.ts", 'export const p = "@cinatra-ai/demo-publish-agent";\n');
    expect(publishPacksOf(root)).toEqual([]);
    expect(scanProductFor(root, publishPacksOf(root))).toEqual([]);
  });

  it("a pack with no publishing node is not a publish pack, so its name is free", () => {
    const root = fixtureRoot({ publishes: false });
    put(root, "src/lib/planted.ts", 'export const p = "@cinatra-ai/demo-publish-agent";\n');
    expect(publishPacksOf(root)).toEqual([]);
    expect(scanProductFor(root, publishPacksOf(root))).toEqual([]);
  });

  it("reads the names from the manifests, not from this file", () => {
    const root = fixtureRoot({ publishes: true });
    const [p] = publishPacksOf(root);
    expect(p).toEqual({
      packageName: "@cinatra-ai/demo-publish-agent",
      nodeIds: ["send_it"],
      rendererIds: ["@cinatra-ai/demo-publish-agent:confirm-card"],
      rendererKinds: ["demo-confirm-card"],
    });
  });
});

/** True when `<root>/extensions/<any scope>/<name>/package.json` exists (the synced layout has no "@" in the scope directory). */
export function hasInstalledExtensions(root: string): boolean {
  const extRoot = path.join(root, "extensions");
  if (!existsSync(extRoot)) return false;
  for (const scope of readdirSync(extRoot, { withFileTypes: true })) {
    if (!scope.isDirectory() || scope.name.startsWith(".") || scope.name === "node_modules") continue;
    for (const dir of readdirSync(path.join(extRoot, scope.name), { withFileTypes: true })) {
      if (dir.isDirectory() && existsSync(path.join(extRoot, scope.name, dir.name, "package.json"))) return true;
    }
  }
  return false;
}

describe("A15 tree detection: the synced layout is found, an empty tree is not", () => {
  it("finds a pack under a scope directory without an @ (the layout sync-dev-extensions.mjs writes)", () => {
    const root = mkdtempSync(path.join(tmpdir(), "a15-"));
    tmpRoots.push(root);
    put(root, "extensions/cinatra-ai/some-agent/package.json", JSON.stringify({ name: "@cinatra-ai/some-agent" }));
    expect(hasInstalledExtensions(root)).toBe(true);
  });

  it("is false without an extensions folder, with an empty one, and with a scope folder that holds no package", () => {
    const root = mkdtempSync(path.join(tmpdir(), "a15-"));
    tmpRoots.push(root);
    expect(hasInstalledExtensions(root)).toBe(false);
    mkdirSync(path.join(root, "extensions", "cinatra-ai", "empty"), { recursive: true });
    expect(hasInstalledExtensions(root)).toBe(false);
  });
});

// Fail closed: CINATRA_REQUIRE_EXTENSIONS=1 (set where the pinned sync ran) turns "no tree" from a skip into a failure.
const REQUIRE_EXTENSIONS = process.env.CINATRA_REQUIRE_EXTENSIONS === "1";
const HAS_EXTENSIONS = hasInstalledExtensions(REPO_ROOT);

describe.skipIf(!HAS_EXTENSIONS && !REQUIRE_EXTENSIONS)("A15 repository: no product file names a publish pack", () => {
  it("reads the installed agent packs (the universe is not empty)", () => {
    expect(HAS_EXTENSIONS, "CINATRA_REQUIRE_EXTENSIONS=1 but extensions/<scope>/<name>/package.json is absent: the sync did not run").toBe(true);
    expect(readAgentPacks(REPO_ROOT).length).toBeGreaterThan(0);
  });

  it("names no publish pack's package name, publishing node id or renderer id under src/ and packages/", () => {
    const hits = scanProductFor(REPO_ROOT, publishPacksOf(REPO_ROOT));
    expect(hits.map((h) => `${h.file}:${h.line} ${h.what}`)).toEqual([]);
  });
});
