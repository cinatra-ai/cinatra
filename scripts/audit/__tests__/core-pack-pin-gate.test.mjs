// core-pack-pin-gate tests (cinatra#4853).
//
// The fixture trees are temporary git repositories whose locks pin packages of
// the neutral owner `@example-org/…`; no real pack is named. The last block is
// the TEST OF RECORD: it runs the check over the real tree, with the list
// compared with the base branch on a pull request's run, so the root suite
// (`pnpm test:root`, job "Perpetual core invariants") refuses a raised count,
// a stale count or a grown list on every pull request.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BASELINE_REL,
  GATE_REL,
  LINK,
  REPO_ROOT,
  ScannerError,
  isCoreTestPath,
  loadPinnedPacks,
  runGate,
  scanCorePins,
  writeBaseline,
} from "../core-pack-pin-gate.mjs";
import { fixtureGit, makeFloorRepo } from "./floor-base-fixture.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const DEMO = "@example-org/demo-agent";
const OTHER = "@example-org/other-artifact";
const LOCK = {
  packages: [
    { packageName: DEMO, repo: "example-org/demo-agent", resolvedSha: SHA },
    { packageName: OTHER, repo: "example-org/other-artifact", resolvedSha: "f".repeat(40) },
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

function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
}

/** A temporary git repository holding the locks and `files`, every file tracked. */
function tree(files, { links = {}, untracked = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "core-pack-pin-"));
  roots.push(root);
  fixtureGit(root, ["init", "-q"]);
  writeTree(root, { ...LOCKS, ...files });
  for (const [rel, target] of Object.entries(links)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    symlinkSync(target, join(root, rel));
  }
  fixtureGit(root, ["add", "-A"]);
  writeTree(root, untracked);
  return root;
}

const T = "packages/agents/src/__tests__/";
const F = "docker/wayflow/tests/fixtures/";
const scan = (files, opts) => scanCorePins(tree(files, opts));
/** One file's findings: `{ package: count }`. */
const one = (rel, src) => {
  const out = {};
  for (const [k, n] of Object.entries(scan({ [rel]: src }))) out[k.split(" :: ")[1]] = n;
  return out;
};

describe("the lexical rule: a string that contains a pinned pack's name, tree path or pin", () => {
  it("finds a package name, a sub-path and a tree path in any string, and counts each mention (red first)", () => {
    const src = `import { x } from "${DEMO}/src/x";
const m = await vi.importActual("${DEMO}");
readFileSync(new URL("../../../../extensions/example-org/demo-agent/cinatra/oas.json", import.meta.url));
const w = "C:\\\\repo\\\\extensions\\\\example-org\\\\other-artifact\\\\x.json";
const t = \`\${ROOT}/extensions/example-org/demo-agent/\${name}\`;
it("${DEMO} loads", () => {});`;
    expect(one(`${T}demo.test.ts`, src)).toEqual({ [DEMO]: 5, [OTHER]: 1 });
  });

  it("compares without case, at a token boundary only", () => {
    const hits = `const a = "@Example-Org/DEMO-AGENT"; const b = "see extensions/example-org/demo-agent.";`;
    expect(one(`${T}case.test.ts`, hits)).toEqual({ [DEMO]: 2 });
    const misses = `const a = "${DEMO}-extra"; const b = "myextensions/example-org/demo-agent";
const c = "extensions/example-org/demo-agent.json"; const d = "x${DEMO}"; const e = "${DEMO}_v2";`;
    expect(one(`${T}miss.test.ts`, misses)).toEqual({});
  });

  it("finds 7 or more leading hex digits of a pinned commit, not 6, not a longer token, not another commit", () => {
    const src = `const a = "copied at ${SHA.slice(0, 7).toUpperCase()}"; const b = "${SHA}";
const c = "${SHA.slice(0, 6)}"; const d = "${SHA.slice(0, 8)}aa"; const e = "${SHA.slice(1, 9)}"; const g = "v${SHA.slice(0, 8)}";`;
    expect(one(`${T}sha.test.ts`, src)).toEqual({ [DEMO]: 2 });
  });

  it("reads every string value and key of a JSON fixture, after its escapes decode", () => {
    const raw = `{"component_type":"Flow","metadata":{"packageName":"@example-org\\/demo-agent","pin":"\\u0030123456789ab"},
"@example-org/other-artifact":{"source":"extensions\\\\example-org\\\\other-artifact\\\\flow.json"}}`;
    expect(one(`${F}flow.json`, raw)).toEqual({ [DEMO]: 2, [OTHER]: 2 });
  });

  it("exempts only a type-only load's specifier; a value load, a test title and any other string count", () => {
    const typeOnly = {
      importType: `import type { X } from "${DEMO}";`,
      exportType: `export type { X } from "${DEMO}";`,
      importEqualsType: `import type X = require("${DEMO}");`,
      typeofImport: `type M = typeof import("${DEMO}");`,
    };
    const counted = {
      namedTypes: `import { type X } from "${DEMO}";`,
      title: `describe("${DEMO}", () => {});`,
      require: `const m = require("${DEMO}");`,
      mock: `vi.mock("${DEMO}", () => ({}));`,
    };
    const files = {};
    for (const [k, v] of Object.entries({ ...typeOnly, ...counted })) files[`${T}${k}.test.ts`] = v;
    expect(Object.keys(scan(files))).toEqual(Object.keys(counted).sort().map((k) => `${T}${k}.test.ts :: ${DEMO}`));
  });

  it("exempts exactly the module specifier of a type load; every other string of the same form counts", () => {
    const counted = {
      typeArgument: `type R = import("./neutral").Registry<"${DEMO}">;`,
      typeofAttribute: `type R = typeof import("./neutral", { with: { "resolution-mode": "${DEMO}" } });`,
      importAttribute: `import type { X } from "./neutral" with { type: "${DEMO}" };`,
      exportAttribute: `export type { X } from "./neutral" with { type: "${DEMO}" };`,
      specifierAndArgument: `type R = import("${DEMO}").Registry<"${DEMO}">;`,
    };
    const files = {};
    for (const [k, v] of Object.entries(counted)) files[`${T}${k}.test.ts`] = v;
    const found = scan(files);
    expect(Object.keys(found)).toEqual(Object.keys(counted).sort().map((k) => `${T}${k}.test.ts :: ${DEMO}`));
    expect(found[`${T}specifierAndArgument.test.ts :: ${DEMO}`]).toBe(1);
  });

  it("does not read comments, made-up packs, or segments joined by code (out of scope: the first limit)", () => {
    const src = `// reads extensions/example-org/demo-agent/cinatra/oas.json
/* ${DEMO} */
const a = "@example-org/made-up-agent";
const b = path.join(ROOT, "extensions", "example-org", "demo-agent");
const c = "@example-org/" + "demo-agent";`;
    expect(one(`${T}c.test.ts`, src)).toEqual({});
  });
});

describe("which files: tracked core tests and JSON fixtures, as git lists them", () => {
  it("selects core test and fixture paths only", () => {
    expect(isCoreTestPath("packages/agents/src/__tests__/a.test.ts")).toBe(true);
    expect(isCoreTestPath("src/lib/thing.spec.tsx")).toBe(true);
    expect(isCoreTestPath(`${F}f.json`)).toBe(true);
    expect(isCoreTestPath("src/lib/thing.ts")).toBe(false);
    expect(isCoreTestPath("src/lib/__tests__/types.d.ts")).toBe(false);
    expect(isCoreTestPath("extensions/example-org/demo-agent/__tests__/a.test.ts")).toBe(false);
    expect(isCoreTestPath("docker/wayflow/tests/test_demo.py")).toBe(false);
  });

  it("reads tracked files only; a tracked symbolic link is a finding by itself, never followed", () => {
    const found = scan(
      { "src/lib/pin.json": { source: `extensions/example-org/demo-agent` } },
      { links: { [`${F}linked.json`]: "../../../../src/lib/pin.json" }, untracked: { [`${T}new.test.ts`]: `import "${DEMO}";` } },
    );
    expect(found).toEqual({ [`${F}linked.json :: ${LINK}`]: 1 });
  });

  it("fails on a test file or a JSON fixture that does not parse, and on a missing lock", () => {
    expect(() => scan({ [`${T}broken.test.ts`]: `const a = ;` })).toThrow(ScannerError);
    expect(() => scan({ [`${F}broken.json`]: `{ component_type: "Flow" }` })).toThrow(ScannerError);
    const root = tree({});
    rmSync(join(root, "cinatra-dev-extensions.lock.json"));
    expect(() => loadPinnedPacks(root)).toThrow(ScannerError);
  });
});

describe("the list: per file, a count per pinned package", () => {
  const PIN_TEST = `${T}demo.test.ts`;
  const PIN_SRC = `const d = "${DEMO}";\n`;
  const floor = (files) => ({ note: "test", files });
  const held = floor({ [PIN_TEST]: { [DEMO]: 1 } });

  it("passes the counts it holds, also after lines move; fails a new mention; fails a count that fell", () => {
    expect(runGate({ root: tree({ [PIN_TEST]: PIN_SRC, [BASELINE_REL]: held }), env: {} }).ok).toBe(true);
    expect(runGate({ root: tree({ [PIN_TEST]: `\n\n// moved\n${PIN_SRC}`, [BASELINE_REL]: held }), env: {} }).ok).toBe(true);

    const added = runGate({ root: tree({ [PIN_TEST]: `${PIN_SRC}const e = "${DEMO}/x";\n`, [BASELINE_REL]: held }), env: {} });
    expect(added.ok).toBe(false);
    expect(added.added).toEqual([`${PIN_TEST} :: ${DEMO} (1 -> 2)`]);

    const stale = runGate({ root: tree({ [BASELINE_REL]: held }), env: {} });
    expect(stale.ok).toBe(false);
    expect(stale.stale).toEqual([`${PIN_TEST} :: ${DEMO} (1 -> 0)`]);
  });

  it("fails closed on an absent or malformed list", () => {
    expect(runGate({ root: tree({}), env: {} }).ok).toBe(false);
    for (const bad of [{ entries: [] }, floor({ [PIN_TEST]: { [DEMO]: 0 } }), floor({ [PIN_TEST]: [] })]) {
      expect(runGate({ root: tree({ [BASELINE_REL]: bad }), env: {} }).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  describe("compared with the base branch (CORE_PACK_PIN_BASE)", () => {
    const env = { CORE_PACK_PIN_BASE: "origin/main" };
    const repo = (base, head) => {
      const r = makeFloorRepo({ base: { ...LOCKS, ...base }, head });
      roots.push(r.root);
      return r.root;
    };
    const OTHER_TEST = `${T}other.test.ts`;
    const OTHER_SRC = `import { m } from "${OTHER}";\n`;

    it("lets the list shrink against the base", () => {
      const root = repo(
        { [GATE_REL]: "// check", [PIN_TEST]: PIN_SRC, [OTHER_TEST]: OTHER_SRC, [BASELINE_REL]: floor({ [PIN_TEST]: { [DEMO]: 1 }, [OTHER_TEST]: { [OTHER]: 1 } }) },
        { [OTHER_TEST]: "// moved to the pack's own CI\n", [BASELINE_REL]: held },
      );
      const r = runGate({ root, env });
      expect(r.lines.join("\n")).toMatch(/does not grow/);
      expect(r.ok).toBe(true);
    });

    it("refuses a list that grew against the base, even when the tree matches it", () => {
      const root = repo(
        { [GATE_REL]: "// check", [PIN_TEST]: PIN_SRC, [BASELINE_REL]: held },
        { [PIN_TEST]: `${PIN_SRC}${PIN_SRC}`, [BASELINE_REL]: floor({ [PIN_TEST]: { [DEMO]: 2 } }) },
      );
      const r = runGate({ root, env });
      expect(r.ok).toBe(false);
      expect(r.lines.join("\n")).toMatch(/GREW[\s\S]*demo-agent \(1 -> 2\)/);
    });

    it("imposes nothing on the introducing change (the base holds neither the list nor the check)", () => {
      const r = runGate({ root: repo({ [PIN_TEST]: PIN_SRC }, { [GATE_REL]: "// check", [BASELINE_REL]: held }), env });
      expect(r.ok).toBe(true);
      expect(r.lines.join("\n")).toMatch(/introducing change/);
    });

    it("fails closed when the base holds the check but not its list, or does not resolve", () => {
      const root = repo({ [GATE_REL]: "// check", [PIN_TEST]: PIN_SRC }, { [BASELINE_REL]: held });
      expect(runGate({ root, env }).ok).toBe(false);
      expect(runGate({ root, env: { CORE_PACK_PIN_BASE: "origin/nope" } }).ok).toBe(false);
    });
  });
});

describe("the list writer only shrinks (--write-baseline)", () => {
  const PIN_TEST = `${T}demo.test.ts`;
  const PIN_SRC = `const d = "${DEMO}";\n`;
  const OTHER_TEST = `${T}other.test.ts`;
  const OTHER_SRC = `const d = "extensions/example-org/other-artifact";\n`;
  const floor = (files) => ({ note: "test", files });
  const env = { CORE_PACK_PIN_BASE: "origin/main" };
  const repo = (base, head) => {
    const r = makeFloorRepo({ base: { ...LOCKS, ...base }, head });
    roots.push(r.root);
    return r.root;
  };
  const filesAt = (root) => JSON.parse(readFileSync(join(root, BASELINE_REL), "utf8")).files;

  it("refuses a missing list when the base holds one; writes nothing", () => {
    const root = repo({ [GATE_REL]: "// check", [PIN_TEST]: PIN_SRC, [BASELINE_REL]: floor({ [PIN_TEST]: { [DEMO]: 1 } }) }, { [OTHER_TEST]: OTHER_SRC });
    rmSync(join(root, BASELINE_REL));
    const r = writeBaseline({ root, env });
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toMatch(/REFUSED[\s\S]*missing/);
    expect(existsSync(join(root, BASELINE_REL))).toBe(false);
  });

  it("refuses a list that is JSON null or not a list", () => {
    for (const bad of ["null\n", "{}\n", "not json"]) {
      const root = repo({ [GATE_REL]: "// check", [PIN_TEST]: PIN_SRC, [BASELINE_REL]: floor({ [PIN_TEST]: { [DEMO]: 1 } }) }, { [BASELINE_REL]: bad });
      const r = writeBaseline({ root, env });
      expect(r.ok, bad).toBe(false);
      expect(readFileSync(join(root, BASELINE_REL), "utf8")).toBe(bad);
    }
  });

  it("refuses to seed without a base, and names the variable to set", () => {
    const root = tree({ [PIN_TEST]: PIN_SRC });
    const r = writeBaseline({ root, env: {} });
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toMatch(/CORE_PACK_PIN_BASE/);
    expect(existsSync(join(root, BASELINE_REL))).toBe(false);
  });

  it("shrinks: lowers a count and drops an entry whose mentions are gone", () => {
    const root = repo(
      { [GATE_REL]: "// check", [PIN_TEST]: `${PIN_SRC}${PIN_SRC}`, [OTHER_TEST]: OTHER_SRC, [BASELINE_REL]: floor({ [PIN_TEST]: { [DEMO]: 2 }, [OTHER_TEST]: { [OTHER]: 1 } }) },
      { [PIN_TEST]: PIN_SRC, [OTHER_TEST]: "// moved to the pack's own CI\n" },
    );
    const r = writeBaseline({ root, env });
    expect(r.ok, r.lines.join("\n")).toBe(true);
    expect(filesAt(root)).toEqual({ [PIN_TEST]: { [DEMO]: 1 } });
  });

  it("refuses growth: a new mention, and a count the head list raised over the base list", () => {
    const root = repo(
      { [GATE_REL]: "// check", [PIN_TEST]: PIN_SRC, [BASELINE_REL]: floor({ [PIN_TEST]: { [DEMO]: 1 } }) },
      { [PIN_TEST]: `${PIN_SRC}${PIN_SRC}`, [OTHER_TEST]: OTHER_SRC, [BASELINE_REL]: floor({ [PIN_TEST]: { [DEMO]: 2 }, [OTHER_TEST]: { [OTHER]: 1 } }) },
    );
    const r = writeBaseline({ root, env });
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toMatch(/REFUSED[\s\S]*demo-agent \(1 -> 2\)[\s\S]*other-artifact \(0 -> 1\)/);
    expect(filesAt(root)).toEqual({ [PIN_TEST]: { [DEMO]: 1 } });
    // Without a base, a mention the list does not hold is refused as well.
    const local = tree({ [PIN_TEST]: PIN_SRC, [OTHER_TEST]: OTHER_SRC, [BASELINE_REL]: floor({ [PIN_TEST]: { [DEMO]: 1 } }) });
    expect(writeBaseline({ root: local, env: {} }).ok).toBe(false);
    expect(filesAt(local)).toEqual({ [PIN_TEST]: { [DEMO]: 1 } });
  });

  it("seeds the introducing change: the base holds neither the list nor the check", () => {
    const root = repo({ [PIN_TEST]: PIN_SRC }, { [GATE_REL]: "// check", [OTHER_TEST]: OTHER_SRC });
    const r = writeBaseline({ root, env });
    expect(r.ok, r.lines.join("\n")).toBe(true);
    expect(r.lines.join("\n")).toMatch(/SEEDED/);
    expect(filesAt(root)).toEqual({ [OTHER_TEST]: { [OTHER]: 1 }, [PIN_TEST]: { [DEMO]: 1 } });
  });
});

// ---------------------------------------------------------------------------
// THE TEST OF RECORD: the check over the real tree, on every pull request of
// the application (the root suite runs in the job "Perpetual core invariants";
// on a pull request's run GITHUB_BASE_REF names the base the list is compared
// with).
// ---------------------------------------------------------------------------

describe("test of record: no core test or fixture names a pinned pack beyond the list", () => {
  it("the real tree holds no raised count, no stale count, and the list did not grow", () => {
    const r = runGate({ root: REPO_ROOT, env: process.env });
    expect(r.ok, r.lines.join("\n")).toBe(true);
  }, 120_000);
});
