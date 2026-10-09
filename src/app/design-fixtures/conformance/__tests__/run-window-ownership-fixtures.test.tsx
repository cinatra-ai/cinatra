// @vitest-environment jsdom
import React, { Suspense, lazy } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor, within } from "@testing-library/react";
// The browser-only lazy boundary still loads the actual conversation view.
vi.mock("next/dynamic", () => ({ default: (load: () => Promise<{ default: React.ComponentType } | React.ComponentType>) => {
  const Loaded = lazy(async () => { const result = await load(); return { default: typeof result === "function" ? result : result.default }; });
  return (props: Record<string, unknown>) => <Suspense fallback={null}><Loaded {...props} /></Suspense>;
} }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }), usePathname: () => "/design-fixtures/conformance", useSearchParams: () => new URLSearchParams() }));
vi.mock("../../../../../packages/agents/src/run-window-actions", () => ({
  loadRunWindowConversation: vi.fn(async () => []),
  sendRunWindowTurn: vi.fn(async () => { throw new Error("Unexpected fixture model turn"); }),
}));
vi.mock("../../../../../packages/agents/src/server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({ connectedApps: [], gmailAliases: [] })),
  getSkillsForAgentAction: vi.fn(async () => []), getRunRecommendedSkillsAction: vi.fn(async () => []),
  getAuditAvailabilityAction: vi.fn(async () => ({ visible: false, promptCount: 0, skillCount: 0 })),
}));
vi.mock("../../../../../packages/agents/src/run-name-actions", () => ({ ensureOrCheckRunNameAction: vi.fn(async () => ({ ok: true, title: "Fixture run" })) }));
vi.mock("../../../../../packages/agents/src/agent-ui-override-registry", () => ({ agentUIOverrideRegistry: { resolve: () => null } }));
vi.mock("../../../../../packages/agents/src/use-runtime-field-renderer-bindings", () => ({ useRuntimeFieldRendererBindings: () => ({ bindings: {}, loading: false }) }));
vi.mock("../../../../../packages/chat/src/pending-call-actions", () => ({ listPendingToolConfirmations: vi.fn(async () => ({ rows: [] })), decidePendingToolCall: vi.fn(async () => { throw new Error("Unexpected decision"); }) }));
vi.mock("../../../../../packages/chat/src/undo-actions", () => ({ recentUndoableChangeSetForRunAction: vi.fn(async () => null) }));
vi.mock("../../../../../packages/agents/src/run-actions", () => ({
  resetAgentRun: vi.fn(async () => { throw new Error("Unexpected reset"); }),
  createAndTriggerRun: vi.fn(async () => { throw new Error("Unexpected launch"); }),
  readRunOutputEvidence: vi.fn(async () => ({ ok: true, outputs: [], hasTranscript: false, hasStepResults: false })),
}));
vi.mock("../../../../../packages/agents/src/hitl-actions", () => ({ approveReviewTask: vi.fn(async () => { throw new Error("Unexpected approve"); }), rejectReviewTask: vi.fn(async () => { throw new Error("Unexpected reject"); }) }));
vi.mock("../../../../../packages/agents/src/a2a-actions", () => ({ getAgentBuilderTask: vi.fn(async () => null) }));
vi.mock("../../../../../packages/agents/src/agent-hitl-screen-actions", () => ({ getAgentHitlScreenStateAction: vi.fn(async () => null) }));
// Unused extension renderer action ports must never be exercised by this
// generic-input fixture; fail fast rather than installing any extension.
vi.mock("../../../../../packages/agents/src/email-outreach-stage-actions", () => new Proxy({}, { get: (_target, name) => name === "then" ? undefined : () => { throw new Error("Unexpected outreach action"); } }));
vi.mock("../../../../../packages/agents/src/list-picker-actions", () => ({ fetchAvailableLists: vi.fn(async () => { throw new Error("Unexpected list read"); }) }));
// External MCP action registration is not part of this static UI fixture.
// Keep the catalog fail-fast guard below for any actual renderer install read.
vi.mock("@/lib/mcp-server-write-actions", () => ({}));
vi.mock("@/lib/generated/extensions.server", () => ({
  get STATIC_EXTENSION_MANIFEST() { throw new Error("Unexpected runtime install catalog read in static ownership fixture"); },
}));
import { RunWindowOwnershipFixture } from "../run-window-ownership-fixtures";
import { OWNERSHIP_INPUT, OWNERSHIP_REVIEW_ANSWER } from "../run-window-ownership-fixture-data";
import { readRunWindowOwnership, assertRunWindowOwnership } from "../../../../../tests/e2e/design/conformance/run-window-ownership";
import { sendRunWindowTurn } from "../../../../../packages/agents/src/run-window-actions";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes("/api/lifecycle-views/resolve") ? OWNERSHIP_REVIEW_ANSWER :
      url.includes("/api/agents/runs/") ? { status: "pending_approval", error: null, messages: [], hitlContext: OWNERSHIP_INPUT, reviewGate: { ref: null, awaiting: false } } : null;
    if (body === null) throw new Error("Unexpected fixture request " + url);
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe("#3487 required static fixtures mount the shipped hosts", () => {
  it.each(["run", "review", "chat"] as const)("%s owns exactly one page input and no card prompt", async (host) => {
    const { container } = render(<RunWindowOwnershipFixture host={host} />);
    const root = container.querySelector<HTMLElement>('[data-run-window-ownership-host="' + host + '"]');
    if (root === null) throw new Error('Missing mounted ownership fixture root');
    await waitFor(() => assertRunWindowOwnership(readRunWindowOwnership(root), host), { timeout: 10000 });
    if (host === "run") {
      expect(root?.querySelector('[data-lifecycle-card="agent_hitl_screen"]')).not.toBeNull();
      await waitFor(() => expect(within(root).getByLabelText(/^Subject\s*\*$/)).toMatchObject({ value: 'Fixture subject' }));
    } else {
      expect(root?.querySelector('[data-lifecycle-card="artifact_review_gate"]')).not.toBeNull();
      expect(root?.querySelector('[data-testid="review-rationale"]')).not.toBeNull();
    }
    expect(sendRunWindowTurn).not.toHaveBeenCalled();
  });
});

function fixtureNodes(node: React.ReactNode): React.ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(fixtureNodes);
  if (!React.isValidElement<{ children?: React.ReactNode }>(node)) return [];
  return [ ...(node.type === RunWindowOwnershipFixture ? [node] : []), ...fixtureNodes(node.props.children) ];
}
describe("the existing conformance route's query seam", () => {
  it.each(["run", "review", "chat"] as const)("the actual page selects the %s ownership mount", async (host) => {
    const { default: page } = await import("../page");
    const result = await page({ searchParams: Promise.resolve({ runWindowHost: host }) });
    const mounts = fixtureNodes(result);
    expect(mounts).toHaveLength(1);
    expect(mounts[0].props).toMatchObject({ host });
  });
  it("keeps the full default route for absent, invalid and multi-value queries", async () => {
    const { default: page } = await import("../page");
    for (const value of [undefined, "unknown", ["run", "review"]]) {
      const result = await page({ searchParams: Promise.resolve({ runWindowHost: value }) });
      expect(fixtureNodes(result)).toHaveLength(0);
      expect(React.isValidElement(result)).toBe(true);
    }
  });
});
