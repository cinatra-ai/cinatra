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
 *      built on the review address, which is the one place that decides where
 *      the reader lands: a pending gate lands on the run page there.
 * B5 — a pending review's notification deep-links to the run page, never to a
 *      review address (a pin: unchanged by this leg).
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

describe("B4: every review link is built on the review address (cinatra#3693)", () => {
  it("the admin console's gate-volume rows address the run's review route", () => {
    expect(gateReviewHref("run-1", "task-1", "@cinatra-ai/blog-draft-writer-agent")).toBe(
      "/agents/cinatra-ai/blog-draft-writer-agent/run-1/review/task-1",
    );
  });

  it("the run panel's review card links the review route the interrupt carries", () => {
    const source = read("packages/agents/src/execution.ts");
    expect(source).toContain(
      "const reviewSurfaceUrl = `${reviewRunBase}/review/${encodeURIComponent(reviewTaskId)}`;",
    );
  });

  it("the rail's settled and audit rows are built on the run's own review route", () => {
    const screens = read("packages/agents/src/instance-screens.tsx");
    expect(screens).toContain(
      "`${buildAgentInstancePath(agentId, encodeURIComponent(run.id), { scopeBase: scopeBase ?? null })}/review`",
    );
    const rail = read("packages/agents/src/run-step-rail-extra-entry.tsx");
    expect(rail).toContain("${reviewHrefBase}/");
  });
});

describe("B5: a pending review's notification opens the run page (cinatra#3693, pinned)", () => {
  it("resolves the bare run page — never a review address", async () => {
    readAgentRunById.mockResolvedValue({ id: "R1", templateId: "T1" });
    readAgentTemplateById.mockResolvedValue({ id: "T1", packageName: "@cinatra-ai/foo" });
    const href = await resolveAgentRunHref({ runId: "R1" });
    expect(href).toBe("/agents/cinatra-ai/foo/R1");
    expect(href).not.toContain("/review/");
  });

  it("the review-wait notification takes its link from that resolver", () => {
    const source = read("src/lib/agent-run-wait-notifications.ts");
    expect(source).toMatch(/resolveAgentRunHref\(\{ runId/);
    expect(source).not.toMatch(/href:[^\n]*\/review\//);
  });
});
