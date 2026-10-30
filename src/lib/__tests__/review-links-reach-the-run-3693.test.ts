/**
 * NO REVIEWS LIST, AND EVERY REVIEW LINK REACHES THE REVIEW'S ONE ADDRESS
 * (cinatra#3693).
 *
 * The owner's decision on cinatra#3693: "There is **no dedicated Reviews page**
 * anywhere: reviews are reached through the Notifications page for every
 * scope, so the workspace-wide Reviews tab under `/agents` and the standalone
 * review page go away; a pending review still opens in place on the run page,
 * as the run-page drawing says."
 *
 * B1 — the Agents strip holds All Agents and Executions only, and
 *      `/agents/reviews` has no page.
 * B4 — every review link the product draws (the rail's settled and audit rows,
 *      the run panel's review card, the admin console's gate-volume rows) is
 *      built on the RUN's own address with the gate's rail selection named on
 *      it. There is no `/review/<taskId>` address left to mint (cinatra#3693,
 *      the second fix leg).
 * B5 — a review's notification deep-links to the run page, and names the gate it
 *      is about so the run detail opens on it.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const readAgentRunById = vi.fn();
const readAgentTemplateById = vi.fn();

// The notifications resolver imports the agents store lazily; stubbed so this
// read never reaches a database.
vi.mock("@cinatra-ai/agents", () => ({
  readAgentRunById: (...args: unknown[]) => readAgentRunById(...args),
  readAgentTemplateById: (...args: unknown[]) => readAgentTemplateById(...args),
}));

import { AGENTS_NAV } from "@/lib/agents-nav";
import { gateReviewHref } from "@/components/artifacts/console/gate-volume-panel";
import { resolveAgentRunHref } from "@cinatra-ai/notifications/server";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("B1: the Agents strip lists no reviews, and the Reviews page is gone (cinatra#3693)", () => {
  it("AGENTS_NAV holds All Agents and Executions only", () => {
    expect(AGENTS_NAV.map((item) => [item.value, item.label, item.href])).toEqual([
      ["all", "All Agents", "/agents"],
      ["executions", "Executions", "/agents/executions"],
    ]);
  });

  it("/agents/reviews has no page, and no redirect stands in for one", () => {
    expect(existsSync(path.join(ROOT, "src/app/agents/reviews/page.tsx"))).toBe(false);
    expect(existsSync(path.join(ROOT, "src/app/agents/reviews"))).toBe(false);
  });
});

describe("B4: every review link is the run's address with the gate selected (cinatra#3693)", () => {
  it("the admin console's gate-volume rows address the run, naming the gate", () => {
    expect(gateReviewHref("run-1", "task-1", "@fixture-vendor/blog-draft-writer-agent")).toBe(
      "/agents/fixture-vendor/blog-draft-writer-agent/run-1?step=review%3Atask-1",
    );
  });

  it("the run engine's interrupt carries that same form, and no review sub-path", () => {
    const source = read("packages/agents/src/execution.ts");
    expect(source).toContain(
      "const reviewSurfaceUrl = buildRunStepPathCopy(",
    );
    expect(source).toContain("runReviewGateStepKeyCopy(reviewTaskId),");
    // The sub-path the interrupt used to mint is gone from the mint entirely.
    expect(source).not.toContain("`${reviewRunBase}/review/");
  });

  it("no product road mints a `/review/<taskId>` address any more", () => {
    for (const rel of [
      "packages/agents/src/execution.ts",
      "packages/notifications/src/agent-run-href.ts",
      "src/components/artifacts/console/gate-volume-panel.tsx",
    ]) {
      expect(read(rel), rel).not.toMatch(/\/review\/\$\{/);
    }
  });

  it("the rail's own review base stays, for a rail mounted with no run detail", () => {
    // The rows select in place wherever the run detail's frame is around them.
    // A rail mounted WITHOUT one — a host that composes no run detail — has
    // nothing to select into and keeps the deep link it has always carried, so
    // the base is still built, and still built under the run's own scope.
    const screens = read("packages/agents/src/instance-screens.tsx");
    expect(screens).toContain(
      "`${buildAgentInstancePath(agentId, run.id, { scopeBase: scopeBase ?? null })}/review`",
    );
    const rail = read("packages/agents/src/run-step-rail-extra-entry.tsx");
    expect(rail).toContain("${reviewHrefBase}/");
    // And both rows DO select in place where the frame is there.
    expect(rail).toContain("selection?.select(settledGateKey)");
    expect(rail).toContain("selection?.select(verificationKey)");
  });
});

describe("B5: a review's notification opens the run page on that gate (cinatra#3693)", () => {
  it("resolves the run page, with no gate named, when the job data names none", async () => {
    readAgentRunById.mockResolvedValue({ id: "R1", templateId: "T1" });
    readAgentTemplateById.mockResolvedValue({ id: "T1", packageName: "@fixture-vendor/foo" });
    const href = await resolveAgentRunHref({ runId: "R1" });
    expect(href).toBe("/agents/fixture-vendor/foo/R1");
    expect(href).not.toContain("/review/");
  });

  it("names the gate on the run's address when the job data carries one", async () => {
    readAgentRunById.mockResolvedValue({ id: "R1", templateId: "T1" });
    readAgentTemplateById.mockResolvedValue({ id: "T1", packageName: "@fixture-vendor/foo" });
    const href = await resolveAgentRunHref({ runId: "R1", reviewTaskId: "task-9" });
    expect(href).toBe("/agents/fixture-vendor/foo/R1?step=review%3Atask-9");
    expect(href).not.toContain("/review/");
  });

  it("a blank or non-string gate id is no gate, and keeps the run's own address", async () => {
    readAgentRunById.mockResolvedValue({ id: "R1", templateId: "T1" });
    readAgentTemplateById.mockResolvedValue({ id: "T1", packageName: "@fixture-vendor/foo" });
    for (const reviewTaskId of ["", "   ", 42, null, undefined]) {
      expect(await resolveAgentRunHref({ runId: "R1", reviewTaskId })).toBe(
        "/agents/fixture-vendor/foo/R1",
      );
    }
  });

  it("the gate-open notification hands that resolver the gate it is about", () => {
    const source = read("src/lib/agent-run-wait-notifications.ts");
    expect(source).toMatch(/resolveAgentRunHref\(\{ runId, reviewTaskId \}\)/);
    expect(source).not.toMatch(/href:[^\n]*\/review\//);
  });
});
