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
// THE HOST KIND TABLE: a renderer kind is the host's own vocabulary. The kind
// table in packages/agents/src/register-default-renderers.ts (RENDERER_KIND_TABLE)
// names every kind once, as a key, and a test keeps its keys set-equal with
// KNOWN_FIELD_RENDERER_KINDS (scripts/extensions/agent-binding-kinds.mjs). A
// publish pack may keep declaring a former screen id on one of those kinds, for
// a run that paused there before the pack declared its publishing step, so a
// table KEY is not a crossing. Only the key is exempt, only in that file, and
// only while the keys and the vocabulary are set-equal: the same kind anywhere
// else, and a pack name or renderer id anywhere, still is a crossing.

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

const KIND_TABLE_FILE = "packages/agents/src/register-default-renderers.ts";
const KIND_VOCABULARY_FILE = "scripts/extensions/agent-binding-kinds.mjs";

/**
 * The lines of the host kind table that hold a top-level key, with that key: line number (1-based, of the
 * comment-masked file) to kind. Null when the table or the vocabulary cannot be read, or when the keys are not
 * set-equal with KNOWN_FIELD_RENDERER_KINDS, so the exemption fails closed.
 */
export function kindTableKeys(root: string): Map<number, string> | null {
  const tableFile = path.join(root, KIND_TABLE_FILE);
  const vocabFile = path.join(root, KIND_VOCABULARY_FILE);
  if (!existsSync(tableFile) || !existsSync(vocabFile)) return null;
  const text = gate.maskComments(readFileSync(tableFile, "utf8"));
  const start = text.indexOf("const RENDERER_KIND_TABLE");
  const open = start < 0 ? -1 : text.indexOf("= {", start);
  const close = open < 0 ? -1 : text.indexOf("\n};", open);
  if (close < 0) return null;
  const firstLine = text.slice(0, open).split("\n").length;
  const keys = new Map<number, string>();
  text
    .slice(open, close)
    .split("\n")
    .forEach((l, i) => {
      const m = /^  ("?)([a-z][a-z0-9-]*)\1\s*:\s*\{/.exec(l);
      if (m) keys.set(firstLine + i, m[2]);
    });
  const vocab = /KNOWN_FIELD_RENDERER_KINDS\s*=\s*Object\.freeze\(\[([^\]]*)\]\)/.exec(readFileSync(vocabFile, "utf8"));
  if (!vocab) return null;
  const known = [...vocab[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
  const tableKinds = [...keys.values()].sort();
  if (known.length === 0 || JSON.stringify(known) !== JSON.stringify(tableKinds)) return null;
  return keys;
}

/** Scan the gate's product roots under `root` for the names; comments are masked first. */
export function scanProductFor(root: string, packs: PublishPack[]): Hit[] {
  const names = namesOf(packs);
  const tableKeys = kindTableKeys(root);
  const hits: Hit[] = [];
  for (const productRoot of gate.PRODUCT_ROOTS) {
    for (const file of gate.walkProductFiles(path.join(root, productRoot), [], root)) {
      const rel = path.relative(root, file).split(path.sep).join("/");
      const text = gate.maskComments(readFileSync(file, "utf8"));
      const lines = text.split("\n");
      for (const n of names) {
        lines.forEach((l, i) => {
          if (!n.re.test(l)) return;
          // The host kind table's own key: the kind, once, as the key of that line, and nowhere else on it.
          const isTableKey =
            n.what.startsWith("renderer kind of ") &&
            rel === KIND_TABLE_FILE &&
            tableKeys?.get(i + 1) === n.name &&
            !n.re.test(l.replace(n.name, ""));
          if (!isTableKey) hits.push({ file: rel, line: i + 1, what: n.what });
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

  // The host kind table (register-default-renderers.ts) and its vocabulary, as a fixture lays them out.
  function kindTable(root: string, keys: string[], vocabulary: string[], extra = "") {
    put(
      root,
      "packages/agents/src/register-default-renderers.ts",
      "const RENDERER_KIND_TABLE: Record<\n  string,\n  { renderer: unknown }\n> = {\n" +
        keys.map((k) => `  ${JSON.stringify(k)}: { renderer: Floor },\n`).join("") +
        "};\n" +
        extra,
    );
    put(
      root,
      "scripts/extensions/agent-binding-kinds.mjs",
      `export const KNOWN_FIELD_RENDERER_KINDS = Object.freeze([\n${vocabulary.map((k) => `  ${JSON.stringify(k)},\n`).join("")}]);\n`,
    );
  }

  it("the host kind table's own key is not a crossing; the same kind elsewhere in that file and in another file is", () => {
    const root = fixtureRoot({ publishes: true });
    kindTable(root, ["demo-confirm-card", "other-kind"], ["other-kind", "demo-confirm-card"], 'export const elsewhere = "demo-confirm-card";\n');
    put(root, "src/lib/planted.ts", 'export const k = { "demo-confirm-card": 1 };\n');
    const hits = scanProductFor(root, publishPacksOf(root));
    expect(hits.map((h) => `${h.file}:${h.line} ${h.what}`).sort()).toEqual([
      "packages/agents/src/register-default-renderers.ts:8 renderer kind of @cinatra-ai/demo-publish-agent",
      "src/lib/planted.ts:1 renderer kind of @cinatra-ai/demo-publish-agent",
    ]);
  });

  it("the table key is a crossing again when the table and the vocabulary are not set-equal", () => {
    const root = fixtureRoot({ publishes: true });
    kindTable(root, ["demo-confirm-card", "other-kind"], ["other-kind"]);
    const hits = scanProductFor(root, publishPacksOf(root));
    expect(hits.map((h) => `${h.file}:${h.line} ${h.what}`)).toEqual([
      "packages/agents/src/register-default-renderers.ts:5 renderer kind of @cinatra-ai/demo-publish-agent",
    ]);
  });

  it("a pack name or renderer id in the kind table file is still a crossing, and so is a table key in another file", () => {
    const root = fixtureRoot({ publishes: true });
    kindTable(root, ["demo-confirm-card"], ["demo-confirm-card"], 'export const id = "@cinatra-ai/demo-publish-agent:confirm-card";\n');
    put(root, "packages/other/src/register-default-renderers.ts", 'const RENDERER_KIND_TABLE = {\n  "demo-confirm-card": { renderer: Floor },\n};\n');
    const hits = scanProductFor(root, publishPacksOf(root)).map((h) => `${h.file}:${h.line} ${h.what}`);
    expect(hits).toContain("packages/agents/src/register-default-renderers.ts:7 package name of @cinatra-ai/demo-publish-agent");
    expect(hits).toContain("packages/agents/src/register-default-renderers.ts:7 renderer id of @cinatra-ai/demo-publish-agent");
    expect(hits).toContain("packages/other/src/register-default-renderers.ts:2 renderer kind of @cinatra-ai/demo-publish-agent");
    expect(hits.filter((h) => h.endsWith("renderer kind of @cinatra-ai/demo-publish-agent"))).toEqual([
      "packages/other/src/register-default-renderers.ts:2 renderer kind of @cinatra-ai/demo-publish-agent",
    ]);
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
    put(root, "extensions/fixture-scope/some-agent/package.json", JSON.stringify({ name: "@cinatra-ai/some-agent" }));
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
