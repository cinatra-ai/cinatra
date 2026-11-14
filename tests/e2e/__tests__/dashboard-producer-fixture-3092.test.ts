/**
 * cinatra#3092 (Road P, P2) — the staging and seeding helper of the dashboard
 * producer fixture (tests/e2e/agents-run/dashboard-producer-fixture.ts).
 *
 * Staging copies the committed fixture tree byte for byte into an extension
 * tree, under `<vendor>/<slug>` (the WayFlow mount path), and is idempotent.
 * Seeding creates one run of the fixture's package whose input is the title,
 * through seed.ts's `seedAgentRun` (replaced here).
 */
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { seedAgentRun } = vi.hoisted(() => ({
  seedAgentRun: vi.fn(async () => "run-1"),
}));

// The run row and the job are seed.ts's road; it is replaced, so no database
// or queue is involved.
vi.mock("../agents-run/seed", () => ({ seedAgentRun }));

import {
  DASHBOARD_PRODUCER_FIXTURE,
  seedDashboardProducerRun,
  stageDashboardProducerFixture,
} from "../agents-run/dashboard-producer-fixture";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SOURCE = path.join(
  REPO_ROOT,
  DASHBOARD_PRODUCER_FIXTURE.fixtureRoot,
  DASHBOARD_PRODUCER_FIXTURE.vendor,
  DASHBOARD_PRODUCER_FIXTURE.slug,
);

let extensionsRoot = "";

beforeEach(async () => {
  seedAgentRun.mockClear();
  extensionsRoot = await mkdtemp(path.join(tmpdir(), "dashboard-producer-fixture-"));
});

afterEach(async () => {
  await rm(extensionsRoot, { recursive: true, force: true });
});

describe("dashboard producer fixture staging (cinatra#3092)", () => {
  it("names the committed fixture tree and its package", async () => {
    const pkg = JSON.parse(await readFile(path.join(SOURCE, "package.json"), "utf8"));
    expect(pkg.name).toBe(DASHBOARD_PRODUCER_FIXTURE.packageName);
    expect(DASHBOARD_PRODUCER_FIXTURE.agentPath).toBe(
      `/agents/${DASHBOARD_PRODUCER_FIXTURE.vendor}/${DASHBOARD_PRODUCER_FIXTURE.slug}`,
    );
  });

  it("copies the fixture byte for byte under <vendor>/<slug>, and re-stages in place", async () => {
    const target = await stageDashboardProducerFixture(REPO_ROOT, extensionsRoot);
    expect(target).toBe(
      path.join(extensionsRoot, DASHBOARD_PRODUCER_FIXTURE.vendor, DASHBOARD_PRODUCER_FIXTURE.slug),
    );
    for (const rel of ["package.json", ".cinatra-published.json", path.join("cinatra", "oas.json")]) {
      expect(await readFile(path.join(target, rel))).toEqual(await readFile(path.join(SOURCE, rel)));
    }
    await stageDashboardProducerFixture(REPO_ROOT, extensionsRoot);
    expect(await readdir(path.join(extensionsRoot, DASHBOARD_PRODUCER_FIXTURE.vendor))).toEqual([
      DASHBOARD_PRODUCER_FIXTURE.slug,
    ]);
  });
});

describe("dashboard producer run seeding (cinatra#3092)", () => {
  it("seeds one run of the fixture's package with the title as its input", async () => {
    expect(await seedDashboardProducerRun("Run board")).toBe("run-1");
    expect(seedAgentRun).toHaveBeenCalledTimes(1);
    expect(seedAgentRun).toHaveBeenCalledWith(DASHBOARD_PRODUCER_FIXTURE.packageName, {
      title: "Run board",
    });
  });

  it("refuses an empty title and seeds nothing", async () => {
    await expect(seedDashboardProducerRun("  ")).rejects.toThrow(/non-empty title/);
    expect(seedAgentRun).not.toHaveBeenCalled();
  });
});
