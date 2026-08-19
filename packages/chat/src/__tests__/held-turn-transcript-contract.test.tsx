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
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import {
  owedExportsByModule,
  owedReachesFrom,
  type SourceGraph,
} from "./owed-card-export-graph";
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
 * Let the card's own resolve settle.
 *
 * `RecommendationHoldCard` reads its authority in an effect on mount, so an
 * observation taken in the same tick would report "no card" on a tree that does
 * mount one. Flushing here is what makes the absence measured rather than
 * assumed.
 */
async function settleResolver() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

/**
 * The kinds this contract enforces whose card is NOT projected by the rendered
 * transcript. Read off whatever is on screen at the moment it is called.
 */
function observeContainer(root: HTMLElement): string[] {
  const observed: string[] = [];
  for (const row of CHAT_THREAD_CARRIAGE_CONTRACT) {
    if (row.enforcer !== "held-turn-card-contract") continue;
    const { projection } = projectionFromProductionTurn(
      root,
      { name: "agent_run", result: DURABLE_RESULT },
      row,
    );
    if (!projectsOwnerCard(projection, row)) observed.push(row.kind);
  }
  return observed;
}

/**
 * THE PRODUCTION OBSERVATION. Mount the real column on a real persisted held
 * transcript, with the resolver ANSWERING HELD, wait for the card's own resolve
 * to settle, and report which enforced kinds the view did not project.
 *
 * The held answer matters more than it looks. The card self-gates on no live
 * hold, so an arm that left the resolver at `none` would see an empty container
 * whether or not the carriage existed, and could never observe the mount
 * landing. With HELD in place, the only thing between this and a rendered card
 * is the carriage.
 */
/**
 * IS THE HOLD CARD'S CHAT MOUNT STILL OWED?
 *
 * ONE switch for the whole suite, read from the contract rather than repeated.
 * Striking `recommendation_hold` from `HELD_TURN_MOUNT_OBLIGATIONS` is the
 * single edit the carriage slice makes, and every assertion below flips with it
 * — which is what "the mount plus its obligation update is green" has to mean.
 */
const HOLD_MOUNT_OWED = HELD_TURN_MOUNT_OBLIGATIONS.includes("recommendation_hold");
const HOLD_ROOT_OWED = ROOT_DECLARATION_OBLIGATIONS.includes("recommendation_hold");

async function observeProductionCarriage(): Promise<string[]> {
  holdStateMock.mockImplementation(async () => HELD);
  const { root } = await mountHeldChat();
  await settleResolver();
  return observeContainer(root);
}

/**
 * Put the REAL card in the REAL triggering container.
 *
 * THIS IS NOT PRODUCTION CARRIAGE and nothing that uses it may claim to be.
 * The carriage question is answered only by `observeProductionCarriage`, which
 * renders the view and looks. What this is for is everything the card owes ONCE
 * it is mounted: that the contract accepts its real markup, that a decision
 * settles in place, and that the ratchet's red direction really moves.
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

  it("does NOT project the held card — measured with the resolver ANSWERING HELD", async () => {
    // THE RATCHET, and the whole point of driving it this way. The card
    // self-gates: with no live hold it renders nothing, so a production arm
    // that left the resolver at `none` would observe an empty container
    // whether the carriage existed or not, and could never see the mount land.
    // The resolver answers HELD here, so the ONLY thing standing between this
    // observation and a rendered card is the carriage itself.
    const observed = await observeProductionCarriage();
    expect(
      observed,
      "the PRODUCTION view's unmounted set drifted from HELD_TURN_MOUNT_OBLIGATIONS — " +
        "strike the row when the mount lands, and never before",
    ).toEqual([...HELD_TURN_MOUNT_OBLIGATIONS]);
  });

  it("asks the authority for the hold state exactly when a card is mounted to ask", async () => {
    // The second signal, independent of every selector this contract knows. The
    // card resolves on mount, so the resolver's call count answers "was a card
    // mounted" on its own. Symmetric on purpose: owed means untouched, and no
    // longer owed means it MUST have been consulted, so a struck row over a
    // silent transcript is just as red as an unstruck row over a live one.
    holdStateMock.mockImplementation(async () => HELD);
    await mountHeldChat();
    await settleResolver();
    if (HOLD_MOUNT_OWED) {
      expect(
        holdStateMock,
        "the production transcript resolved a recommendation hold — the carriage " +
          "has landed; strike the obligation row",
      ).not.toHaveBeenCalled();
    } else {
      expect(
        holdStateMock,
        "the obligation row is struck, so the production transcript must mount the " +
          "card and resolve its authority — it did not",
      ).toHaveBeenCalled();
    }
  });

  it.runIf(HOLD_MOUNT_OWED)("RATCHET DIRECTION: the observation flips the moment the container holds the card", async () => {
    // The red half, proven without pretending it is production carriage. The
    // card is put in the container the production view built, exactly where the
    // carriage will put it, and the SAME observation function is re-run. If it
    // did not flip, landing the mount would leave CI green and the ratchet
    // would be decoration.
    holdStateMock.mockImplementation(async () => HELD);
    const { root } = await mountHeldChat();
    const { triggerContainer } = projectionFromProductionTurn(root, {
      name: "agent_run",
      result: DURABLE_RESULT,
    });
    expect(observeContainer(root)).toEqual([...HELD_TURN_MOUNT_OBLIGATIONS]);

    mountRealCardInto(triggerContainer);
    await waitFor(() =>
      expect(root.querySelector('[data-conformance-id="run-chip-row"]')).not.toBeNull(),
    );

    const afterMount = observeContainer(root);
    expect(afterMount, "the observation did not move when the card appeared").toEqual([]);
    // …and that new observation no longer matches the declared obligation, which
    // is what turns CI red until the row is struck.
    expect(afterMount).not.toEqual([...HELD_TURN_MOUNT_OBLIGATIONS]);
  });

  it.runIf(HOLD_MOUNT_OWED)("RATCHET DIRECTION: striking the row while nothing mounts is also red", async () => {
    // The other half of the coupling: an empty declared list against this
    // observation is a mismatch, so the row cannot be struck ahead of the mount.
    const observed = await observeProductionCarriage();
    expect(observed).not.toEqual([]);
  });

  it.runIf(!HOLD_MOUNT_OWED)("the struck row is backed by a card the PRODUCTION view mounted", async () => {
    // Once the row is struck this replaces the two above: the view itself must
    // project the card, in the triggering container, outside the run card's
    // subtree, with its decision controls. No hand-mounting anywhere near it.
    holdStateMock.mockImplementation(async () => HELD);
    const { root } = await mountHeldChat();
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
  });
});

// ---------------------------------------------------------------------------
// CARD-LEVEL PROOFS. Not carriage claims.
// ---------------------------------------------------------------------------
// Everything below puts the real card in the real container by hand, because
// the carriage does not exist on this tree yet. Each one answers "what does the
// card owe once it is mounted", never "is it mounted". The carriage question is
// answered above, by rendering the view and looking.
describe("the REAL card, once it is in the REAL triggering container", () => {
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
  // Card-level, per the note above. When the carriage lands, the same
  // assertions run against the card the production view mounted, because the
  // container and the card are both already the real ones.
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
      void HOLD_ROOT_OWED;
    }
    expect(
      owed,
      "the real card's root declaration drifted from ROOT_DECLARATION_OBLIGATIONS — " +
        "strike the row when the declaration lands, and never before",
    ).toEqual([...ROOT_DECLARATION_OBLIGATIONS]);
  });

  it.runIf(!HOLD_ROOT_OWED)("the struck root obligation is backed by a real declaration", () => {
    // Symmetry again: with the row struck, the shipped component must really
    // emit both attributes on one root, or the strike was premature.
    const source = readFileSync(
      join(__dirname, "..", "..", "..", "agents", "src", "run-recommendation-chip-row.tsx"),
      "utf8",
    );
    expect(source).toContain('data-lifecycle-card="recommendation_hold"');
    expect(source).toContain("data-lifecycle-card-host");
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
    // An ISOLATED container: the point is the reader, not whatever the tree
    // around it happens to render, and on a tree where the card already
    // declares its root the ambient DOM would answer for the fixture.
    const isolated = document.createElement("div");
    const a = document.createElement("div");
    a.setAttribute("data-lifecycle-card", "recommendation_hold");
    const b = document.createElement("div");
    b.setAttribute("data-lifecycle-card-host", "chat_thread");
    isolated.append(a, b);
    void triggerContainer;

    const row = HELD_TURN_ROW;
    const declared = Array.from(isolated.querySelectorAll(row.ruledRootAnchors[0]!)).some((el) =>
      row.ruledRootAnchors.every((sel) => el.matches(sel)),
    );
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

  it("sees NO interactive affordance of any kind in the held turn's own slot", async () => {
    // The anchorless case, which no attribute probe can reach: a card built from
    // plain elements with no data-* at all. An OPERABLE card must still offer
    // something to click, so the container is checked for interactivity itself.
    // This is the floor under the attribute probes, not a duplicate of them.
    const { root } = await mountHeldChat();
    const { triggerContainer } = projectionFromProductionTurn(root, {
      name: "agent_run",
      result: DURABLE_RESULT,
    });
    const interactive = Array.from(
      triggerContainer.querySelectorAll('button, [role="button"], a[href], input, select'),
    ).filter((el) => !HELD_TURN_ROW.foreignHostSubtrees.some((f) => el.closest(f) !== null));
    expect(
      interactive.map((el) => el.tagName.toLowerCase()),
      "something clickable appeared in the held turn's own slot — if a card landed " +
        "there, strike the obligation row; the attribute probes cannot see a card " +
        "built from plain elements, and this is what does",
    ).toEqual([]);
  });

  it("the interactive floor FIRES on a card with no data attributes at all", async () => {
    const { root } = await mountHeldChat();
    const { triggerContainer } = projectionFromProductionTurn(root, {
      name: "agent_run",
      result: DURABLE_RESULT,
    });
    const anchorless = document.createElement("section");
    anchorless.innerHTML = "<button>Decide</button>";
    triggerContainer.appendChild(anchorless);

    expect(probeOutsideRunCard(triggerContainer)).toEqual([]); // invisible to attributes
    const interactive = Array.from(
      triggerContainer.querySelectorAll('button, [role="button"], a[href], input, select'),
    ).filter((el) => !HELD_TURN_ROW.foreignHostSubtrees.some((f) => el.closest(f) !== null));
    expect(interactive.length).toBeGreaterThan(0); // …and caught by this
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

const CHAT_SRC = join(__dirname, "..");
const AGENTS_SRC = join(__dirname, "..", "..", "..", "agents", "src");
// ONLY the modules of kinds whose chat mount is still owed. `review-gate-card`
// is deliberately absent: the review kind's chat mount has LANDED, through the
// renderable-views registry, and forbidding it would be forbidding the thing
// this program is trying to achieve.
// BOTH SPELLINGS. The card's drawing module is reachable as its own filename
// and through the `@cinatra-ai/agents/run-recommendation-card` alias the
// carriage slice adds; a list carrying only one of them would miss the import
// that lands the mount.
const OWED_OWNER_MODULES = ["run-recommendation-chip-row", "run-recommendation-card"];
const OWED_OWNER_SYMBOLS = ["RecommendationHoldCard", "RunRecommendationChipRow"];

function chatSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__" || entry.name === "node_modules") continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) chatSourceFiles(abs, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(abs);
  }
  return out;
}

describe("the production mount points, read from the import graph", () => {
  // WHY SOURCE AT ALL. The inline run panel is replaced in this suite (its graph
  // reaches the server runtime), so a hold card mounted INSIDE that panel would
  // be invisible to every DOM assertion here — the one blind spot of the mock
  // boundary. This watches that spot instead of pretending the DOM covers it.
  //
  // WHY THE IMPORT SPECIFIER, not the identifier. A check for the string
  // "RecommendationHoldCard" is defeated by `import { RecommendationHoldCard as
  // RHC }`, and a check on a fixed slice of the render branch is defeated by
  // moving that branch into a helper component. A MODULE SPECIFIER survives
  // both: the drawing code has to name the module it comes from, wherever in
  // this package it ends up living.
  // CHAT_SRC / AGENTS_SRC / OWED_OWNER_* / chatSourceFiles are module-scoped so
  // the reachability check at the bottom of this file reads the SAME owed list
  // these scans do; two lists would drift and neither would be authoritative.
  // ONLY the modules of kinds whose chat mount is still owed. `review-gate-card`
  // is deliberately absent: the review kind's chat mount has LANDED, through the
  // renderable-views registry, and forbidding it would be forbidding the thing
  // this program is trying to achieve.
  // BOTH SPELLINGS. The card's drawing module is reachable as its own filename
  // and through the `@cinatra-ai/agents/run-recommendation-card` alias the
  // carriage slice adds; a list carrying only one of them would miss the import
  // that lands the mount.
  // The barrels a chat import could reach the card through without ever naming
  // its module. Watched below, which is what closes the re-export route.
  const AGENTS_BARRELS = ["index.ts", "client-entry.ts"];

  it("no production file in the chat package imports an OWED lifecycle card's drawing module", () => {
    // When the chat mount lands it will import one of these, and this is what
    // turns red and forces the obligation row to be revisited. It cannot be
    // aliased away and it does not care where the JSX lives.
    const offenders: string[] = [];
    for (const file of chatSourceFiles(CHAT_SRC)) {
      const source = readFileSync(file, "utf8");
      for (const mod of OWED_OWNER_MODULES) {
        if (new RegExp(`from\\s+["'][^"']*${mod}["']`).test(source)) {
          offenders.push(`${file.slice(CHAT_SRC.length + 1)} → ${mod}`);
        }
      }
    }
    if (HOLD_MOUNT_OWED) {
      expect(
        offenders,
        "a lifecycle card's drawing module is now imported by chat production code — " +
          "if that is the chat mount landing, strike the obligation row",
      ).toEqual([]);
    } else {
      expect(
        offenders.length,
        "the obligation row is struck, so chat production code must import the card " +
          "it now mounts — nothing does",
      ).toBeGreaterThan(0);
    }
  });

  it("the agents barrels do not re-export an owed card, so the module scan cannot be routed around", () => {
    // THE RE-EXPORT ROUTE, closed. Without this, chat could import the card from
    // `@cinatra-ai/agents` and name neither its module nor, if the barrel
    // renamed it, its symbol. A barrel that re-exports it has to write the
    // original name at the export site, so watching the barrels closes the
    // chain: module specifier, symbol name, or barrel export — all three are
    // seen, and there is no fourth way in.
    for (const barrel of AGENTS_BARRELS) {
      const source = readFileSync(join(AGENTS_SRC, barrel), "utf8");
      for (const symbol of OWED_OWNER_SYMBOLS) {
        if (!HOLD_MOUNT_OWED) continue;
        expect(
          source.includes(symbol),
          `packages/agents/src/${barrel} now re-exports ${symbol} — the owed chat mount may be ` +
            "landing through the barrel; check the obligation row",
        ).toBe(false);
      }
      if (HOLD_MOUNT_OWED) expect(source).not.toContain("run-recommendation-chip-row");
    }
  });

  it("no production file in the chat package names an owed card's SYMBOL either", () => {
    // The alias case is covered by construction: `import { RecommendationHoldCard
    // as RHC }` still writes the original name at the import site.
    const offenders: string[] = [];
    for (const file of chatSourceFiles(CHAT_SRC)) {
      const source = readFileSync(file, "utf8");
      for (const symbol of OWED_OWNER_SYMBOLS) {
        if (source.includes(symbol)) offenders.push(`${file.slice(CHAT_SRC.length + 1)} → ${symbol}`);
      }
    }
    if (HOLD_MOUNT_OWED) expect(offenders).toEqual([]);
    else expect(offenders.length).toBeGreaterThan(0);
  });

  it("the transcript's agent_run branch still names the inline run card", () => {
    // The positive half: the container this gate measures is the one the run
    // card renders into. If that stops being true the projection is measuring
    // something else, and this says so.
    const view = readFileSync(join(CHAT_SRC, "chat-messages-view.tsx"), "utf8");
    expect(view).toContain('part.name === "agent_run"');
    expect(view).toContain("<InlineAgentRunCard");
    expect(view).toContain("<UndoActionChip");
  });
});

describe("the re-export route, closed by REACHABILITY rather than by spelling", () => {
  // The scans above watch three spellings: the drawing module's name in a
  // `from` clause, the owed symbols as literal substrings, and two named
  // barrels. The agents package publishes ~90 subpath exports, and chat already
  // imports several of them — `lifecycle-card-runtime`, `client-entry`,
  // `review-gate-card`. So an agents-side module that is NEITHER barrel can
  // re-export the card under another name and be imported by chat while every
  // one of those three scans stays green. This asks the question they cannot:
  // by ANY name, through ANY module, can chat production code get the card?
  const AGENTS_PKG = join(AGENTS_SRC, "..");
  const agentsExports: Record<string, string> = JSON.parse(
    readFileSync(join(AGENTS_PKG, "package.json"), "utf8"),
  ).exports;

  function resolveFile(base: string): string | null {
    for (const candidate of [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      join(base, "index.ts"),
      join(base, "index.tsx"),
    ]) {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
    return null;
  }

  /** A specifier as written, resolved to a file in this repo — or null. */
  function resolveSpec(fromFile: string, spec: string): string | null {
    if (spec.startsWith(".")) return resolveFile(resolvePath(dirname(fromFile), spec));
    if (spec !== "@cinatra-ai/agents" && !spec.startsWith("@cinatra-ai/agents/")) return null;
    const sub = spec === "@cinatra-ai/agents" ? "." : `.${spec.slice("@cinatra-ai/agents".length)}`;
    const target = agentsExports[sub];
    return typeof target === "string" ? resolveFile(join(AGENTS_PKG, target)) : null;
  }

  function agentsSourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) agentsSourceFiles(abs, out);
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(abs);
    }
    return out;
  }

  const realGraph: SourceGraph = {
    files: agentsSourceFiles(AGENTS_SRC),
    read: (file) => readFileSync(file, "utf8"),
    resolve: resolveSpec,
  };

  /** The modules that DRAW the owed card, and the names they draw it under. */
  function owedSeeds(): Map<string, string[]> {
    const seeds = new Map<string, string[]>();
    for (const mod of OWED_OWNER_MODULES) {
      for (const ext of [".ts", ".tsx"]) {
        const file = join(AGENTS_SRC, `${mod}${ext}`);
        if (!existsSync(file)) continue;
        const source = readFileSync(file, "utf8");
        const drawn = OWED_OWNER_SYMBOLS.filter((symbol) =>
          new RegExp(`export\\s+(?:async\\s+)?(?:function|const|class)\\s+${symbol}\\b`).test(source),
        );
        if (drawn.length > 0) seeds.set(file, drawn);
      }
    }
    return seeds;
  }

  it("finds the owed card where it is actually drawn — the analysis is not seeded empty", () => {
    // The negative control for everything below: an empty seed set would make
    // every reachability answer trivially green.
    const seeds = owedSeeds();
    expect(seeds.size).toBeGreaterThan(0);
    expect([...seeds.values()].flat()).toContain("RecommendationHoldCard");
  });

  it("no chat production module can reach an owed card export, under ANY name", () => {
    const owed = owedExportsByModule(realGraph, owedSeeds());
    const offenders = owedReachesFrom(realGraph, chatSourceFiles(CHAT_SRC), owed, (f) =>
      f.slice(CHAT_SRC.length + 1),
    );
    if (HOLD_MOUNT_OWED) {
      expect(
        offenders,
        "chat production code can now obtain a lifecycle card whose chat mount is still " +
          "owed — if that is the mount landing, strike the obligation row; the name it " +
          "arrived under does not matter to this check",
      ).toEqual([]);
    } else {
      expect(
        offenders.length,
        "the obligation row is struck, so chat production code must be able to reach the " +
          "card it now mounts — nothing can",
      ).toBeGreaterThan(0);
    }
  });

  it("the agents package re-exports the owed card to a bounded, reviewed set of modules", () => {
    // The inventory, so a NEW re-export site is a visible diff rather than a
    // silent widening of the surface chat could import from.
    const owed = owedExportsByModule(realGraph, owedSeeds());
    const sites = [...owed.entries()]
      .filter(([, names]) => names.size > 0)
      .map(([file, names]) => `${file.slice(AGENTS_SRC.length + 1)}: ${[...names].sort().join(", ")}`)
      .sort();
    expect(sites).toEqual([
      "run-recommendation-chip-row.tsx: RecommendationHoldCard, RunRecommendationChipRow",
    ]);
  });

  it("FOLLOWS a renamed re-export through a module that is neither barrel", () => {
    // THE ATTACK, as a case. `hold-widgets` is not `index.ts`, not
    // `client-entry.ts`, and its specifier contains no watched module substring;
    // the name chat imports contains no watched symbol. Every spelling-based
    // scan in this file reads it as clean.
    const virtual: Record<string, string> = {
      "/agents/run-recommendation-chip-row.tsx": "export function RecommendationHoldCard() {}",
      "/agents/hold-widgets.ts":
        'export { RecommendationHoldCard as HoldPanel } from "./run-recommendation-chip-row";',
      "/agents/deeper.ts": 'export { HoldPanel as Panel } from "./hold-widgets";',
      "/chat/view.tsx": 'import { Panel } from "@cinatra-ai/agents/deeper";\nexport const V = Panel;',
    };
    const graph: SourceGraph = {
      files: Object.keys(virtual).filter((f) => f.startsWith("/agents/")),
      read: (file) => virtual[file] ?? "",
      resolve: (from, spec) => {
        if (spec.startsWith("@cinatra-ai/agents/")) {
          const name = spec.slice("@cinatra-ai/agents/".length);
          return virtual[`/agents/${name}.ts`] !== undefined ? `/agents/${name}.ts` : null;
        }
        if (!spec.startsWith(".")) return null;
        const base = `/agents/${spec.replace(/^\.\//, "")}`;
        for (const candidate of [`${base}.ts`, `${base}.tsx`]) {
          if (virtual[candidate] !== undefined) return candidate;
        }
        return null;
      },
    };

    // The spelling-based scans, run over the same chat source: all clean.
    const chatSource = virtual["/chat/view.tsx"]!;
    for (const mod of OWED_OWNER_MODULES) {
      expect(new RegExp(`from\\s+["'][^"']*${mod}["']`).test(chatSource)).toBe(false);
    }
    for (const symbol of OWED_OWNER_SYMBOLS) expect(chatSource.includes(symbol)).toBe(false);

    // Reachability is not.
    const owed = owedExportsByModule(graph, new Map([
      ["/agents/run-recommendation-chip-row.tsx", ["RecommendationHoldCard"]],
    ]));
    expect(owed.get("/agents/deeper.ts")).toEqual(new Set(["Panel"]));
    expect(owedReachesFrom(graph, ["/chat/view.tsx"], owed)).toEqual([
      "/chat/view.tsx → @cinatra-ai/agents/deeper as Panel",
    ]);
  });

  it("FOLLOWS a dynamic import, which no `from` regex sees", () => {
    const virtual: Record<string, string> = {
      "/agents/run-recommendation-chip-row.tsx": "export function RecommendationHoldCard() {}",
      "/chat/lazy.tsx":
        'const M = await import("@cinatra-ai/agents/run-recommendation-chip-row");\nexport const V = M;',
    };
    const graph: SourceGraph = {
      files: ["/agents/run-recommendation-chip-row.tsx"],
      read: (file) => virtual[file] ?? "",
      resolve: (_from, spec) =>
        spec === "@cinatra-ai/agents/run-recommendation-chip-row"
          ? "/agents/run-recommendation-chip-row.tsx"
          : null,
    };
    // `from\s+["']…["']` requires the word `from`; `import("…")` has none.
    expect(/from\s+["'][^"']*run-recommendation-chip-row["']/.test(virtual["/chat/lazy.tsx"]!)).toBe(
      false,
    );
    const owed = owedExportsByModule(graph, new Map([
      ["/agents/run-recommendation-chip-row.tsx", ["RecommendationHoldCard"]],
    ]));
    expect(owedReachesFrom(graph, ["/chat/lazy.tsx"], owed)).toEqual([
      "/chat/lazy.tsx → @cinatra-ai/agents/run-recommendation-chip-row (whole module; owed: RecommendationHoldCard)",
    ]);
  });

  it("does NOT flag a module that merely SITS BESIDE the card in the same package", () => {
    // The false positive worth avoiding, stated as a case. `client-entry`
    // re-exports the run panel, and the run panel draws the hold card INSIDE the
    // run_card host — which is the ruled place for it. Module-level taint would
    // call that an offence and make the check unusable; export-level does not.
    const virtual: Record<string, string> = {
      "/agents/run-recommendation-chip-row.tsx": "export function RecommendationHoldCard() {}",
      "/agents/panel.tsx":
        'import { RecommendationHoldCard } from "./run-recommendation-chip-row";\n' +
        "export function AgenticRunPanel() { return RecommendationHoldCard; }",
      "/agents/client-entry.ts": 'export { AgenticRunPanel } from "./panel";',
      "/chat/inline.tsx": 'import { AgenticRunPanel } from "@cinatra-ai/agents/client-entry";',
    };
    const graph: SourceGraph = {
      files: ["/agents/run-recommendation-chip-row.tsx", "/agents/panel.tsx", "/agents/client-entry.ts"],
      read: (file) => virtual[file] ?? "",
      resolve: (_from, spec) => {
        if (spec === "@cinatra-ai/agents/client-entry") return "/agents/client-entry.ts";
        if (spec === "./panel") return "/agents/panel.tsx";
        if (spec === "./run-recommendation-chip-row") return "/agents/run-recommendation-chip-row.tsx";
        return null;
      },
    };
    const owed = owedExportsByModule(graph, new Map([
      ["/agents/run-recommendation-chip-row.tsx", ["RecommendationHoldCard"]],
    ]));
    expect(owed.get("/agents/panel.tsx") ?? new Set()).toEqual(new Set());
    expect(owedReachesFrom(graph, ["/chat/inline.tsx"], owed)).toEqual([]);
  });
});
