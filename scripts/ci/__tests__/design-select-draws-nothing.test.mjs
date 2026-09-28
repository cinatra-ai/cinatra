// WHAT THE DESIGN SUITE'S SELECTION READS AS DRAWING NOTHING (cinatra#3748).
//
// This changes what the design suite runs on a pull request. Three kinds of
// changed path can change no page, so the selection reads them as drawing
// nothing and a pull request made only of them gets its design verdict without
// the suite:
//
//   1. a test file or a test fixture: a path under `__tests__`, a name ending
//      `.test.ts`, `.test.tsx` or `.test.mjs`, or a path under `__fixtures__`,
//      unless it is one of the selection's own proofs, part of the design suite
//      itself, or reached by a family's import graph;
//   2. the generated SERVER map of the extensions (the client map keeps today's
//      reading);
//   3. an extension lock whose moved pins cross only pack files that draw
//      nothing, by the pack rule the approval gate's lock evidence uses.
//
// Every rule is pinned here together with a control that still runs the
// families. The selection runs over a VIRTUAL repo (the shape of
// design-select.test.mjs), and the lock evidence over REAL git repositories in
// a temporary directory (the shape of design-select-range.test.mjs): an
// application repository holding the two locks, with each pack repository at
// its own extensions/<scope>/<name> checkout. Nothing here reads the network.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import * as selector from "../design-select.mjs";

const { buildFamilies, resolveChangedFiles, selectFamilies } = selector;

// ---------------------------------------------------------------------------
// The virtual repo (copied from design-select.test.mjs, never imported from it).

const TSCONFIG_JSON = JSON.stringify({
  compilerOptions: {
    paths: {
      "@/*": ["./src/*"],
      "@cinatra-ai/agents": ["./packages/agents/src/index.ts"],
      "@cinatra-ai/agents/*": ["./packages/agents/src/*"],
    },
  },
});

/** A virtual repo: repo-relative path -> file text. */
const makeIo = (files) => {
  const all = Object.hasOwn(files, "tsconfig.json")
    ? files
    : { ...files, "tsconfig.json": TSCONFIG_JSON };
  return {
    read: (rel) => (Object.hasOwn(all, rel) ? all[rel] : null),
    exists: (rel) => Object.hasOwn(all, rel),
    list: (rel) => {
      const children = new Map();
      for (const path of Object.keys(all)) {
        if (!path.startsWith(`${rel}/`)) continue;
        const rest = path.slice(rel.length + 1);
        const slash = rest.indexOf("/");
        const name = slash === -1 ? rest : rest.slice(0, slash);
        if (!children.has(name) || slash !== -1) children.set(name, slash !== -1);
      }
      return [...children].map(([name, directory]) => ({ name, directory }));
    },
  };
};

const REPO = {
  "tests/e2e/design/alpha.spec.ts": `
    import { test } from "@playwright/test";
    const FIXTURE_PATH = "/design-fixtures/alpha";
    test("alpha", async ({ page }) => { await page.goto(FIXTURE_PATH); });
  `,
  "tests/e2e/design/beta.spec.ts": `
    import { test } from "@playwright/test";
    const FIXTURE_PATH = "/design-fixtures/beta";
    test("beta", async ({ page }) => { await page.goto(FIXTURE_PATH); });
  `,
  "tests/e2e/design/conformance/gamma.spec.ts": `
    import { test } from "@playwright/test";
    import { HARNESS_PATH } from "./contract";
    test("gamma", async ({ page }) => { await page.goto(HARNESS_PATH); });
  `,
  "tests/e2e/design/conformance/contract.ts": `
    export const HARNESS_PATH = "/design-fixtures/gamma";
  `,
  "src/app/design-fixtures/alpha/page.tsx": `
    import { Widget } from "@/lib/widget";
    export default function Page() { return <Widget />; }
  `,
  "src/app/design-fixtures/beta/page.tsx": `
    import { Widget } from "../../../lib/widget";
    export default function Page() { return <Widget />; }
  `,
  "src/app/design-fixtures/gamma/page.tsx": `
    import { Other } from "@/lib/other";
    export default function Page() { return <Other />; }
  `,
  "src/lib/widget.tsx": "export const Widget = () => null;",
  "src/lib/other.tsx": "export const Other = () => null;",
};

const SPECS = [
  "tests/e2e/design/alpha.spec.ts",
  "tests/e2e/design/beta.spec.ts",
  "tests/e2e/design/conformance/gamma.spec.ts",
];

const ALPHA = "tests/e2e/design/alpha.spec.ts";
const GAMMA = "tests/e2e/design/conformance/gamma.spec.ts";

const familiesOf = (files = REPO) => buildFamilies({ specFiles: SPECS, io: makeIo(files) });

const select = (changedFiles, files = REPO, options = {}) =>
  selectFamilies({ changedFiles, ...familiesOf(files), ...options });

const SERVER_MAP = "src/lib/generated/extensions.server.ts";
const CLIENT_MAP = "src/lib/generated/extensions.client.tsx";
const MEASURED_TEST =
  "packages/agents/src/__tests__/upload-dependency-runnable-gate-3204.integration.test.ts";

// A family's fixture page that imports the server map, and one that reaches a
// fixture through production source (src/lib/deployment-registry-config.ts
// imports ./__fixtures__/deployment-registry-config.fixture on main).
const REPO_WITH_SERVER_MAP_AND_FIXTURE = {
  ...REPO,
  "src/app/design-fixtures/alpha/page.tsx": `
    import { Widget } from "@/lib/widget";
    import { EXTENSIONS } from "@/lib/generated/extensions.server";
    import { REGISTRY } from "@/lib/deployment-registry-config";
    export default function Page() { return <Widget items={EXTENSIONS} registry={REGISTRY} />; }
  `,
  [SERVER_MAP]: "export const EXTENSIONS = [];",
  "src/lib/deployment-registry-config.ts":
    'export { REGISTRY } from "./__fixtures__/deployment-registry-config.fixture";',
  "src/lib/__fixtures__/deployment-registry-config.fixture.ts": "export const REGISTRY = {};",
};

describe("a change of only test files or test fixtures selects no design family", () => {
  const TEST_ONLY = [
    MEASURED_TEST,
    "packages/agents/src/run-page.test.ts",
    "packages/agents/src/run-page.test.tsx",
    "packages/agents/src/run-page.test.mjs",
    "packages/dashboards/src/components/__fixtures__/dc-client-allowed.fixture.tsx",
    "src/app/design-fixtures/conformance/__tests__/seed-partition.test.ts",
  ];

  for (const file of TEST_ONLY) {
    it(`selects no design family for a change of only ${file}`, () => {
      const result = select([file]);
      expect(result.mode).toBe("none");
      expect(result.specs).toEqual([]);
      expect(result.summary).toContain("1 read as drawing nothing");
      expect(result.summary).toContain("test-file 1");
    });
  }

  it("selects no design family for a change made of all of them together", () => {
    const result = select(TEST_ONLY);
    expect(result.mode).toBe("none");
    expect(result.summary).toContain(`${TEST_ONLY.length} read as drawing nothing`);
  });
});

describe("a test file beside a change that can draw still runs the families", () => {
  for (const drawn of ["src/components/ui/button.tsx", "packages/agents/src/run-page.tsx"]) {
    it(`runs every family for the measured test file together with ${drawn}`, () => {
      const result = select([MEASURED_TEST, drawn]);
      expect(result.mode).toBe("all");
      expect(result.specs).toEqual(SPECS);
    });
  }
});

describe("the selection's own proofs, the suite's own tree and a reached fixture keep today's reading", () => {
  for (const file of [
    "scripts/ci/design-select.mjs",
    "scripts/ci/__tests__/design-select.test.mjs",
    "scripts/ci/__tests__/design-select-range.test.mjs",
    "scripts/ci/__tests__/design-select-draws-nothing.test.mjs",
    ".github/workflows/design-visual-verify.yml",
  ]) {
    it(`runs every family for a change of only ${file}`, () => {
      const result = select([file]);
      expect(result.mode).toBe("all");
      expect(result.specs).toEqual(SPECS);
      expect(result.summary).toContain(file);
    });
  }

  it("still selects the family whose graph reaches a changed fixture", () => {
    const fixture = "src/lib/__fixtures__/deployment-registry-config.fixture.ts";
    const { families } = familiesOf(REPO_WITH_SERVER_MAP_AND_FIXTURE);
    expect(families.get(ALPHA).has(fixture)).toBe(true);
    const result = select([fixture], REPO_WITH_SERVER_MAP_AND_FIXTURE);
    expect(result.mode).toBe("subset");
    expect(result.specs).toEqual([ALPHA]);
  });

  it("still selects its own family for a changed spec file of the design suite", () => {
    const result = select(["tests/e2e/design/beta.spec.ts"]);
    expect(result.mode).toBe("subset");
    expect(result.specs).toEqual(["tests/e2e/design/beta.spec.ts"]);
  });

  it("still selects the family below a changed fixture inside the design suite", () => {
    const result = select(["tests/e2e/design/conformance/__fixtures__/seed.json"]);
    expect(result.mode).toBe("subset");
    expect(result.specs).toEqual([GAMMA]);
  });
});

describe("the generated server map reads as drawing nothing; the client map does not", () => {
  it("selects no design family for a change of only the generated server map", () => {
    const result = select([SERVER_MAP]);
    expect(result.mode).toBe("none");
    expect(result.summary).toContain("generated-server-map 1");
  });

  it("selects no design family for the server map although a family's fixture page imports it", () => {
    const { families } = familiesOf(REPO_WITH_SERVER_MAP_AND_FIXTURE);
    expect(families.get(ALPHA).has(SERVER_MAP)).toBe(true);
    const result = select([SERVER_MAP], REPO_WITH_SERVER_MAP_AND_FIXTURE);
    expect(result.mode).toBe("none");
    expect(result.specs).toEqual([]);
  });

  it("runs every family for a change of the generated client map", () => {
    const result = select([CLIENT_MAP]);
    expect(result.mode).toBe("all");
    expect(result.specs).toEqual(SPECS);
    expect(result.summary).toContain(CLIENT_MAP);
  });

  it("runs every family for another generated file", () => {
    const result = select(["src/lib/generated/artifact-renderers.ts"]);
    expect(result.mode).toBe("all");
    expect(result.specs).toEqual(SPECS);
  });
});

// ---------------------------------------------------------------------------
// The extension locks, over REAL git repositories in a temporary directory.

const DEV_LOCK = "cinatra-dev-extensions.lock.json";
const REQUIRED_LOCK = "cinatra-required-extensions.lock.json";
const DEV_PACK = { packageName: "@cinatra-ai/web-research-agent", repo: "cinatra-ai/web-research-agent" };
const REQUIRED_PACK = {
  packageName: "@cinatra-ai/anthropic-connector",
  repo: "cinatra-ai/anthropic-connector",
};
const OTHER_PACK = { packageName: "@cinatra-ai/blog-connector", repo: "cinatra-ai/blog-connector" };
// An unmoved pin whose repo is not a plain owner/name: the gate refuses the lock.
const NOT_PLAIN_PACK = { ...OTHER_PACK, repo: "cinatra-ai/packs/blog-connector" };

// The fixture's git sees nothing of the machine it runs on (as in
// design-select-range.test.mjs).
const FIXTURE_ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
const IDENTITY = ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid"];

function repository(dir) {
  mkdirSync(dir, { recursive: true });
  const calls = [];
  const git = (args) => {
    calls.push(args.join(" "));
    return execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: FIXTURE_ENV,
      stdio: ["ignore", "pipe", "pipe"],
    });
  };
  const write = (rel, body) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  };
  const commit = (message) => {
    git(["add", "-A"]);
    git([...IDENTITY, "commit", "-q", "--allow-empty", "-m", message]);
    return git(["rev-parse", "HEAD"]).trim();
  };
  git(["init", "-q", "-b", "main"]);
  return { dir, git, write, commit, calls };
}

/** A pack repository at extensions/<scope>/<name> of the application. */
function buildPack(appDir, packageName) {
  const [scope, name] = packageName.slice(1).split("/");
  const pack = repository(join(appDir, "extensions", scope, name));
  pack.write("package.json", `${JSON.stringify({ name: packageName })}\n`);
  pack.write("src/index.ts", "export {};\n");
  pack.write("src/components/result-card.tsx", "export const ResultCard = () => null;\n");
  const start = pack.commit("the pack at its first pin");

  pack.write("src/__tests__/client.test.ts", "export {};\n");
  pack.write("scripts/build.mjs", "export {};\n");
  pack.write("src/lib/client.ts", "export const client = 1;\n");
  const quiet = pack.commit("a test, a build script and source outside every drawn directory");

  pack.write("src/components/result-card.tsx", "export const ResultCard = () => 'changed';\n");
  const display = pack.commit("a display file under src/components");

  pack.git(["checkout", "-q", "--detach", quiet]);
  pack.write("src/theme.css", ".card { color: inherit; }\n");
  const style = pack.commit("a stylesheet");

  pack.git(["checkout", "-q", "--detach", quiet]);
  pack.git(["mv", "src/components/result-card.tsx", "src/lib/result-card.ts"]);
  const renamed = pack.commit("a display file renamed out of src/components");

  pack.git(["checkout", "-q", "--detach", quiet]);
  pack.write("src/lib/server.ts", "export const server = 1;\n");
  const quietSide = pack.commit("plain source beside the display change");

  pack.git(["checkout", "-q", "--detach", quiet]);
  return { ...pack, start, quiet, display, style, renamed, quietSide };
}

const pin = (pack, resolvedSha, extra = {}) => ({ ...pack, resolvedSha, ...extra });
const lockDocument = (...packages) =>
  `${JSON.stringify({ note: "fixture lock", schemaVersion: 1, packages }, null, 2)}\n`;

function buildLockFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "design-select-draws-nothing-")));
  const app = repository(join(root, "app"));
  app.write(".gitignore", "extensions/\n");
  app.write("README.md", "an ordinary file\n");
  app.commit("the application");
  const devPack = buildPack(app.dir, DEV_PACK.packageName);
  const requiredPack = buildPack(app.dir, REQUIRED_PACK.packageName);

  /** One lock move: the lock as `before` at the base, as `after` at the head. */
  const move = (lock, before, after) => {
    app.write(lock, before);
    const base = app.commit(`${lock} at the base`);
    app.write(lock, after);
    const head = app.commit(`${lock} at the head`);
    return { lock, range: { base, head } };
  };
  const cases = {
    devQuiet: move(DEV_LOCK, lockDocument(pin(DEV_PACK, devPack.start)), lockDocument(pin(DEV_PACK, devPack.quiet))),
    requiredQuiet: move(
      REQUIRED_LOCK,
      lockDocument(pin(REQUIRED_PACK, requiredPack.start)),
      lockDocument(pin(REQUIRED_PACK, requiredPack.quiet)),
    ),
    movedBack: move(DEV_LOCK, lockDocument(pin(DEV_PACK, devPack.quiet)), lockDocument(pin(DEV_PACK, devPack.start))),
    display: move(DEV_LOCK, lockDocument(pin(DEV_PACK, devPack.start)), lockDocument(pin(DEV_PACK, devPack.display))),
    style: move(DEV_LOCK, lockDocument(pin(DEV_PACK, devPack.start)), lockDocument(pin(DEV_PACK, devPack.style))),
    renamed: move(DEV_LOCK, lockDocument(pin(DEV_PACK, devPack.quiet)), lockDocument(pin(DEV_PACK, devPack.renamed))),
    across: move(DEV_LOCK, lockDocument(pin(DEV_PACK, devPack.display)), lockDocument(pin(DEV_PACK, devPack.style))),
    acrossFromDrawn: move(
      DEV_LOCK,
      lockDocument(pin(DEV_PACK, devPack.display)),
      lockDocument(pin(DEV_PACK, devPack.quietSide)),
    ),
    added: move(
      DEV_LOCK,
      lockDocument(pin(DEV_PACK, devPack.start)),
      lockDocument(pin(DEV_PACK, devPack.quiet), pin(OTHER_PACK, devPack.quiet)),
    ),
    removed: move(
      DEV_LOCK,
      lockDocument(pin(DEV_PACK, devPack.start), pin(OTHER_PACK, devPack.start)),
      lockDocument(pin(DEV_PACK, devPack.quiet)),
    ),
    changesMore: move(
      REQUIRED_LOCK,
      lockDocument(pin(REQUIRED_PACK, requiredPack.start, { treeSha256: "a".repeat(64) })),
      lockDocument(pin(REQUIRED_PACK, requiredPack.quiet, { treeSha256: "b".repeat(64) })),
    ),
    unknownOwner: move(
      DEV_LOCK,
      lockDocument(pin({ ...DEV_PACK, repo: "example-owner/web-research-agent" }, devPack.start)),
      lockDocument(pin({ ...DEV_PACK, repo: "example-owner/web-research-agent" }, devPack.quiet)),
    ),
    oldPinAbsent: move(
      DEV_LOCK,
      lockDocument(pin(DEV_PACK, "e".repeat(40))),
      lockDocument(pin(DEV_PACK, devPack.quiet)),
    ),
    checkoutAbsent: move(
      DEV_LOCK,
      lockDocument(pin(OTHER_PACK, devPack.start)),
      lockDocument(pin(OTHER_PACK, devPack.quiet)),
    ),
    notPlainRepo: move(
      DEV_LOCK,
      lockDocument(pin(DEV_PACK, devPack.start), pin(NOT_PLAIN_PACK, devPack.start)),
      lockDocument(pin(DEV_PACK, devPack.quiet), pin(NOT_PLAIN_PACK, devPack.start)),
    ),
    unreadableAtBase: move(DEV_LOCK, "{ not json\n", lockDocument(pin(DEV_PACK, devPack.quiet))),
  };
  return { root, app, devPack, cases };
}

const lockFixture = buildLockFixture();
afterAll(() => rmSync(lockFixture.root, { recursive: true, force: true }));

/** The real lock evidence, handed to the real selection the way `main` hands it. */
const judgeLock = ({ lock, range }) =>
  select([lock], REPO, {
    lockReading: (path) => selector.lockEvidence({ lock: path, range, git: lockFixture.app.git }),
  });

describe("an extension lock whose moved pins cross only pack files that draw nothing selects no design family", () => {
  it("selects no design family for a moved pin of the dev lock across a test, a script and plain source", () => {
    const result = judgeLock(lockFixture.cases.devQuiet);
    expect(result.mode).toBe("none");
    expect(result.summary).toContain("extension-lock 1");
  });

  it("selects no design family for a moved pin of the required lock across the same files", () => {
    const result = judgeLock(lockFixture.cases.requiredQuiet);
    expect(result.mode).toBe("none");
  });

  it("selects no design family for a pin moved back across files that draw nothing", () => {
    const result = judgeLock(lockFixture.cases.movedBack);
    expect(result.mode).toBe("none");
  });

  it("reads the lock at the two ends of the range the diff resolution computes", () => {
    const { app, cases } = lockFixture;
    const diff = resolveChangedFiles({
      env: { GITHUB_EVENT_NAME: "pull_request", DESIGN_SELECT_DIFF_BASE: cases.devQuiet.range.base },
      git: app.git,
    });
    expect(diff.mode).toBe("diff");
    expect(diff.mergeBase).toBe(cases.devQuiet.range.base);
    expect(diff.head).toBe("HEAD");
  });

  it("names the approval gate's reason for every lock it does not read as drawing nothing", () => {
    const { app, cases } = lockFixture;
    const reason = (name) =>
      selector.lockEvidence({ lock: cases[name].lock, range: cases[name].range, git: app.git });
    expect(reason("devQuiet")).toBe(null);
    expect(reason("requiredQuiet")).toBe(null);
    expect(reason("display")).toMatch(/src\/components\/result-card\.tsx, which the pack rule reads as drawn/);
    expect(reason("style")).toMatch(/src\/theme\.css, which the pack rule reads as drawn/);
    expect(reason("renamed")).toMatch(/src\/components\/result-card\.tsx, which the pack rule reads as drawn/);
    expect(reason("across")).toMatch(/which the pack rule reads as drawn/);
    expect(reason("acrossFromDrawn")).toMatch(/src\/components\/result-card\.tsx, which the pack rule reads as drawn/);
    expect(reason("notPlainRepo")).toMatch(/cannot be read at the base \(a package names no plain repo/);
    expect(reason("added")).toMatch(/adds the pin of cinatra-ai\/blog-connector/);
    expect(reason("removed")).toMatch(/removes the pin of cinatra-ai\/blog-connector/);
    expect(reason("changesMore")).toBe("the lock changes more than the commits it pins");
    expect(reason("unknownOwner")).toMatch(/example-owner\/web-research-agent is an unknown pack/);
    expect(reason("oldPinAbsent")).toMatch(/is absent from its checkout/);
    expect(reason("checkoutAbsent")).toMatch(/checkout extensions\/cinatra-ai\/blog-connector is absent/);
    expect(reason("unreadableAtBase")).toMatch(/cannot be read at the base/);
    expect(
      selector.lockEvidence({ lock: DEV_LOCK, range: null, git: app.git }),
    ).toMatch(/no range/);
  });

  it("reads the pins with local git alone, never fetching or reading the network", () => {
    const { app, cases } = lockFixture;
    app.calls.length = 0;
    for (const name of Object.keys(cases)) {
      selector.lockEvidence({ lock: cases[name].lock, range: cases[name].range, git: app.git });
    }
    expect(app.calls.length).toBeGreaterThan(0);
    expect(app.calls.filter((call) => /\b(fetch|clone|ls-remote|pull|push|remote)\b/.test(call))).toEqual([]);
  });
});

describe("a moved pin that crosses a pack's display file still runs the families", () => {
  for (const name of ["display", "style", "renamed", "across", "acrossFromDrawn"]) {
    it(`runs every family for a moved pin across a drawn pack file (${name})`, () => {
      const result = judgeLock(lockFixture.cases[name]);
      expect(result.mode).toBe("all");
      expect(result.specs).toEqual(SPECS);
    });
  }
});

describe("every doubt about a lock move still runs the families", () => {
  for (const name of [
    "added",
    "removed",
    "changesMore",
    "unknownOwner",
    "oldPinAbsent",
    "checkoutAbsent",
    "notPlainRepo",
    "unreadableAtBase",
  ]) {
    it(`runs every family for a lock move with a doubt (${name})`, () => {
      const result = judgeLock(lockFixture.cases[name]);
      expect(result.mode).toBe("all");
      expect(result.specs).toEqual(SPECS);
    });
  }

  it("runs every family for a lock move judged without a range, as the --changed aid judges it", () => {
    const result = judgeLock({ lock: DEV_LOCK, range: null });
    expect(result.mode).toBe("all");
    expect(result.specs).toEqual(SPECS);
  });

  it("runs every family for a lock with uncommitted changes the range does not show", () => {
    const { app, devPack, cases } = lockFixture;
    app.write(DEV_LOCK, lockDocument(pin(DEV_PACK, devPack.display)));
    try {
      const result = judgeLock(cases.devQuiet);
      expect(result.mode).toBe("all");
      expect(result.specs).toEqual(SPECS);
      expect(result.summary).toMatch(/the lock has uncommitted changes/);
    } finally {
      app.git(["checkout", "-q", "--", DEV_LOCK]);
    }
  });

  it("runs every family for a lock move when no lock reading is handed to the selection", () => {
    const result = select([DEV_LOCK]);
    expect(result.mode).toBe("all");
    expect(result.specs).toEqual(SPECS);
  });
});
