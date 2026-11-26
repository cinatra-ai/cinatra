// core-test-pack-pin-gate tests (cinatra#4853).
//
// The fixture trees are temporary repositories whose locks pin packages of the
// owner `@example-org/…`; no real pack is named. The last block is the TEST OF
// RECORD: it runs the gate over the real tree, with the floor compared with the
// base branch on a pull request's run, so the root suite (`pnpm test:root`,
// job "Perpetual core invariants") refuses a new pin, a stale entry or a grown
// floor on every pull request.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  runGate,
  scanCorePins,
} from "../core-test-pack-pin-gate.mjs";
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
  const root = mkdtempSync(join(tmpdir(), "core-test-pack-pin-"));
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

  it("finds a Python test that walks Path segments into a pinned pack", () => {
    const src = `AGENT = _REPO_ROOT / "extensions" / "example-org" / "demo-agent"\n`;
    expect(pins({ "docker/wayflow/tests/test_demo.py": src })).toEqual([
      "read :: docker/wayflow/tests/test_demo.py :: @example-org/demo-agent",
    ]);
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

    it("finds a pytest fixture name rebound by an annotated assignment", () => {
      const src = `def test_x(tmp_path):\n    tmp_path: Path = REPO_ROOT\n    seed(tmp_path / "extensions" / "example-org" / "demo-agent")\n`;
      expect(pins({ "docker/wayflow/tests/test_annotated.py": src })).toEqual([`read :: docker/wayflow/tests/test_annotated.py :: ${DEMO}`]);
    });

    it("finds a path spelled in a triple-quoted Python string, and a pack named in a docstring", () => {
      const path = `OAS = REPO_ROOT / """extensions/example-org/demo-agent/oas.json"""\n`;
      const doc = `def test_x():\n    """Reads \`extensions/example-org/demo-agent\`."""\n    assert True\n`;
      expect(pins({ "docker/wayflow/tests/test_triple.py": path, "docker/wayflow/tests/test_doc.py": doc })).toEqual([
        `read :: docker/wayflow/tests/test_doc.py :: ${DEMO}`,
        `read :: docker/wayflow/tests/test_triple.py :: ${DEMO}`,
      ]);
    });

    it("finds a pinned pack's tree rebuilt in a real temporary directory, a stand-in absolute path or a core directory; not a made-up pack", () => {
      // red-first-expect: expected [] to deeply equal [ …(4) ]
      const js = `const tmp = mkdtempSync(path.join(os.tmpdir(), "x-"));
mkdirSync(path.join(tmp, "extensions/example-org/demo-agent"), { recursive: true });`;
      const abs = `expect(map("x")).toBe(path.resolve("/repo/extensions/example-org/demo-agent"));`;
      const core = `const a = "src/components/extensions/example-org/demo-agent/x.ts";`;
      const py = `def test_x(tmp_path):\n    seed(tmp_path / "extensions" / "example-org" / "demo-agent")\n`;
      // A test that needs a made-up pack uses a made-up name: no lock pins it.
      const madeUpJs = js.replace("demo-agent", "made-up-agent");
      const madeUpPy = py.replace("demo-agent", "made-up-agent");
      expect(
        pins({
          [`${T}tmp.test.ts`]: js,
          [`${T}abs.test.ts`]: abs,
          [`${T}core.test.ts`]: core,
          "docker/wayflow/tests/test_tmp.py": py,
          [`${T}madeup.test.ts`]: madeUpJs,
          "docker/wayflow/tests/test_madeup.py": madeUpPy,
        }),
      ).toEqual([
        `read :: docker/wayflow/tests/test_tmp.py :: ${DEMO}`,
        `read :: ${T}abs.test.ts :: ${DEMO}`,
        `read :: ${T}core.test.ts :: ${DEMO}`,
        `read :: ${T}tmp.test.ts :: ${DEMO}`,
      ]);
    });
  });

  it("reads a Python string's decoded value (\\x, \\u, octal escapes)", () => {
    const src = `A = _REPO_ROOT / "extensions" / "example-org" / "demo\\x2dagent"\nB = _REPO_ROOT / "extensions" / "example\\u002dorg" / "other\\055artifact"\n`;
    expect(pins({ "docker/wayflow/tests/test_esc.py": src })).toEqual([
      "read :: docker/wayflow/tests/test_esc.py :: @example-org/demo-agent",
      "read :: docker/wayflow/tests/test_esc.py :: @example-org/other-artifact",
    ]);
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
    const src = `expect(label("@example-org/demo-agent")).toBe("Demo");
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

  describe("compared with the base branch (CORE_TEST_PACK_PIN_BASE)", () => {
    const env = { CORE_TEST_PACK_PIN_BASE: "origin/main" };
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
      expect(runGate({ root, env: { CORE_TEST_PACK_PIN_BASE: "origin/nope" } }).ok).toBe(false);
    });
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
