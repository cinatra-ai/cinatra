// cinatra#1392 Gap 2 — the LIVE injection: the A2A mount wires the tested
// edge-bound serving binding (`a2a-edge-bound-serving.ts`) into
// `MultiAgentExecutor` as `resolveEdgeBoundServing` (deferred from #1403 behind
// the route-graph ratchet; the growth is carried by annotated absorb records).
// Mocks mirror a2a-mount-generation.test.ts (that suite owns the cache
// semantics; this one owns the injection).

import { describe, it, expect, vi, beforeEach } from "vitest";

const captured = vi.hoisted(() => ({
  executorOpts: [] as Array<Record<string, unknown>>,
  resolveEdgeBoundServingDecision: vi.fn(async () => ({ kind: "none" as const })),
}));

vi.mock("@cinatra-ai/a2a", () => ({
  buildAgentCard: vi.fn(() => ({ name: "card" })),
  MultiAgentExecutor: class {
    constructor(opts: Record<string, unknown>) {
      captured.executorOpts.push(opts);
    }
  },
  createA2ATaskStoreWithDbFallback: (inner: unknown) => inner,
  CinatraResubscribeHandler: class {},
  InMemoryTaskStore: class {},
  JsonRpcTransportHandler: class {
    handle = vi.fn();
  },
}));

vi.mock("@cinatra-ai/agents", () => ({
  readPublishedAgentTemplates: vi.fn(async () => []),
  isAgentPubliclyDiscoverable: () => true,
  readAgentTemplateVersions: vi.fn(async () => ({ items: [] })),
}));

vi.mock("@/lib/agent-run-enqueue", () => ({ enqueueAgentRun: vi.fn() }));

vi.mock("@/lib/a2a-manifest-gate", () => ({
  filterTemplatesToLiveManifest: <T,>(t: T[]) => t,
  readLiveAgentPackageNames: vi.fn(async () => new Set<string>()),
}));

vi.mock("@/lib/a2a-edge-bound-serving", () => ({
  resolveEdgeBoundServingDecision: captured.resolveEdgeBoundServingDecision,
}));

import { getA2AMount, refreshA2AMount } from "@/lib/a2a-server";

describe("buildA2AMount — edge-bound serving injection (cinatra#1392 Gap 2)", () => {
  beforeEach(() => {
    refreshA2AMount();
    captured.executorOpts.length = 0;
    captured.resolveEdgeBoundServingDecision.mockClear();
  });

  it("wires resolveEdgeBoundServing into MultiAgentExecutor and delegates to the app binding", async () => {
    await getA2AMount();
    expect(captured.executorOpts).toHaveLength(1);
    const resolve = captured.executorOpts[0].resolveEdgeBoundServing as (input: {
      targetPackageName: string;
    }) => Promise<unknown>;
    expect(typeof resolve).toBe("function");

    const decision = await resolve({ targetPackageName: "@x/target" });
    expect(decision).toEqual({ kind: "none" });
    expect(captured.resolveEdgeBoundServingDecision).toHaveBeenCalledWith({
      targetPackageName: "@x/target",
    });
  });
});
