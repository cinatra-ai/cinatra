// The rendering gate in warn mode (cinatra#3871, the slice of cinatra#3036's
// acceptance row 2): every claiming artifact extension resolves a display of
// its own; today's deficit is the floor, and the floor only shrinks.
//
// Every fixture lives in a temporary directory that the suite removes, and
// every package, type and key in it belongs to the owner `@example-org`.
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  discoverArtifactPackNames,
  readDashboardMime,
  readGeneratedRendererEntries,
  readMimeAllowlist,
} from "../artifact-review-floor-gate.mjs";
import {
  FLOOR_BASE_VAR,
  FLOOR_FILE,
  GATE_FILE,
  GATE_MODE,
  checkFloorAgainstBase,
  classifyRendering,
  diffAgainstFloor,
  readClaimingExtensions,
  verdict,
} from "../extension-rendering-gate.mjs";
import {
  NO_PULL_REQUEST_RUN,
  PULL_REQUEST_RUN,
  UNREADABLE_BASE_RUN,
  envWithoutBase,
  makeFloorRepo,
} from "./floor-base-fixture.mjs";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const GATE_SCRIPT = join(import.meta.dirname, "..", "extension-rendering-gate.mjs");
const MAP_FILE = "src/lib/generated/artifact-renderers.ts";

const ALPHA = "@example-org/alpha-artifact";
const BETA = "@example-org/beta-artifact";
const GAMMA = "@example-org/gamma-artifacts";
const DELTA = "@example-org/delta-artifacts";
const EPSILON = "@example-org/epsilon-artifact";
const ZETA = "@example-org/zeta-artifact";

/** The six artifact extensions of the fixture fleet (R1). */
function fleet() {
  return [
    // A self-namespaced claim with no detail display: a finding.
    { dir: "alpha-artifact", manifest: artifactManifest(ALPHA, [{ type: `${ALPHA}:item` }]) },
    // A self-namespaced claim WITH a detail display in the build map.
    { dir: "beta-artifact", manifest: artifactManifest(BETA, [{ type: `${BETA}:item` }]) },
    // A foreign-namespace claim of projection artifact-safe with no display: a finding.
    {
      dir: "gamma-artifacts",
      manifest: artifactManifest(GAMMA, [
        { type: "@example-org/gamma:note", dispositions: { projection: "artifact-safe" } },
      ]),
    },
    // A foreign-namespace claim of projection none only: outside the gate.
    {
      dir: "delta-artifacts",
      manifest: artifactManifest(DELTA, [
        { type: "@example-org/delta:contact", dispositions: { projection: "none" } },
      ]),
    },
    // No objectTypes at all: outside the gate.
    { dir: "epsilon-artifact", manifest: artifactManifest(EPSILON, undefined) },
    // A malformed type id only: outside the gate.
    { dir: "zeta-artifact", manifest: artifactManifest(ZETA, [{ type: "not-a-type-id" }]) },
  ];
}

function artifactManifest(name, objectTypes, accepts = {}) {
  const artifact = objectTypes === undefined ? { accepts } : { objectTypes, accepts };
  return { name, cinatra: { kind: "artifact", artifact } };
}

function mapLine(pkg, slot = "detail", resolution = "required", representations = ["application/json"]) {
  return (
    `  "${pkg}::${slot}": { resolution: "${resolution}", "packageName":"${pkg}","slot":"${slot}",` +
    `"representations":${JSON.stringify(representations)},"propsApiVersion":2, load: () => import("${pkg}/src/renderers/${slot}") },`
  );
}

// The two application sources the content-type rule reads beside the build
// map, in the shapes the floor gate's readers parse.
const ALLOWLIST_FILE = "src/lib/artifacts/artifact-read.ts";
const DASHBOARD_FILE = "src/lib/dashboards/dashboard-artifact-twin-writer.ts";
const FIXTURE_ALLOWLIST = ["text/markdown", "text/plain", "application/pdf", "image/png", "application/x-example"];
const FIXTURE_DASHBOARD_MIME = "application/vnd.example.dashboard+json";

function allowlistSource(mimes) {
  return [
    "// fixture allowlist",
    "const PREVIEW_INLINE_MIME_ALLOWLIST: ReadonlySet<string> = new Set([",
    ...mimes.map((m) => `  "${m}",`),
    "]);",
    "",
  ].join("\n");
}

function buildMap(lines) {
  return [
    "// fixture build map",
    "export const GENERATED_ARTIFACT_RENDERERS: Record<string, GeneratedArtifactRendererEntry> = {",
    ...lines,
    "};",
    "",
  ].join("\n");
}

const DEFAULT_MAP = [mapLine(BETA, "detail", "guardedOptional"), mapLine(DELTA, "preview")];

const floorDoc = (entries) => ({ note: "fixture floor", deficit: entries });
const entry = (pkg, types) => ({ package: pkg, types });
const TODAY = [entry(ALPHA, [`${ALPHA}:item`]), entry(GAMMA, ["@example-org/gamma:note"])];

const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

function write(root, rel, content) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, typeof content === "string" ? content : JSON.stringify(content, null, 2) + "\n");
}

/** A fixture repository: extensions tree, build map, locks and (optionally) a floor. */
function makeTree({ packs = fleet(), map = DEFAULT_MAP, floor = TODAY, lockExtra = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "extension-rendering-gate-"));
  dirs.push(root);
  mkdirSync(join(root, "extensions"), { recursive: true });
  for (const p of packs) write(root, `extensions/example-org/${p.dir}/package.json`, p.manifest);
  write(root, MAP_FILE, buildMap(map));
  write(root, ALLOWLIST_FILE, allowlistSource(FIXTURE_ALLOWLIST));
  write(root, DASHBOARD_FILE, `const DASHBOARD_RESOURCE_MIME = "${FIXTURE_DASHBOARD_MIME}";\n`);
  write(root, "cinatra-required-extensions.lock.json", {
    packages: [...packs.map((p) => ({ packageName: p.manifest.name })), ...lockExtra.map((n) => ({ packageName: n }))],
  });
  if (floor !== null) write(root, FLOOR_FILE, floorDoc(floor));
  return root;
}

const FIXTURE_ENV = { ...envWithoutBase(process.env), ...NO_PULL_REQUEST_RUN };

function runGate(root, extra = [], env = FIXTURE_ENV) {
  return spawnSync(
    process.execPath,
    [GATE_SCRIPT, "--repo-root", root, "--extensions-root", join(root, "extensions"), "--baseline", FLOOR_FILE, ...extra],
    { cwd: root, encoding: "utf8", env },
  );
}

const REPORT_LINE =
  /\[extension-rendering-gate\] \d+ of \d+ claiming extensions draw no display of their own \(warn mode; \d+ artifact extensions scanned\)/;

function classifyFixture(root) {
  return classifyRendering({
    extensions: readClaimingExtensions(join(root, "extensions")),
    generatedEntries: readGeneratedRendererEntries(readFileSync(join(root, MAP_FILE), "utf8")),
    mimeAllowlist: readMimeAllowlist(readFileSync(join(root, ALLOWLIST_FILE), "utf8")),
    dashboardMime: readDashboardMime(readFileSync(join(root, DASHBOARD_FILE), "utf8")),
  });
}

// R1 — checklist 1: a claiming extension with no display of its own is a finding.
describe("extension-rendering-gate — the classifier", () => {
  it("counts a claiming extension with no own detail display, and puts the rest outside by construction", () => {
    const root = makeTree();
    expect(classifyFixture(root)).toEqual({
      deficit: [entry(ALPHA, [`${ALPHA}:item`]), entry(GAMMA, ["@example-org/gamma:note"])],
      ownDisplay: [BETA],
      drawnByContentType: [],
      outside: [
        { package: DELTA, reason: "declares no artifact-writable claim" },
        { package: EPSILON, reason: "declares no objectTypes" },
        { package: ZETA, reason: "declares no artifact-writable claim" },
      ],
    });
  });

  it("reads only artifact extensions and records each writable claim", () => {
    const root = makeTree();
    const read = readClaimingExtensions(join(root, "extensions"));
    expect(read.map((e) => e.package)).toEqual([ALPHA, BETA, DELTA, EPSILON, GAMMA, ZETA]);
    expect(read.find((e) => e.package === GAMMA).writableTypes).toEqual(["@example-org/gamma:note"]);
    expect(read.find((e) => e.package === DELTA).writableTypes).toEqual([]);
  });
});

// R2 — checklist 2: a finding above the floor is reported as a warning and does not fail.
describe("extension-rendering-gate — warn mode", () => {
  it("the gate's mode is warn", () => {
    expect(GATE_MODE).toBe("warn");
  });

  it("a live deficit equal to the floor passes with the report line", () => {
    const res = runGate(makeTree());
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(REPORT_LINE);
    expect(res.stdout).toContain("2 of 3 claiming extensions draw no display of their own (warn mode; 6 artifact extensions scanned)");
    expect(res.stdout).toContain(`outside the gate by construction: ${EPSILON}`);
  });

  it("a live finding above the floor prints one WARN line naming it and passes", () => {
    const res = runGate(makeTree({ floor: [entry(ALPHA, [`${ALPHA}:item`])] }));
    expect(res.status).toBe(0);
    const warns = res.stdout.split("\n").filter((l) => l.includes("WARN"));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain(GAMMA);
  });

  it("in blocking mode every live finding fails", () => {
    const deficit = TODAY;
    const { above, stale } = diffAgainstFloor(deficit, floorDoc([entry(ALPHA, [`${ALPHA}:item`])]));
    const v = verdict({ mode: "blocking", above, stale, deficit });
    expect(v.exitCode).toBe(1);
    expect(v.lines.filter((l) => l.includes("FAIL") && l.includes(ALPHA))).toHaveLength(1);
    expect(v.lines.filter((l) => l.includes("FAIL") && l.includes(GAMMA))).toHaveLength(1);
    const warn = verdict({ mode: "warn", above, stale, deficit });
    expect(warn.exitCode).toBe(0);
  });
});

// R3 — checklist 2 and 3: the floor holds today's deficit and only shrinks.
describe("extension-rendering-gate — a stale floor entry", () => {
  const staleFloor = [...TODAY, entry(BETA, [`${BETA}:item`])];

  it("warn mode: one WARN line naming the stale entry and the writer that removes it, exit 0", () => {
    const res = runGate(makeTree({ floor: staleFloor }));
    expect(res.status).toBe(0);
    const warns = res.stdout.split("\n").filter((l) => l.includes("WARN"));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain(BETA);
    expect(warns[0]).toContain("--write-baseline");
  });

  it("blocking mode: the stale entry fails and names the writer", () => {
    const { above, stale } = diffAgainstFloor(TODAY, floorDoc(staleFloor));
    expect(above).toEqual([]);
    expect(stale.map((e) => e.package)).toEqual([BETA]);
    const v = verdict({ mode: "blocking", above, stale, deficit: [] });
    expect(v.exitCode).toBe(1);
    const line = v.lines.find((l) => l.includes(BETA));
    expect(line).toContain("FAIL");
    expect(line).toContain("--write-baseline");
  });

  it("--write-baseline removes the stale entry and never adds the finding above the floor", () => {
    const root = makeTree({ floor: [entry(ALPHA, [`${ALPHA}:item`]), entry(BETA, [`${BETA}:item`])] });
    const res = runGate(root, ["--write-baseline"]);
    expect(res.status).toBe(0);
    const written = JSON.parse(readFileSync(join(root, FLOOR_FILE), "utf8"));
    expect(written.deficit).toEqual([entry(ALPHA, [`${ALPHA}:item`])]);
    expect(typeof written.note).toBe("string");
  });

  it("--write-baseline with no committed floor writes the live deficit (the introducing write)", () => {
    const root = makeTree({ floor: null });
    const res = runGate(root, ["--write-baseline"]);
    expect(res.status).toBe(0);
    const written = JSON.parse(readFileSync(join(root, FLOOR_FILE), "utf8"));
    expect(written.deficit).toEqual(TODAY);
  });
});

// R4 — checklist 3: the committed floor is compared with the base branch.
describe("extension-rendering-gate — floor compared with the base", () => {
  const fixtures = [];
  afterEach(() => {
    while (fixtures.length) fixtures.pop().cleanup();
  });
  function repo(base, head) {
    const f = makeFloorRepo({ base, head });
    fixtures.push(f);
    return f.root;
  }
  const floorOf = (...pkgs) => floorDoc(pkgs.map((p) => entry(p, [`${p}:item`])));

  it("a head floor with an extension the base floor lacks FAILS, and the growth names it", () => {
    const root = repo({ [FLOOR_FILE]: floorOf(ALPHA) }, { [FLOOR_FILE]: floorOf(ALPHA, BETA) });
    const r = checkFloorAgainstBase({ repoRoot: root, env: PULL_REQUEST_RUN });
    expect(r.ok).toBe(false);
    expect(r.growth).toEqual([BETA]);
  });

  it("a lowered floor is held", () => {
    const root = repo({ [FLOOR_FILE]: floorOf(ALPHA, BETA) }, { [FLOOR_FILE]: floorOf(ALPHA) });
    expect(checkFloorAgainstBase({ repoRoot: root, env: PULL_REQUEST_RUN })).toMatchObject({ ok: true, status: "held" });
  });

  it("a base that cannot be read on a pull request's run FAILS with its reason", () => {
    const root = repo({ [FLOOR_FILE]: floorOf(ALPHA) }, {});
    const r = checkFloorAgainstBase({ repoRoot: root, env: UNREADABLE_BASE_RUN });
    expect(r.ok).toBe(false);
    expect(r.lines[0]).toMatch(/did not resolve/);
  });

  it("no pull request passes with its line", () => {
    const root = repo({ [FLOOR_FILE]: floorOf(ALPHA) }, {});
    const r = checkFloorAgainstBase({ repoRoot: root, env: NO_PULL_REQUEST_RUN });
    expect(r).toMatchObject({ ok: true, status: "no-base" });
    expect(r.lines[0]).toContain(FLOOR_BASE_VAR);
  });

  it("a base that holds neither the floor nor the gate script is the introducing change", () => {
    const root = repo({ "README.md": "fixture\n" }, { [FLOOR_FILE]: floorOf(ALPHA) });
    const r = checkFloorAgainstBase({ repoRoot: root, env: PULL_REQUEST_RUN });
    expect(r).toMatchObject({ ok: true, status: "introducing" });
    expect(r.lines).toHaveLength(1);
  });

  it("a base that holds the gate script but not the floor FAILS closed", () => {
    const root = repo({ [GATE_FILE]: "// fixture gate\n" }, { [FLOOR_FILE]: floorOf(ALPHA) });
    const r = checkFloorAgainstBase({ repoRoot: root, env: PULL_REQUEST_RUN });
    expect(r.ok).toBe(false);
  });

  it("the gate itself runs the guard: an unreadable base fails it with the reason", () => {
    const res = spawnSync(process.execPath, [GATE_SCRIPT], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...envWithoutBase(process.env), ...UNREADABLE_BASE_RUN },
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/cannot be compared with the base: the base "origin\/no-such-base-3832" did not resolve/);
  });
});

// R5 — checklist 4: a tree the gate cannot fully read is a scanner error.
describe("extension-rendering-gate — scanner errors exit 2", () => {
  it("an extensions root with no artifact extension", () => {
    const res = runGate(makeTree({ packs: [] }));
    expect(res.status).toBe(2);
  });

  it("a lock naming an artifact pack the tree lacks", () => {
    const root = makeTree({ lockExtra: ["@example-org/missing-artifact"] });
    const res = runGate(root);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("@example-org/missing-artifact");
    expect(runGate(root, ["--allow-partial-fleet"]).status).toBe(0);
  });

  it("a build map line the reader cannot parse", () => {
    const res = runGate(makeTree({ map: [...DEFAULT_MAP, "  ...spreadOfSomething,"] }));
    expect(res.status).toBe(2);
  });

  it("a build map the gate cannot read", () => {
    const root = makeTree();
    rmSync(join(root, MAP_FILE));
    mkdirSync(join(root, MAP_FILE));
    const res = runGate(root);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("SCANNER ERROR");
  });

  it("an extensions root the gate cannot list", () => {
    const root = makeTree();
    write(root, "not-a-folder", "");
    const res = spawnSync(
      process.execPath,
      [GATE_SCRIPT, "--repo-root", root, "--extensions-root", join(root, "not-a-folder"), "--baseline", FLOOR_FILE],
      { cwd: root, encoding: "utf8", env: FIXTURE_ENV },
    );
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("SCANNER ERROR");
  });

  it("an absent floor file", () => {
    const res = runGate(makeTree({ floor: null }));
    expect(res.status).toBe(2);
  });
});

// R6 — checklist 1 and 5: the test of record, the gate over the real tree.
const REAL_TREE_EMPTY = discoverArtifactPackNames(join(REPO_ROOT, "extensions")).size === 0;

describe("extension-rendering-gate — the real tree (test of record)", () => {
  it.skipIf(REAL_TREE_EMPTY && !process.env.CI)(
    "passes in warn mode and prints the report line",
    () => {
      if (REAL_TREE_EMPTY) {
        throw new Error("the extension tree holds no artifact extension on a CI run; materialize it before the root suite");
      }
      const res = spawnSync(process.execPath, [GATE_SCRIPT], { cwd: REPO_ROOT, encoding: "utf8", env: process.env });
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toMatch(REPORT_LINE);
    },
    120_000,
  );
});

// R7 — checklist 2: an open pull request that gives a floor extension its
// display does not turn red when it meets the gate.
describe("extension-rendering-gate — a pull request that gives an extension its display", () => {
  it("warns about the stale floor entry and passes", () => {
    const root = makeTree({ map: [...DEFAULT_MAP, mapLine(ALPHA, "detail", "required")] });
    const res = runGate(root);
    expect(res.status).toBe(0);
    const warns = res.stdout.split("\n").filter((l) => l.includes("WARN"));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain(ALPHA);
    expect(warns[0]).toContain("--write-baseline");
  });
});

// R8 — cinatra#3092: an extension whose every declared form is drawn by a
// REQUIRED content-type display of the build is drawn, and leaves the deficit.
describe("extension-rendering-gate — a form drawn by a required content-type display", () => {
  const ETA = "@example-org/eta-artifact";
  const MARKDOWN = "@example-org/markdown-artifact";
  const IMAGE = "@example-org/image-artifact";
  const PNG = "@example-org/png-artifact";
  const TEXT = "@example-org/text-artifact";
  const OPTIONAL = "@example-org/optional-artifact";
  const CATCH_ALL = "@example-org/catch-all-artifact";
  const PREVIEW = "@example-org/preview-artifact";

  // The required detail displays of the fixture build, by exact and type-wildcard match.
  const PROVIDERS = [
    mapLine(MARKDOWN, "detail", "required", ["text/markdown"]),
    mapLine(IMAGE, "detail", "required", ["image/*"]),
    mapLine(PNG, "detail", "required", ["image/png"]),
    mapLine(TEXT, "detail", "required", ["text/plain"]),
  ];

  const etaPack = (accepts) => ({ dir: "eta-artifact", manifest: artifactManifest(ETA, [{ type: `${ETA}:item` }], accepts) });
  const classifyEta = (accepts, map = PROVIDERS) => classifyFixture(makeTree({ packs: [etaPack(accepts)], map }));
  const deficitPackages = (result) => result.deficit.map((e) => e.package);
  const drawnPackages = (result) => (result.drawnByContentType ?? []).map((e) => e.package);

  function expectDeficit(result) {
    expect(deficitPackages(result)).toEqual([ETA]);
    expect(result.ownDisplay).toEqual([]);
    expect(drawnPackages(result)).toEqual([]);
  }

  it("(a) every declared form allowlisted and served by a required detail display: drawn, with each form's provider", () => {
    const result = classifyEta({
      file: { mimeTypes: ["text/markdown", "image/png"] },
      connectorRef: { resolvedMimeTypes: ["text/plain"] },
    });
    expect(result.drawnByContentType).toEqual([
      {
        package: ETA,
        forms: [
          { form: "image/png", by: PNG },
          { form: "text/markdown", by: MARKDOWN },
          { form: "text/plain", by: TEXT },
        ],
      },
    ]);
    expect(deficitPackages(result)).toEqual([]);
    expect(result.ownDisplay).toEqual([]);
  });

  it("(b) a declared form no required detail display serves: deficit", () => {
    expectDeficit(classifyEta({ file: { mimeTypes: ["text/markdown", "application/x-example"] } }));
  });

  it("(c) a form served only by a guardedOptional detail display: deficit", () => {
    const map = [...PROVIDERS, mapLine(OPTIONAL, "detail", "guardedOptional", ["application/pdf"])];
    expectDeficit(classifyEta({ file: { mimeTypes: ["application/pdf"] } }, map));
  });

  it("(d) a form matched only by a required catch-all detail display: deficit", () => {
    const map = [...PROVIDERS, mapLine(CATCH_ALL, "detail", "required", ["*/*"])];
    expectDeficit(classifyEta({ file: { mimeTypes: ["application/x-example"] } }, map));
  });

  it("(e) no declared form: deficit", () => {
    expectDeficit(classifyEta({}));
  });

  it("(f) an own detail display wins over the content-type displays", () => {
    const map = [...PROVIDERS, mapLine(ETA, "detail", "guardedOptional", ["text/markdown"])];
    const result = classifyEta({ file: { mimeTypes: ["text/markdown"] } }, map);
    expect(result.ownDisplay).toEqual([ETA]);
    expect(deficitPackages(result)).toEqual([]);
    expect(drawnPackages(result)).toEqual([]);
  });

  it("(g) a form a required type-wildcard display matches but outside the allowlist: deficit", () => {
    expectDeficit(classifyEta({ file: { mimeTypes: ["image/bmp"] } }));
  });

  it("(h) an accepts key the contract does not name: deficit", () => {
    expectDeficit(classifyEta({ file: { mimeTypes: ["text/markdown"] }, exampleForm: { mimeTypes: ["text/plain"] } }));
  });

  it("(h2) a form block not shaped as the contract types it: deficit, never a crash", () => {
    expectDeficit(classifyEta({ file: { mimeTypes: {} } }));
    expectDeficit(classifyEta({ connectorRef: { resolvedMimeTypes: 42 } }));
    expectDeficit(classifyEta({ file: { mimeTypes: "text/markdown" } }));
    expectDeficit(classifyEta({ file: { mimeTypes: ["text/markdown"] }, dashboard: "yes" }));
  });

  it("(i) a form served only by a required preview display: deficit", () => {
    const map = [...PROVIDERS, mapLine(PREVIEW, "preview", "required", ["application/x-example"])];
    expectDeficit(classifyEta({ file: { mimeTypes: ["application/x-example"] } }, map));
  });

  it("(j) the gate warns about the floor entry the rule resolves, prints the drawn line and passes", () => {
    const root = makeTree({
      packs: [...fleet(), etaPack({ file: { mimeTypes: ["text/markdown", "image/png"] } })],
      map: [...DEFAULT_MAP, ...PROVIDERS],
      floor: [...TODAY, entry(ETA, [`${ETA}:item`])],
    });
    const res = runGate(root);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(REPORT_LINE);
    expect(res.stdout).toContain("2 of 4 claiming extensions draw no display of their own (warn mode; 7 artifact extensions scanned)");
    expect(res.stdout).toContain(
      `    drawn by a content-type display: ${ETA} (image/png by ${PNG}, text/markdown by ${MARKDOWN})`,
    );
    const warns = res.stdout.split("\n").filter((l) => l.includes("WARN"));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain(ETA);
    expect(warns[0]).toContain("--write-baseline");
  });

  it("(k) a tree without the allowlist source is a scanner error", () => {
    const root = makeTree();
    rmSync(join(root, ALLOWLIST_FILE));
    const res = runGate(root);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("SCANNER ERROR");
  });
});
