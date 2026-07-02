// cinatra#659 — the A2A mount is keyed on the extension control-plane (activation)
// generation so an install / disable / uninstall reflects in the external
// AgentCard WITHOUT a process restart. Before this change `refreshA2AMount()` was
// defined but never called, so the process-cached mount only refreshed on restart.
//
// We mock the heavy `buildA2AMount` dependencies (the @cinatra-ai/a2a transport +
// the agents store reads + the manifest gate) so the build is cheap and counts how
// many times the AgentCard was (re)built. The control-plane generation singleton
// (`extension-activation-generation`) is used UNMOCKED — it is a pure in-process
// counter and is the real invalidation key the cache compares against.

import { describe, it, expect, vi, beforeEach } from "vitest";

const a2a = vi.hoisted(() => ({
  buildAgentCard: vi.fn(() => ({ name: "card" })),
}));

vi.mock("@cinatra-ai/a2a", () => ({
  buildAgentCard: a2a.buildAgentCard,
  MultiAgentExecutor: class {},
  createA2ATaskStoreWithDbFallback: (inner: unknown) => inner,
  CinatraResubscribeHandler: class {},
  InMemoryTaskStore: class {},
  JsonRpcTransportHandler: class {
    handle = vi.fn();
  },
}));

vi.mock("@cinatra-ai/agents", () => ({
  readPublishedAgentTemplates: vi.fn(async () => [
    { id: "t1", packageName: "@x/a", visibility: "public" },
  ]),
  isAgentPubliclyDiscoverable: () => true,
  readAgentTemplateVersions: vi.fn(async () => ({ items: [] })),
}));

vi.mock("@/lib/agent-run-enqueue", () => ({ enqueueAgentRun: vi.fn() }));

vi.mock("@/lib/a2a-manifest-gate", () => ({
  // Identity gate (keep all) — we are testing cache invalidation, not the gate
  // (a2a-manifest-gate.test.ts owns the gate semantics).
  filterTemplatesToLiveManifest: <T,>(t: T[]) => t,
  readLiveAgentPackageNames: vi.fn(async () => new Set(["@x/a"])),
}));

import { getA2AMount, refreshA2AMount } from "@/lib/a2a-server";
import {
  bumpActivationGeneration,
  __resetActivationGenerationForTests,
} from "@/lib/extension-activation-generation";

describe("getA2AMount — control-plane-generation-keyed cache (cinatra#659)", () => {
  beforeEach(() => {
    __resetActivationGenerationForTests();
    refreshA2AMount(); // drop any cache carried across files
    a2a.buildAgentCard.mockClear();
  });

  it("builds once and reuses the cached mount across calls at the same generation", async () => {
    await getA2AMount();
    await getA2AMount();
    await getA2AMount();
    expect(a2a.buildAgentCard).toHaveBeenCalledTimes(1);
  });

  it("REBUILDS after a lifecycle transition bumps the control-plane generation", async () => {
    await getA2AMount();
    expect(a2a.buildAgentCard).toHaveBeenCalledTimes(1);

    // An install/activate (or archive/uninstall teardown) bumps the generation.
    bumpActivationGeneration("activate", "@x/a");
    await getA2AMount();
    expect(a2a.buildAgentCard).toHaveBeenCalledTimes(2);

    // A teardown (archive/uninstall) bumps it again → another rebuild, so the
    // external card reflects the disable without a restart.
    bumpActivationGeneration("teardown", "@x/a");
    await getA2AMount();
    expect(a2a.buildAgentCard).toHaveBeenCalledTimes(3);
  });

  it("refreshA2AMount() forces a rebuild on the next call (explicit clear)", async () => {
    await getA2AMount();
    expect(a2a.buildAgentCard).toHaveBeenCalledTimes(1);
    refreshA2AMount();
    await getA2AMount();
    expect(a2a.buildAgentCard).toHaveBeenCalledTimes(2);
  });
});
