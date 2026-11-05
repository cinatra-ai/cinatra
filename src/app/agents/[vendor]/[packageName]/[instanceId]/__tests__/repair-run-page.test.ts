/**
 * A REPAIR RUN'S OWN PAGE OPENS (cinatra#3080).
 *
 * The link builders write a repair run's id (`lifecycle-repair-run:` plus its
 * repair's id) into the address as ONE encoded path segment, and the page
 * itself has to read it back. The router hands a dynamic segment to a page
 * STILL PERCENT-ENCODED, and these routes passed it straight into the run
 * lookup: `lifecycle-repair-run%3A…` is no run's id, so the screen refused a
 * run it had. Every ordinary run id is a uuid, which reads back byte-identical —
 * which is why nothing else ever saw it.
 *
 * These cases drive the route the browser drives (the bare run page, its tab
 * title, and the scoped shell's direct-screen road), then read the segment
 * reading WHERE IT IS WRITTEN in each sibling copy, because the recurring
 * defect on this issue has been a fix that landed in one copy and not the rest.
 * Last, every run-page call site that used to encode the id BEFORE the builder
 * is read: the builder encodes now, so a second encoding there would send a
 * repair run's reader to `lifecycle-repair-run%253A…`.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  RESERVED_AGENT_INSTANCE_SEGMENTS,
  readAgentInstanceIdFromSegment,
  buildAgentInstancePath,
} from "@/lib/agent-url";

const REPAIR_RUN_ID = "lifecycle-repair-run:8f1d2a3b-4c5d-6e7f-8091-a2b3c4d5e6f7";
const ORDINARY_RUN_ID = "8f1d2a3b-4c5d-6e7f-8091-a2b3c4d5e6f7";
const REPAIR_RUN_SEGMENT = "lifecycle-repair-run%3A8f1d2a3b-4c5d-6e7f-8091-a2b3c4d5e6f7";
const PACKAGE = "@cinatra-ai/blog-draft-writer-agent";
const AGENT_ID = "cinatra-ai/blog-draft-writer-agent";

const mocks = vi.hoisted(() => ({
  instanceSetup: vi.fn(),
  resolveAgentInstanceMetadata: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("next/navigation", () => ({
  notFound: () => mocks.notFound(),
  redirect: () => undefined,
}));

vi.mock("@/app/plugins-registry", () => ({
  resolveAgentScreensWithA2AFallback: async () => ({
    instanceSetup: (props: { agentId: string; instanceId: string }) => mocks.instanceSetup(props),
  }),
}));

// The tab-title helper the page's metadata asks (cinatra#2934): replaced, so the
// case reads exactly which id the page hands it.
vi.mock("@/lib/agent-instance-tab-title", () => ({
  resolveAgentInstanceMetadata: (params: unknown) => mocks.resolveAgentInstanceMetadata(params),
}));

// The scoped shell reads its scope's name once; a name is not this suite's subject.
vi.mock("@/lib/scope-surface-entity-name", () => ({
  readScopeSurfaceEntityName: async () => null,
}));

afterAll(() => {
  vi.doUnmock("next/navigation");
  vi.doUnmock("@/app/plugins-registry");
  vi.doUnmock("@/lib/agent-instance-tab-title");
  vi.doUnmock("@/lib/scope-surface-entity-name");
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.resetModules();
});

const pageModule = await import("@/app/agents/[vendor]/[packageName]/[instanceId]/page");
const { default: AgentPackageInstancePage, generateMetadata } = pageModule;
const { ScopedAgentsRoute } = await import("@/app/scoped-launch-routes");

function bareParams(segment: string) {
  return Promise.resolve({
    vendor: "cinatra-ai",
    packageName: "blog-draft-writer-agent",
    instanceId: segment,
  });
}

async function open(segment: string) {
  return AgentPackageInstancePage({
    params: bareParams(segment),
    searchParams: Promise.resolve({}),
  } as never);
}

describe("cinatra#3080 — the repair run's page reads its own address", () => {
  beforeEach(() => {
    mocks.instanceSetup.mockReset();
    mocks.instanceSetup.mockResolvedValue(null);
    mocks.resolveAgentInstanceMetadata.mockReset();
    mocks.resolveAgentInstanceMetadata.mockResolvedValue({ title: "Agent run" });
    mocks.notFound.mockClear();
  });

  it("hands the screen the RUN, not the path segment, for the address the product itself builds", async () => {
    // The address the link builders write for this run — the one the browser
    // was on when the page drew 404.
    const path = buildAgentInstancePath(PACKAGE, REPAIR_RUN_ID);
    const segment = path.split("/").pop()!;
    expect(segment).toBe(REPAIR_RUN_SEGMENT);

    await open(segment);

    expect(mocks.instanceSetup).toHaveBeenCalledTimes(1);
    expect(mocks.instanceSetup.mock.calls[0]![0].instanceId).toBe(REPAIR_RUN_ID);
    expect(mocks.notFound).not.toHaveBeenCalled();
  });

  it("leaves every ordinary run's page byte-identical — a uuid reads back as itself", async () => {
    await open(ORDINARY_RUN_ID);
    expect(mocks.instanceSetup.mock.calls[0]![0].instanceId).toBe(ORDINARY_RUN_ID);
  });

  it("passes a malformed segment through rather than raising out of the route — no run has that id, and the screen's own answer is the right one", async () => {
    await open("%E0%A4%A");
    expect(mocks.instanceSetup.mock.calls[0]![0].instanceId).toBe("%E0%A4%A");
  });

  it("names the tab from the RUN as well: the page's metadata hands the tab-title helper the decoded id, which that helper encodes once", async () => {
    await generateMetadata({ params: bareParams(REPAIR_RUN_SEGMENT) } as never);
    expect(mocks.resolveAgentInstanceMetadata).toHaveBeenCalledTimes(1);
    expect(mocks.resolveAgentInstanceMetadata.mock.calls[0]![0]).toMatchObject({
      vendor: "cinatra-ai",
      packageName: "blog-draft-writer-agent",
      instanceId: REPAIR_RUN_ID,
    });

    await generateMetadata({ params: bareParams(ORDINARY_RUN_ID) } as never);
    expect(mocks.resolveAgentInstanceMetadata.mock.calls[1]![0]).toMatchObject({
      instanceId: ORDINARY_RUN_ID,
    });
  });

  it("the scoped shell's direct-screen road hands the screen the RUN too, and an ordinary run's id unchanged", async () => {
    // `<scope-base>/agents/<vendor>/<package>/<segment>` — the catch-all hands
    // the shell the segment as the address carries it, and the shell mounts the
    // registry screen itself, never through a page module.
    const scope = { kind: "team", id: "t1" } as const;
    await ScopedAgentsRoute({
      scope,
      segments: ["cinatra-ai", "blog-draft-writer-agent", REPAIR_RUN_SEGMENT],
    });
    await ScopedAgentsRoute({
      scope,
      segments: ["cinatra-ai", "blog-draft-writer-agent", ORDINARY_RUN_ID],
    });

    expect(mocks.instanceSetup).toHaveBeenCalledTimes(2);
    expect(mocks.instanceSetup.mock.calls[0]![0]).toMatchObject({
      agentId: AGENT_ID,
      instanceId: REPAIR_RUN_ID,
      scopeBase: "/teams/t1",
    });
    expect(mocks.instanceSetup.mock.calls[1]![0].instanceId).toBe(ORDINARY_RUN_ID);
    expect(mocks.notFound).not.toHaveBeenCalled();
  });

  it("reads a segment back to exactly what the link builder wrote, for any id", () => {
    // The launch segment is not on this list: the builder refuses a reserved
    // segment below the vendor/package pair, because it is a route of its own,
    // not an instance id. The refusal is pinned just below.
    for (const id of [REPAIR_RUN_ID, ORDINARY_RUN_ID, "a b", "a/b"]) {
      const segment = buildAgentInstancePath("@cinatra-ai/x", id).split("/").pop()!;
      expect(readAgentInstanceIdFromSegment(segment)).toBe(id);
    }
  });

  it.each(RESERVED_AGENT_INSTANCE_SEGMENTS.map((segment) => [segment]))(
    "refuses %s as an instance id — a reserved segment is a route of its own, never a run",
    (segment) => {
      expect(() => buildAgentInstancePath("@cinatra-ai/x", segment)).toThrow(/reserved segment/);
    },
  );

  // The run page is one of EIGHT routes under `[instanceId]` that read the same
  // segment, each in its body AND in its tab-title metadata. A fix in one and
  // not the rest is precisely the shape this issue keeps taking, so every copy
  // is read where it is written.
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
    // Once in the body, once in `generateMetadata`.
    expect(source.split("readAgentInstanceIdFromSegment(").length - 1).toBeGreaterThanOrEqual(2);
    // …and no destructure binds the raw segment to the name the run lookup is
    // made under: each has to RENAME it, so the id can only come from the reader.
    const destructures = source.split("\n").filter((line) => line.includes("= await params;"));
    expect(destructures.length).toBeGreaterThan(0);
    for (const line of destructures) {
      expect(line).not.toMatch(/\binstanceId\s*[,}]/);
    }
  });
});

/**
 * THE RUN PAGE'S OWN LINKS ENCODE THE ID ONCE (cinatra#3080).
 *
 * `packages/agents/src/instance-screens.tsx` encoded the run id itself before
 * handing it to the host builder. Now that the builder writes the id as one
 * encoded segment, each of those call sites hands it the RAW id, so a repair
 * run's address carries `%3A` once and a uuid's address is byte-identical.
 * Each call site is read where it is written, and the address it now builds is
 * computed from the same builder it calls.
 */
describe("cinatra#3080 — the run page's own links encode a repair run's id once", () => {
  const screens = readFileSync(
    join(process.cwd(), "packages/agents/src/instance-screens.tsx"),
    "utf8",
  );

  it("no call site encodes the id before the builder does", () => {
    expect(screens).not.toMatch(/buildAgentInstancePath\([^,()]+,\s*encodeURIComponent\(/);
  });

  it.each([
    ["the launcher's redirect to the fresh run", "buildAgentInstancePath(agentId, result.runId, {", ""],
    [
      "the review link",
      "`${buildAgentInstancePath(agentId, run.id, { scopeBase: scopeBase ?? null })}/review`",
      "/review",
    ],
    ["the Run button's redirect", "redirectTo={buildAgentInstancePath(agentId, run.id, {", ""],
    ["the data tab's redirect", "buildAgentInstancePath(agentPath, instanceId, {", ""],
    ["the finished run's link", "href={buildAgentInstancePath(agentId, instanceId, {", ""],
  ])("%s hands the builder the raw id, so the address carries it encoded once", (_label, callText, suffix) => {
    expect(screens).toContain(callText);
    const repair = `${buildAgentInstancePath(AGENT_ID, REPAIR_RUN_ID, { scopeBase: "/teams/t1" })}${suffix}`;
    expect(repair).toBe(`/teams/t1/agents/${AGENT_ID}/${REPAIR_RUN_SEGMENT}${suffix}`);
    expect(repair).not.toContain("%25");
    // A uuid's address is the one it has always been.
    expect(`${buildAgentInstancePath(AGENT_ID, ORDINARY_RUN_ID)}${suffix}`).toBe(
      `/agents/${AGENT_ID}/${ORDINARY_RUN_ID}${suffix}`,
    );
  });
});
