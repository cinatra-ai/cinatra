// @vitest-environment jsdom
/**
 * THE HELD TURN IN THE PRODUCTION TRANSCRIPT — half (b) of the held-turn gate.
 *
 * WHAT MAKES THIS THE REAL THING. It mounts the column `/chat` mounts, through
 * the shared surface harness, with a real persisted transcript whose assistant
 * turn carries the durable `agent_run` part. The card it measures is the real
 * `RecommendationHoldCard` resolving through its real state action and drawing
 * the real `RunRecommendationChipRow`. Nothing here is hand-written markup
 * standing in for a renderer, because a gate that measures its own fixture
 * cannot observe the mount it exists to require.
 *
 * THE FOUR THINGS IT HOLDS:
 *
 *   1. THE ALWAYS-ON ARM, on production output. If the hold anchors appear at
 *      all, they must appear in the triggering part's OWN container and OUTSIDE
 *      the inline run card's subtree. The run card is a ruled RUN_CARD mount;
 *      counting its render as the chat mount is the mislabeling this slice is
 *      about.
 *
 *   2. THE MOUNT RATCHET, observable. The production view does not mount the
 *      hold card yet, so the OBSERVED unmounted set is measured against
 *      `HELD_TURN_MOUNT_OBLIGATIONS`. When the mount lands, the observation
 *      changes and the row must be struck; strike it early and this fails at
 *      once. That only works because the observation comes from the real view.
 *
 *   3. THE STRUCTURAL INVARIANT, which is the gate proper. A parked dispatch
 *      must project an ACTIONABLE card in the same turn: the real card in the
 *      triggering container with its two decision controls. A Confirm keeps the
 *      URL and settles in the same mount point. The regex ban is defence in
 *      depth beside this, never a substitute for it.
 *
 *   4. THE ROOT-DECLARATION OBLIGATION. The real card does not yet emit
 *      `data-lifecycle-card` / `data-lifecycle-card-host` (the review card
 *      does). That is recorded as a red done-check against the real component,
 *      so adding it forces the row to be struck.
 *
 * LOCAL NOTE: this suite runs under the chat package's own vitest config. CI
 * (Node 24) is authoritative for it.
 */

import React from "react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));

import {
  ANY_LIFECYCLE_MOUNT_PROBES,
  CHAT_THREAD_CARRIAGE_CONTRACT,
  HELD_TURN_MOUNT_OBLIGATIONS,
  HELD_TURN_ROW,
  ROOT_DECLARATION_OBLIGATIONS,
  evaluateHeldTurnProjection,
  projectsOwnerCard,
  type ChatThreadCarriageRow,
  type ProjectedNode,
  type TurnProjection,
} from "@/lib/lifecycle/held-turn-card-contract";

// --- the card's own graph, stubbed exactly as the agents suite stubs it ------

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

const routerPush = vi.fn();
const routerReplace = vi.fn();
const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: routerReplace, refresh: routerRefresh }),
  usePathname: () => "/chat",
  useSearchParams: () => new URLSearchParams(),
}));

type HoldState =
  | { state: "none" }
  | {
      state: "held";
      agentPackageName: string;
      promptText: string;
      recommendations: {
        skillId: string;
        skillRevisionId: string;
        recommended: boolean;
        name?: string;
      }[];
      holdRef: string;
    }
  | { state: "confirmed"; skillNames: string[] }
  | { state: "skipped" };

const holdStateMock = vi.fn(async (): Promise<HoldState> => ({ state: "none" }));
const confirmMock = vi.fn(async () => ({ ok: true, dispatched: true }));
const skipMock = vi.fn(async () => ({ ok: true, dispatched: true }));

vi.mock("../../../agents/src/run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: () => holdStateMock(),
  confirmRunRecommendationAction: () => confirmMock(),
  skipRunRecommendationAction: () => skipMock(),
}));

// `server-actions` is a server-only graph, so it is stubbed rather than loaded.
// It must carry EVERY symbol the lazy chat chunk reaches — the inline run panel
// imports two more — or that chunk fails to evaluate and the transcript never
// mounts at all, which would look like a passing negative arm.
vi.mock("../../../agents/src/server-actions", () => ({
  getRunRecommendedSkillsAction: vi.fn(async () => []),
  getSkillsForAgentAction: vi.fn(async () => []),
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({})),
  confirmRunSkillSelectionAction: vi.fn(async () => ({ ok: true })),
}));

// Some Node builds expose a global `localStorage` that SHADOWS jsdom's and
// throws on use, which the composer's prompt field reads on mount. Repair it
// only when it is actually broken: on a runtime whose jsdom storage works (the
// one CI runs) this is inert, and the suite behaves identically on both.
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

// ---------------------------------------------------------------------------
// The four modules the mounted list reaches that belong to the SERVER or to the
// agent-run substrate. Replaced exactly as the shared inventory suite replaces
// them, and for its stated reason: their graphs reach the server runtime, so
// without these the column does not mount at all. What stays REAL is everything
// this gate measures — the transcript, the ordered-parts containers, the host
// declaration, and the card.
// ---------------------------------------------------------------------------
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
// runtime. It is replaced by a stand-in that declares the SAME host the shipped
// panel declares, so the foreign-host arm is measured against the production
// vocabulary rather than a marker invented for the test.
vi.mock("../inline-agent-run-card", () => ({
  InlineAgentRunCard: ({ runId }: { runId: string }) => (
    <div data-lifecycle-card-host="run_card" data-inline-run-card={runId} />
  ),
}));

import { LifecycleCardSurfaceProvider } from "../../../agents/src/lifecycle-card-runtime";
import { RecommendationHoldCard } from "../../../agents/src/run-recommendation-chip-row";
import { mountSurface } from "./conversation-column-harness";
import type { UiMessage } from "../types";

// ---------------------------------------------------------------------------
// The transcript
// ---------------------------------------------------------------------------

const RUN_ID = "run-held-2821";
const DURABLE_RESULT = JSON.stringify({ runId: RUN_ID, status: "pending_input" });
const DISPATCH_TEXT =
  "Dispatched `@cinatra-ai/proof-agent` (runId: `" + RUN_ID + "`, status: `pending_input`).";

const HELD: HoldState = {
  state: "held",
  agentPackageName: "@cinatra-ai/proof-agent",
  promptText: "{}",
  recommendations: [
    { skillId: "skill-a", skillRevisionId: "rev-a", recommended: true, name: "Skill A" },
  ],
  holdRef: "hold-ref-2821",
};

/**
 * A PERSISTED transcript of a held dispatch turn: the deterministic answer and
 * the durable `agent_run` part the server pinned. This is the shape a reload
 * replays, so the whole suite runs on rebuilt state rather than a live stream.
 */
function heldTranscript(text: string = DISPATCH_TEXT): UiMessage[] {
  return [
    { id: "u1", role: "user", content: "Run the proof agent" },
    {
      id: "a1",
      role: "assistant",
      content: "",
      parts: [
        { kind: "text", content: text },
        {
          kind: "tool_call",
          id: "t1",
          name: "agent_run",
          runId: RUN_ID,
          status: "completed",
          resultLabel: `runId: ${RUN_ID}, status: pending_input`,
        },
      ],
    } as UiMessage,
  ];
}

// ---------------------------------------------------------------------------
// The adapter — production DOM to the contract's projection
// ---------------------------------------------------------------------------

/**
 * The ordered-parts list the production view renders: one child per rendered
 * part. It carries no id of its own, so it is resolved through the text part's
 * stable `data-embed-content` hook and then CHECKED, so a structural change in
 * the view fails loudly here instead of being silently misread.
 */
function orderedPartsList(root: HTMLElement): HTMLElement {
  const text = root.querySelector("[data-embed-content]");
  if (!text?.parentElement) throw new Error("no ordered-parts list in the rendered transcript");
  return text.parentElement;
}

function projectionFromProductionTurn(
  root: HTMLElement,
  wire: { name: string; result: string },
  row: ChatThreadCarriageRow = HELD_TURN_ROW,
): { projection: TurnProjection; triggerContainer: HTMLElement } {
  const list = orderedPartsList(root);
  const slots = Array.from(list.children) as HTMLElement[];
  // The fixture turn has exactly two rendered parts. Asserting it here means a
  // view that starts rendering a third container cannot be misclassified.
  expect(slots.length, "the held turn renders one container per part").toBe(2);

  let triggerContainer: HTMLElement | null = null;
  const parts: Array<TurnProjection["parts"][number]> = slots.map((el, slot) => {
    const isText = el.matches("[data-embed-content]") || el.querySelector("[data-embed-content]");
    if (isText) return { kind: "text" as const, slot, text: el.textContent ?? "" };
    triggerContainer = el;
    return { kind: "tool_result" as const, slot, name: wire.name, result: wire.result };
  });
  if (triggerContainer === null) throw new Error("no agent_run container in the rendered turn");

  const anchorsByEl = new Map<Element, string[]>();
  for (const selector of [...row.ownerAnchors, ...row.ruledRootAnchors]) {
    for (const el of Array.from(list.querySelectorAll(selector))) {
      anchorsByEl.set(el, [...(anchorsByEl.get(el) ?? []), selector]);
    }
  }

  const nodes: ProjectedNode[] = [];
  for (const [el, anchors] of anchorsByEl) {
    const slot = slots.findIndex((s) => s === el || s.contains(el));
    nodes.push({
      anchors,
      slot: slot === -1 ? null : slot,
      insideSubtrees: row.foreignHostSubtrees.filter((s) => el.closest(s) !== null),
    });
  }
  return { projection: { parts, nodes }, triggerContainer };
}

/**
 * Which vocabulary-independent probes match INSIDE the triggering container but
 * OUTSIDE the inline run card's own subtree.
 *
 * The run card is a ruled run_card mount and legitimately declares its host
 * there, so its subtree is excluded; anything else that matches is a lifecycle
 * card in the chat's own slot under a name this contract does not know.
 */
function probeOutsideRunCard(container: HTMLElement): string[] {
  return ANY_LIFECYCLE_MOUNT_PROBES.filter((sel) =>
    Array.from(container.querySelectorAll(sel)).some(
      (el) => !HELD_TURN_ROW.foreignHostSubtrees.some((f) => el.closest(f) !== null),
    ),
  );
}

/** Mount the production `/chat` column on a held transcript. */
async function mountHeldChat(text?: string) {
  const mounted = await mountSurface("chat", { messages: heldTranscript(text) });
  const root = mounted.container.querySelector<HTMLElement>('[data-parity-surface="chat"]');
  if (!root) throw new Error("the chat surface did not mount");
  return { mounted, root };
}

/**
 * Mount the REAL card into the REAL triggering container, under the chat_thread
 * host the column declares. This is the shape the production mount must
 * produce: both halves are real, and the wiring between them is what the mount
 * slice adds.
 */
function mountRealCardInto(container: HTMLElement) {
  return render(
    <LifecycleCardSurfaceProvider host="chat_thread">
      <RecommendationHoldCard
        runId={RUN_ID}
        agentPackageName="@cinatra-ai/proof-agent"
        wireRef="hold-ref-2821"
      />
    </LifecycleCardSurfaceProvider>,
    { container },
  );
}

beforeEach(() => {
  holdStateMock.mockImplementation(async () => ({ state: "none" }));
  routerPush.mockReset();
  routerReplace.mockReset();
  routerRefresh.mockReset();
  confirmMock.mockClear();
  skipMock.mockClear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the PRODUCTION chat transcript, on a held dispatch turn", () => {
  it("renders one container per part, with the agent_run part in its own", async () => {
    const { root } = await mountHeldChat();
    const { projection, triggerContainer } = projectionFromProductionTurn(root, {
      name: "agent_run",
      result: DURABLE_RESULT,
    });
    expect(projection.parts.map((p) => p.kind)).toEqual(["text", "tool_result"]);
    expect(triggerContainer).toBeInstanceOf(HTMLElement);
  });

  it("satisfies the ALWAYS-ON arm — no pointer text, no anchors in a foreign host", async () => {
    const { root } = await mountHeldChat();
    const { projection } = projectionFromProductionTurn(root, {
      name: "agent_run",
      result: DURABLE_RESULT,
    });
    const violations = evaluateHeldTurnProjection(projection, HELD_TURN_ROW);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it("FAILS when the turn answers with the first round's pointer sentence", async () => {
    const { root } = await mountHeldChat(
      "The agent is waiting on you. You can confirm or skip the recommended skills on the run card above.",
    );
    const { projection } = projectionFromProductionTurn(root, {
      name: "agent_run",
      result: DURABLE_RESULT,
    });
    expect(evaluateHeldTurnProjection(projection, HELD_TURN_ROW).map((v) => v.code)).toContain(
      "decision_path_pointer",
    );
  });

  it("does NOT project the held card yet — the observed obligation set is what is declared", async () => {
    const observed: string[] = [];
    for (const row of CHAT_THREAD_CARRIAGE_CONTRACT) {
      if (row.enforcer !== "held-turn-card-contract") continue;
      const { root } = await mountHeldChat();
      const { projection } = projectionFromProductionTurn(
        root,
        { name: "agent_run", result: DURABLE_RESULT },
        row,
      );
      if (!projectsOwnerCard(projection, row)) observed.push(row.kind);
      cleanup();
    }
    expect(
      observed,
      "the PRODUCTION view's unmounted set drifted from HELD_TURN_MOUNT_OBLIGATIONS — " +
        "strike the row when the mount lands, and never before",
    ).toEqual([...HELD_TURN_MOUNT_OBLIGATIONS]);
  });
});

describe("the REAL card in the REAL triggering container", () => {
  it("PASSES the contract — the ruled mount is accepted, not rejected", async () => {
    holdStateMock.mockImplementation(async () => HELD);
    const { root } = await mountHeldChat();
    const first = projectionFromProductionTurn(root, {
      name: "agent_run",
      result: DURABLE_RESULT,
    });

    mountRealCardInto(first.triggerContainer);
    await waitFor(() =>
      expect(root.querySelector('[data-conformance-id="run-chip-row"]')).not.toBeNull(),
    );

    const { projection } = projectionFromProductionTurn(root, {
      name: "agent_run",
      result: DURABLE_RESULT,
    });
    const violations = evaluateHeldTurnProjection(projection, HELD_TURN_ROW, {
      requireMount: true,
    });
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
    expect(projectsOwnerCard(projection)).toBe(true);
  });

  it("FAILS when the same real card renders inside the run card's subtree", async () => {
    holdStateMock.mockImplementation(async () => HELD);
    const { root } = await mountHeldChat();
    const first = projectionFromProductionTurn(root, {
      name: "agent_run",
      result: DURABLE_RESULT,
    });
    // A run-card render, in the transcript, is still a run_card render. The
    // subtree is the one the shipped run panel declares, found in the rendered
    // turn rather than invented here.
    const foreign = first.triggerContainer.querySelector<HTMLElement>(
      '[data-lifecycle-card-host="run_card"]',
    );
    expect(foreign, "the turn renders the inline run card's own host subtree").not.toBeNull();
    mountRealCardInto(foreign!);
    await waitFor(() =>
      expect(root.querySelector('[data-conformance-id="run-chip-row"]')).not.toBeNull(),
    );

    const { projection } = projectionFromProductionTurn(root, {
      name: "agent_run",
      result: DURABLE_RESULT,
    });
    const codes = new Set(evaluateHeldTurnProjection(projection, HELD_TURN_ROW).map((v) => v.code));
    expect([...codes]).toEqual(["anchors_in_foreign_host"]);
    expect(projectsOwnerCard(projection)).toBe(false);
  });

  it("FAILS when the same real card renders outside the triggering container", async () => {
    holdStateMock.mockImplementation(async () => HELD);
    const { root } = await mountHeldChat();
    const list = orderedPartsList(root);
    mountRealCardInto(list.children[0] as HTMLElement); // the TEXT part's container
    await waitFor(() =>
      expect(root.querySelector('[data-conformance-id="run-chip-row"]')).not.toBeNull(),
    );

    const { projection } = projectionFromProductionTurn(root, {
      name: "agent_run",
      result: DURABLE_RESULT,
    });
    expect(evaluateHeldTurnProjection(projection, HELD_TURN_ROW).map((v) => v.code)).toContain(
      "anchors_off_position",
    );
  });

  it("SURVIVES a transcript reload — the card is rebuilt from the durable part alone", async () => {
    holdStateMock.mockImplementation(async () => HELD);
    const first = await mountHeldChat();
    mountRealCardInto(
      projectionFromProductionTurn(first.root, { name: "agent_run", result: DURABLE_RESULT })
        .triggerContainer,
    );
    await waitFor(() =>
      expect(first.root.querySelector('[data-conformance-id="run-chip-row"]')).not.toBeNull(),
    );
    cleanup();

    // The reload: a fresh mount of the SAME persisted transcript, no live
    // stream, the card rebuilt from the durable part and its own resolve.
    const second = await mountHeldChat();
    const reloaded = projectionFromProductionTurn(second.root, {
      name: "agent_run",
      result: DURABLE_RESULT,
    });
    mountRealCardInto(reloaded.triggerContainer);
    await waitFor(() =>
      expect(second.root.querySelector('[data-conformance-id="run-chip-row"]')).not.toBeNull(),
    );

    const { projection } = projectionFromProductionTurn(second.root, {
      name: "agent_run",
      result: DURABLE_RESULT,
    });
    expect(evaluateHeldTurnProjection(projection, HELD_TURN_ROW, { requireMount: true })).toEqual(
      [],
    );
  });
});

describe("the structural invariant — a decision keeps the URL and settles in place", () => {
  it("Confirm settles the same mount point without navigating", async () => {
    holdStateMock.mockImplementation(async () => HELD);
    const { root } = await mountHeldChat();
    const { triggerContainer } = projectionFromProductionTurn(root, {
      name: "agent_run",
      result: DURABLE_RESULT,
    });
    mountRealCardInto(triggerContainer);

    const confirm = await waitFor(() => {
      const el = root.querySelector<HTMLButtonElement>(
        '[data-action="confirm-run-recommendation"]',
      );
      if (!el) throw new Error("the actionable card never appeared");
      return el;
    });
    const urlBefore = window.location.href;

    // The decision lands and the authority now answers CONFIRMED.
    holdStateMock.mockImplementation(async () => ({
      state: "confirmed",
      skillNames: ["Skill A"],
    }));
    await act(async () => {
      fireEvent.click(confirm);
    });

    await waitFor(() =>
      expect(
        triggerContainer.querySelector('[data-run-recommendation-decision="confirmed"]'),
      ).not.toBeNull(),
    );
    expect(confirmMock).toHaveBeenCalled();
    // The URL never moved, and the settled card is in the SAME container the
    // pending one occupied — no navigation, no second surface.
    expect(window.location.href).toBe(urlBefore);
    expect(routerPush).not.toHaveBeenCalled();
    expect(routerReplace).not.toHaveBeenCalled();
    expect(
      triggerContainer.querySelector('[data-action="confirm-run-recommendation"]'),
    ).toBeNull();
  });

  it("Skip settles the same mount point without navigating", async () => {
    holdStateMock.mockImplementation(async () => HELD);
    const { root } = await mountHeldChat();
    const { triggerContainer } = projectionFromProductionTurn(root, {
      name: "agent_run",
      result: DURABLE_RESULT,
    });
    mountRealCardInto(triggerContainer);

    const skip = await waitFor(() => {
      const el = root.querySelector<HTMLButtonElement>('[data-action="skip-run-recommendation"]');
      if (!el) throw new Error("the actionable card never appeared");
      return el;
    });
    const urlBefore = window.location.href;

    holdStateMock.mockImplementation(async () => ({ state: "skipped" }));
    await act(async () => {
      fireEvent.click(skip);
    });

    await waitFor(() =>
      expect(
        triggerContainer.querySelector('[data-run-recommendation-decision="skipped"]'),
      ).not.toBeNull(),
    );
    expect(skipMock).toHaveBeenCalled();
    expect(window.location.href).toBe(urlBefore);
    expect(routerPush).not.toHaveBeenCalled();
  });
});

describe("the root-declaration obligation, measured on the real card's own root", () => {
  it("records that the held card's ROOT declares neither its kind nor its host", async () => {
    holdStateMock.mockImplementation(async () => HELD);
    const { root } = await mountHeldChat();
    const { triggerContainer } = projectionFromProductionTurn(root, {
      name: "agent_run",
      result: DURABLE_RESULT,
    });
    mountRealCardInto(triggerContainer);
    await waitFor(() =>
      expect(root.querySelector('[data-conformance-id="run-chip-row"]')).not.toBeNull(),
    );

    const owed: string[] = [];
    for (const row of CHAT_THREAD_CARRIAGE_CONTRACT) {
      if (row.enforcer !== "held-turn-card-contract") continue;
      // ONE element, inside the triggering container, carrying BOTH ruled
      // selectors. Querying the whole surface would let an unrelated card supply
      // the kind and an unrelated wrapper supply the host, and the obligation
      // would read as met by two strangers.
      const declared = Array.from(
        triggerContainer.querySelectorAll(row.ruledRootAnchors[0] ?? "[data-lifecycle-card]"),
      ).some((el) => row.ruledRootAnchors.every((a) => el.matches(a)));
      if (!declared) owed.push(row.kind);
    }
    expect(
      owed,
      "the real card's root declaration drifted from ROOT_DECLARATION_OBLIGATIONS — " +
        "strike the row when the declaration lands, and never before",
    ).toEqual([...ROOT_DECLARATION_OBLIGATIONS]);
  });

  it("REFUSES a declaration split across two elements", async () => {
    // The bypass the check above closes, stated as a case: the kind on one
    // element and the host on another satisfies neither reader nor contract.
    holdStateMock.mockImplementation(async () => HELD);
    const { root } = await mountHeldChat();
    const { triggerContainer } = projectionFromProductionTurn(root, {
      name: "agent_run",
      result: DURABLE_RESULT,
    });
    const a = document.createElement("div");
    a.setAttribute("data-lifecycle-card", "recommendation_hold");
    const b = document.createElement("div");
    b.setAttribute("data-lifecycle-card-host", "chat_thread");
    triggerContainer.append(a, b);

    const row = HELD_TURN_ROW;
    const declared = Array.from(
      triggerContainer.querySelectorAll(row.ruledRootAnchors[0]!),
    ).some((el) => row.ruledRootAnchors.every((sel) => el.matches(sel)));
    expect(declared).toBe(false);
  });
});

describe("the mount ratchet does not depend on today's selector NAMES", () => {
  it("sees no lifecycle mount of ANY spelling in the triggering container", async () => {
    // The vocabulary-independent probe. A mount that landed with renamed
    // actions would satisfy a reader while the anchor-based ratchet still read
    // "unmounted"; these selectors match the ATTRIBUTE, not its value, so any
    // card, chip row or decision control in that container is seen.
    const { root } = await mountHeldChat();
    const { triggerContainer } = projectionFromProductionTurn(root, {
      name: "agent_run",
      result: DURABLE_RESULT,
    });
    expect(
      probeOutsideRunCard(triggerContainer),
      "a lifecycle card appeared in the held turn's container under a name this " +
        "contract does not know — add it to the row's anchors and strike the obligation",
    ).toEqual([]);
  });

  it("the probe FIRES on a card that uses none of the contract's anchor names", async () => {
    // The negative control: without this, the check above could be green
    // because the probe matches nothing at all.
    const { root } = await mountHeldChat();
    const { triggerContainer } = projectionFromProductionTurn(root, {
      name: "agent_run",
      result: DURABLE_RESULT,
    });
    const renamed = document.createElement("div");
    renamed.setAttribute("data-lifecycle-card", "recommendation_hold");
    renamed.innerHTML =
      '<span data-action="confirm-recommendations">Confirm</span>' +
      '<span data-action="skip-recommendations">Skip</span>';
    triggerContainer.appendChild(renamed);

    expect(probeOutsideRunCard(triggerContainer).length).toBeGreaterThan(0);
    // …and the anchor-based arm alone would have missed it, which is the point.
    const { projection } = projectionFromProductionTurn(root, {
      name: "agent_run",
      result: DURABLE_RESULT,
    });
    expect(projectsOwnerCard(projection)).toBe(false);
  });
});

describe("the production mount points, read from source", () => {
  // WHY SOURCE. The inline run panel is replaced in this suite (its graph
  // reaches the server runtime), so a hold card mounted INSIDE that panel would
  // be invisible to every DOM assertion here — the one blind spot of the mock
  // boundary. These checks watch that spot in the production source instead of
  // pretending the DOM covers it.
  const readSource = (rel: string) =>
    readFileSync(join(__dirname, "..", "..", "..", "..", rel), "utf8");

  it("the transcript's agent_run branch mounts the run card and the undo chip, and nothing else", () => {
    const view = readSource("packages/chat/src/chat-messages-view.tsx");
    const branch = view.slice(
      view.indexOf('part.name === "agent_run"'),
      view.indexOf('part.name === "agent_run"') + 800,
    );
    expect(branch).toContain("<InlineAgentRunCard");
    expect(branch).toContain("<UndoActionChip");
    // A lifecycle card mounted here would be a chat_thread mount landing in the
    // transcript. When it lands, this expectation is what forces the obligation
    // row to be revisited.
    for (const owner of ["RecommendationHoldCard", "RunRecommendationChipRow"]) {
      expect(branch, `${owner} is mounted in the transcript's agent_run branch`).not.toContain(
        owner,
      );
    }
  });

  it("the inline run card does not draw the hold card inside its own subtree", () => {
    // The forbidden arrangement the mock hides: a chat mount nested in the
    // run_card host. Caught here rather than not at all.
    const card = readSource("packages/chat/src/inline-agent-run-card.tsx");
    expect(card).not.toContain("RecommendationHoldCard");
    expect(card).not.toContain("RunRecommendationChipRow");
  });
});
