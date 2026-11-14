import { beforeEach, describe, expect, it, vi } from "vitest";

// BullMQ 5.80.1 addStandardJob/handleDuplicatedJob returns an existing custom
// ID without insertion, even for a retained completed job. Model that queue
// contract and exercise the REAL dispatcher; no Redis, worker or DB runs here.
const s = vi.hoisted(() => ({
  run: { id: "run-1", templateId: "template-1", orgId: "org-1", runBy: "user-1", status: "pending_trigger" },
  park: { id: "d4ff58df-7c91-4640-90f3-2cc31cfa19a4", status: "released" } as { id: string; status: string } | null,
  jobs: new Map<string, { runId: string; state: "completed" | "waiting" | "active" }>(),
  newJobs: [] as string[],
  enqueueError: false, authorityError: false,
  enqueue: vi.fn(), advance: vi.fn(), compensate: vi.fn(), clear: vi.fn(),
}));
vi.mock("../store", () => ({
  readAgentRunById: vi.fn(async () => ({ ...s.run })),
  readAgentTemplateById: vi.fn(async () => ({ id: "template-1", name: "Blog writer", packageName: "@vendor/blog", connectorDependencies: { "@vendor/cms": "^1" } })),
  slugifyAgentTemplateName: () => "blog-writer",
  RunTransitionError: class extends Error { code = "stale_from_status"; },
  transitionRunStatus: (...args: unknown[]) => s.compensate(...args),
}));
vi.mock("@/lib/org-write/authority", () => ({
  verifySessionAuthority: vi.fn(async () => {
    if (s.authorityError) throw new Error("membership refused");
    return { member: "user-1", org: "org-1" };
  }),
}));
vi.mock("../recommendation-hold", () => ({
  readRecommendationParkForRun: vi.fn(async () => s.park),
  maybeHoldRunForRecommendation: vi.fn(async () => ({ held: false })),
}));
vi.mock("../lifecycle-coordinator", () => ({
  advanceAgentRun: (...args: unknown[]) => s.advance(...args),
  clearRunLifecycleMoment: (...args: unknown[]) => s.clear(...args),
}));
vi.mock("@/lib/agent-run-enqueue", () => ({
  enqueueDepsForTemplate: (template: { connectorDependencies: unknown }) => ({ connectorDependencies: template.connectorDependencies }),
  enqueueAgentRun: (...args: unknown[]) => s.enqueue(...args),
}));
import { dispatchRunStartForPrincipal } from "../run-dispatch-core";
import { RunTransitionError } from "../store";
const dispatch = (templateSlug = "template-1") => dispatchRunStartForPrincipal(
  { runId: "run-1", templateSlug }, { via: "session", userId: "user-1" },
);
beforeEach(() => {
  vi.clearAllMocks();
  s.run = { id: "run-1", templateId: "template-1", orgId: "org-1", runBy: "user-1", status: "pending_trigger" };
  s.park = { id: "d4ff58df-7c91-4640-90f3-2cc31cfa19a4", status: "released" };
  s.jobs.clear(); s.jobs.set("run-1", { runId: "run-1", state: "completed" });
  s.newJobs = []; s.enqueueError = false; s.authorityError = false;
  s.advance.mockImplementation(async ({ release }: { release: { from: string; to: string } }) => {
    if (s.run.status !== release.from) throw new RunTransitionError({ code: "stale_from_status", runId: "run-1", from: release.from as "pending_input", to: "queued" });
    s.run.status = release.to;
  });
  s.compensate.mockImplementation(async (_id: string, from: string, to: string) => {
    if (s.run.status === from) s.run.status = to;
  });
  s.enqueue.mockImplementation(async ({ runId }: { runId: string }, options: { jobId: string }) => {
    if (s.enqueueError) throw new Error("connector preflight failed");
    if (!s.jobs.has(options.jobId)) {
      s.jobs.set(options.jobId, { runId, state: "waiting" }); s.newJobs.push(options.jobId);
    }
    return { runId, jobId: options.jobId, status: "queued" };
  });
});
const runnable = () => [...s.jobs.values()].filter((job) => job.state !== "completed");
describe("released recommendation continuation survives retained setup completion", () => {
  it.each(["pending_input", "pending_trigger"])("creates a runnable continuation from %s", async (status) => {
    s.run.status = status;
    expect(await dispatch()).toEqual({ ok: true });
    expect(runnable()).toEqual([{ runId: "run-1", state: "waiting" }]);
    expect(s.newJobs).toHaveLength(1);
    expect(s.jobs.get("run-1")).toEqual({ runId: "run-1", state: "completed" });
    expect(s.clear).toHaveBeenCalledTimes(1);
    expect(s.enqueue.mock.calls[0][1].connectorDependencies).toEqual({ "@vendor/cms": "^1" });
    expect(s.newJobs[0]).not.toContain(":");
  });
  it("keeps one active continuation on a retry of the same released hold", async () => {
    await dispatch(); const id = s.newJobs[0]; expect(id).toBeDefined();
    s.jobs.get(id)!.state = "active";
    // A separately supplied waiting-row observation: queue dedup still owns
    // this same hold, even when another caller can win a waiting CAS.
    s.run.status = "pending_trigger";
    await dispatch();
    expect(s.newJobs).toEqual([id]);
    expect(runnable()).toEqual([{ runId: "run-1", state: "active" }]);
  });
  it("keeps no-park callers on their original dedup identity", async () => {
    s.park = null; s.run.status = "pending_input";
    expect(await dispatch()).toEqual({ ok: true });
    expect(s.enqueue.mock.calls[0][1].jobId).toBe("run-1");
    expect(s.newJobs).toEqual([]); expect(s.jobs.size).toBe(1);
  });
  it("does not dispatch past a live park", async () => {
    s.park!.status = "parked"; s.run.status = "pending_input";
    expect(await dispatch()).toEqual({ ok: true });
    expect(s.advance).not.toHaveBeenCalled(); expect(s.enqueue).not.toHaveBeenCalled();
  });
  it.each(["queued", "running"])("does not replay a run already %s", async (status) => {
    s.run.status = status;
    expect(await dispatch()).toEqual({ ok: false, error: "run is not in pending_input state" });
    expect(s.advance).not.toHaveBeenCalled(); expect(s.enqueue).not.toHaveBeenCalled();
  });
  it("preserves ownership refusal", async () => {
    s.run.runBy = "another-user";
    expect(await dispatch()).toEqual({ ok: false, error: "forbidden" });
    expect(s.enqueue).not.toHaveBeenCalled();
  });
  it("preserves template binding", async () => {
    expect(await dispatch("different-template")).toEqual({ ok: false, error: "template mismatch" });
    expect(s.enqueue).not.toHaveBeenCalled();
  });
  it("refuses membership before CAS", async () => {
    s.authorityError = true;
    await expect(dispatch()).rejects.toThrow("membership refused");
    expect(s.advance).not.toHaveBeenCalled(); expect(s.enqueue).not.toHaveBeenCalled();
  });
  it.each(["pending_input", "pending_trigger"])("compensates enqueue failure back to %s", async (status) => {
    s.run.status = status; s.enqueueError = true;
    expect(await dispatch()).toEqual({ ok: false, error: "enqueue failed" });
    expect(s.run.status).toBe(status);
    expect(s.compensate.mock.calls[0].slice(0, 3)).toEqual(["run-1", "queued", status]);
    expect(s.clear).not.toHaveBeenCalled(); expect(s.newJobs).toEqual([]);
  });
});
