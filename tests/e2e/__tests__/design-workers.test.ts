// The design suite's worker rule per family (cinatra#3770), read from the REAL
// Playwright configuration.
//
// The functional-acceptance family runs with several workers inside the design
// job, against its one build; every other family keeps one worker with its
// tests in order, so the pixel comparisons stay serial. Which family gets which
// workers is decided in two places that must agree: the project a family lands
// in (tests/e2e/config/design.config.ts, by testMatch/testIgnore) and that
// project's `workers` and `fullyParallel`. So the families are taken from the
// design suite selector (one family per spec file, the same list the job's
// summary line names), each is matched to its projects with Playwright's own
// file matcher, and the project's numbers are held to the rule in
// tests/e2e/config/design-workers.mjs.
//
// No browser, no server: the configuration is imported as data.

import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { discoverSpecFiles } from "../../../scripts/ci/design-select.mjs";
import {
  FUNCTIONAL_ACCEPTANCE_FAMILY,
  FUNCTIONAL_ACCEPTANCE_WORKERS,
  SERIAL_FAMILY_WORKERS,
  designWorkers,
  workersForFamily,
} from "../config/design-workers.mjs";

// The seed convergence's own suite call is replaced: these tests never reach a
// server, and the real module is the functional-acceptance drivers.
const { ensureSeeded } = vi.hoisted(() => ({ ensureSeeded: vi.fn() }));
vi.mock("../design/conformance/contract", () => ({ ensureSeeded }));

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

type Pattern = string | RegExp | Array<string | RegExp>;
type Project = {
  name?: string;
  testMatch?: Pattern;
  testIgnore?: Pattern;
  fullyParallel?: boolean;
  workers?: number | string;
};
type Config = {
  testMatch?: Pattern;
  testIgnore?: Pattern;
  fullyParallel?: boolean;
  workers?: number | string;
  globalSetup?: string | string[];
  shard?: { current: number; total: number };
  projects: Project[];
};

// Playwright's OWN matcher and default, so a project's reach is decided exactly
// the way `playwright test` decides it (collectFilesForProject: not ignored, and
// matched).
const requireHere = createRequire(import.meta.url);
const requirePlaywright = createRequire(requireHere.resolve("@playwright/test/package.json"));
const { createFileMatcher } = requirePlaywright("playwright/lib/util") as {
  createFileMatcher: (patterns: Pattern) => (file: string) => boolean;
};
const PLAYWRIGHT_DEFAULT_TEST_MATCH = "**/*.@(spec|test).?(c|m)[jt]s?(x)";
const TEST_FILE_EXTENSIONS = new Set([".js", ".ts", ".mjs", ".mts", ".cjs", ".cts", ".jsx", ".tsx"]);

async function loadConfig(): Promise<Config> {
  return (await import("../config/design.config")).default as unknown as Config;
}

function projectsOf(config: Config, family: string): Project[] {
  const file = path.join(REPO_ROOT, family);
  return config.projects.filter((project) => {
    const testMatch = createFileMatcher(project.testMatch ?? config.testMatch ?? PLAYWRIGHT_DEFAULT_TEST_MATCH);
    const testIgnore = createFileMatcher(project.testIgnore ?? config.testIgnore ?? []);
    return !testIgnore(file) && testMatch(file);
  });
}

/** Every file under the suite's test dir a Playwright project could collect. */
function candidateFiles(dir = path.join(REPO_ROOT, "tests/e2e/design")): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") out.push(...candidateFiles(full));
    } else if (TEST_FILE_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(path.relative(REPO_ROOT, full).split(path.sep).join("/"));
    }
  }
  return out;
}

const FAMILIES = discoverSpecFiles();

describe("the worker rule per family, read from the design suite's configuration", () => {
  it("knows the families: the selector's list is exactly what the projects collect", async () => {
    const config = await loadConfig();
    expect(FAMILIES).toContain(FUNCTIONAL_ACCEPTANCE_FAMILY);
    const collected = candidateFiles().filter((file) => projectsOf(config, file).length > 0);
    expect(collected.sort()).toEqual([...FAMILIES].sort());
  });

  it("runs every family in exactly one project, with the workers the rule gives that family", async () => {
    const config = await loadConfig();
    for (const family of FAMILIES) {
      const projects = projectsOf(config, family);
      expect(projects.map((project) => project.name), family).toHaveLength(1);
      const [project] = projects;
      expect(project.workers, `${family} (${project.name})`).toBe(workersForFamily(family));
      expect(project.fullyParallel, `${family} (${project.name})`).toBe(
        family === FUNCTIONAL_ACCEPTANCE_FAMILY,
      );
    }
  });

  it("gives the functional-acceptance family the one constant, several workers, and caps the run at it", async () => {
    const config = await loadConfig();
    const [project] = projectsOf(config, FUNCTIONAL_ACCEPTANCE_FAMILY);
    expect(FUNCTIONAL_ACCEPTANCE_WORKERS).toBeGreaterThan(1);
    expect(project.workers).toBe(FUNCTIONAL_ACCEPTANCE_WORKERS);
    expect(project.fullyParallel).toBe(true);
    // The cap: a serial family borrows one of these workers, so no more browsers
    // than the functional-acceptance number ever run at once.
    expect(config.workers).toBe(FUNCTIONAL_ACCEPTANCE_WORKERS);
    // Serial is the default every other project starts from.
    expect(config.fullyParallel).toBe(false);
    // That project holds that family and nothing else.
    expect(FAMILIES.filter((family) => projectsOf(config, family).includes(project))).toEqual([
      FUNCTIONAL_ACCEPTANCE_FAMILY,
    ]);
  });

  it("splits the functional-acceptance family per surface, and never into a skip-on-failure chain", () => {
    const source = readFileSync(path.join(REPO_ROOT, FUNCTIONAL_ACCEPTANCE_FAMILY), "utf8");
    const modes = [...source.matchAll(/test\.describe\.configure\(\{\s*mode:\s*"(\w+)"\s*\}\)/g)].map(
      (match) => match[1],
    );
    // One declaration, in the per-surface describe: a surface's battery is the
    // unit spread over the workers, and "default" retries each test on its own.
    expect(modes).toEqual(["default"]);
  });
});

describe("the pixel families are serial", () => {
  const pixelFamilies = FAMILIES.filter((family) =>
    readFileSync(path.join(REPO_ROOT, family), "utf8").includes("toHaveScreenshot("),
  );

  it("finds the families that take a pixel comparison", () => {
    // Guard against a vacuous pass: the suite's own picture families.
    expect(pixelFamilies).toContain("tests/e2e/design/design-fixtures.spec.ts");
    expect(pixelFamilies).not.toContain(FUNCTIONAL_ACCEPTANCE_FAMILY);
  });

  it("runs every family that takes a pixel comparison on one worker, its tests in order", async () => {
    const config = await loadConfig();
    for (const family of pixelFamilies) {
      const [project] = projectsOf(config, family);
      expect(project.workers, family).toBe(SERIAL_FAMILY_WORKERS);
      expect(project.fullyParallel, family).toBe(false);
    }
  });

  it("keeps one worker for every family other than functional acceptance", async () => {
    const config = await loadConfig();
    for (const family of FAMILIES.filter((f) => f !== FUNCTIONAL_ACCEPTANCE_FAMILY)) {
      const [project] = projectsOf(config, family);
      expect(project.workers, family).toBe(1);
      expect(project.fullyParallel, family).toBe(false);
    }
  });
});

describe("an opt-in partition keeps one worker for every family", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("derives one worker everywhere from the same rule", () => {
    expect(designWorkers({ partitioned: true })).toEqual({ total: 1, functionalAcceptance: 1, serial: 1 });
    expect(workersForFamily(FUNCTIONAL_ACCEPTANCE_FAMILY, { partitioned: true })).toBe(1);
  });

  it("loads the configuration of a partition with one worker in every project", async () => {
    const partitionEnv = {
      CINATRA_DESIGN_PARTITION: "1/2",
      CINATRA_DESIGN_PARTITION_RUN_ID: "workers-trial",
      CINATRA_DESIGN_HEAD_SHA: "a".repeat(40),
      CINATRA_DESIGN_PARTITION_BASE_PORT: "4150",
      SUPABASE_DB_URL: "postgresql://test:test@localhost:5433/cinatra_design_workers_trial_p1",
      REDIS_URL: "redis://localhost:6380/1",
      CINATRA_DESIGN_ARTIFACT_ROOT: path.join(tmpdir(), "design-workers-partition"),
      // Written by the configuration itself; stubbed first so they are restored.
      CINATRA_CONFORMANCE_RUN_ID: "",
      E2E_DESIGN_PORT: "",
      E2E_DESIGN_BASE_URL: "",
      PORT: "",
    };
    for (const [key, value] of Object.entries(partitionEnv)) vi.stubEnv(key, value);
    vi.resetModules();
    const config = await loadConfig();
    expect(config.shard).toEqual({ current: 1, total: 2 });
    expect(config.workers).toBe(1);
    for (const project of config.projects) expect(project.workers, project.name).toBe(1);
    // The partition proves its server first, then the namespace is converged.
    expect(config.globalSetup).toEqual([
      path.join(REPO_ROOT, "tests/e2e/design/partition-setup.ts"),
      path.join(REPO_ROOT, "tests/e2e/design/seed-setup.ts"),
    ]);
  });
});

describe("the seeded namespace is converged once, before any worker starts", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    ensureSeeded.mockReset();
  });

  it("is the configuration's global setup", async () => {
    const config = await loadConfig();
    expect(config.globalSetup).toEqual([path.join(REPO_ROOT, "tests/e2e/design/seed-setup.ts")]);
  });

  it("converges through the suite's own provisioning call when the capability is armed", async () => {
    vi.stubEnv("CINATRA_CONFORMANCE_SEED_TOKEN", "x".repeat(32));
    ensureSeeded.mockResolvedValue(undefined);
    const { default: seedSetup } = await import("../design/seed-setup");
    await seedSetup();
    expect(ensureSeeded).toHaveBeenCalledTimes(1);
  });

  it("does nothing without the capability", async () => {
    vi.stubEnv("CINATRA_CONFORMANCE_SEED_TOKEN", "");
    const { default: seedSetup } = await import("../design/seed-setup");
    await seedSetup();
    expect(ensureSeeded).not.toHaveBeenCalled();
  });

  it("reports a failed convergence and leaves it to the seeded tests", async () => {
    vi.stubEnv("CINATRA_CONFORMANCE_SEED_TOKEN", "x".repeat(32));
    ensureSeeded.mockRejectedValue(new Error("seed provisioning failed: HTTP 500"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { default: seedSetup } = await import("../design/seed-setup");
      await expect(seedSetup()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/HTTP 500/);
    } finally {
      warn.mockRestore();
    }
  });
});
