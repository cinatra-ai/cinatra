/**
 * Dashboard producer fixture harness (cinatra#3092, Road P).
 *
 * `tests/fixtures/dashboard-producer-agent/` ships a deterministic, NO-LLM
 * agent: StartNode(title) → one passthrough call to `dashboards_create` →
 * EndNode(dashboardId). Its run writes one personal dashboard of the run's
 * owner, as the run, so the dashboard names that run as its producer. It is
 * not a product extension: it is private, never published, and lives only in
 * the harness tree, in the shape of `tests/fixtures/review-gate-agent/`.
 *
 * This module stages and seeds it the same way `./review-gate-fixture.ts`
 * stages and seeds the marked review gate fixture: the tree is copied into
 * `extensions/` (both the host's dev boot scan and the WayFlow runtime read
 * it), and only run CREATION is seeded (a row + the BullMQ job), through
 * `./seed.ts`'s `seedAgentRun`. Everything after run creation is the shipped
 * path.
 */
import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { seedAgentRun } from "./seed";

/** The fixture's coordinates. `vendor/slug` is the on-disk tree AND the WayFlow
 * mount path; `packageName` is the `agent_templates` key the host registers. */
export const DASHBOARD_PRODUCER_FIXTURE = {
  vendor: "cinatra-dashboard-fixture",
  slug: "run-writes-dashboard",
  packageName: "@cinatra-dashboard-fixture/run-writes-dashboard",
  /** The flow input that names the dashboard. */
  titleInput: "title",
  /** Where the committed fixture tree lives, relative to the repo root. */
  fixtureRoot: "tests/fixtures/dashboard-producer-agent",
  /** The A2A mount the WayFlow runtime serves it at. */
  agentPath: "/agents/cinatra-dashboard-fixture/run-writes-dashboard",
} as const;

/**
 * Copy the committed fixture into the extension tree (`extensions/` of the
 * repo root unless `extensionsRoot` names another). `extensions/` is
 * git-ignored, so this is a staging step, never a commit. Idempotent:
 * re-staging overwrites in place. Returns the staged directory.
 */
export async function stageDashboardProducerFixture(
  repoRoot: string,
  extensionsRoot: string = join(repoRoot, "extensions"),
): Promise<string> {
  const source = join(
    repoRoot,
    DASHBOARD_PRODUCER_FIXTURE.fixtureRoot,
    DASHBOARD_PRODUCER_FIXTURE.vendor,
    DASHBOARD_PRODUCER_FIXTURE.slug,
  );
  const vendorDir = join(extensionsRoot, DASHBOARD_PRODUCER_FIXTURE.vendor);
  const target = join(vendorDir, DASHBOARD_PRODUCER_FIXTURE.slug);
  await mkdir(vendorDir, { recursive: true });
  await cp(source, target, { recursive: true, force: true });
  return target;
}

/**
 * Create a queued run of the fixture agent with its `title` input, as the
 * harness's test actor, and enqueue the execution job. Returns the run id. The
 * run then follows the shipped path: dispatch → WayFlow → the passthrough's
 * `dashboards_create` as the run. The fixture must be staged and registered.
 */
export async function seedDashboardProducerRun(title: string): Promise<string> {
  if (title.trim() === "") {
    throw new Error("seedDashboardProducerRun: a non-empty title is required");
  }
  return seedAgentRun(DASHBOARD_PRODUCER_FIXTURE.packageName, {
    [DASHBOARD_PRODUCER_FIXTURE.titleInput]: title,
  });
}
