/**
 * A REPAIR RUN'S OWN PAGE OPENS (cinatra#3080, fix leg 3).
 *
 * The link builders were fixed, then the breadcrumb prefix was fixed, and the
 * page itself still answered "404 — Page not found" for a repair run that was
 * sitting right there in the store. The reason is the other end of the same
 * rope: the router hands a dynamic segment to a page STILL PERCENT-ENCODED, and
 * these routes passed it straight into the run lookup. `lifecycle-repair-run%3A…`
 * is no run's id, so the screen refused a run it had. Every ordinary run id is a
 * uuid, which reads back byte-identical — which is why nothing else ever saw it.
 *
 * These cases drive the route the browser drives, and then read the segment
 * reading WHERE IT IS WRITTEN in each sibling copy, because the recurring defect
 * on this issue has been a fix that landed in one copy and not the rest.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { readAgentInstanceIdFromSegment, buildAgentInstancePath } from "@/lib/agent-url";

const REPAIR_RUN_ID = "lifecycle-repair-run:8f1d2a3b-4c5d-6e7f-8091-a2b3c4d5e6f7";
const ORDINARY_RUN_ID = "8f1d2a3b-4c5d-6e7f-8091-a2b3c4d5e6f7";

const instanceSetup = vi.fn();
const notFound = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});

vi.mock("next/navigation", () => ({
  notFound: () => notFound(),
  redirect: () => undefined,
}));

vi.mock("@/app/plugins-registry", () => ({
  resolveAgentScreensWithA2AFallback: async () => ({
    instanceSetup: (props: { agentId: string; instanceId: string }) => instanceSetup(props),
  }),
}));

const { default: AgentPackageInstancePage } = await import(
  "@/app/agents/[vendor]/[packageName]/[instanceId]/page"
);

async function open(segment: string) {
  return AgentPackageInstancePage({
    params: Promise.resolve({
      vendor: "cinatra-ai",
      packageName: "blog-draft-writer-agent",
      instanceId: segment,
    }),
    searchParams: Promise.resolve({}),
  } as never);
}

describe("cinatra#3080 — the repair run's page reads its own address", () => {
  beforeEach(() => {
    instanceSetup.mockReset();
    instanceSetup.mockResolvedValue(null);
    notFound.mockClear();
  });

  it("hands the screen the RUN, not the path segment, for the address the product itself builds", async () => {
    // The address the link builders write for this run — the one the browser
    // was on when the page drew 404.
    const path = buildAgentInstancePath("@cinatra-ai/blog-draft-writer-agent", REPAIR_RUN_ID);
    const segment = path.split("/").pop()!;
    expect(segment).toBe("lifecycle-repair-run%3A8f1d2a3b-4c5d-6e7f-8091-a2b3c4d5e6f7");

    await open(segment);

    expect(instanceSetup).toHaveBeenCalledTimes(1);
    expect(instanceSetup.mock.calls[0]![0].instanceId).toBe(REPAIR_RUN_ID);
    expect(notFound).not.toHaveBeenCalled();
  });

  it("leaves every ordinary run's page byte-identical — a uuid reads back as itself", async () => {
    await open(ORDINARY_RUN_ID);
    expect(instanceSetup.mock.calls[0]![0].instanceId).toBe(ORDINARY_RUN_ID);
  });

  it("passes a malformed segment through rather than raising out of the route — no run has that id, and the screen's own answer is the right one", async () => {
    await open("%E0%A4%A");
    expect(instanceSetup.mock.calls[0]![0].instanceId).toBe("%E0%A4%A");
  });

  it("reads a segment back to exactly what the link builder wrote, for any id", () => {
    for (const id of [REPAIR_RUN_ID, ORDINARY_RUN_ID, "new", "a b", "a/b"]) {
      const segment = buildAgentInstancePath("@cinatra-ai/x", id).split("/").pop()!;
      expect(readAgentInstanceIdFromSegment(segment)).toBe(id);
    }
  });

  // The run page is one of EIGHT routes under `[instanceId]` that read the same
  // segment. A fix in one and not the rest is precisely the shape this issue
  // keeps taking, so every copy is read where it is written.
  it.each([
    ["the run page", "page.tsx"],
    ["the data tab", "data/page.tsx"],
    ["the optimization tab", "optimization/page.tsx"],
    ["the permissions tab", "permissions/page.tsx"],
    ["the results tab", "results/page.tsx"],
    ["the skills tab", "skills/page.tsx"],
    ["the trigger tab", "trigger/page.tsx"],
    ["the review surface", "review/[reviewTaskId]/page.tsx"],
  ])("%s reads its instance-id segment back through the one reader", (_label, file) => {
    const source = readFileSync(
      join(process.cwd(), "src/app/agents/[vendor]/[packageName]/[instanceId]", file),
      "utf8",
    );
    expect(source).toContain("readAgentInstanceIdFromSegment");
    // …and never binds the raw segment to the name the run lookup is made
    // under: the destructure has to RENAME it, so the id can only come from
    // the reader above.
    const destructure = source
      .split("\n")
      .find((line) => line.includes("= await params;"))!;
    expect(destructure).toBeDefined();
    expect(destructure).not.toMatch(/\binstanceId\s*[,}]/);
  });
});
