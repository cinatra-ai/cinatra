import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  scanHostPeerValueImports as gateScanHostPeerValueImports,
  parseModuleImports as gateParseModuleImports,
  basePackageOf,
  relativeImportSpecifiers,
  resolveServerEntryFile,
  scanExtensionGraph,
  diffSurface,
  baselineGrowth,
  HOST_PEERS,
} from "../host-peer-value-import-ban.mjs";
// The materialize-time CORE helpers — imported here ONLY for the core-vs-gate
// parity test (the two classifiers must agree form-for-form). Resolved via the
// vitest `@/` alias to src/lib/.
import {
  scanHostPeerValueImports as coreScanHostPeerValueImports,
  parseModuleImports as coreParseModuleImports,
} from "@/lib/extension-package-store-core";

// In the gate's own test surface, the unqualified names refer to the gate copy.
const scanHostPeerValueImports = gateScanHostPeerValueImports;
const parseModuleImports = gateParseModuleImports;

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const GATE = join(REPO_ROOT, "scripts/audit/host-peer-value-import-ban.mjs");
const SDK = "@cinatra-ai/sdk-extensions";

function runGate(extraEnv = {}) {
  return spawnSync("node", [GATE], { cwd: REPO_ROOT, env: { ...process.env, ...extraEnv }, encoding: "utf8" });
}

// Build a throwaway extension dir with the given files + package.json.
function makeExtension(files, cinatra, exportsMap) {
  const dir = mkdtempSync(join(tmpdir(), "cinatra-hpvi-"));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
  }
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "@cinatra-ai/fixture", version: "0.0.1", ...(exportsMap ? { exports: exportsMap } : {}), cinatra }),
  );
  return dir;
}

describe("scanHostPeerValueImports (parity with the materialize-time helper)", () => {
  it("canonical host-peer set is exactly the 3 host-internal SDK peers", () => {
    expect([...HOST_PEERS].sort()).toEqual([
      "@cinatra-ai/mcp-client",
      "@cinatra-ai/sdk-extensions",
      "@cinatra-ai/sdk-ui",
    ]);
  });
  it("does NOT flag a type-only import", () => {
    expect(scanHostPeerValueImports(`import type { Ctx } from "${SDK}";`)).toEqual([]);
  });
  it("does NOT flag a bare `import \"server-only\"` before a type-only host-peer import", () => {
    expect(scanHostPeerValueImports(`import "server-only";\nimport type { X } from "${SDK}";`)).toEqual([]);
  });
  it("flags a named value import", () => {
    const hits = scanHostPeerValueImports(`import { requireExtensionAction } from "${SDK}";`);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ peer: SDK, bindings: ["requireExtensionAction"], line: 1 });
  });
  it("flags a mixed `{ type X, Y }` with only the value binding", () => {
    const hits = scanHostPeerValueImports(`import { type X, requireExtensionAction } from "${SDK}";`);
    expect(hits[0].bindings).toEqual(["requireExtensionAction"]);
  });
  it("flags default / namespace / bare / require / dynamic", () => {
    expect(scanHostPeerValueImports(`import d from "${SDK}";`)).toHaveLength(1);
    expect(scanHostPeerValueImports(`import * as ns from "${SDK}";`)).toHaveLength(1);
    expect(scanHostPeerValueImports(`import "${SDK}";`)).toHaveLength(1);
    expect(scanHostPeerValueImports(`const x = require("${SDK}");`)).toHaveLength(1);
    expect(scanHostPeerValueImports(`const x = await import("${SDK}");`)).toHaveLength(1);
  });
  it("resolves a subpath to the base peer + ignores comments/strings", () => {
    expect(scanHostPeerValueImports(`import { x } from "${SDK}/blog-contract";`)[0].peer).toBe(SDK);
    expect(scanHostPeerValueImports(`// import { x } from "${SDK}"\nconst s = "${SDK}";`)).toEqual([]);
  });
  it("does NOT flag an import-looking STRING literal, but flags a real import on the next line", () => {
    const src = `const s = 'import { x } from "${SDK}";';\nimport { requireExtensionAction } from "${SDK}";`;
    const hits = scanHostPeerValueImports(src);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ peer: SDK, bindings: ["requireExtensionAction"], line: 2 });
  });
});

describe("parseModuleImports (shared classifier — value-edge awareness, parity with the core helper)", () => {
  it("classifies declaration-level `import type` / `export type` as NON-value edges", () => {
    expect(parseModuleImports(`import type { A } from "./c";`)[0]).toMatchObject({ specifier: "./c", isValueEdge: false });
    expect(parseModuleImports(`export type { A } from "./c";`)[0]).toMatchObject({ isValueEdge: false });
  });
  it("classifies an all-inline-`type` brace import/export as a VALUE edge (verbatimModuleSyntax keeps the `import {}` runtime shell)", () => {
    expect(parseModuleImports(`import { type A, type B } from "./c";`)[0]).toMatchObject({ isValueEdge: true, valueBindings: [] });
    expect(parseModuleImports(`export { type A } from "./c";`)[0]).toMatchObject({ isValueEdge: true, valueBindings: [] });
  });
  it("classifies mixed/default/namespace/bare/require/dynamic as VALUE edges", () => {
    expect(parseModuleImports(`import { type X, Y } from "./c";`)[0]).toMatchObject({ isValueEdge: true, valueBindings: ["Y"] });
    expect(parseModuleImports(`import D from "./d";`)[0]).toMatchObject({ isValueEdge: true });
    expect(parseModuleImports(`import * as ns from "./n";`)[0]).toMatchObject({ isValueEdge: true });
    expect(parseModuleImports(`import "./s";`)[0]).toMatchObject({ isValueEdge: true, kind: "bare" });
    expect(parseModuleImports(`const x = require("./r");`)[0]).toMatchObject({ isValueEdge: true, kind: "require" });
    expect(parseModuleImports(`const y = import("./dyn");`)[0]).toMatchObject({ isValueEdge: true, kind: "dynamic" });
  });
  it("reports specifier + line for bare and self-package specifiers too", () => {
    const imps = parseModuleImports(`import type { A } from "./a";\nimport { v } from "@scope/ext/internal";`);
    expect(imps).toHaveLength(2);
    expect(imps[1]).toMatchObject({ specifier: "@scope/ext/internal", line: 2, isValueEdge: true });
  });
});

describe("parser-only edge cases (in the gate copy)", () => {
  it("sees a dynamic `import(\"<peer>\")` inside a template interpolation", () => {
    const hits = scanHostPeerValueImports("const x = `${await import(\"" + SDK + "\")}`;");
    expect(hits).toHaveLength(1);
    expect(hits[0].peer).toBe(SDK);
  });
  it("sees a `require(\"<peer>\")` inside a template interpolation", () => {
    const hits = scanHostPeerValueImports("const x = `${require(\"" + SDK + "\")}`;");
    expect(hits).toHaveLength(1);
    expect(hits[0].peer).toBe(SDK);
  });
  it("`import { type as t }` is a VALUE import of an export named `type`", () => {
    const hits = scanHostPeerValueImports(`import { type as t } from "${SDK}";`);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ peer: SDK, bindings: ["type as t"], line: 1 });
  });
  it("a regex literal whose body mentions the peer is NOT a hit", () => {
    expect(scanHostPeerValueImports(`const r = /import { x } from "${SDK}"/;`)).toEqual([]);
  });
  it("a regex literal does not suppress a real import on a later line", () => {
    const src = `const r = /import { x } from "${SDK}"/;\nimport { requireExtensionAction } from "${SDK}";`;
    const hits = scanHostPeerValueImports(src);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ peer: SDK, bindings: ["requireExtensionAction"], line: 2 });
  });
  it("flags `import sdk = require(\"<peer>\")` (ImportEquals value require)", () => {
    expect(scanHostPeerValueImports(`import sdk = require("${SDK}");`)).toHaveLength(1);
  });
  it("empty `{}` import/export from a host peer is a side-effect runtime edge", () => {
    // Under verbatimModuleSyntax an empty `{}` import/export is preserved as a
    // real module edge, so the prod file:// loader would try to resolve the peer.
    expect(scanHostPeerValueImports(`import {} from "${SDK}";`)).toHaveLength(1);
    expect(scanHostPeerValueImports(`export {} from "${SDK}";`)).toHaveLength(1);
    // only a DECLARATION-level `import type {}` is fully erased → not flagged.
    expect(scanHostPeerValueImports(`import type {} from "${SDK}";`)).toEqual([]);
    // an inline-`type` named import keeps the `import {}` runtime shell → flagged.
    expect(scanHostPeerValueImports(`import { type X } from "${SDK}";`)).toHaveLength(1);
  });

  it("flags a `module.require(\"<peer>\")` member call (CommonJS escape hatch)", () => {
    const hits = scanHostPeerValueImports(`const sdk = module.require("${SDK}");`);
    expect(hits).toHaveLength(1);
    expect(hits[0].peer).toBe(SDK);
  });
  it("does NOT treat an unrelated `<obj>.require(\"<peer>\")` member call as an import", () => {
    expect(parseModuleImports(`foo.require("${SDK}");`)).toEqual([]);
  });
  it("flags a JSX-embedded value `import(\"<peer>\")` when the fileName is `.tsx`", () => {
    const src = `export function Reg(){ return <div>{import("${SDK}")}</div>; }`;
    const hits = scanHostPeerValueImports(src, undefined, "reg.tsx");
    expect(hits).toHaveLength(1);
    expect(hits[0].peer).toBe(SDK);
  });
});

describe("core-vs-gate classifier PARITY (the two must agree form-for-form)", () => {
  // A corpus spanning every form: type-only, mixed, value, default, namespace,
  // bare, require, dynamic, ImportEquals, the `{ type as t }` value-of-`type`
  // case, a `${import()}` template interpolation, and a regex literal.
  const CORPUS = [
    `import type { Ctx } from "${SDK}";`,
    `import { type A, type B } from "${SDK}";`,
    `import { type X, requireExtensionAction } from "${SDK}";`,
    `import { type as t } from "${SDK}";`,
    `import { requireExtensionAction as guard } from "${SDK}";`,
    `import sdk from "${SDK}";`,
    `import * as ns from "${SDK}";`,
    `import "${SDK}";`,
    `import {} from "${SDK}";`,
    `export {} from "${SDK}";`,
    `import type {} from "${SDK}";`,
    `const a = require("${SDK}");`,
    `const b = await import("${SDK}");`,
    `const mr = module.require("${SDK}");`,
    `foo.require("${SDK}");`,
    `import eq = require("${SDK}");`,
    "const c = `${await import(\"" + SDK + "\")}`;",
    "const d = `${require(\"" + SDK + "\")}`;",
    `const r = /import { x } from "${SDK}"/;`,
    `export { requireObjectsProvider } from "${SDK}";`,
    `export type { Foo } from "${SDK}";`,
    `import "server-only";\nimport type { E } from "${SDK}";`,
    `const s = "import { y } from '${SDK}'";\nimport { real } from "${SDK}";`,
  ];

  it("scanHostPeerValueImports agrees on every corpus entry", () => {
    for (const src of CORPUS) {
      const gate = scanHostPeerValueImports(src);
      const core = coreScanHostPeerValueImports(src);
      expect(gate, `gate vs core mismatch on:\n${src}`).toEqual(core);
    }
  });

  it("parseModuleImports agrees on specifier/isValueEdge/valueBindings/kind for every entry", () => {
    const slim = (imps) =>
      imps.map((i) => ({ specifier: i.specifier, isValueEdge: i.isValueEdge, valueBindings: i.valueBindings, kind: i.kind, line: i.line }));
    for (const src of CORPUS) {
      expect(slim(parseModuleImports(src)), `parse mismatch on:\n${src}`).toEqual(slim(coreParseModuleImports(src)));
    }
  });
});

describe("basePackageOf / relativeImportSpecifiers", () => {
  it("collapses subpaths and rejects relative/absolute", () => {
    expect(basePackageOf("@a/b/c")).toBe("@a/b");
    expect(basePackageOf("pkg/sub")).toBe("pkg");
    expect(basePackageOf("./x")).toBeNull();
    expect(basePackageOf("/x")).toBeNull();
  });
  it("collects only relative specifiers (not bare/scoped)", () => {
    const src = `import { a } from "./local";\nimport { b } from "../up";\nimport { c } from "${SDK}";\nimport { d } from "zod";`;
    expect(relativeImportSpecifiers(src).sort()).toEqual(["../up", "./local"]);
  });
});

describe("scanExtensionGraph (graph reachability is the discriminator)", () => {
  it("flags a value import in the serverEntry file itself", () => {
    const dir = makeExtension(
      { "src/register.ts": `import { registerCrmProvider } from "${SDK}";\nexport function register(){ registerCrmProvider(); }` },
      { serverEntry: "./register" },
      { ".": "./src/index.ts", "./register": "./src/register.ts" },
    );
    const hits = scanExtensionGraph(dir, JSON.parse(readPkg(dir)));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("src/register.ts");
    expect(hits[0]).toContain(SDK);
  });

  it("flags a value import in a TRANSITIVELY-reachable file", () => {
    const dir = makeExtension(
      {
        "src/register.ts": `import type { Ctx } from "${SDK}";\nimport { helper } from "./actions";\nexport function register(c){ helper(); }`,
        "src/actions.ts": `import { requireExtensionAction } from "${SDK}";\nexport function helper(){ requireExtensionAction(); }`,
      },
      { serverEntry: "./register" },
      { "./register": "./src/register.ts" },
    );
    const hits = scanExtensionGraph(dir, JSON.parse(readPkg(dir)));
    expect(hits.some((h) => h.includes("src/actions.ts"))).toBe(true);
  });

  it("does NOT flag a value import in a file UNREACHABLE from serverEntry (the false-positive guard)", () => {
    const dir = makeExtension(
      {
        "src/register.ts": `import type { Ctx } from "${SDK}";\nexport function register(c){}`,
        // actions.ts value-imports the peer but register never imports it → out of graph.
        "src/actions.ts": `import { requireExtensionAction } from "${SDK}";\nexport function helper(){ requireExtensionAction(); }`,
      },
      { serverEntry: "./register" },
      { "./register": "./src/register.ts" },
    );
    expect(scanExtensionGraph(dir, JSON.parse(readPkg(dir)))).toEqual([]);
  });

  it("returns empty when serverEntry is null (nothing to gate)", () => {
    const dir = makeExtension(
      { "src/actions.ts": `import { requireExtensionAction } from "${SDK}";` },
      { serverEntry: null },
    );
    expect(scanExtensionGraph(dir, JSON.parse(readPkg(dir)))).toEqual([]);
  });

  it("does NOT follow into node_modules (bundled deps are out of scope)", () => {
    const dir = makeExtension(
      {
        "src/register.ts": `import type { Ctx } from "${SDK}";\nimport { dep } from "some-dep";\nexport function register(c){ dep(); }`,
        "node_modules/some-dep/index.js": `const sdk = require("${SDK}");\nexports.dep = () => sdk;`,
      },
      { serverEntry: "./register" },
      { "./register": "./src/register.ts" },
    );
    expect(scanExtensionGraph(dir, JSON.parse(readPkg(dir)))).toEqual([]);
  });

  it("does NOT follow a `import type` relative edge (type edges have no runtime presence)", () => {
    const dir = makeExtension(
      {
        // register type-only-imports ./contract; contract value-imports the peer
        // but is reached ONLY type-only → must NOT be flagged.
        "src/register.ts": `import type { Thing } from "./contract";\nexport function register(){ return null; }`,
        "src/contract.ts": `import { requireExtensionAction } from "${SDK}";\nexport type Thing = ReturnType<typeof requireExtensionAction>;`,
      },
      { serverEntry: "./register" },
      { "./register": "./src/register.ts" },
    );
    expect(scanExtensionGraph(dir, JSON.parse(readPkg(dir)))).toEqual([]);
  });

  it("follows a VALUE edge through the package's OWN name subpath (self-reference via exports)", () => {
    const dir = makeExtension(
      {
        "src/register.ts": `import type { Ctx } from "${SDK}";\nimport { run } from "@cinatra-ai/fixture/internal";\nexport function register(c){ run(); }`,
        "src/internal.ts": `import { requireExtensionAction } from "${SDK}";\nexport function run(){ requireExtensionAction(); }`,
      },
      { serverEntry: "./register" },
      { ".": "./src/index.ts", "./register": "./src/register.ts", "./internal": "./src/internal.ts" },
    );
    const hits = scanExtensionGraph(dir, JSON.parse(readPkg(dir)));
    expect(hits.some((h) => h.includes("src/internal.ts"))).toBe(true);
  });

  it("does NOT follow a TRUE third-party bare specifier (only the package's own name self-resolves)", () => {
    const dir = makeExtension(
      {
        "src/register.ts": `import type { Ctx } from "${SDK}";\nimport { run } from "other-pkg/internal";\nexport function register(c){ run(); }`,
        "node_modules/other-pkg/internal.js": `const sdk = require("${SDK}");\nexports.run = () => sdk;`,
      },
      { serverEntry: "./register" },
      { "./register": "./src/register.ts" },
    );
    expect(scanExtensionGraph(dir, JSON.parse(readPkg(dir)))).toEqual([]);
  });

  it("flags a JSX-embedded value `import(\"<peer>\")` in a `.tsx` serverEntry (real-filename ScriptKind)", () => {
    // The graph walker MUST thread the real `.tsx` path so the parser uses TSX
    // ScriptKind — otherwise the JSX fails to parse and the embedded value
    // import is silently missed (a fail-open gap).
    const dir = makeExtension(
      { "src/register.tsx": `export function Register(){ return <div>{import("${SDK}")}</div>; }` },
      { serverEntry: "./register" },
      { "./register": "./src/register.tsx" },
    );
    const hits = scanExtensionGraph(dir, JSON.parse(readPkg(dir)));
    expect(hits.some((h) => h.includes("src/register.tsx") && h.includes(SDK))).toBe(true);
  });

  it("flags a `module.require(\"<peer>\")` member call in the graph", () => {
    const dir = makeExtension(
      { "src/register.ts": `export function register(){ return module.require("${SDK}"); }` },
      { serverEntry: "./register" },
      { "./register": "./src/register.ts" },
    );
    const hits = scanExtensionGraph(dir, JSON.parse(readPkg(dir)));
    expect(hits.some((h) => h.includes("src/register.ts") && h.includes(SDK))).toBe(true);
  });

  it("resolveServerEntryFile handles a direct-path serverEntry and rejects traversal", () => {
    const dir = makeExtension({ "register.mjs": `export function register(){}` }, { serverEntry: "./register.mjs" });
    expect(resolveServerEntryFile(dir, JSON.parse(readPkg(dir)))).toContain("register.mjs");
    expect(resolveServerEntryFile(dir, { cinatra: { serverEntry: "../escape" } })).toBeNull();
    expect(resolveServerEntryFile(dir, { cinatra: { serverEntry: "/etc/passwd" } })).toBeNull();
    expect(resolveServerEntryFile(dir, { cinatra: {} })).toBeNull();
  });

  it("FAILS LOUD when a file that resolved INTO the graph cannot be read (CI/core parity)", () => {
    // Matches the materialize core's `assertNoHostPeerValueImports`: a file that
    // entered the graph and then fails to read must THROW (not be silently
    // skipped). register.ts value-imports ./helper; we make helper.ts unreadable.
    const dir = makeExtension(
      {
        "src/register.ts": `import type { Ctx } from "${SDK}";\nimport { helper } from "./helper";\nexport function register(c){ helper(); }`,
        "src/helper.ts": `export function helper(){}`,
      },
      { serverEntry: "./register" },
      { "./register": "./src/register.ts" },
    );
    const helperAbs = join(dir, "src/helper.ts");
    chmodSync(helperAbs, 0o000);
    let readable = true;
    try {
      readFileSync(helperAbs, "utf8");
    } catch {
      readable = false;
    }
    try {
      if (!readable) {
        // chmod 000 is a no-op when running as root — only assert when it took.
        expect(() => scanExtensionGraph(dir, JSON.parse(readPkg(dir)))).toThrow(/cannot be read/);
      }
    } finally {
      chmodSync(helperAbs, 0o644);
    }
  });

  it("does NOT throw for a no-serverEntry or missing-serverEntry package (those stay graceful skips)", () => {
    const noEntry = makeExtension({ "src/x.ts": `export const x = 1;` }, { serverEntry: null });
    expect(scanExtensionGraph(noEntry, JSON.parse(readPkg(noEntry)))).toEqual([]);
    const missing = makeExtension({ "src/x.ts": `export const x = 1;` }, { serverEntry: "./does-not-exist" });
    expect(scanExtensionGraph(missing, JSON.parse(readPkg(missing)))).toEqual([]);
  });
});

describe("diffSurface (no-new-rot core)", () => {
  it("passes when current == baseline", () => {
    const b = { surface: { "@cinatra-ai/x": ["a.ts :: " + SDK + " (foo) L1"] } };
    const { newViolations, stale } = diffSurface(b, b.surface);
    expect(newViolations).toEqual([]);
    expect(stale).toEqual([]);
  });
  it("FAILS on a NEW hit not in the baseline", () => {
    const b = { surface: {} };
    const cur = { "@cinatra-ai/x": ["a.ts :: " + SDK + " (foo) L1"] };
    const { newViolations } = diffSurface(b, cur);
    expect(newViolations).toHaveLength(1);
    expect(newViolations[0]).toContain("@cinatra-ai/x");
  });
  it("reports a stale baseline entry (resolved — present in baseline, gone now)", () => {
    const b = { surface: { "@cinatra-ai/x": ["a.ts :: " + SDK + " (foo) L1"] } };
    const { newViolations, stale } = diffSurface(b, {});
    expect(newViolations).toEqual([]);
    expect(stale.some((s) => s.includes("@cinatra-ai/x"))).toBe(true);
  });
});

describe("baselineGrowth (monotonic-ratchet guard)", () => {
  const base = { surface: { "@cinatra-ai/x": ["a.ts :: " + SDK + " (foo) L1"] } };
  it("allows a shrunk / identical committed baseline", () => {
    expect(baselineGrowth(base, { surface: {} })).toEqual([]);
    expect(baselineGrowth(base, base)).toEqual([]);
  });
  it("FAILS when the committed baseline ADDED a new entry (the attack)", () => {
    const committed = { surface: { "@cinatra-ai/x": ["a.ts :: " + SDK + " (foo) L1", "b.ts :: " + SDK + " (bar) L2"] } };
    const grew = baselineGrowth(base, committed);
    expect(grew.some((g) => g.includes("b.ts"))).toBe(true);
  });
});

describe("gate smoke + monotonic fail-closed", () => {
  it("exits 0 with the committed (empty) baseline and no base ref", () => {
    const r = runGate({ HOST_PEER_BAN_BASE: "" });
    // 0 = pass; 1 only if assertExtensionsPresent fails (extensions not cloned).
    // Either way it must not crash (status 2) — accept 0 (clean) or 1 (no clone-back).
    expect([0, 1]).toContain(r.status);
    if (r.status === 0) expect(r.stdout).toContain("[host-peer-value-import-ban] OK");
  });
  it("FAILS CLOSED (exit 1) when HOST_PEER_BAN_BASE is set but unresolvable", () => {
    const r = runGate({ HOST_PEER_BAN_BASE: "definitely-not-a-real-ref-zzz-9f3a1" });
    // assert-extensions may exit first if not cloned; otherwise the monotonic guard fails closed.
    expect(r.status).toBe(1);
  });
  it("FAILS CLOSED (exit 1) when HOST_PEER_BAN_BASE is flag-like (leading dash)", () => {
    const r = runGate({ HOST_PEER_BAN_BASE: "--upload-pack=evil" });
    expect(r.status).toBe(1);
  });
});

// helper: read a fixture's package.json text
function readPkg(dir) {
  return readFileSync(join(dir, "package.json"), "utf8");
}
