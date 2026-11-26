// core-pack-pin-gate tests (cinatra#4853).
//
// The fixture trees are temporary repositories whose locks pin packages of the
// owner `@example-org/…`; no real pack is named. The last block is the TEST OF
// RECORD: it runs the gate over the real tree, with the floor compared with the
// base branch on a pull request's run, so the root suite (`pnpm test:root`,
// job "Perpetual core invariants") refuses a new pin, a stale entry or a grown
// floor on every pull request.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BASELINE_REL,
  GATE_REL,
  REPO_ROOT,
  ScannerError,
  isCoreTestPath,
  loadPinnedPacks,
  normalizePath,
  runGate,
  scanCorePins,
  writeBaseline,
} from "../core-pack-pin-gate.mjs";
import { makeFloorRepo } from "./floor-base-fixture.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const LOCK = {
  packages: [
    { packageName: "@example-org/demo-agent", repo: "example-org/demo-agent", resolvedSha: SHA },
    { packageName: "@example-org/other-artifact", repo: "example-org/other-artifact", resolvedSha: "f".repeat(40) },
  ],
};
const LOCKS = {
  "cinatra-required-extensions.lock.json": LOCK,
  "cinatra-dev-extensions.lock.json": { packages: [LOCK.packages[0]] },
};

const roots = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), "core-pack-pin-"));
  roots.push(root);
  for (const [rel, content] of Object.entries({ ...LOCKS, ...files })) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
  return root;
}

const pins = (files) => scanCorePins(tree(files)).map((f) => `${f.rule} :: ${f.file} :: ${f.pack}`);

const T = "packages/agents/src/__tests__/";

describe("the read rule: a core test that reads one pinned pack from the extensions tree", () => {
  it("finds a relative path into a pinned pack's directory (red first)", () => {
    const src = `import { readFileSync } from "node:fs";
const oas = readFileSync(new URL("../../../../extensions/example-org/demo-agent/cinatra/oas.json", import.meta.url));`;
    expect(pins({ [`${T}demo.test.ts`]: src })).toEqual([`read :: ${T}demo.test.ts :: @example-org/demo-agent`]);
  });

  it("finds a path joined from literal segments after the repository root", () => {
    const src = `const dir = path.join(REPO_ROOT, "extensions", "example-org", "demo-agent");`;
    expect(pins({ [`src/lib/__tests__/a.test.ts`]: src })).toEqual([`read :: src/lib/__tests__/a.test.ts :: @example-org/demo-agent`]);
  });

  it("finds a pack named in a literal of a file whose path reaches the tree with the name in a variable", () => {
    const src = `const EXT = path.resolve(__dirname, "../../../../extensions/example-org");
const AGENTS = ["demo-agent"];
for (const a of AGENTS) readFileSync(path.join(EXT, a, "cinatra/oas.json"));`;
    expect(pins({ [`${T}named.test.ts`]: src })).toEqual([`read :: ${T}named.test.ts :: @example-org/demo-agent`]);
  });

  it("finds an import of a pinned pack (a subpath too), not a type-only one", () => {
    expect(pins({ [`${T}i.test.ts`]: `import { x } from "@example-org/demo-agent/src/x";` })).toEqual([
      `read :: ${T}i.test.ts :: @example-org/demo-agent`,
    ]);
    expect(pins({ [`${T}t.test.ts`]: `import type { X } from "@example-org/demo-agent";` })).toEqual([]);
  });

  it("does not find a test that proves its rule on a synthetic flow", () => {
    const src = `const flow = { component_type: "Flow", id: "synthetic", nodes: [] };
expect(validate(flow)).toEqual([]);`;
    expect(pins({ [`${T}synthetic.test.ts`]: src })).toEqual([]);
  });

  it("does not find a fleet test that iterates the lock and names no pack", () => {
    const src = `const lock = JSON.parse(readFileSync(path.join(ROOT, "cinatra-dev-extensions.lock.json"), "utf8"));
for (const row of lock.packages) {
  const dir = path.join(ROOT, "extensions", row.packageName.slice(1));
  expect(existsSync(path.join(dir, "package.json"))).toBe(true);
}
for (const d of readdirSync(\`\${ROOT}/extensions/\${scope}\`)) check(d);`;
    expect(pins({ [`${T}fleet.test.ts`]: src })).toEqual([]);
  });

  describe("no temporary-root exemption: a pinned pack's path counts wherever it is rooted", () => {
    const DEMO = "@example-org/demo-agent";

    it("finds a root whose name or callee only looks temporary (a local tmpdir(), resolve(tmpdir(), REPO_ROOT))", () => {
      const localTmpdir = `function tmpdir() {\n  return REPO_ROOT;\n}\nreadFileSync(join(tmpdir(), "extensions/example-org/demo-agent/oas.json"));`;
      const resolveOverTmp = `readFileSync(join(resolve(tmpdir(), REPO_ROOT), "extensions/example-org/demo-agent/oas.json"));`;
      expect(pins({ [`${T}localTmpdir.test.ts`]: localTmpdir, [`${T}resolveOverTmp.test.ts`]: resolveOverTmp })).toEqual([
        `read :: ${T}localTmpdir.test.ts :: ${DEMO}`,
        `read :: ${T}resolveOverTmp.test.ts :: ${DEMO}`,
      ]);
    });

    it("finds a pinned pack's tree rebuilt in a real temporary directory, a stand-in absolute path or a core directory; not a made-up pack", () => {
      const js = `const tmp = mkdtempSync(path.join(os.tmpdir(), "x-"));
mkdirSync(path.join(tmp, "extensions/example-org/demo-agent"), { recursive: true });`;
      const abs = `expect(map("x")).toBe(path.resolve("/repo/extensions/example-org/demo-agent"));`;
      const core = `const a = "src/components/extensions/example-org/demo-agent/x.ts";`;
      // A test that needs a made-up pack uses a made-up name: no lock pins it.
      const madeUpJs = js.replace("demo-agent", "made-up-agent");
      expect(
        pins({
          [`${T}tmp.test.ts`]: js,
          [`${T}abs.test.ts`]: abs,
          [`${T}core.test.ts`]: core,
          [`${T}madeup.test.ts`]: madeUpJs,
        }),
      ).toEqual([
        `read :: ${T}abs.test.ts :: ${DEMO}`,
        `read :: ${T}core.test.ts :: ${DEMO}`,
        `read :: ${T}tmp.test.ts :: ${DEMO}`,
      ]);
    });
  });

  it("exempts an import or export-from only when it loads no value", () => {
    const P = `"@example-org/demo-agent"`;
    const typeOnly = {
      declaration: `import type { X } from ${P};`,
      specifiers: `import { type X, type Y } from ${P};`,
      exportDeclaration: `export type { X } from ${P};`,
      exportSpecifiers: `export { type X, type Y } from ${P};`,
      importEqualsType: `import type X = require(${P});`,
    };
    const runtime = {
      mixed: `import { type X, y } from ${P};`,
      defaultAndType: `import D, { type X } from ${P};`,
      namespace: `import * as ns from ${P};`,
      sideEffect: `import ${P};`,
      empty: `import {} from ${P};`,
      exportMixed: `export { type X, y } from ${P};`,
      exportStar: `export * from ${P};`,
      importEquals: `import X = require(${P});`,
      requireActual: `const m = jest.requireActual(${P});`,
    };
    const files = {};
    for (const [k, v] of Object.entries({ ...typeOnly, ...runtime })) files[`${T}${k}.test.ts`] = v;
    expect(pins(files)).toEqual(Object.keys(runtime).sort().map((k) => `read :: ${T}${k}.test.ts :: @example-org/demo-agent`));
  });

  it("does not find a pack named only as a label, or `extensions` used as a word", () => {
    const src = `it("@example-org/demo-agent", () => expect(label(x)).toBe("Demo"));
expect(crumbs(["configuration", "extensions", "x"])).toEqual([]);
expect(route("/extensions/upload")).toBe(true);`;
    expect(pins({ [`${T}label.test.ts`]: src })).toEqual([]);
  });

  it("ignores comments and packs no lock pins", () => {
    const src = `// reads extensions/example-org/demo-agent/cinatra/oas.json
const b = "../../../../extensions/example-org/unpinned-agent/oas.json";`;
    expect(pins({ [`${T}c.test.ts`]: src })).toEqual([]);
  });

  it("reads core test and fixture files only: product code and the extensions tree are not scanned", () => {
    expect(isCoreTestPath("packages/agents/src/__tests__/a.test.ts")).toBe(true);
    expect(isCoreTestPath("docker/wayflow/tests/fixtures/f.json")).toBe(true);
    expect(isCoreTestPath("src/lib/thing.ts")).toBe(false);
    expect(isCoreTestPath("extensions/example-org/demo-agent/__tests__/a.test.ts")).toBe(false);
    expect(isCoreTestPath("packages/x/node_modules/y/__tests__/a.test.js")).toBe(false);
    // Python tests are not covered yet (the follow-up is part of cinatra#4853).
    expect(isCoreTestPath("docker/wayflow/tests/test_demo.py")).toBe(false);
  });
});

describe("one path normalizer and one comparison for every caller", () => {
  const DEMO = "@example-org/demo-agent";
  const F = "docker/wayflow/tests/fixtures/";

  it("normalizes `.`, `..`, repeated separators and backslashes before judging a path", () => {
    expect(normalizePath("extensions/./example-org/demo-agent")).toEqual(["extensions", "example-org", "demo-agent"]);
    expect(normalizePath("../x/../extensions/example-org/demo-agent")).toEqual(["..", "extensions", "example-org", "demo-agent"]);
    expect(normalizePath("./extensions//example-org")).toEqual([".", "extensions", "example-org"]);
    expect(normalizePath("C:\\repo\\extensions\\example-org\\demo-agent")).toEqual(["C:", "repo", "extensions", "example-org", "demo-agent"]);
    expect(normalizePath("/../extensions/%2E/example-org")).toEqual(["", "extensions", "example-org"]);
    // An encoded separator is no separator: fileURLToPath refuses it, a plain path keeps it.
    expect(normalizePath("extensions/example-org%2Fdemo-agent")).toEqual(["extensions", "example-org%2Fdemo-agent"]);
  });

  it("finds a code path into a pinned pack written with `./`, `../x/../`, `//` or backslashes", () => {
    const forms = {
      dot: `readFileSync("../../extensions/./example-org/demo-agent/oas.json");`,
      up: `readFileSync(join(ROOT, "extensions/x/../example-org/demo-agent/oas.json"));`,
      double: `readFileSync(ROOT + "/extensions//example-org//demo-agent/oas.json");`,
      back: `readFileSync("..\\\\..\\\\extensions\\\\example-org\\\\demo-agent\\\\oas.json");`,
      escaped: `readFileSync(new URL("../../extensions/example-org/demo%2Dagent/oas.json", import.meta.url));`,
    };
    const files = {};
    for (const [k, v] of Object.entries(forms)) files[`${T}${k}.test.ts`] = v;
    expect(pins(files)).toEqual(Object.keys(forms).sort().map((k) => `read :: ${T}${k}.test.ts :: ${DEMO}`));
  });

  it("applies the path rule to every string and key of a JSON fixture, flow-shaped or not", () => {
    const files = {
      [`${F}flow-path.json`]: { component_type: "Flow", id: "f", nodes: [{ source: "extensions/example-org/demo-agent/flow.json" }] },
      [`${F}plain-path.json`]: { source: "../../extensions/./example-org/demo-agent/oas.json" },
      [`${F}key-path.json`]: { "extensions\\example-org\\demo-agent": true },
      [`${F}synthetic.json`]: { source: "extensions/example-org/made-up-agent/flow.json" },
    };
    expect(pins(files)).toEqual([
      `read :: ${F}flow-path.json :: ${DEMO}`,
      `read :: ${F}key-path.json :: ${DEMO}`,
      `read :: ${F}plain-path.json :: ${DEMO}`,
    ]);
  });

  it("compares package names and sha prefixes without case", () => {
    const files = {
      [`${T}upper-import.test.ts`]: `import { x } from "@Example-Org/Demo-Agent";`,
      [`${T}upper-path.test.ts`]: `readFileSync("../../extensions/Example-Org/DEMO-AGENT/oas.json");`,
      [`${F}upper-sha.json`]: { component_type: "Flow", id: "f", nodes: [], $comment: `copied at ${SHA.slice(0, 7).toUpperCase()}` },
      [`${F}upper-name.json`]: { component_type: "Flow", id: "f", nodes: [], metadata: { packageName: "@EXAMPLE-ORG/demo-agent" } },
    };
    expect(pins(files)).toEqual([
      `flow :: ${F}upper-name.json :: ${DEMO}`,
      `flow :: ${F}upper-sha.json :: sha:${SHA.slice(0, 7)}`,
      `read :: ${T}upper-import.test.ts :: ${DEMO}`,
      `read :: ${T}upper-path.test.ts :: ${DEMO}`,
    ]);
  });

  it("exempts a type-only load from the path rule too, structurally; a value load of the same path counts", () => {
    const P = `"../../extensions/example-org/demo-agent/src/x"`;
    const files = {
      [`${T}type-import.test.ts`]: `import type { X } from ${P};`,
      [`${T}type-query.test.ts`]: `type M = typeof import(${P});`,
      [`${T}value-import.test.ts`]: `import { x } from ${P};`,
    };
    expect(pins(files)).toEqual([`read :: ${T}value-import.test.ts :: ${DEMO}`]);
  });
});

describe("transparent wrappers: the scanner reads through everything the TypeScript tree wraps around an expression", () => {
  const DEMO = "@example-org/demo-agent";
  // Every wrapper that changes no value: parentheses (twice too), `as`,
  // `satisfies`, a non-null `!`, a type assertion `<T>x` and `await`.
  const WRAPPERS = {
    paren: (x) => `(${x})`,
    doubleParen: (x) => `((${x}))`,
    as: (x) => `(${x} as string)`,
    asUnwrapped: (x) => `${x} as string`,
    satisfies: (x) => `(${x} satisfies string)`,
    nonNull: (x) => `${x}!`,
    typeAssertion: (x) => `<string>${x}`,
    await: (x) => `await ${x}`,
    awaitParen: (x) => `(await (${x}))`,
  };
  // A module file (it has an export), so `await` is the keyword in every position.
  const pinsOf = (files) => pins(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, `export {};\n${v}`])));
  const found = (kind) => [`read :: ${T}${kind}.test.ts :: ${DEMO}`];
  const each = (build) => {
    const files = {};
    for (const [name, wrap] of Object.entries(WRAPPERS)) files[`${T}${name}.test.ts`] = build(wrap);
    return files;
  };
  const expected = () => Object.keys(WRAPPERS).sort().flatMap((n) => found(n));

  it("finds a path joined from literals when the whole call is wrapped", () => {
    const files = each((w) => `readFileSync(${w(`path.join(ROOT, "extensions", "example-org", "demo-agent")`)});`);
    expect(pinsOf(files)).toEqual(expected());
  });

  it("finds a path literal when the literal is wrapped", () => {
    const files = each((w) => `readFileSync(${w(`"extensions/example-org/demo-agent/cinatra/oas.json"`)});`);
    expect(pinsOf(files)).toEqual(expected());
  });

  it("finds a path whose segments are wrapped inside the join", () => {
    const files = each((w) => `const d = path.join(ROOT, ${w(`"extensions"`)}, ${w(`"example-org"`)}, ${w(`"demo-agent"`)});`);
    expect(pinsOf(files)).toEqual(expected());
  });

  it("finds a path built with + when an operand is wrapped", () => {
    const files = each((w) => `const d = ROOT + "/" + ${w(`"extensions/example-org/"`)} + "demo-agent";`);
    expect(pinsOf(files)).toEqual(expected());
  });

  it("finds a dynamic import and a require whose specifier is wrapped", () => {
    const dyn = each((w) => `const m = import(${w(`"${DEMO}"`)});`);
    const req = {};
    for (const [name, wrap] of Object.entries(WRAPPERS)) req[`${T}req-${name}.test.ts`] = `const m = require(${wrap(`"${DEMO}"`)});`;
    expect(pinsOf({ ...dyn, ...req })).toEqual(
      [...Object.keys(WRAPPERS).map((n) => `req-${n}`), ...Object.keys(WRAPPERS)].sort().map((n) => `read :: ${T}${n}.test.ts :: ${DEMO}`),
    );
  });

  it("finds require.resolve, import.meta.resolve and importActual whose specifier is wrapped", () => {
    const files = {};
    for (const [name, wrap] of Object.entries(WRAPPERS)) {
      files[`${T}res-${name}.test.ts`] = `const p = require.resolve(${wrap(`"${DEMO}"`)});`;
      files[`${T}meta-${name}.test.ts`] = `const p = import.meta.resolve(${wrap(`"${DEMO}"`)});`;
      files[`${T}act-${name}.test.ts`] = `const m = await vi.importActual(${wrap(`"${DEMO}"`)});`;
    }
    const names = Object.keys(WRAPPERS).flatMap((n) => [`res-${n}`, `meta-${n}`, `act-${n}`]).sort();
    expect(pinsOf(files)).toEqual(names.map((n) => `read :: ${T}${n}.test.ts :: ${DEMO}`));
  });

  it("finds a load whose callee is wrapped", () => {
    const P = `"${DEMO}"`;
    const files = {
      [`${T}callee-paren.test.ts`]: `const m = (require)(${P});`,
      [`${T}callee-nonnull.test.ts`]: `const m = require!(${P});`,
      [`${T}callee-as.test.ts`]: `const m = (require as NodeRequire)(${P});`,
      [`${T}recv-as.test.ts`]: `const m = (vi as any).importActual(${P});`,
      [`${T}recv-paren.test.ts`]: `const m = (jest).requireActual(${P});`,
      [`${T}resolve-paren.test.ts`]: `const p = (require).resolve(${P});`,
      [`${T}joiner-paren.test.ts`]: `readFileSync((path.join)(ROOT, "extensions/example-org/demo-agent"));`,
    };
    expect(pinsOf(files)).toEqual(Object.keys(files).map((f) => f.replace(T, "")).sort().map((f) => `read :: ${T}${f} :: ${DEMO}`));
  });

  it("does not find a wrapped made-up pack, or a wrapped path that stops at the tree", () => {
    const files = each((w) => `readFileSync(${w(`path.join(ROOT, "extensions", "made-up-org", "made-up-agent")`)});
const m = import(${w(`"@made-up-org/made-up-agent"`)});
const t = readdirSync(${w(`path.join(ROOT, "extensions", scope)`)});`);
    expect(pinsOf(files)).toEqual([]);
  });
});

describe("module mocks name a module like an import does", () => {
  const DEMO = "@example-org/demo-agent";
  const P = `"${DEMO}"`;

  // The names are spelled through V and J so this file holds no literal module
  // mock call itself (the runner would hoist and rewrite the file's imports).
  const V = "vi";
  const J = "jest";
  const VI = ["doMock", "doUnmock", "importActual", "importMock", "mock", "unmock"];
  const JEST = ["createMockFromModule", "doMock", "dontMock", "genMockFromModule", "mock", "requireActual", "requireMock", "setMock", "unmock"];

  it("finds a pinned package named by each call of the table, on vi and on jest", () => {
    const files = {};
    for (const [recv, names] of [["vi", VI], ["jest", JEST]]) {
      for (const name of names) files[`${T}${recv}-${name}.test.ts`] = `${recv}.${name}(${P}, () => ({}));`;
    }
    expect(pins(files)).toEqual(Object.keys(files).map((f) => f.replace(T, "")).sort().map((f) => `read :: ${T}${f} :: ${DEMO}`));
  });

  it("finds a mocked pack by a subpath, a template literal and a wrapped specifier", () => {
    const files = {
      [`${T}sub.test.ts`]: `${V}.mock("${DEMO}/src/x", () => ({}));`,
      [`${T}tpl.test.ts`]: V + ".doMock(`" + DEMO + "`, () => ({}));",
      [`${T}wrapped.test.ts`]: `${V}.mock((${P} as string), () => ({}));`,
      [`${T}hoisted.test.ts`]: `const m = ${V}.hoisted(async () => await ${V}.importMock(${P}));`,
      [`${T}factory.test.ts`]: `${V}.mock(${P}, async () => ({ ...(await ${V}.importActual(${P})) }));`,
    };
    expect(pins(files)).toEqual(Object.keys(files).map((f) => f.replace(T, "")).sort().map((f) => `read :: ${T}${f} :: ${DEMO}`));
  });

  it("does not find a mock of a made-up pack or of a core module", () => {
    const files = {
      [`${T}made-up.test.ts`]: `${V}.mock("@made-up-org/made-up-agent", () => ({}));\n${J}.mock("@made-up-org/other", () => ({}));`,
      [`${T}core.test.ts`]: `${V}.mock("@/lib/db", () => ({}));\n${V}.unmock("node:fs");`,
    };
    expect(pins(files)).toEqual([]);
  });
});

describe("a pinned package name counts wherever it stands, whoever receives it", () => {
  const DEMO = "@example-org/demo-agent";
  const P = `"${DEMO}"`;
  const each = (srcs) => Object.fromEntries(Object.entries(srcs).map(([k, v]) => [`${T}${k}.test.ts`, v]));
  const all = (files) => Object.keys(files).sort().map((f) => `read :: ${f} :: ${DEMO}`);

  it("finds the name passed to an aliased require, a renamed mock or any call", () => {
    const files = each({
      aliased: `const req = createRequire(import.meta.url);\nconst p = req.resolve(${P});`,
      aliasedSub: `const r = createRequire(import.meta.url);\nconst m = r(${P} + "/x");`,
      renamedMock: `const mockModule = vi.mock;\nmockModule(${P}, () => ({}));`,
      anyCall: `const m = load(${P});`,
      wrapped: `const p = req.resolve((${P} as string));`,
    });
    expect(pins(files)).toEqual(all(files));
  });

  it("finds the name or a sub-path of it in an array, an object value and a template", () => {
    const files = each({
      array: `const mods = ["node:fs", ${P}];`,
      object: `const cfg = { alias: { x: "${DEMO}/src/x" } };`,
      template: "const s = `" + DEMO + "`;",
      templateHead: "const s = `" + DEMO + "/${sub}`;",
      message: `expect(m, ${P}).toBeDefined();`,
    });
    expect(pins(files)).toEqual(all(files));
  });

  it("exempts a test title (describe, it, test and their each, skip and only forms) and a type-only load, nothing else", () => {
    const titles = each({
      describe: `describe(${P}, () => {});`,
      it: `it(${P}, () => {});`,
      test: `test("${DEMO}/x", () => {});`,
      skip: `it.skip(${P}, () => {});`,
      only: `describe.only(${P}, () => {});`,
      each: `test.each([1])(${P}, () => {});`,
      onlyEach: `it.only.each([1])(${P}, () => {});`,
      typeOf: `type M = typeof import(${P});`,
    });
    const notTitles = each({
      secondArg: `it("loads", () => load(${P}));`,
      otherCall: `bench(${P}, () => {});`,
      otherForm: `it.todo(${P});`,
    });
    expect(pins({ ...titles, ...notTitles })).toEqual(all(notTitles));
  });

  it("does not find a made-up package or a name that only starts like a pinned one", () => {
    const files = each({
      madeUp: `const p = req.resolve("@made-up-org/made-up-agent");`,
      longer: `const p = req.resolve("${DEMO}-extra");`,
      prose: `expect(msg).toBe("see ${DEMO} docs");`,
    });
    expect(pins(files)).toEqual([]);
  });
});

describe("the flow rule: a flow-shaped core fixture that carries a pinned-pack marker", () => {
  const flow = (extra) => ({ component_type: "Flow", id: "f", nodes: [], ...extra });

  it("finds a flow naming a pinned package (red first)", () => {
    const f = "docker/wayflow/tests/fixtures/f.json";
    expect(pins({ [f]: flow({ metadata: { cinatra: { packageName: "@example-org/demo-agent" } } }) })).toEqual([
      `flow :: ${f} :: @example-org/demo-agent`,
    ]);
  });

  it("finds a flow copied at a lock pin (a sha prefix of 7+ hex digits), nested anywhere", () => {
    const f = "src/lib/__fixtures__/parity.json";
    expect(pins({ [f]: { $comment: `copied at ${SHA.slice(0, 8)}`, flows: [{ flow: flow() }] } })).toEqual([
      `flow :: ${f} :: sha:${SHA.slice(0, 8)}`,
    ]);
  });

  it("reads the parsed value: an escaped name or pin still counts", () => {
    const F = "docker/wayflow/tests/fixtures/";
    const raw = (meta) => `{"component_type":"Flow","id":"f","nodes":[],"metadata":${meta}}`;
    const files = {
      [`${F}slash.json`]: raw(`{"packageName":"@example-org\\/demo-agent"}`),
      [`${F}unicode.json`]: raw(`{"packageName":"@example-org/\\u0064emo-agent"}`),
      [`${F}key.json`]: raw(`{"@example-org\\/other-artifact":{}}`),
      [`${F}pin.json`]: raw(`{"$comment":"copied at \\u0030123456789ab"}`),
    };
    expect(pins(files)).toEqual([
      `flow :: ${F}key.json :: @example-org/other-artifact`,
      `flow :: ${F}pin.json :: sha:0123456789ab`,
      `flow :: ${F}slash.json :: @example-org/demo-agent`,
      `flow :: ${F}unicode.json :: @example-org/demo-agent`,
    ]);
  });

  it("reports a flow-shaped fixture that does not parse; skips other unparsable JSON", () => {
    const F = "docker/wayflow/tests/fixtures/";
    expect(
      pins({
        [`${F}broken.json`]: `{ component_type: "Flow", id: "f", // not JSON\n }`,
        [`${F}other.json`]: `{ not: json`,
      }),
    ).toEqual([`flow :: ${F}broken.json :: (unparsed flow fixture)`]);
  });

  it("does not find a synthetic flow, or a fixture that names a pack but holds no flow", () => {
    expect(pins({ "docker/wayflow/tests/fixtures/s.json": flow({ id: "synthetic-demo" }) })).toEqual([]);
    expect(pins({ "docker/wayflow/tests/fixtures/v.json": { packageName: "@example-org/demo-agent" } })).toEqual([]);
  });
});

describe("the floor", () => {
  const PIN_TEST = `${T}demo.test.ts`;
  const PIN_SRC = `const d = path.join(ROOT, "extensions", "example-org", "demo-agent");`;
  const entry = { rule: "read", file: PIN_TEST, pack: "@example-org/demo-agent" };
  const floor = (entries) => ({ note: "test", entries });

  it("passes a pin the floor holds; fails a new pin; fails a stale entry", () => {
    expect(runGate({ root: tree({ [PIN_TEST]: PIN_SRC, [BASELINE_REL]: floor([entry]) }), env: {} }).ok).toBe(true);

    const added = runGate({ root: tree({ [PIN_TEST]: PIN_SRC, [BASELINE_REL]: floor([]) }), env: {} });
    expect(added.ok).toBe(false);
    expect(added.added).toEqual([`read :: ${PIN_TEST} :: @example-org/demo-agent`]);

    const stale = runGate({ root: tree({ [BASELINE_REL]: floor([entry]) }), env: {} });
    expect(stale.ok).toBe(false);
    expect(stale.stale).toEqual([`read :: ${PIN_TEST} :: @example-org/demo-agent`]);
  });

  it("fails closed on an absent or malformed floor and on an absent lock", () => {
    expect(runGate({ root: tree({}), env: {} }).ok).toBe(false);
    expect(runGate({ root: tree({ [BASELINE_REL]: { entries: [{ rule: "x" }] } }), env: {} }).ok).toBe(false);
    const root = tree({});
    rmSync(join(root, "cinatra-dev-extensions.lock.json"));
    expect(() => loadPinnedPacks(root)).toThrow(ScannerError);
  });

  describe("compared with the base branch (CORE_PACK_PIN_BASE)", () => {
    const env = { CORE_PACK_PIN_BASE: "origin/main" };
    const repo = (base, head) => {
      const r = makeFloorRepo({ base: { ...LOCKS, ...base }, head });
      roots.push(r.root);
      return r.root;
    };
    const other = { rule: "read", file: `${T}other.test.ts`, pack: "@example-org/other-artifact" };
    const OTHER_SRC = `import { m } from "@example-org/other-artifact";`;

    it("lets the floor shrink against the base", () => {
      const root = repo(
        { [GATE_REL]: "// gate", [PIN_TEST]: PIN_SRC, [`${T}other.test.ts`]: OTHER_SRC, [BASELINE_REL]: floor([entry, other]) },
        { [`${T}other.test.ts`]: "// moved to the pack's own CI\n", [BASELINE_REL]: floor([entry]) },
      );
      const r = runGate({ root, env });
      expect(r.lines.join("\n")).toMatch(/does not grow/);
      expect(r.ok).toBe(true);
    });

    it("refuses a floor that grew against the base, even when the tree matches it", () => {
      const root = repo(
        { [GATE_REL]: "// gate", [PIN_TEST]: PIN_SRC, [BASELINE_REL]: floor([entry]) },
        { [`${T}other.test.ts`]: OTHER_SRC, [BASELINE_REL]: floor([entry, other]) },
      );
      const r = runGate({ root, env });
      expect(r.ok).toBe(false);
      expect(r.lines.join("\n")).toMatch(/GREW[\s\S]*other-artifact/);
    });

    it("imposes nothing on the introducing change (the base holds neither the floor nor the gate)", () => {
      const root = repo({ [PIN_TEST]: PIN_SRC }, { [GATE_REL]: "// gate", [BASELINE_REL]: floor([entry]) });
      const r = runGate({ root, env });
      expect(r.ok).toBe(true);
      expect(r.lines.join("\n")).toMatch(/introducing change/);
    });

    it("fails closed when the base holds the gate but not its floor, or does not resolve", () => {
      const root = repo({ [GATE_REL]: "// gate", [PIN_TEST]: PIN_SRC }, { [BASELINE_REL]: floor([entry]) });
      expect(runGate({ root, env }).ok).toBe(false);
      expect(runGate({ root, env: { CORE_PACK_PIN_BASE: "origin/nope" } }).ok).toBe(false);
    });
  });
});

describe("the list writer only shrinks (--write-baseline)", () => {
  const PIN_TEST = `${T}demo.test.ts`;
  const PIN_SRC = `const d = path.join(ROOT, "extensions", "example-org", "demo-agent");`;
  const OTHER_TEST = `${T}other.test.ts`;
  const OTHER_SRC = `const d = path.join(ROOT, "extensions", "example-org", "other-artifact");`;
  const entry = { rule: "read", file: PIN_TEST, pack: "@example-org/demo-agent" };
  const other = { rule: "read", file: OTHER_TEST, pack: "@example-org/other-artifact" };
  const floor = (entries) => ({ note: "test", entries });
  const env = { CORE_PACK_PIN_BASE: "origin/main" };
  const repo = (base, head) => {
    const r = makeFloorRepo({ base: { ...LOCKS, ...base }, head });
    roots.push(r.root);
    return r.root;
  };
  const floorAt = (root) => JSON.parse(readFileSync(join(root, BASELINE_REL), "utf8"));

  it("refuses a missing floor when the base holds one; writes nothing", () => {
    // red-first-expect: writeBaseline is not a function
    const root = repo({ [GATE_REL]: "// gate", [PIN_TEST]: PIN_SRC, [BASELINE_REL]: floor([entry]) }, { [OTHER_TEST]: OTHER_SRC });
    rmSync(join(root, BASELINE_REL));
    const r = writeBaseline({ root, env });
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toMatch(/REFUSED[\s\S]*missing/);
    expect(existsSync(join(root, BASELINE_REL))).toBe(false);
  });

  it("refuses a floor that is JSON null or not a floor", () => {
    // red-first-expect: writeBaseline is not a function
    for (const bad of ["null\n", "{}\n", "not json"]) {
      const root = repo({ [GATE_REL]: "// gate", [PIN_TEST]: PIN_SRC, [BASELINE_REL]: floor([entry]) }, { [OTHER_TEST]: OTHER_SRC, [BASELINE_REL]: bad });
      const r = writeBaseline({ root, env });
      expect(r.ok, bad).toBe(false);
      expect(readFileSync(join(root, BASELINE_REL), "utf8")).toBe(bad);
    }
  });

  it("refuses to seed without a base, and names the variable to set", () => {
    // red-first-expect: writeBaseline is not a function
    const root = tree({ [PIN_TEST]: PIN_SRC });
    const r = writeBaseline({ root, env: {} });
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toMatch(/CORE_PACK_PIN_BASE/);
    expect(existsSync(join(root, BASELINE_REL))).toBe(false);
  });

  it("shrinks: drops an entry whose pin is gone", () => {
    // red-first-expect: writeBaseline is not a function
    const root = repo(
      { [GATE_REL]: "// gate", [PIN_TEST]: PIN_SRC, [OTHER_TEST]: OTHER_SRC, [BASELINE_REL]: floor([entry, other]) },
      { [OTHER_TEST]: "// moved to the pack's own CI\n" },
    );
    const r = writeBaseline({ root, env });
    expect(r.ok, r.lines.join("\n")).toBe(true);
    expect(floorAt(root).entries).toEqual([entry]);
  });

  it("refuses growth: a new pin, and an entry the head floor added but the base floor does not hold", () => {
    // red-first-expect: writeBaseline is not a function
    const root = repo(
      { [GATE_REL]: "// gate", [PIN_TEST]: PIN_SRC, [BASELINE_REL]: floor([entry]) },
      { [OTHER_TEST]: OTHER_SRC, [BASELINE_REL]: floor([entry, other]) },
    );
    const r = writeBaseline({ root, env });
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toMatch(/REFUSED[\s\S]*other-artifact/);
    expect(floorAt(root).entries).toEqual([entry]);
    // Without a base, a pin the floor does not hold is refused as well.
    const local = tree({ [PIN_TEST]: PIN_SRC, [OTHER_TEST]: OTHER_SRC, [BASELINE_REL]: floor([entry]) });
    const l = writeBaseline({ root: local, env: {} });
    expect(l.ok).toBe(false);
    expect(floorAt(local).entries).toEqual([entry]);
  });

  it("seeds the introducing change: the base holds neither the floor nor the gate", () => {
    // red-first-expect: writeBaseline is not a function
    const root = repo({ [PIN_TEST]: PIN_SRC }, { [GATE_REL]: "// gate", [OTHER_TEST]: OTHER_SRC });
    const r = writeBaseline({ root, env });
    expect(r.ok, r.lines.join("\n")).toBe(true);
    expect(r.lines.join("\n")).toMatch(/SEEDED/);
    expect(floorAt(root).entries).toEqual([entry, other]);
  });
});

// ---------------------------------------------------------------------------
// THE TEST OF RECORD: the gate over the real tree, on every pull request of the
// application (the root suite runs in the job "Perpetual core invariants"; on a
// pull request's run GITHUB_BASE_REF names the base the floor is compared with).
// ---------------------------------------------------------------------------

describe("test of record: no core test or fixture pins a pack outside the floor", () => {
  it("the real tree holds no new pin, no stale entry, and the floor did not grow", () => {
    const r = runGate({ root: REPO_ROOT, env: process.env });
    expect(r.ok, r.lines.join("\n")).toBe(true);
  }, 120_000);
});
