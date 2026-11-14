import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import { AuthzError } from "@/lib/authz";
const seams = vi.hoisted(() => ({ recorded: vi.fn(), run: vi.fn(), template: vi.fn() }));
vi.mock("../started-run-store", () => ({ readStartedRunsFor: seams.recorded }));
vi.mock("../store", () => ({ readAgentRunById: seams.run, readAgentTemplateById: seams.template }));
import { readVisibleStartedRuns } from "../visible-started-runs";
const actor: PrimitiveActorContext = { actorType: "human", source: "ui", userId: "reader" };
const roles = { actorOrganizationId: "org" };
const starter = { id: "curator", orgId: "org" };
const rows = [
  { id: "first", templateId: "tpl1", orgId: "org", startedByRunId: "curator", parentRunId: "unrelated-orchestrator", status: "running", launchScopeAnchor: { v: 1, kind: "team", id: "team1" } },
  { id: "failed", templateId: "tpl2", orgId: "org", startedByRunId: "curator", parentRunId: null, status: "failed", launchScopeAnchor: { v: 1, kind: "project", id: "project2" } },
];
beforeEach(() => {
  vi.resetAllMocks(); seams.recorded.mockResolvedValue(rows);
  seams.run.mockImplementation(async id => rows.find(r => r.id === id) ?? null);
  seams.template.mockImplementation(async id => ({ id, name: id === "tpl1" ? "First agent" : "Second agent", packageName: id === "tpl1" ? "@example/first" : "@example/second" }));
});
describe("the recorded children each keep their own authorized run page", () => {
  it("reads only this starter/org, independently authorizes each child and preserves exact order/name/state/ownscope", async () => {
    expect(await readVisibleStartedRuns(starter, actor, roles)).toEqual([
      { id: "first", agentDisplayName: "First agent", status: "running", href: "/teams/team1/agents/example/first/first" },
      { id: "failed", agentDisplayName: "Second agent", status: "failed", href: "/projects/project2/agents/example/second/failed" },
    ]);
    expect(seams.recorded).toHaveBeenCalledExactlyOnceWith(starter);
    expect(seams.run.mock.calls).toEqual([["first", actor, roles], ["failed", actor, roles]]);
  });
  it.each([403, 404] as const)("does not leak a child denied by its own policy (%s)", async statusCode => {
    seams.run.mockImplementation(async id => {
      if (id === "failed") throw new AuthzError({ statusCode, reason: "hidden", message: "not visible" });
      return rows[0];
    });
    expect((await readVisibleStartedRuns(starter, actor, roles)).map(r => r.id)).toEqual(["first"]);
    expect(seams.template).toHaveBeenCalledTimes(1);
  });
  it("rechecks exact linkage and org if a row changed after the raw read", async () => {
    seams.run.mockImplementation(async id => id === "first" ? { ...rows[0], startedByRunId: "another" } : { ...rows[1], orgId: "other-org" });
    expect(await readVisibleStartedRuns(starter, actor, roles)).toEqual([]);
    expect(seams.template).not.toHaveBeenCalled();
  });
  it("draws no list for an empty record, and does not manufacture a missing template's name", async () => {
    seams.recorded.mockResolvedValue([]);
    expect(await readVisibleStartedRuns(starter, actor, roles)).toEqual([]);
    seams.recorded.mockResolvedValue(rows);seams.template.mockResolvedValue(null);
    expect(await readVisibleStartedRuns(starter, actor, roles)).toEqual([]);
  });
  it("does not turn operational failure into a falsely empty list", async () => {
    seams.run.mockRejectedValue(new Error("read failed"));
    await expect(readVisibleStartedRuns(starter, actor, roles)).rejects.toThrow("read failed");
  });
});
