// Unit tests for the self-rendering-extensions BORDER GATE (cinatra#3471,
// epic #2926 — decision 407 of 2026-09-13).
//
// Every case runs the gate as a SUBPROCESS against a SYNTHETIC extension tree
// written into a throwaway temp dir, so the assertion is the gate's real exit
// code and real message — never an internal shortcut. The shared committed
// `extensions/` tree is never read by these tests: the gate is pointed at the
// synthetic root with SELF_RENDERING_BORDER_EXT_ROOT and at a synthetic
// baseline with SELF_RENDERING_BORDER_BASELINE (the same injectable-root shape
// `CINATRA_INVENTORY_EXT_ROOT` gives scripts/extensions/inventory.mjs).
// The declared set is the package.json beside the synthetic extension root,
// as the repository root's is beside the real one.

import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync } from "node:fs";
import * as realFs from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as gate from "../self-rendering-extensions-border-gate.mjs";
import {
  FLOOR_BASE_VAR,
  FLOOR_FILE,
  checkFloorAgainstBase,
} from "../self-rendering-extensions-border-gate.mjs";
import {
  NO_PULL_REQUEST_RUN,
  PULL_REQUEST_RUN,
  UNREADABLE_BASE_RUN,
  envWithoutBase,
  makeFloorRepo,
} from "../../audit/__tests__/floor-base-fixture.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GATE = join(__dirname, "..", "self-rendering-extensions-border-gate.mjs");
const REPO_ROOT = join(__dirname, "..", "..", "..");

const temps = [];
afterEach(() => {
  while (temps.length) rmSync(temps.pop(), { recursive: true, force: true });
});

/**
 * Build a synthetic extension tree.
 * `packages` = [{ dir, kind, files: { "<relpath>": "<contents>" }, manifest?, undeclared? }]
 * `baseline` = { "<dir>": ["src/components/ui/button.tsx", ...] } | null
 * `<base>/package.json` declares (cinatra.devExtensions) exactly the packages it
 * makes, unless `opts.declared` gives the devExtensions value itself or
 * `opts.extraDeclared` adds names. A package's `manifest` (a string) replaces
 * its package.json text; `undeclared: true` leaves it out of the declared set.
 */
function makeTree(packages, baseline, opts = {}) {
  const base = mkdtempSync(join(tmpdir(), "cinatra-border-gate-"));
  temps.push(base);
  const extRoot = join(base, "extensions");
  const declared =
    "declared" in opts
      ? opts.declared
      : Object.fromEntries(
          [
            ...packages.filter((p) => !p.undeclared).map((p) => `@cinatra-ai/${p.dir}`),
            ...(opts.extraDeclared ?? []),
          ].map((n) => [n, {}]),
        );
  writeFileSync(join(base, "package.json"), JSON.stringify({ name: "fixture-root", cinatra: { devExtensions: declared } }, null, 2));
  for (const pkg of packages) {
    const pkgDir = join(extRoot, "cinatra-ai", pkg.dir);
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      pkg.manifest ?? JSON.stringify({ name: `@cinatra-ai/${pkg.dir}`, cinatra: { kind: pkg.kind } }, null, 2),
    );
    for (const [rel, contents] of Object.entries(pkg.files ?? {})) {
      const dest = join(pkgDir, rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, contents);
    }
  }
  const baselinePath = join(base, "baseline.json");
  writeFileSync(
    baselinePath,
    JSON.stringify({ note: "synthetic test baseline", copies: baseline ?? {} }, null, 2) + "\n",
  );
  return { base, extRoot, baselinePath };
}

function runGate({ extRoot, baselinePath }, args = [], extraEnv = {}) {
  const res = spawnSync(process.execPath, [GATE, ...args], {
    encoding: "utf8",
    // A synthetic floor is never compared with the real base branch: the
    // base variables of a pull request's run are dropped for these cases.
    env: {
      ...envWithoutBase(process.env),
      SELF_RENDERING_BORDER_EXT_ROOT: extRoot,
      SELF_RENDERING_BORDER_BASELINE: baselinePath,
      ...extraEnv,
    },
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

const BUTTON_COPY = 'import { cn } from "../../lib/utils";\nexport const Button = () => null;\n';

describe("self-rendering-extensions border gate", () => {
  it("(a) FAILS on a connector primitive copy that is not in the baseline", () => {
    const tree = makeTree(
      [
        {
          dir: "demo-connector",
          kind: "connector",
          files: { "src/components/ui/button.tsx": BUTTON_COPY },
        },
      ],
      {},
    );
    const { status, stderr } = runGate(tree);
    expect(status).not.toBe(0);
    expect(stderr).toContain("demo-connector");
    expect(stderr).toContain("src/components/ui/button.tsx");
  });

  it("(a) PASSES when the same (package, path) pair is in the baseline", () => {
    const tree = makeTree(
      [
        {
          dir: "demo-connector",
          kind: "connector",
          files: { "src/components/ui/button.tsx": BUTTON_COPY },
        },
      ],
      { "demo-connector": ["src/components/ui/button.tsx"] },
    );
    const { status, stderr } = runGate(tree);
    expect(stderr).toBe("");
    expect(status).toBe(0);
  });

  it("(b) FAILS on a baseline pair whose file no longer exists (shrink-only)", () => {
    const tree = makeTree(
      [{ dir: "demo-connector", kind: "connector", files: {} }],
      { "demo-connector": ["src/components/ui/button.tsx"] },
    );
    const { status, stderr } = runGate(tree);
    expect(status).not.toBe(0);
    expect(stderr).toContain("src/components/ui/button.tsx");
  });

  it("(c) FAILS on a direct @/components/ui import in a connector source file", () => {
    const tree = makeTree(
      [
        {
          dir: "demo-connector",
          kind: "connector",
          files: {
            "src/setup-page.tsx": 'import { Button } from "@/components/ui/button";\nexport default Button;\n',
          },
        },
      ],
      {},
    );
    const { status, stderr } = runGate(tree);
    expect(status).not.toBe(0);
    expect(stderr).toContain("@/components/ui/button");
  });

  it("(c) FAILS on a direct @/lib/utils import and on a src/components/ui import", () => {
    const utils = makeTree(
      [
        {
          dir: "demo-connector",
          kind: "connector",
          files: { "src/a.ts": 'import { cn } from "@/lib/utils";\nexport { cn };\n' },
        },
      ],
      {},
    );
    const utilsRun = runGate(utils);
    expect(utilsRun.status).not.toBe(0);
    expect(utilsRun.stderr).toContain("@/lib/utils");

    const deep = makeTree(
      [
        {
          dir: "demo-connector",
          kind: "connector",
          files: {
            "src/b.ts": 'import { Button } from "../../../src/components/ui/button";\nexport { Button };\n',
          },
        },
      ],
      {},
    );
    const deepRun = runGate(deep);
    expect(deepRun.status).not.toBe(0);
    expect(deepRun.stderr).toContain("src/components/ui/button");
  });

  it("(c) PASSES on a relative import of the package's own baselined copy", () => {
    const tree = makeTree(
      [
        {
          dir: "demo-connector",
          kind: "connector",
          files: {
            "src/components/ui/button.tsx": BUTTON_COPY,
            "src/setup-page.tsx": 'import { Button } from "./components/ui/button";\nexport default Button;\n',
          },
        },
      ],
      { "demo-connector": ["src/components/ui/button.tsx"] },
    );
    const { status, stderr } = runGate(tree);
    expect(stderr).toBe("");
    expect(status).toBe(0);
  });

  // cinatra#3512 (slice 2b of #3471): the BUILD-TIME road. A source-compiled
  // package (a connector setup page, an artifact package's server part) takes
  // the host's primitives through the host-neutral module id. The border rule
  // bans the product-INTERNAL path, never the shared id — the gate must let the
  // migrated form through, or slice 3 cannot land a single package.
  it("(c) PASSES on the host-shared primitives module id @cinatra-ai/design-primitives", () => {
    const tree = makeTree(
      [
        {
          dir: "demo-connector",
          kind: "connector",
          files: {
            "src/setup-page.tsx":
              'import { Alert, AlertDescription } from "@cinatra-ai/design-primitives";\nexport default [Alert, AlertDescription];\n',
          },
        },
      ],
      {},
    );
    const { status, stderr } = runGate(tree);
    expect(stderr).toBe("");
    expect(status).toBe(0);
  });

  it("(c) does not read the ban out of a COMMENT that merely names the host path", () => {
    const tree = makeTree(
      [
        {
          dir: "demo-connector",
          kind: "connector",
          files: {
            "src/notes.ts": '// bundled-react connectors cannot import "@/components/ui/tabs"\nexport const x = 1;\n',
          },
        },
      ],
      {},
    );
    const { status } = runGate(tree);
    expect(status).toBe(0);
  });

  it("a kind:agent package is out of scope here (gate #3470 covers agents)", () => {
    const tree = makeTree(
      [
        {
          dir: "demo-agent",
          kind: "agent",
          files: {
            "src/components/ui/button.tsx": BUTTON_COPY,
            "src/renderer.tsx": 'import { Button } from "@/components/ui/button";\nexport default Button;\n',
          },
        },
      ],
      {},
    );
    const { status, stderr } = runGate(tree);
    expect(stderr).toBe("");
    expect(status).toBe(0);
  });

  it("names decision 407 and issue #3471 in its failure message", () => {
    const tree = makeTree(
      [
        {
          dir: "demo-connector",
          kind: "connector",
          files: { "src/components/ui/button.tsx": BUTTON_COPY },
        },
      ],
      {},
    );
    const { status, stderr } = runGate(tree);
    expect(status).not.toBe(0);
    expect(stderr).toContain("decision 407");
    expect(stderr).toContain("#3471");
  });

  // --- convergence round (codex, 2026-09-13): the detection gaps below were
  // found on the delta and are pinned here so they cannot come back.

  it("(c) FAILS on a side-effect import written without whitespace", () => {
    const tree = makeTree(
      [
        {
          dir: "demo-connector",
          kind: "connector",
          files: { "src/side-effect.ts": 'import"@/components/ui/button";\nexport const x = 1;\n' },
        },
      ],
      {},
    );
    const { status, stderr } = runGate(tree);
    expect(status).not.toBe(0);
    expect(stderr).toContain("@/components/ui/button");
  });

  it("(c) FAILS on the host alias written with an explicit code extension", () => {
    const tree = makeTree(
      [
        {
          dir: "demo-connector",
          kind: "connector",
          files: { "src/a.ts": 'import { cn } from "@/lib/utils.ts";\nexport { cn };\n' },
        },
      ],
      {},
    );
    const { status, stderr } = runGate(tree);
    expect(status).not.toBe(0);
    expect(stderr).toContain("@/lib/utils.ts");
  });

  it("(c) PASSES on a relative reach into a sibling directory that is not the banned one", () => {
    const tree = makeTree(
      [
        {
          dir: "demo-connector",
          kind: "connector",
          files: {
            "src/b.ts": 'import { Button } from "../../../src/components/ui-extra/button";\nexport { Button };\n',
          },
        },
      ],
      {},
    );
    const { status, stderr } = runGate(tree);
    expect(stderr).toBe("");
    expect(status).toBe(0);
  });

  it("(a) FAILS on an unlisted copy parked in a build-named subdirectory of the ui tree", () => {
    const tree = makeTree(
      [
        {
          dir: "demo-connector",
          kind: "connector",
          files: { "src/components/ui/build/button.tsx": BUTTON_COPY },
        },
      ],
      {},
    );
    const { status, stderr } = runGate(tree);
    expect(status).not.toBe(0);
    expect(stderr).toContain("src/components/ui/build/button.tsx");
  });

  it("(b) counts a SYMLINKED baselined copy as present, not stale", () => {
    const tree = makeTree(
      [
        {
          dir: "demo-connector",
          kind: "connector",
          files: { "src/button-impl.tsx": BUTTON_COPY },
        },
      ],
      { "demo-connector": ["src/components/ui/button.tsx"] },
    );
    const uiDir = join(tree.extRoot, "cinatra-ai", "demo-connector", "src", "components", "ui");
    mkdirSync(uiDir, { recursive: true });
    symlinkSync(join("..", "..", "button-impl.tsx"), join(uiDir, "button.tsx"));
    const { status, stderr } = runGate(tree);
    expect(stderr).toBe("");
    expect(status).toBe(0);
  });

  it("--write-baseline refuses to GROW the committed baseline (shrink-only)", () => {
    const tree = makeTree(
      [
        {
          dir: "demo-connector",
          kind: "connector",
          files: { "src/components/ui/button.tsx": BUTTON_COPY },
        },
      ],
      {},
    );
    const { status, stderr } = runGate(tree, ["--write-baseline"]);
    expect(status).not.toBe(0);
    expect(stderr).toContain("shrink-only");
  });
});

// cinatra#3832: the committed floor is compared with the copy on the base
// branch, so a pull request cannot add a copy to the floor in its own change.
describe("self-rendering-extensions border gate — floor compared with the base", () => {
  const fixtures = [];
  afterEach(() => {
    while (fixtures.length) fixtures.pop().cleanup();
  });
  const floor = (copies) => ({ note: "fixture", copies });
  function repo(baseCopies, headCopies) {
    const f = makeFloorRepo({ base: { [FLOOR_FILE]: floor(baseCopies) }, head: { [FLOOR_FILE]: floor(headCopies) } });
    fixtures.push(f);
    return f.root;
  }

  it("a raised floor (a new copy in the baseline) FAILS against the base", () => {
    const root = repo({ demo: ["src/components/ui/a.tsx"] }, { demo: ["src/components/ui/a.tsx", "src/components/ui/b.tsx"] });
    const r = checkFloorAgainstBase({ repoRoot: root, env: PULL_REQUEST_RUN });
    expect(r.ok).toBe(false);
    expect(r.growth).toEqual(["demo :: src/components/ui/b.tsx"]);
  });

  it("a lowered floor (a removed copy) PASSES", () => {
    const root = repo({ demo: ["src/components/ui/a.tsx", "src/components/ui/b.tsx"] }, { demo: ["src/components/ui/a.tsx"] });
    expect(checkFloorAgainstBase({ repoRoot: root, env: PULL_REQUEST_RUN })).toMatchObject({ ok: true, status: "held" });
  });

  it("a base that cannot be read on a pull request's run FAILS with its reason", () => {
    const root = repo({}, {});
    const r = checkFloorAgainstBase({ repoRoot: root, env: UNREADABLE_BASE_RUN });
    expect(r.ok).toBe(false);
    expect(r.lines[0]).toMatch(/did not resolve/);
  });

  it("no pull request PASSES with its line", () => {
    const root = repo({}, { demo: ["src/components/ui/a.tsx"] });
    const r = checkFloorAgainstBase({ repoRoot: root, env: NO_PULL_REQUEST_RUN });
    expect(r).toMatchObject({ ok: true, status: "no-base" });
    expect(r.lines[0]).toContain(FLOOR_BASE_VAR);
  });

  it("the gate itself runs the guard: an unreadable base fails it with the reason", () => {
    const res = spawnSync(process.execPath, [GATE], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...envWithoutBase(process.env), ...UNREADABLE_BASE_RUN },
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/cannot be compared with the base: the base "origin\/no-such-base-3832" did not resolve/);
  });
});

// cinatra#3471: with the floor empty there is no baselined pair left to go
// stale, so the census itself must refuse anything it cannot read. Each case
// below pins one refusal branch of the gate (class (e) of its header).
describe("self-rendering-extensions border gate — nothing unread at an empty floor", () => {
  const CONNECTOR = { dir: "demo-connector", kind: "connector", files: { "src/index.ts": "export const x = 1;\n" } };
  /** The manifest path a refusal names, relative to the repository root. */
  const manifestPath = (dir) => ["extensions", "cinatra-ai", dir, "package.json"].join("/");
  const failing = (code, path) => Object.assign(new Error(`${code}: ${path}`), { code });

  it("the committed floor is empty", () => {
    const committed = JSON.parse(readFileSync(join(REPO_ROOT, FLOOR_FILE), "utf8"));
    expect(committed.copies).toEqual({});
  });

  it("refuses a declared package with no directory, by name", () => {
    const tree = makeTree([CONNECTOR], {}, { extraDeclared: ["@cinatra-ai/ghost-connector"] });
    const { status, stderr } = runGate(tree);
    expect(status).toBe(1);
    expect(stderr).toContain(
      `[self-rendering-border] REFUSED: @cinatra-ai/ghost-connector is declared but ${manifestPath("ghost-connector")} is missing`,
    );
  });

  it("refuses a declared package whose package.json is malformed JSON, by name", () => {
    const tree = makeTree([{ ...CONNECTOR, manifest: "{ not json" }], {});
    const { status, stderr } = runGate(tree);
    expect(status).toBe(1);
    expect(stderr).toContain("REFUSED: @cinatra-ai/demo-connector: package.json cannot be read (");
  });

  it("refuses a declared package whose package.json is JSON but not an object", () => {
    for (const manifest of ["null", "[]", '"x"']) {
      const tree = makeTree([{ ...CONNECTOR, manifest }], {});
      const { status, stderr } = runGate(tree);
      expect(status, manifest).toBe(1);
      expect(stderr, manifest).toContain("REFUSED: @cinatra-ai/demo-connector: package.json cannot be read (not a JSON object)");
    }
  });

  it("refuses a declared package with no cinatra.kind, by name", () => {
    for (const manifest of [{ name: "@cinatra-ai/demo-connector" }, { name: "@cinatra-ai/demo-connector", cinatra: {} }, { name: "@cinatra-ai/demo-connector", cinatra: "connector" }]) {
      const tree = makeTree([{ ...CONNECTOR, manifest: JSON.stringify(manifest) }], {});
      const { status, stderr } = runGate(tree);
      expect(status, JSON.stringify(manifest)).toBe(1);
      expect(stderr).toContain("REFUSED: @cinatra-ai/demo-connector has no cinatra.kind");
    }
  });

  it("refuses a declared package whose cinatra.kind is not a string", () => {
    for (const kind of [7, { x: 1 }, null, ["connector"]]) {
      const tree = makeTree([{ ...CONNECTOR, manifest: JSON.stringify({ name: "@cinatra-ai/demo-connector", cinatra: { kind } }) }], {});
      const { status, stderr } = runGate(tree);
      expect(status, JSON.stringify(kind)).toBe(1);
      expect(stderr).toContain("REFUSED: @cinatra-ai/demo-connector has no cinatra.kind");
    }
  });

  it("refuses a declared package whose cinatra.kind is a string no extension kind has, case variants and empty included", () => {
    for (const kind of ["Connector", "ARTIFACT", "widget", "", " connector"]) {
      const tree = makeTree([{ ...CONNECTOR, manifest: JSON.stringify({ name: "@cinatra-ai/demo-connector", cinatra: { kind } }) }], {});
      const { status, stderr } = runGate(tree);
      expect(status, JSON.stringify(kind)).toBe(1);
      expect(stderr, JSON.stringify(kind)).toContain(
        `REFUSED: @cinatra-ai/demo-connector has an unknown cinatra.kind ${JSON.stringify(kind)}`,
      );
    }
  });

  it("reads every canonical extension kind, and only those, as known", () => {
    const canonical = readFileSync(join(REPO_ROOT, "packages", "extensions", "src", "canonical-types.ts"), "utf8");
    const m = /export const EXTENSION_KINDS = \[([^\]]*)\] as const;/.exec(canonical);
    expect(m, "EXTENSION_KINDS in packages/extensions/src/canonical-types.ts").not.toBeNull();
    const kinds = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort();
    expect([...gate.KNOWN_KINDS].sort()).toEqual(kinds);
    // A declared package of every known kind that is not self-rendering is read and passes.
    const others = kinds.filter((k) => !gate.SELF_RENDERING_KINDS.has(k));
    const tree = makeTree(others.map((kind) => ({ dir: `demo-${kind}`, kind, files: { "src/components/ui/button.tsx": BUTTON_COPY } })), {});
    const { status, stderr } = runGate(tree);
    expect(stderr).toBe("");
    expect(status).toBe(0);
  });

  it("refuses a declared package whose package.json names another package, naming both", () => {
    const tree = makeTree([{ ...CONNECTOR, manifest: JSON.stringify({ name: "@cinatra-ai/other-connector", cinatra: { kind: "connector" } }) }], {});
    const { status, stderr } = runGate(tree);
    expect(status).toBe(1);
    expect(stderr).toContain(
      `REFUSED: @cinatra-ai/demo-connector is declared but ${manifestPath("demo-connector")} names "@cinatra-ai/other-connector"`,
    );
  });

  it("refuses an empty, absent or unreadable declared set", () => {
    const declaredValues = [{}, null, [], { "@other-scope/x": {} }, "@cinatra-ai/demo-connector"];
    for (const declared of declaredValues) {
      const tree = makeTree([CONNECTOR], {}, { declared });
      const { status, stderr } = runGate(tree);
      expect(status, JSON.stringify(declared)).toBe(1);
      expect(stderr).toContain(
        "[self-rendering-border] REFUSED: the declared extension set (package.json cinatra.devExtensions) is empty or unreadable — an empty census would pass vacuously",
      );
    }
    // No root package.json at all, and one that is not JSON.
    const tree = makeTree([CONNECTOR], {});
    rmSync(join(tree.base, "package.json"));
    expect(runGate(tree).stderr).toContain("cinatra.devExtensions) is empty or unreadable");
    writeFileSync(join(tree.base, "package.json"), "{ broken");
    const broken = runGate(tree);
    expect(broken.status).toBe(1);
    expect(broken.stderr).toContain("cinatra.devExtensions) is empty or unreadable");
  });

  it("refuses a declared name outside the scope or one it cannot map to a directory", () => {
    const tree = makeTree([CONNECTOR], {}, { extraDeclared: ["@other-scope/x-connector", "@cinatra-ai/Bad_Name"] });
    const { status, stderr } = runGate(tree);
    expect(status).toBe(1);
    expect(stderr).toContain("REFUSED: @other-scope/x-connector is declared outside the @cinatra-ai scope this census reads");
    expect(stderr).toContain("REFUSED: @cinatra-ai/Bad_Name is not a package name this census can map to a directory");
  });

  it("refuses a missing extension scope directory when packages are declared", () => {
    const tree = makeTree([], {}, { declared: { "@cinatra-ai/demo-connector": {} } });
    const { status, stderr } = runGate(tree);
    expect(status).toBe(1);
    expect(stderr).toContain(`REFUSED: the extension scope directory ${join(tree.extRoot, "cinatra-ai")} is missing`);
  });

  it("refuses a dangling symlink inside a connector's source, naming <package>/<rel>", () => {
    const tree = makeTree([CONNECTOR], {});
    symlinkSync(join("no", "such", "target.ts"), join(tree.extRoot, "cinatra-ai", "demo-connector", "src", "dangling.ts"));
    const { status, stderr } = runGate(tree);
    expect(status).toBe(1);
    expect(stderr).toContain("REFUSED: demo-connector/src/dangling.ts: unreadable (ENOENT)");
  });

  it("refuses a baseline without copies, and every other bad shape, by name", () => {
    const shapes = [{ note: "x" }, { copies: [] }, { copies: null }, { copies: { "demo-connector": "src/components/ui/a.tsx" } }, { copies: { "demo-connector": [1] } }, []];
    for (const shape of shapes) {
      const tree = makeTree([CONNECTOR], {});
      writeFileSync(tree.baselinePath, JSON.stringify(shape));
      const { status, stderr } = runGate(tree);
      expect(status, JSON.stringify(shape)).toBe(1);
      expect(stderr).toContain('"copies" is missing or not an object of string arrays');
    }
    const tree = makeTree([CONNECTOR], {});
    writeFileSync(tree.baselinePath, "{ broken");
    const broken = runGate(tree);
    expect(broken.status).toBe(1);
    expect(broken.stderr).toContain("not readable JSON");
  });

  it("still scans an UNDECLARED self-rendering directory under the scope", () => {
    const tree = makeTree(
      [CONNECTOR, { dir: "stale-connector", kind: "connector", undeclared: true, files: { "src/components/ui/button.tsx": BUTTON_COPY } }],
      {},
    );
    const { status, stderr } = runGate(tree);
    expect(status).toBe(1);
    expect(stderr).toContain("+ stale-connector :: src/components/ui/button.tsx");
  });

  it("prints EVERY refusal before the (a)-(c) lines, and does not stop at the first", () => {
    const tree = makeTree(
      [
        { dir: "copy-connector", kind: "connector", files: { "src/components/ui/button.tsx": BUTTON_COPY } },
        { ...CONNECTOR, manifest: JSON.stringify({ name: "@cinatra-ai/demo-connector" }) },
      ],
      {},
      { extraDeclared: ["@cinatra-ai/ghost-connector"] },
    );
    const { status, stderr } = runGate(tree);
    expect(status).toBe(1);
    const ghost = stderr.indexOf("REFUSED: @cinatra-ai/ghost-connector is declared");
    const kindless = stderr.indexOf("REFUSED: @cinatra-ai/demo-connector has no cinatra.kind");
    const classA = stderr.indexOf("(a) UNLISTED primitive copy");
    expect(ghost).toBeGreaterThan(-1);
    expect(kindless).toBeGreaterThan(-1);
    expect(classA).toBeGreaterThan(-1);
    expect(Math.max(ghost, kindless)).toBeLessThan(classA);
    expect(stderr).toContain("+ copy-connector :: src/components/ui/button.tsx");
  });

  it("--write-baseline on a tree missing a declared package refuses and leaves the baseline byte-identical", () => {
    const tree = makeTree([CONNECTOR], { "demo-connector": ["src/components/ui/button.tsx"] }, { extraDeclared: ["@cinatra-ai/ghost-connector"] });
    const before = readFileSync(tree.baselinePath, "utf8");
    const { status, stderr } = runGate(tree, ["--write-baseline"]);
    expect(status).toBe(1);
    expect(stderr).toContain("REFUSED: @cinatra-ai/ghost-connector is declared");
    expect(readFileSync(tree.baselinePath, "utf8")).toBe(before);
  });

  it("--write-baseline over a badly shaped baseline refuses and leaves it byte-identical", () => {
    const tree = makeTree([CONNECTOR], {});
    writeFileSync(tree.baselinePath, JSON.stringify({ copies: [] }));
    const before = readFileSync(tree.baselinePath, "utf8");
    const { status, stderr } = runGate(tree, ["--write-baseline"]);
    expect(status).toBe(1);
    expect(stderr).toContain('"copies" is missing or not an object of string arrays');
    expect(readFileSync(tree.baselinePath, "utf8")).toBe(before);
  });

  it("--write-baseline on a fully read tree writes the shrunk floor", () => {
    const tree = makeTree([CONNECTOR], { "demo-connector": ["src/components/ui/button.tsx"] });
    const { status } = runGate(tree, ["--write-baseline"]);
    expect(status).toBe(0);
    expect(JSON.parse(readFileSync(tree.baselinePath, "utf8")).copies).toEqual({});
    expect(runGate(tree).status).toBe(0);
  });

  // In process, through the census's file-system seam: as root in CI chmod
  // denies no read, so the readdir and the read branches need an injected io.
  const ioWith = (overrides) => ({
    readdirSync: realFs.readdirSync,
    statSync: realFs.statSync,
    readFileSync: realFs.readFileSync,
    existsSync: realFs.existsSync,
    ...overrides,
  });

  it("scanBorder refuses a directory it cannot list (readdir EACCES), and the real io has no refusal", () => {
    const tree = makeTree([CONNECTOR], {});
    const srcDir = join(tree.extRoot, "cinatra-ai", "demo-connector", "src");
    const io = ioWith({
      readdirSync: (p, o) => {
        if (p === srcDir) throw failing("EACCES", p);
        return realFs.readdirSync(p, o);
      },
    });
    const denied = gate.scanBorder({ extRoot: tree.extRoot, declaredRoot: tree.base, io });
    expect(denied.refusals).toContain("[self-rendering-border] REFUSED: demo-connector/src: unreadable (EACCES)");
    const real = gate.scanBorder({ extRoot: tree.extRoot, declaredRoot: tree.base });
    expect(real.refusals).toEqual([]);
    expect(real.packages.map((p) => p.name)).toEqual(["demo-connector"]);
  });

  it("scanBorder refuses a source file it cannot read (EIO); the coupling is not read as clean", () => {
    const tree = makeTree(
      [{ ...CONNECTOR, files: { "src/index.ts": 'import { Button } from "@/components/ui/button";\nexport { Button };\n' } }],
      {},
    );
    const file = join(tree.extRoot, "cinatra-ai", "demo-connector", "src", "index.ts");
    const io = ioWith({
      readFileSync: (p, o) => {
        if (p === file) throw failing("EIO", p);
        return realFs.readFileSync(p, o);
      },
    });
    const census = gate.scanBorder({ extRoot: tree.extRoot, declaredRoot: tree.base, io });
    expect(census.refusals).toContain("[self-rendering-border] REFUSED: demo-connector/src/index.ts: unreadable (EIO)");
    expect(gate.scanBorder({ extRoot: tree.extRoot, declaredRoot: tree.base }).coupling).toEqual([
      { package: "demo-connector", file: "src/index.ts", specifier: "@/components/ui/button" },
    ]);
  });

  it("scanBorder refuses a manifest it cannot read for a reason other than malformed JSON", () => {
    const tree = makeTree([CONNECTOR], {});
    const manifest = join(tree.extRoot, "cinatra-ai", "demo-connector", "package.json");
    const io = ioWith({
      readFileSync: (p, o) => {
        if (p === manifest) throw failing("EACCES", p);
        return realFs.readFileSync(p, o);
      },
    });
    const census = gate.scanBorder({ extRoot: tree.extRoot, declaredRoot: tree.base, io });
    expect(census.refusals).toContain("[self-rendering-border] REFUSED: @cinatra-ai/demo-connector: package.json cannot be read (EACCES)");
    expect(census.packages).toEqual([]);
  });

  it("scanBorder refuses a scope directory it cannot list, and a stat it cannot take", () => {
    const tree = makeTree([CONNECTOR], {});
    const scopeDir = join(tree.extRoot, "cinatra-ai");
    const scope = gate.scanBorder({
      extRoot: tree.extRoot,
      declaredRoot: tree.base,
      io: ioWith({
        readdirSync: (p, o) => {
          if (p === scopeDir) throw failing("EACCES", p);
          return realFs.readdirSync(p, o);
        },
      }),
    });
    expect(scope.refusals).toContain(`[self-rendering-border] REFUSED: ${scopeDir}: unreadable (EACCES)`);
    symlinkSync("index.ts", join(scopeDir, "demo-connector", "src", "alias.ts"));
    const aliased = join(scopeDir, "demo-connector", "src", "alias.ts");
    const stat = gate.scanBorder({
      extRoot: tree.extRoot,
      declaredRoot: tree.base,
      io: ioWith({
        statSync: (p, o) => {
          if (p === aliased) throw failing("ELOOP", p);
          return realFs.statSync(p, o);
        },
      }),
    });
    expect(stat.refusals).toContain("[self-rendering-border] REFUSED: demo-connector/src/alias.ts: unreadable (ELOOP)");
    expect(gate.scanBorder({ extRoot: tree.extRoot, declaredRoot: tree.base }).refusals).toEqual([]);
  });

  it("the single-purpose exported reads throw on a refusal instead of reading the tree as clean", () => {
    const tree = makeTree([], {});
    // These read the declared set beside the synthetic tree, which is empty;
    // the census is refused, never returned as an empty, clean result.
    expect(() => gate.scanPrimitiveCopies(tree.extRoot)).toThrow(/REFUSED/);
    expect(() => gate.scanDirectCoupling(tree.extRoot)).toThrow(/REFUSED/);
    expect(() => gate.listSelfRenderingPackages(tree.extRoot)).toThrow(/REFUSED/);
  });

  it("parseFloor accepts an empty floor and string arrays only", () => {
    expect(gate.parseFloor('{"copies":{}}', "f")).toEqual({});
    expect(gate.parseFloor('{"copies":{"a":["src/components/ui/x.tsx"]}}', "f")).toEqual({ a: ["src/components/ui/x.tsx"] });
    for (const bad of ['{"note":1}', '{"copies":[]}', '{"copies":null}', '{"copies":{"a":"x"}}', '{"copies":{"a":[1]}}', "[]", "null"]) {
      expect(() => gate.parseFloor(bad, "f"), bad).toThrow('REFUSED: f: "copies" is missing or not an object of string arrays');
    }
  });
});

// cinatra#3471: a directory under the scope that the declared set does not
// name is read with the same allow-list as a declared one. A package.json it
// cannot read, a missing kind and a kind no extension has are refused by the
// directory's path; only an entry that holds no package.json is not a package.
describe("self-rendering-extensions border gate — an undeclared directory is read or refused", () => {
  const CONNECTOR = { dir: "demo-connector", kind: "connector", files: { "src/index.ts": "export const x = 1;\n" } };
  const where = (dir) => ["extensions", "cinatra-ai", dir].join("/");
  const failing = (code, path) => Object.assign(new Error(`${code}: ${path}`), { code });
  const ioWith = (overrides) => ({
    readdirSync: realFs.readdirSync,
    statSync: realFs.statSync,
    readFileSync: realFs.readFileSync,
    existsSync: realFs.existsSync,
    ...overrides,
  });
  const stale = (manifest) => ({ dir: "stale-pkg", undeclared: true, manifest, files: { "src/index.ts": "export const y = 1;\n" } });

  it("refuses an undeclared package.json that is malformed JSON or not an object, by path", () => {
    for (const manifest of ["{ not json", "null", "[]", '"x"']) {
      const tree = makeTree([CONNECTOR, stale(manifest)], {});
      const { status, stderr } = runGate(tree);
      expect(status, manifest).toBe(1);
      expect(stderr, manifest).toContain(`REFUSED: ${where("stale-pkg")} is not declared and its package.json cannot be read (`);
    }
  });

  it("refuses an undeclared package with no cinatra.kind or a kind that is not a string, by path", () => {
    for (const manifest of [{ name: "@cinatra-ai/stale-pkg" }, { cinatra: {} }, { cinatra: "connector" }, { cinatra: { kind: 7 } }, { cinatra: { kind: null } }, { cinatra: { kind: ["artifact"] } }]) {
      const tree = makeTree([CONNECTOR, stale(JSON.stringify(manifest))], {});
      const { status, stderr } = runGate(tree);
      expect(status, JSON.stringify(manifest)).toBe(1);
      expect(stderr, JSON.stringify(manifest)).toContain(`REFUSED: ${where("stale-pkg")} is not declared and has no cinatra.kind`);
    }
  });

  it("refuses an undeclared package whose cinatra.kind no extension has, case variants and empty included", () => {
    for (const kind of ["Connector", "ARTIFACT", "Artifact", "widget", "", " connector", "artifact "]) {
      const tree = makeTree([CONNECTOR, stale(JSON.stringify({ name: "@cinatra-ai/stale-pkg", cinatra: { kind } }))], {});
      const { status, stderr } = runGate(tree);
      expect(status, JSON.stringify(kind)).toBe(1);
      expect(stderr, JSON.stringify(kind)).toContain(
        `REFUSED: ${where("stale-pkg")} is not declared and has an unknown cinatra.kind ${JSON.stringify(kind)}`,
      );
    }
  });

  it("refuses an undeclared package.json that is a dangling symlink", () => {
    const tree = makeTree([CONNECTOR], {});
    const dir = join(tree.extRoot, "cinatra-ai", "stale-pkg");
    mkdirSync(dir, { recursive: true });
    symlinkSync(join("no", "such", "package.json"), join(dir, "package.json"));
    const { status, stderr } = runGate(tree);
    expect(status).toBe(1);
    expect(stderr).toContain(`REFUSED: ${where("stale-pkg")} is not declared and its package.json cannot be read (ENOENT)`);
  });

  it("scanBorder refuses an undeclared package.json it cannot read (EACCES)", () => {
    const tree = makeTree([CONNECTOR, { dir: "stale-pkg", kind: "artifact", undeclared: true }], {});
    const manifest = join(tree.extRoot, "cinatra-ai", "stale-pkg", "package.json");
    const io = ioWith({
      readFileSync: (p, o) => {
        if (p === manifest) throw failing("EACCES", p);
        return realFs.readFileSync(p, o);
      },
    });
    const census = gate.scanBorder({ extRoot: tree.extRoot, declaredRoot: tree.base, io });
    expect(census.refusals).toContain(
      `[self-rendering-border] REFUSED: ${where("stale-pkg")} is not declared and its package.json cannot be read (EACCES)`,
    );
    expect(census.packages.map((p) => p.name)).toEqual(["demo-connector"]);
    const real = gate.scanBorder({ extRoot: tree.extRoot, declaredRoot: tree.base });
    expect(real.refusals).toEqual([]);
    expect(real.packages.map((p) => p.name)).toEqual(["demo-connector", "stale-pkg"]);
  });

  it("scanBorder refuses an undeclared directory it cannot list (EACCES), never reads it as no package", () => {
    const tree = makeTree([CONNECTOR, { dir: "stale-pkg", kind: "artifact", undeclared: true }], {});
    const dir = join(tree.extRoot, "cinatra-ai", "stale-pkg");
    const io = ioWith({
      readdirSync: (p, o) => {
        if (p === dir) throw failing("EACCES", p);
        return realFs.readdirSync(p, o);
      },
      existsSync: (p) => (p.startsWith(dir) ? false : realFs.existsSync(p)),
      statSync: (p, o) => {
        if (p.startsWith(dir)) throw failing("EACCES", p);
        return realFs.statSync(p, o);
      },
    });
    const census = gate.scanBorder({ extRoot: tree.extRoot, declaredRoot: tree.base, io });
    expect(census.refusals).toContain(`[self-rendering-border] REFUSED: ${where("stale-pkg")} is not declared and cannot be listed (EACCES)`);
  });

  it("passes an undeclared directory with no package.json and a plain file under the scope (neither is a package)", () => {
    const tree = makeTree([CONNECTOR], {});
    const dir = join(tree.extRoot, "cinatra-ai", "notes-dir");
    mkdirSync(join(dir, "src", "components", "ui"), { recursive: true });
    writeFileSync(join(dir, "src", "components", "ui", "button.tsx"), BUTTON_COPY);
    writeFileSync(join(tree.extRoot, "cinatra-ai", "README.md"), "not a package\n");
    const { status, stderr } = runGate(tree);
    expect(stderr).toBe("");
    expect(status).toBe(0);
  });

  it("reads an undeclared package of a known kind that does not render itself as out of scope", () => {
    const tree = makeTree(
      [CONNECTOR, { dir: "stale-agent", kind: "agent", undeclared: true, files: { "src/components/ui/button.tsx": BUTTON_COPY } }],
      {},
    );
    const { status, stderr } = runGate(tree);
    expect(stderr).toBe("");
    expect(status).toBe(0);
  });
});

// cinatra#3471: the declared set is the extension tree's own (the package.json
// beside it). No variable narrows it independently of the tree, so a
// declared-but-missing package cannot be hidden by pointing the declared set
// somewhere else.
describe("self-rendering-extensions border gate — the declared set cannot be narrowed", () => {
  const CONNECTOR = { dir: "demo-connector", kind: "connector", files: { "src/index.ts": "export const x = 1;\n" } };
  const missing = `REFUSED: @cinatra-ai/ghost-connector is declared but ${["extensions", "cinatra-ai", "ghost-connector", "package.json"].join("/")} is missing`;
  function narrowRoot(devExtensions) {
    const dir = mkdtempSync(join(tmpdir(), "cinatra-border-declared-"));
    temps.push(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "narrow-root", cinatra: { devExtensions } }));
    return dir;
  }

  it("SELF_RENDERING_BORDER_DECLARED_ROOT pointing at a narrower set does not hide a declared-but-missing package", () => {
    const tree = makeTree([CONNECTOR], {}, { extraDeclared: ["@cinatra-ai/ghost-connector"] });
    expect(runGate(tree).stderr).toContain(missing);
    for (const narrow of [narrowRoot({ "@cinatra-ai/demo-connector": {} }), narrowRoot({})]) {
      const { status, stderr } = runGate(tree, [], { SELF_RENDERING_BORDER_DECLARED_ROOT: narrow });
      expect(status).toBe(1);
      expect(stderr).toContain(missing);
    }
  });

  it("SELF_RENDERING_BORDER_DECLARED_ROOT cannot re-declare an unknown kind's directory as undeclared and out of sight", () => {
    const tree = makeTree([CONNECTOR, { dir: "odd-pkg", kind: "Connector" }], {});
    const narrow = narrowRoot({ "@cinatra-ai/demo-connector": {} });
    const { status, stderr } = runGate(tree, [], { SELF_RENDERING_BORDER_DECLARED_ROOT: narrow });
    expect(status).toBe(1);
    expect(stderr).toContain('has an unknown cinatra.kind "Connector"');
  });

  it("scanBorder reads the declared set beside the extension tree by default", () => {
    const tree = makeTree([CONNECTOR], {}, { extraDeclared: ["@cinatra-ai/ghost-connector"] });
    const census = gate.scanBorder({ extRoot: tree.extRoot });
    expect(census.refusals).toContain(`[self-rendering-border] ${missing}`);
    expect(census.packages.map((p) => p.name)).toEqual(["demo-connector"]);
  });
});

// cinatra#3471: the gate covers TWO kinds. With the floor empty there is no
// committed artifact copy left to hold the artifact branch, so every refusal
// and every pass branch is pinned for an artifact package as well as for a
// connector. The kinds are written out here, never read from the gate, so a
// kind dropped from the gate fails these cases.
describe("self-rendering-extensions border gate — every branch for each self-rendering kind", () => {
  const KINDS = ["connector", "artifact"];
  const failing = (code, path) => Object.assign(new Error(`${code}: ${path}`), { code });
  const ioWith = (overrides) => ({
    readdirSync: realFs.readdirSync,
    statSync: realFs.statSync,
    readFileSync: realFs.readFileSync,
    existsSync: realFs.existsSync,
    ...overrides,
  });

  it("the gate's self-rendering kinds are exactly connector and artifact", () => {
    expect([...gate.SELF_RENDERING_KINDS].sort()).toEqual([...KINDS].sort());
  });

  for (const kind of KINDS) {
    const dir = `demo-${kind}`;

    it(`${kind}: (a) an unlisted copy FAILS, naming the pair`, () => {
      const tree = makeTree([{ dir, kind, files: { "src/components/ui/button.tsx": BUTTON_COPY } }], {});
      const { status, stderr } = runGate(tree);
      expect(status).toBe(1);
      expect(stderr).toContain("(a) UNLISTED primitive copy");
      expect(stderr).toContain(`+ ${dir} :: src/components/ui/button.tsx`);
    });

    it(`${kind}: (a) a baselined copy PASSES`, () => {
      const tree = makeTree([{ dir, kind, files: { "src/components/ui/button.tsx": BUTTON_COPY } }], { [dir]: ["src/components/ui/button.tsx"] });
      const { status, stderr } = runGate(tree);
      expect(stderr).toBe("");
      expect(status).toBe(0);
    });

    it(`${kind}: (b) a stale baseline pair FAILS`, () => {
      const tree = makeTree([{ dir, kind, files: { "src/index.ts": "export const x = 1;\n" } }], { [dir]: ["src/components/ui/button.tsx"] });
      const { status, stderr } = runGate(tree);
      expect(status).toBe(1);
      expect(stderr).toContain("(b) STALE baseline entry");
      expect(stderr).toContain(`- ${dir} :: src/components/ui/button.tsx`);
    });

    it(`${kind}: (c) a direct reach into @/components/ui, @/lib/utils or src/components/ui FAILS`, () => {
      const tree = makeTree(
        [
          {
            dir,
            kind,
            files: {
              "src/a.tsx": 'import { Button } from "@/components/ui/button";\nexport { Button };\n',
              "src/b.ts": 'import { cn } from "@/lib/utils";\nexport { cn };\n',
              "src/c.ts": 'import { Card } from "../../../src/components/ui/card";\nexport { Card };\n',
            },
          },
        ],
        {},
      );
      const { status, stderr } = runGate(tree);
      expect(status).toBe(1);
      expect(stderr).toContain(`! ${dir} :: src/a.tsx imports @/components/ui/button`);
      expect(stderr).toContain(`! ${dir} :: src/b.ts imports @/lib/utils`);
      expect(stderr).toContain(`! ${dir} :: src/c.ts imports ../../../src/components/ui/card`);
    });

    it(`${kind}: (c) the shared module id and a relative import of its own baselined copy PASS`, () => {
      const tree = makeTree(
        [
          {
            dir,
            kind,
            files: {
              "src/components/ui/button.tsx": BUTTON_COPY,
              "src/view.tsx": 'import { Button } from "./components/ui/button";\nimport { Alert } from "@cinatra-ai/design-primitives";\nexport default [Button, Alert];\n',
            },
          },
        ],
        { [dir]: ["src/components/ui/button.tsx"] },
      );
      const { status, stderr } = runGate(tree);
      expect(stderr).toBe("");
      expect(status).toBe(0);
    });

    it(`${kind}: an UNDECLARED directory of this kind is still scanned`, () => {
      const tree = makeTree(
        [
          { dir: "anchor-agent", kind: "agent" },
          { dir: `stale-${kind}`, kind, undeclared: true, files: { "src/components/ui/button.tsx": BUTTON_COPY } },
        ],
        {},
      );
      const { status, stderr } = runGate(tree);
      expect(status).toBe(1);
      expect(stderr).toContain(`+ stale-${kind} :: src/components/ui/button.tsx`);
    });

    it(`${kind}: a declared case variant of the kind is refused, not read as out of scope`, () => {
      for (const variant of [kind.toUpperCase(), kind[0].toUpperCase() + kind.slice(1), ` ${kind}`]) {
        const tree = makeTree([{ dir, kind: variant, files: { "src/components/ui/button.tsx": BUTTON_COPY } }], {});
        const { status, stderr } = runGate(tree);
        expect(status, variant).toBe(1);
        expect(stderr, variant).toContain(`REFUSED: @cinatra-ai/${dir} has an unknown cinatra.kind ${JSON.stringify(variant)}`);
      }
    });

    it(`${kind}: scanBorder refuses a copy directory it cannot list and a source file it cannot read`, () => {
      const tree = makeTree([{ dir, kind, files: { "src/components/ui/button.tsx": BUTTON_COPY, "src/index.ts": "export const x = 1;\n" } }], {});
      const pkgDir = join(tree.extRoot, "cinatra-ai", dir);
      const uiDir = join(pkgDir, "src", "components", "ui");
      const file = join(pkgDir, "src", "index.ts");
      const census = gate.scanBorder({
        extRoot: tree.extRoot,
        declaredRoot: tree.base,
        io: ioWith({
          readdirSync: (p, o) => {
            if (p === uiDir) throw failing("EACCES", p);
            return realFs.readdirSync(p, o);
          },
          readFileSync: (p, o) => {
            if (p === file) throw failing("EIO", p);
            return realFs.readFileSync(p, o);
          },
        }),
      });
      expect(census.refusals).toContain(`[self-rendering-border] REFUSED: ${dir}/src/components/ui: unreadable (EACCES)`);
      expect(census.refusals).toContain(`[self-rendering-border] REFUSED: ${dir}/src/index.ts: unreadable (EIO)`);
      const real = gate.scanBorder({ extRoot: tree.extRoot, declaredRoot: tree.base });
      expect(real.refusals).toEqual([]);
      expect(real.packages).toEqual([{ name: dir, dir: pkgDir, kind }]);
      expect(real.copies).toEqual({ [dir]: ["src/components/ui/button.tsx"] });
    });

    it(`${kind}: --write-baseline refuses to grow the floor and leaves it byte-identical`, () => {
      const tree = makeTree([{ dir, kind, files: { "src/components/ui/button.tsx": BUTTON_COPY } }], {});
      const before = readFileSync(tree.baselinePath, "utf8");
      const { status, stderr } = runGate(tree, ["--write-baseline"]);
      expect(status).toBe(1);
      expect(stderr).toContain("shrink-only");
      expect(stderr).toContain(`+ ${dir} :: src/components/ui/button.tsx`);
      expect(readFileSync(tree.baselinePath, "utf8")).toBe(before);
    });

    it(`${kind}: --write-baseline ratchets a removed copy down to an empty floor`, () => {
      const tree = makeTree([{ dir, kind, files: { "src/index.ts": "export const x = 1;\n" } }], { [dir]: ["src/components/ui/button.tsx"] });
      const { status } = runGate(tree, ["--write-baseline"]);
      expect(status).toBe(0);
      expect(JSON.parse(readFileSync(tree.baselinePath, "utf8")).copies).toEqual({});
      expect(runGate(tree).status).toBe(0);
    });
  }
});

describe("self-rendering-extensions border gate — a badly shaped floor fails the base guard closed", () => {
  const fixtures = [];
  afterEach(() => {
    while (fixtures.length) fixtures.pop().cleanup();
  });
  const BAD_SHAPES = [{ note: "no copies" }, { copies: [] }, { copies: null }, { copies: { demo: "src/components/ui/a.tsx" } }, { copies: { demo: [1] } }];

  it("a BASE floor of a bad shape is unreadable, never an empty floor", () => {
    for (const shape of BAD_SHAPES) {
      const f = makeFloorRepo({ base: { [FLOOR_FILE]: shape }, head: { [FLOOR_FILE]: { note: "fixture", copies: {} } } });
      fixtures.push(f);
      const r = checkFloorAgainstBase({ repoRoot: f.root, env: PULL_REQUEST_RUN });
      expect(r.ok, JSON.stringify(shape)).toBe(false);
      expect(r.status).toBe("unreadable");
      expect(r.lines[0]).toMatch(/is not a readable floor/);
      expect(r.lines[0]).toContain('"copies" is missing or not an object of string arrays');
    }
  });

  it("a HEAD floor of a bad shape, read by default, fails closed on a pull request's run and on no pull request", () => {
    for (const shape of BAD_SHAPES) {
      const f = makeFloorRepo({ base: { [FLOOR_FILE]: { note: "fixture", copies: {} } }, head: { [FLOOR_FILE]: shape } });
      fixtures.push(f);
      for (const env of [PULL_REQUEST_RUN, NO_PULL_REQUEST_RUN]) {
        const r = checkFloorAgainstBase({ repoRoot: f.root, env });
        expect(r.ok, JSON.stringify(shape)).toBe(false);
        expect(r.lines[0]).toContain('"copies" is missing or not an object of string arrays');
      }
    }
  });
});

// cinatra#3471: once the floor is empty, the statements that described it as
// holding copies are history. Each file's text is normalized (comment markers
// dropped, lines joined, whitespace collapsed), so a claim split across
// comment lines is still found, and every new sentence is asserted by name.
describe("self-rendering-extensions border gate — the statements of an empty floor", () => {
  const normalize = (text) =>
    text
      .split("\n")
      .map((line) => line.replace(/\/\*+|\*+\//g, " ").replace(/^\s*\*(?!\*)/, " ").replace(/^\s*\/\/+/, " "))
      .join(" ")
      .replace(/\s+/g, " ");
  const normalized = (rel) => normalize(readFileSync(join(REPO_ROOT, rel), "utf8"));
  const FILES = {
    gate: "scripts/extensions/self-rendering-extensions-border-gate.mjs",
    bundle: "packages/sdk-extensions/src/artifact-client-bundle.ts",
    contractTest: "packages/sdk-extensions/src/__tests__/design-primitives-contract.test.ts",
    contractDoc: "docs/internals/contracts/host-shared-primitives-contract.md",
    vendor: "scripts/extensions/vendor-extension-primitives.mjs",
    baseline: FLOOR_FILE,
  };
  const OLD_CLAIMS = [
    "records as byte copies",
    "border floor records",
    "border floor also records",
    "baseline ALSO lists",
    "appear in the border floor",
    "No package is migrated",
    "Today fifteen connector packages",
    "still carry are recorded",
    "The floor empties as packages move",
    "A package keeps its own copy",
  ];
  const ANCHORS = [
    ["H1", "gate", "Connector and artifact packages held BYTE COPIES of those primitives under src/components/ui/ until the run-time-shared road of #3471 replaced them; the last copies (email-artifacts) went with #3471, and the floor is empty."],
    ["H1", "gate", "The gate now refuses any copy outright and refuses any declared package it cannot read."],
    ["H2", "bundle", "exactly the exports of the seventeen product components under src/components/ui/ that connector and artifact packages copied before the migration of #3471: alert, alert-dialog, badge, button, card, checkbox, dialog, field, input-group, input, label, paginated-table, pagination, select, separator, table, textarea."],
    ["H2", "bundle", "The list is frozen by the contract version, not by the border floor, which is empty."],
    ["H3", "bundle", "Before the migration the border floor also recorded external-link.tsx, link.tsx and text-link.tsx. Those are NOT product primitives: they are the extensions' OWN components, and no such file exists under src/components/ui/, so the host cannot and does not serve them."],
    ["H4", "contractTest", 'it("names an export of every frozen primitive anchor"'],
    ["H4", "contractTest", "PRIMITIVE_ANCHORS: the seventeen product components of the frozen list"],
    ["H4", "contractTest", "external-link / link / text-link are not in PRIMITIVE_ANCHORS"],
    ["H5", "contractDoc", "Exactly the exports of the seventeen product components under src/components/ui/ that connector and artifact packages copied before the migration of #3471."],
    ["H6", "contractDoc", "Before the migration the border floor also recorded external-link.tsx, link.tsx and text-link.tsx. Those are not product primitives: they are the extensions' own components, and no such file exists under src/components/ui/, so the host cannot serve them. A connector or artifact package keeps such a component in its own source outside src/components/ui/ (the border gate refuses any file there); they never enter this contract."],
    ["H7", "contractDoc", "Remove the package's pairs from the border floor and move its dev-lock pin. (Only a kind:agent package also has a VENDOR_MANIFEST entry to drop; see #3470.)"],
    ["H8", "contractDoc", "## What this slice did not do"],
    ["H8", "contractDoc", "Migrated since: #3509, #3510 and #3471; the border floor is empty."],
    ["H9", "vendor", "The copies those packages carried were recorded by the shrink-only baseline of scripts/extensions/self-rendering-extensions-border-gate.mjs until #3471 emptied it; that gate now refuses any copy in either kind outright."],
    ["H10", "baseline", "The floor emptied with #3471 and stays empty: a design-primitive copy under src/components/ui/ of a synced kind:connector / kind:artifact package fails the gate."],
  ];

  it("holds only while the committed floor is empty", () => {
    expect(JSON.parse(readFileSync(join(REPO_ROOT, FLOOR_FILE), "utf8")).copies).toEqual({});
  });

  for (const [key, rel] of Object.entries(FILES)) {
    it(`${key}: no statement still describes the floor as holding copies`, () => {
      const text = normalized(rel);
      for (const claim of OLD_CLAIMS) expect(text.includes(claim), `${rel} still says "${claim}"`).toBe(false);
    });
  }

  for (const [h, key, anchor] of ANCHORS) {
    it(`${h}: ${FILES[key]} carries its new sentence`, () => {
      expect(normalized(FILES[key])).toContain(anchor.replace(/\s+/g, " "));
    });
  }

  it("the normalization finds a claim split over comment lines", () => {
    expect(normalize("/**\n * that the border floor\n * records as byte copies\n */\n")).toContain(
      "border floor records as byte copies",
    );
    expect(normalize("// The copies those packages still carry\n// are recorded by the baseline\n")).toContain(
      "still carry are recorded",
    );
  });
});
