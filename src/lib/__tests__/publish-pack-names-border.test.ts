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
//
// How the two are read (kindTableKeysFrom): both sources with their comments
// masked and the content of their strings blanked, so a commented-out or quoted
// declaration is never the declaration; a key is a top-level key only at brace
// depth 1 of the table object, never a nested property that happens to sit at
// the same indentation; and each declaration must be found exactly once, or the
// test FAILS (it never falls back to an empty or a guessed reading). A table that
// holds a regular expression or a template placeholder is refused the same way,
// because the walk cannot see through either.

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
 * `text` (comments already masked) with the CONTENT of every string and template literal blanked: the quotes,
 * every offset and every newline stay, so a brace, a bracket or a declaration spelled inside a string is never
 * read as code. An unterminated string ends at its line.
 */
function blankStrings(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    out += ch;
    i += 1;
    if (ch !== '"' && ch !== "'" && ch !== "`") continue;
    const quote = ch;
    while (i < text.length && text[i] !== quote && (text[i] !== "\n" || quote === "`")) {
      const width = text[i] === "\\" ? 2 : 1;
      out += text.slice(i, i + width).replace(/[^\n]/g, " ");
      i += width;
    }
    if (text[i] === quote) {
      out += quote;
      i += 1;
    }
  }
  return out;
}

/** A source as the kind table reader sees it: `text` has its comments masked, `code` also has its strings blanked. */
type Code = { text: string; code: string };
const codeOf = (source: string): Code => {
  const text = gate.maskComments(source);
  return { text, code: blankStrings(text) };
};

/** The one match of `re` (global) in a source's code; any other count is a test failure, never a guess. */
function onlyMatch(src: Code, re: RegExp, what: string): RegExpMatchArray {
  const all = [...src.code.matchAll(re)];
  if (all.length !== 1) throw new Error(`expected exactly one ${what} outside comments and strings, found ${all.length}`);
  return all[0];
}

/**
 * The lines of the host kind table that hold a top-level key, with that key: line number (1-based, of the
 * comment-masked file) to kind, from the text of the table file and of the vocabulary file. A key counts only at
 * brace depth 1 of the table object. Null when the keys are not set-equal with KNOWN_FIELD_RENDERER_KINDS, so the
 * exemption fails closed; throws when a declaration is not found exactly once, or the table or the vocabulary
 * cannot be read as plain literals.
 */
export function kindTableKeysFrom(tableSource: string, vocabularySource: string): Map<number, string> | null {
  const table = codeOf(tableSource);
  const declaration = onlyMatch(table, /\bconst\s+RENDERER_KIND_TABLE\b/g, `const RENDERER_KIND_TABLE in ${KIND_TABLE_FILE}`);
  const assignment = /=\s*\{/g;
  assignment.lastIndex = declaration.index ?? 0;
  const opened = assignment.exec(table.code);
  if (!opened) throw new Error(`RENDERER_KIND_TABLE in ${KIND_TABLE_FILE} is not assigned an object literal`);
  const open = opened.index + opened[0].length - 1;
  const keys = new Map<number, string>();
  let depth = 0;
  let line = table.text.slice(0, open).split("\n").length;
  let close = -1;
  for (let i = open; i < table.code.length && close < 0; i += 1) {
    const c = table.code[i];
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) close = i;
    } else if (c === "\n") {
      line += 1;
      if (depth === 1) {
        const end = table.text.indexOf("\n", i + 1);
        const m = /^\s*("?)([a-z][a-z0-9-]*)\1\s*:\s*\{/.exec(table.text.slice(i + 1, end < 0 ? undefined : end));
        if (m) keys.set(line, m[2]);
      }
    }
  }
  if (close < 0) throw new Error(`the RENDERER_KIND_TABLE object literal in ${KIND_TABLE_FILE} is not closed`);
  // A regular expression or a template placeholder can hide a brace or a quote from the walk above, so a table that holds one is refused.
  if (table.code.slice(open, close).includes("/") || table.text.slice(open, close).includes("${")) {
    throw new Error(`the RENDERER_KIND_TABLE object literal in ${KIND_TABLE_FILE} holds a regular expression or a template placeholder, which this reader does not parse`);
  }

  const vocabulary = codeOf(vocabularySource);
  const exported = onlyMatch(
    vocabulary,
    /\bexport\s+const\s+KNOWN_FIELD_RENDERER_KINDS\s*=\s*Object\s*\.\s*freeze\s*\(\s*\[/g,
    `exported KNOWN_FIELD_RENDERER_KINDS in ${KIND_VOCABULARY_FILE}`,
  );
  const from = (exported.index ?? 0) + exported[0].length;
  const to = vocabulary.code.indexOf("]", from);
  if (to < 0) throw new Error(`KNOWN_FIELD_RENDERER_KINDS in ${KIND_VOCABULARY_FILE} is not closed`);
  if (vocabulary.code.slice(from, to).replace(/"\s*"/g, "").replace(/[\s,]/g, "") !== "") {
    throw new Error(`KNOWN_FIELD_RENDERER_KINDS in ${KIND_VOCABULARY_FILE} holds something other than double-quoted string literals`);
  }
  const known = [...vocabulary.text.slice(from, to).matchAll(/"([^"]*)"/g)].map((m) => m[1]).sort();
  const tableKinds = [...keys.values()].sort();
  if (known.length === 0 || JSON.stringify(known) !== JSON.stringify(tableKinds)) return null;
  return keys;
}

/** The same, from the two files under `root`; null when either file is missing (a tree without the host's table). */
export function kindTableKeys(root: string): Map<number, string> | null {
  const tableFile = path.join(root, KIND_TABLE_FILE);
  const vocabFile = path.join(root, KIND_VOCABULARY_FILE);
  if (!existsSync(tableFile) || !existsSync(vocabFile)) return null;
  return kindTableKeysFrom(readFileSync(tableFile, "utf8"), readFileSync(vocabFile, "utf8"));
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

describe("A15 kind table reader: top-level keys only, real declarations only, each exactly once", () => {
  const vocabOf = (kinds: string[], before = "") =>
    `${before}export const KNOWN_FIELD_RENDERER_KINDS = Object.freeze([\n${kinds.map((k) => `  ${JSON.stringify(k)},\n`).join("")}]);\n`;
  const tableOf = (kinds: string[], before = "") =>
    `${before}const RENDERER_KIND_TABLE = {\n${kinds.map((k) => `  ${JSON.stringify(k)}: { renderer: Floor },\n`).join("")}};\n`;
  const crossing = (line: number) => `${KIND_TABLE_FILE}:${line} renderer kind of @cinatra-ai/demo-publish-agent`;
  // The two sources laid into a fixture tree, then scanned: the crossings the scan reports.
  const scanWith = (tableSource: string, vocabularySource: string) => {
    const root = fixtureRoot({ publishes: true });
    put(root, KIND_TABLE_FILE, tableSource);
    put(root, KIND_VOCABULARY_FILE, vocabularySource);
    return scanProductFor(root, publishPacksOf(root)).map((h) => `${h.file}:${h.line} ${h.what}`);
  };

  // The pack's kind is only a NESTED property (line 5), written at the indentation of a top-level key.
  const NESTED = [
    "const RENDERER_KIND_TABLE = {",
    '  "other-kind": {',
    "    renderer: Floor,",
    "    params: {",
    '  "demo-confirm-card": { renderer: Floor },',
    "    },",
    "  },",
    '  "second-kind": { renderer: Floor },',
    "};",
    "",
  ].join("\n");

  it("a nested property at the indentation of a key is not a top-level key", () => {
    const keys = kindTableKeysFrom(NESTED, vocabOf(["other-kind", "second-kind"]));
    expect(keys && [...keys]).toEqual([
      [2, "other-kind"],
      [8, "second-kind"],
    ]);
  });

  it("a kind that is only a nested property is not in the table, even when the vocabulary lists it", () => {
    const vocabulary = vocabOf(["demo-confirm-card", "other-kind", "second-kind"]);
    expect(kindTableKeysFrom(NESTED, vocabulary)).toBeNull();
    expect(scanWith(NESTED, vocabulary)).toEqual([crossing(5)]);
  });

  const STALE_VOCABULARIES: [string, string][] = [
    ["a line comment", '// export const KNOWN_FIELD_RENDERER_KINDS = Object.freeze(["demo-confirm-card", "other-kind"]);\n'],
    ["a block comment", '/*\nexport const KNOWN_FIELD_RENDERER_KINDS = Object.freeze([\n  "demo-confirm-card",\n  "other-kind",\n]);\n*/\n'],
  ];
  for (const [label, stale] of STALE_VOCABULARIES) {
    it(`a stale vocabulary in ${label} does not stand in for the real export`, () => {
      const table = tableOf(["demo-confirm-card", "other-kind"]);
      const vocabulary = vocabOf(["other-kind"], stale); // the real export lists one kind only
      expect(kindTableKeysFrom(table, vocabulary)).toBeNull();
      expect(scanWith(table, vocabulary)).toEqual([crossing(2)]);
    });
  }

  it("the real export is the one read, whatever a stale comment lists", () => {
    const stale = '// export const KNOWN_FIELD_RENDERER_KINDS = Object.freeze(["other-kind"]);\n';
    const keys = kindTableKeysFrom(tableOf(["demo-confirm-card", "other-kind"]), vocabOf(["demo-confirm-card", "other-kind"], stale));
    expect(keys && [...keys.values()].sort()).toEqual(["demo-confirm-card", "other-kind"]);
  });

  it("a commented-out or quoted table declaration is not the table", () => {
    const stale = '// const RENDERER_KIND_TABLE = {\n//   "stale-kind": { renderer: Floor },\n// };\nconst note = "const RENDERER_KIND_TABLE = {";\n';
    const keys = kindTableKeysFrom(tableOf(["other-kind"], stale), vocabOf(["other-kind"]));
    expect(keys && [...keys]).toEqual([[6, "other-kind"]]);
  });

  // A brace and a quote inside strings, and a template that spans two lines, hold braces that are not code.
  const STRINGY = [
    "const RENDERER_KIND_TABLE = {",
    '  "other-kind": { renderer: Floor, note: "} \\" {", also: \'}\' },',
    '  "second-kind": { renderer: Floor, note: `}',
    '  "third-kind": { x: 1 }` },',
    '  "fourth-kind": { renderer: Floor },',
    "};",
    "",
  ].join("\n");

  it("a brace or a quote inside a string does not move the depth", () => {
    const keys = kindTableKeysFrom(STRINGY, vocabOf(["other-kind", "second-kind", "fourth-kind"]));
    expect(keys && [...keys]).toEqual([
      [2, "other-kind"],
      [3, "second-kind"],
      [5, "fourth-kind"],
    ]);
  });

  const UNREADABLE: [string, string, string, RegExp][] = [
    ["no table declaration", "export const unrelated = 1;\n", vocabOf(["a-kind"]), /exactly one const RENDERER_KIND_TABLE.*found 0/],
    ["a table declared only in a comment", '// const RENDERER_KIND_TABLE = {\n//   "a-kind": { renderer: Floor },\n// };\n', vocabOf(["a-kind"]), /RENDERER_KIND_TABLE.*found 0/],
    ["two table declarations", tableOf(["a-kind"]) + tableOf(["a-kind"]), vocabOf(["a-kind"]), /RENDERER_KIND_TABLE.*found 2/],
    ["a table that is never closed", 'const RENDERER_KIND_TABLE = {\n  "a-kind": { renderer: Floor },\n', vocabOf(["a-kind"]), /RENDERER_KIND_TABLE.*not closed/],
    ["a table that holds a regular expression", 'const RENDERER_KIND_TABLE = {\n  "a-kind": { renderer: Floor, match: /x}/ },\n};\n', vocabOf(["a-kind"]), /does not parse/],
    ["a table that holds a regular expression with a quote", 'const RENDERER_KIND_TABLE = {\n  "a-kind": { renderer: Floor, match: /"{/ },\n};\n', vocabOf(["a-kind"]), /does not parse|is not closed/],
    ["a table that holds a template placeholder", 'const RENDERER_KIND_TABLE = {\n  "a-kind": { renderer: Floor, note: `${x}` },\n};\n', vocabOf(["a-kind"]), /does not parse/],
    ["no vocabulary export", tableOf(["a-kind"]), "export const KNOWN_A2UI_TRANSLATOR_KINDS = Object.freeze([]);\n", /exactly one exported KNOWN_FIELD_RENDERER_KINDS.*found 0/],
    ["a vocabulary that is not exported", tableOf(["a-kind"]), 'const KNOWN_FIELD_RENDERER_KINDS = Object.freeze(["a-kind"]);\n', /KNOWN_FIELD_RENDERER_KINDS.*found 0/],
    ["a vocabulary declared only in a comment", tableOf(["a-kind"]), '// export const KNOWN_FIELD_RENDERER_KINDS = Object.freeze(["a-kind"]);\n', /KNOWN_FIELD_RENDERER_KINDS.*found 0/],
    ["two vocabulary exports", tableOf(["a-kind"]), vocabOf(["a-kind"]) + vocabOf(["a-kind"]), /KNOWN_FIELD_RENDERER_KINDS.*found 2/],
    ["a vocabulary that spreads another list", tableOf(["a-kind"]), 'export const KNOWN_FIELD_RENDERER_KINDS = Object.freeze(["a-kind", ...OTHER]);\n', /other than double-quoted string literals/],
  ];
  for (const [label, table, vocabulary, message] of UNREADABLE) {
    it(`fails the test (throws) for ${label}`, () => {
      expect(() => kindTableKeysFrom(table, vocabulary)).toThrow(message);
    });
  }

  it("a scan throws when the table file is there but its declaration is not", () => {
    const root = fixtureRoot({ publishes: true });
    put(root, KIND_TABLE_FILE, "export const nothing = 1;\n");
    put(root, KIND_VOCABULARY_FILE, vocabOf(["a-kind"]));
    expect(() => scanProductFor(root, publishPacksOf(root))).toThrow(/RENDERER_KIND_TABLE.*found 0/);
  });
});

describe("A15 host kind table: the real files", () => {
  it("each declaration is found exactly once, and the top-level keys are set-equal with the vocabulary", () => {
    const keys = kindTableKeys(REPO_ROOT);
    expect(keys, `${KIND_TABLE_FILE} or ${KIND_VOCABULARY_FILE} is missing, or the table keys are not the vocabulary`).not.toBeNull();
    const lines = readFileSync(path.join(REPO_ROOT, KIND_TABLE_FILE), "utf8").split("\n");
    expect(keys?.size).toBeGreaterThan(0);
    for (const [line, kind] of keys ?? []) expect(lines[line - 1]).toContain(kind);
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
