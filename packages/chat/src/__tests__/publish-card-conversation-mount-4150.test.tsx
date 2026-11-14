// @vitest-environment jsdom
// THE PUBLISH CARD'S CONVERSATION MOUNT (cinatra#4150), through the REAL shared column on both of its arms.
//
// The column mounts the card at the `agent_run` dispatch part's own slot, beside the hitl screen and outside the
// inline run card's subtree, keyed by the run alone. These arms prove the mount draws exactly one card when the run
// has an open publish decision, reads through the transport its host declares (the session action on /chat, the
// broker GET on the widget), and draws NOTHING when there is no open decision.

import React from "react";
import { act, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("lucide-react", () => {
  const StubIcon: React.FC = () => null;
  return new Proxy({} as Record<string, React.FC>, {
    get: (_t, prop) => {
      if (prop === "__esModule") return true;
      if (prop === "then") return undefined;
      if (typeof prop === "symbol") return undefined;
      return StubIcon;
    },
    has: () => true,
    ownKeys: () => ["Check", "ChevronDown", "default"],
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true, value: StubIcon }),
  });
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/chat",
  useSearchParams: () => new URLSearchParams(),
}));

const holdStateMock = vi.fn(async () => ({ state: "none" }) as Record<string, unknown>);
vi.mock("../../../agents/src/run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: () => holdStateMock(),
  confirmRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
  skipRunRecommendationAction: vi.fn(async () => ({ ok: true, dispatched: true })),
}));
const hitlScreenStateMock = vi.fn(async () => ({ state: "none" }) as Record<string, unknown>);
// The HITL screen card's own server-only entry, stubbed for the same reason
// (cinatra#2930, lifecycle-b W3): the column mounts that card beside the §V one
// now, and an unstubbed `"use server"` module fails the whole lazy chat chunk.
// The default answer is "no screen", so a suite that is not about this kind sees
// exactly what it saw before the card existed.
vi.mock("../../../agents/src/agent-hitl-screen-actions", () => ({
  getAgentHitlScreenStateAction: () => hitlScreenStateMock(),
}));
// The publish card's own session entry (cinatra#4150); "none" unless its own arm runs.
const publishStateMock = vi.fn(async () => ({ state: "none" }) as Record<string, unknown>);
vi.mock("../../../agents/src/publish-decision-card-actions", () => ({
  getPublishDecisionCardStateAction: () => publishStateMock(),
}));
vi.mock("../../../agents/src/hitl-actions", () => ({
  approveReviewTask: vi.fn(async () => undefined),
  rejectReviewTask: vi.fn(async () => undefined),
}));

vi.mock("../../../agents/src/server-actions", () => ({
  getRunRecommendedSkillsAction: vi.fn(async () => []),
  getSkillsForAgentAction: vi.fn(async () => []),
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({})),
  confirmRunSkillSelectionAction: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../pending-call-actions", () => ({
  listPendingToolConfirmations: async () => ({ rows: [] }),
  decidePendingToolCall: async () => ({ ok: true }),
}));
vi.mock("../undo-actions", () => ({
  recentUndoableChangeSetForRunAction: async () => ({ changeSetId: null }),
}));
vi.mock("@/components/data-safety/undo-toast", () => ({
  undoDeepLink: (id: string) => `/objects?undo=${id}`,
}));
// The inline run card is the AG-UI run panel, whose graph reaches the server
// runtime. The stand-in declares the SAME host the shipped panel declares, so a
// card found inside it is still recognisable as a run-card mount rather than a
// conversation one.
vi.mock("../inline-agent-run-card", () => ({
  InlineAgentRunCard: ({ runId }: { runId: string }) => (
    <div data-lifecycle-card-host="run_card" data-inline-run-card={runId} />
  ),
}));

import {
  HELD_RUN_ID,
  installWidgetServiceStub,
  lifecycleHeldTranscript,
  mountSurface,
  type SurfaceName,
} from "./conversation-column-harness";

if (typeof window !== "undefined" && typeof window.localStorage?.getItem !== "function") {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
}

const CARD = '[data-lifecycle-card="publish_decision"]';
const BROKER = "/api/lifecycle-views/publish-decision";
const PENDING = {
  state: "pending",
  runId: HELD_RUN_ID,
  agentName: "Proof agent",
  rows: [{ label: "Title", value: "Spring launch" }],
  mayDecide: true,
} as Record<string, unknown>;

let stub: ReturnType<typeof installWidgetServiceStub> | null = null;

async function mountArm(surface: SurfaceName, open: boolean) {
  const answer = open ? PENDING : { state: "none" };
  publishStateMock.mockImplementation(async () => answer);
  stub = installWidgetServiceStub({ publishDecision: () => answer });
  const mounted = await mountSurface(surface, { messages: lifecycleHeldTranscript() });
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
  const root = mounted.container.querySelector<HTMLElement>(`[data-parity-surface="${surface}"]`);
  if (!root) throw new Error(`the ${surface} surface did not mount`);
  return root;
}

beforeEach(() => {
  publishStateMock.mockImplementation(async () => ({ state: "none" }));
});

afterEach(() => {
  cleanup();
  stub?.restore();
  stub = null;
  vi.clearAllMocks();
});

describe("the publish card on the conversation hosts (cinatra#4150)", () => {
  it.each([
    ["chat", "chat_thread"],
    ["widget", "site_widget"],
  ] as const)("%s: an open decision draws EXACTLY ONE card at the run's own slot, under %s", async (surface, host) => {
    const root = await mountArm(surface, true);
    const cards = root.querySelectorAll<HTMLElement>(CARD);
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(card.getAttribute("data-lifecycle-card-host")).toBe(host);
    expect(card.getAttribute("data-lifecycle-card-state")).toBe("pending");
    expect(card.getAttribute("data-conformance-id")).toBe("publish-card");
    // The run's own slot, and never inside the inline run card's subtree.
    expect(card.closest(`[data-agent-run-slot="${HELD_RUN_ID}"]`)).not.toBeNull();
    expect(card.closest('[data-lifecycle-card-host="run_card"]')).toBeNull();
    // Both controls are drawn; no host passes a decide door yet, so neither can send.
    for (const action of ["decline-publish -> declined", "approve-publish -> released"]) {
      const control = card.querySelector<HTMLButtonElement>(`[data-action="${action}"]`);
      expect(control, action).not.toBeNull();
      expect(control!.disabled, action).toBe(true);
    }
  });

  it.each(["chat", "widget"] as const)("%s: with NO open decision the mount draws nothing", async (surface) => {
    const root = await mountArm(surface, false);
    expect(root.querySelector(CARD)).toBeNull();
    expect(root.querySelector('[data-conformance-id="publish-card"]')).toBeNull();
    // The turn itself still stands: the mount withholds only its own card.
    expect(root.querySelector(`[data-agent-run-slot="${HELD_RUN_ID}"]`)).not.toBeNull();
  });

  it("/chat reads through the session action and never the broker", async () => {
    await mountArm("chat", true);
    expect(publishStateMock).toHaveBeenCalled();
    expect((stub?.calls ?? []).some((c) => c.url.startsWith(BROKER))).toBe(false);
  });

  it("the widget reads through the broker GET with its own credential, never the session action", async () => {
    await mountArm("widget", true);
    const reads = (stub?.calls ?? []).filter((c) => c.url.startsWith(`${BROKER}?`));
    expect(reads.length).toBeGreaterThan(0);
    expect(reads[0]!.url).toBe(`${BROKER}?runId=${encodeURIComponent(HELD_RUN_ID)}`);
    expect(reads[0]!.init.method).toBe("GET");
    expect(reads[0]!.init.credentials).toBe("omit");
    expect(reads[0]!.init.body).toBeUndefined();
    expect(publishStateMock).not.toHaveBeenCalled();
  });
});
