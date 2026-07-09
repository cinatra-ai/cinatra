/**
 * Warm dev-session HMR smoke (cinatra#1093).
 *
 * The HMR-re-evaluation-over-framework-locked-objects class (cinatra#1068:
 * "Cannot redefine property: $$typeof" in the server-reference bridge under
 * Turbopack HMR) is invisible to every other automated surface: vitest and the
 * production-build render-smoke/dashboards suites run fresh, deterministic
 * builds; the fresh-install gate is deliberately fresh-boot-only. The class
 * only manifests in a WARM dev session AFTER a true recompile re-evaluates a
 * module that copies props onto an object React has already locked.
 *
 * This spec makes that executable:
 *   1. WARM  — visit the server-action surfaces (connector setup dispatch
 *      routes, which bind host server actions into `<form action>` via the
 *      setup-action reference bridge, plus /connectors and /agents). Rendering
 *      them registers the server-reference objects React then locks. Assert the
 *      no-500 / no-error-boundary / no-dev-overlay FLOOR (baseline).
 *   2. RECOMPILE — touch the setup-action reference bridge
 *      (src/lib/connector-setup-action-references.server.ts) with a benign,
 *      restored-afterward comment so Turbopack performs a TRUE recompile that
 *      re-evaluates the bridge over the now-locked references.
 *   3. RE-WALK — visit the SAME surfaces again. This is where #1068 500s.
 *      Assert the same floor.
 * The workflow additionally scans the captured dev-server log for the
 * server-reference redefine stack (scripts/ci/hmr-smoke-scan.mjs).
 *
 * REPORT-ONLY rollout: this suite runs in a non-required workflow (nightly +
 * path-filtered PRs). A red here means "a warm-dev HMR regression slipped in",
 * never "main is broken".
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { test, expect } from "@playwright/test";
import type { Page, Response } from "@playwright/test";

// Same CLI-safe, dependency-free catalog module render-smoke imports — the
// source of the connector setup-page route enumeration (no hand-curated list).
import { CONNECTOR_DESCRIPTORS } from "@cinatra-ai/connectors-catalog/descriptors.mjs";

// ---------------------------------------------------------------------------
// Surfaces: the server-action-bearing routes that exercise the setup-action
// reference bridge. Bounded to a small representative set — a warm `pnpm dev`
// compiles each route cold on first hit, so an unbounded walk would exhaust the
// CI runner (the documented reason dashboards run a prod build). The bound is
// enough to register server-reference objects and force the bridge recompile.
// ---------------------------------------------------------------------------

const MAX_CONNECTORS = Number(process.env.HMR_SMOKE_MAX_CONNECTORS ?? 6);

type ConnectorDescriptor = { packageId: string; slug: string; setupSubroute: string };

const CONNECTOR_SETUP_ROUTES = (CONNECTOR_DESCRIPTORS as ConnectorDescriptor[])
  .map((d) => `/connectors/${d.packageId.replace(/^@/, "").split("/")[0]}/${d.slug}/${d.setupSubroute}`)
  .sort()
  .slice(0, Math.max(1, MAX_CONNECTORS));

const SURFACES: string[] = ["/connectors", "/agents", ...CONNECTOR_SETUP_ROUTES];

// The setup-action reference bridge — the exact module the #1068 fix made
// idempotent. Touching it forces Turbopack to re-evaluate the server-reference
// re-copy path, which is where the regression throws. Resolved from the repo
// root (Playwright runs with cwd = REPO_ROOT via the config's webServer.cwd).
const BRIDGE_FILE = resolve(process.cwd(), "src/lib/connector-setup-action-references.server.ts");

// ---------------------------------------------------------------------------
// Floor detection (no-500 / no-error-boundary / no-dev-overlay)
// ---------------------------------------------------------------------------

const ERROR_BOUNDARY_MARKERS = [
  "Application Error",
  "Application error: a client-side exception has occurred",
  "Application error: a server-side exception has occurred",
];

// Next.js dev overlay chrome (the visible face of a warm-dev compile/runtime
// error — exactly what #1068 renders).
const DEV_OVERLAY_MARKERS = ["Unhandled Runtime Error", "Build Error", "Failed to compile"];

async function pageProblem(page: Page): Promise<string | null> {
  const body = (await page.locator("body").innerText().catch(() => "")) ?? "";
  for (const marker of [...ERROR_BOUNDARY_MARKERS, ...DEV_OVERLAY_MARKERS]) {
    if (body.includes(marker)) return marker;
  }
  // The Next dev ERROR overlay renders into a `nextjs-portal` shadow root — but
  // so does the always-present dev-tools indicator, so the element's mere
  // PRESENCE is not an error (checking for it flags every healthy dev page).
  // Read the portal shadow text and flag ONLY when it carries a dev-overlay
  // error heading. The #1068 server-reference throw also returns HTTP 5xx
  // (checkSurface) and prints the redefine stack (hmr-smoke-scan.mjs), so this
  // is the client-visible-overlay leg of a three-way floor, not the sole one.
  const overlayError = await page
    .evaluate((markers: string[]) => {
      for (const host of Array.from(document.querySelectorAll("nextjs-portal"))) {
        const text = (host as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot?.textContent ?? "";
        for (const m of markers) if (text.includes(m)) return m;
      }
      return null;
    }, DEV_OVERLAY_MARKERS)
    .catch(() => null);
  if (overlayError) return `dev-overlay error: "${overlayError}"`;
  return null;
}

/** Visit one surface and assert the floor. Returns a failure string or null. */
async function checkSurface(page: Page, route: string): Promise<string | null> {
  let response: Response | null = null;
  try {
    response = await page.goto(route, { waitUntil: "domcontentloaded" });
  } catch (err) {
    return `${route}: navigation threw (${(err as Error).message})`;
  }
  const status = response?.status() ?? 0;
  if (status >= 500) return `${route}: HTTP ${status}`;
  const problem = await pageProblem(page);
  if (problem) return `${route}: rendered error surface ("${problem}")`;
  return null;
}

async function walk(page: Page, phase: string): Promise<string[]> {
  const failures: string[] = [];
  for (const route of SURFACES) {
    const failure = await checkSurface(page, route);
    if (failure) failures.push(`[${phase}] ${failure}`);
  }
  return failures;
}

// ---------------------------------------------------------------------------

test.describe("warm dev-session HMR smoke", () => {
  test("server-action surfaces survive a true HMR recompile of the reference bridge", async ({ page }) => {
    test.info().annotations.push({
      type: "surfaces",
      description: `${SURFACES.length} server-action surfaces: ${SURFACES.join(", ")}`,
    });

    // 1. WARM — baseline floor + register the server-reference objects.
    const warmFailures = await walk(page, "warm");
    expect(warmFailures, `warm-walk floor failures (baseline broken, independent of HMR):\n${warmFailures.join("\n")}`).toEqual([]);

    // 2. RECOMPILE — benign, restored touch of the bridge module.
    const original = readFileSync(BRIDGE_FILE, "utf8");
    let reWalkFailures: string[] = [];
    try {
      writeFileSync(
        BRIDGE_FILE,
        `${original}\n// cinatra#1093 warm-dev HMR smoke recompile touch ${Date.now()} (auto-restored)\n`,
        "utf8",
      );
      // Let the file-watcher register the change before we drive the recompile.
      await page.waitForTimeout(2_000);
      // Drive the on-demand Turbopack recompile by re-requesting a bridge-bound
      // route; the navigation blocks until the module re-evaluates. A #1068
      // regression throws here (deterministically), not transiently.
      await page.goto(CONNECTOR_SETUP_ROUTES[0], { waitUntil: "domcontentloaded" }).catch(() => undefined);
      await page.waitForTimeout(1_000);

      // 3. RE-WALK — the same surfaces, post-recompile. This is the #1068 leg.
      reWalkFailures = await walk(page, "post-recompile");
    } finally {
      writeFileSync(BRIDGE_FILE, original, "utf8");
    }

    expect(
      reWalkFailures,
      `post-recompile floor failures (the warm-dev HMR regression class, cinatra#1068):\n${reWalkFailures.join("\n")}`,
    ).toEqual([]);
  });
});
