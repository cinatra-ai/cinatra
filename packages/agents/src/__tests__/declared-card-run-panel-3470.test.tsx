// @vitest-environment jsdom
// A DECLARED CARD IN THE CONVERSATION'S RUN CARD (cinatra#3470, app-lifecycle-cards V.1):
// the real run panel draws the declared fields, holds its one Continue until every field
// holds text, and sends the one answer the card staged.
import React from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { ensureDefaultFieldRenderersRegistered, registerFieldRendererBindings } from "../register-default-renderers";

vi.mock("@cinatra-ai/sdk-ui", () => ({
  LoadingSpinner: () => null,
  PromptField: ({ placeholder }: { placeholder?: string }) => <div>{placeholder}</div>,
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("lucide-react", () => {
  const StubIcon = () => null;
  return new Proxy({} as Record<string, () => null>, {
    get: (_t, prop) => (prop === "__esModule" ? true : prop === "then" || typeof prop === "symbol" ? undefined : StubIcon),
    has: () => true,
    ownKeys: () => ["ArrowRight", "Check", "CheckCircle2", "ChevronDown", "Circle", "CircleDot", "ClipboardList", "ExternalLink", "Loader2", "XCircle", "default"],
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true, value: StubIcon }),
  });
});
const gateSend = vi.hoisted(() => ({ approveReviewTask: vi.fn(async (..._args: unknown[]) => ({ ok: true })) }));
vi.mock("../hitl-actions", () => ({
  approveReviewTask: (...args: unknown[]) => gateSend.approveReviewTask(...args),
  rejectReviewTask: vi.fn(async () => undefined),
}));
vi.mock("../a2a-actions", () => ({ getAgentBuilderTask: vi.fn(async () => null) }));
vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({ connectedApps: [], gmailAliases: [], runId: "run-1" })),
  getAuditAvailabilityAction: vi.fn(async () => ({ visible: false, promptCount: 0, skillCount: 0 })),
  getSkillsForAgentAction: vi.fn(async () => []),
  getRuntimeFieldRendererBindingsAction: vi.fn(async () => []),
}));
vi.mock("../agent-ui-override-registry", () => ({ agentUIOverrideRegistry: { resolve: () => null } }));
const stream = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../use-ag-ui-run-stream", () => ({ useAgUiRunStream: () => stream.current }));

const CARD_ID = "@acme/card-fixture-agent:brief";
const SCREEN = {
  layout: "card",
  sections: [
    { type: "note", text: "Check the brief before it is written." },
    { type: "fact", label: "Topic", key: "topic" },
    { type: "field", key: "angle", label: "Angle" },
  ],
  carry: ["topic"],
};

function cardStream() {
  return {
    status: "pending_approval", error: null, presentationHint: null, isLive: true, streamedText: "",
    interruptContext: {
      xRenderer: CARD_ID,
      schema: { type: "object", "x-renderer": CARD_ID, properties: { angle: { type: "string", title: "Angle" } } },
      values: { stepNumber: 1, topic: "Audit trails for agent runs" },
      reviewTaskId: "gate-card-3470",
    },
  };
}

function continueButtons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("button")).filter((b) => /^continu/i.test((b.textContent ?? "").trim()));
}

beforeEach(() => {
  ensureDefaultFieldRenderersRegistered();
  registerFieldRendererBindings([{ id: CARD_ID, kind: "cta", priority: 90, midRunHitl: true, screen: SCREEN }]);
  stream.current = cardStream();
});
afterEach(() => {
  cleanup();
  stream.current = null;
  vi.clearAllMocks();
});
afterAll(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("the run panel draws a declared card and holds its Continue until the field is written", () => {
  it("shows the declared note, fact and field; Continue waits for text and then sends the one staged answer", async () => {
    const { AgenticRunPanel } = await import("../agentic-run-panel");
    render(<AgenticRunPanel runId="run-3470" initialStatus="pending_approval" initialError={null} initialMessages={[]} agUiEnabled={true} />);
    await waitFor(() => expect(document.querySelector("[data-declared-hitl-screen]")).not.toBeNull());
    const screen = document.querySelector("[data-declared-hitl-screen]")!;
    expect(screen.textContent).toContain("Check the brief before it is written.");
    expect(screen.querySelector('[data-conformance-id="hitl-declared-facts"]')?.textContent).toContain("Audit trails for agent runs");
    expect(continueButtons()).toHaveLength(1);
    expect(continueButtons()[0]!.disabled).toBe(true);

    const field = screen.querySelector<HTMLInputElement>("input")!;
    fireEvent.change(field, { target: { value: "   " } });
    await waitFor(() => expect(continueButtons()[0]!.disabled).toBe(true));
    fireEvent.click(continueButtons()[0]!);
    expect(gateSend.approveReviewTask).not.toHaveBeenCalled();

    fireEvent.change(field, { target: { value: "Why runs need a record" } });
    await waitFor(() => expect(continueButtons()[0]!.disabled).toBe(false));
    fireEvent.click(continueButtons()[0]!);
    await waitFor(() => expect(gateSend.approveReviewTask).toHaveBeenCalledTimes(1));
    const [taskId, payload] = gateSend.approveReviewTask.mock.calls[0]! as [string, Record<string, unknown>];
    expect(taskId).toBe("gate-card-3470");
    const answer = { topic: "Audit trails for agent runs", angle: "Why runs need a record" };
    expect(payload).toMatchObject({ ...answer, userResponse: JSON.stringify(answer) });
    const declared = new Set(["topic", "angle", "userResponse", "approved", "approvedAt", "stepNumber"]);
    expect(Object.keys(payload).filter((k) => !declared.has(k))).toEqual([]);
  });
});
