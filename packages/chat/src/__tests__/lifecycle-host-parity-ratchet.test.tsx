// @vitest-environment jsdom
/**
 * THE RENDER-OBSERVED HOST-PARITY RATCHET (cinatra#2826, epic #2784 S9m).
 *
 * WHAT THIS REPLACES. Host parity used to be asserted from a table in an epic
 * and from `lifecycleViewTypesForHost` — a function that ignores its `host`
 * argument and answers the same three kinds for all four. Neither has seen a
 * card. Either can be edited to pass, and a mount that quietly stopped drawing
 * moves neither by one character.
 *
 * WHAT IS MEASURED HERE. For every kind in `LIFECYCLE_CARD_KINDS` — the full
 * closed set, not the DATA_PART-only helper — the hosts are collected from OWNER
 * ROOTS rendered through the production host compositions, and judged against
 * the ratchet by `evaluateHostParity`:
 *
 *   `transcript`  the kind's real carriage goes through the shared conversation
 *                 column (the `/chat` arm and the embed arm of the SAME
 *                 component) and the root is read off the rendered transcript.
 *   `composition` the host mounts its owner directly. The cell counts only when
 *                 BOTH halves hold: the production source really composes that
 *                 owner inside that host's provider, AND rendering that owner
 *                 under that host declaration really produces the card's own
 *                 anchors. A provider string with nothing in it is not a host.
 *
 * The ratchet refuses both directions — a kind that LOSES a host, and a cell
 * that starts being produced without being recorded — and an owed cell that
 * starts drawing forces its row to be struck. The negative controls below prove
 * each direction can go red, because a ratchet nobody has seen fail is a claim.
 *
 *   pnpm --filter @cinatra-ai/chat exec vitest run \
 *     src/__tests__/lifecycle-host-parity-ratchet.test.tsx
 */

import React from "react";
import { readFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, render } from "@testing-library/react";
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
vi.mock("../inline-agent-run-card", () => ({
  InlineAgentRunCard: ({ runId }: { runId: string }) => (
    <div data-lifecycle-card-host="run_card" data-inline-run-card={runId} />
  ),
}));

import {
  LIFECYCLE_CARD_HOSTS,
  LIFECYCLE_CARD_KINDS,
  LIFECYCLE_DATA_PART_VIEW_TYPES,
  LIFECYCLE_VIEW_SCHEMA_VERSION,
  lifecycleViewTypesForHost,
  type LifecycleCardHost,
  type LifecycleCardKind,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";
import { carriageRowFor } from "@/lib/lifecycle/held-turn-card-contract";
import {
  HOST_COMPOSITION_SOURCES,
  LIFECYCLE_HOST_PARITY_RATCHET,
  MANDATORY_HOST,
  TRANSCRIPT_HOSTS,
  evaluateHostParity,
  hostParityExpectations,
  ownerTagsFor,
  scanHostCompositionOwners,
  scanRegistryOwners,
  type HostObservationMethod,
  type ObservedHostParity,
} from "@/lib/lifecycle/lifecycle-host-parity-ratchet";
import { LifecycleCardSurfaceProvider } from "../../../agents/src/lifecycle-card-runtime";
import { ReviewGateCard } from "../../../agents/src/review-gate-card";
import { RecommendationHoldCard } from "../../../agents/src/run-recommendation-chip-row";
import { LifecycleCard } from "../renderable-views/lifecycle-card";
import {
  LIFECYCLE_RESOLVE_ANSWERS,
  installWidgetServiceStub,
  lifecycleDataPartTranscript,
  lifecycleHeldTranscript,
  mountSurface,
  type SurfaceName,
} from "./conversation-column-harness";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(__dirname, "..", "..", "..", "..");
const readSource = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf8");

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

/** The HELD answer — the one state that makes the hold card draw at all. */
const HELD = {
  state: "held",
  agentPackageName: "@cinatra-ai/proof-agent",
  promptText: "{}",
  recommendations: [
    { skillId: "skill-a", skillRevisionId: "rev-a", recommended: true, name: "Skill A" },
  ],
  holdRef: "hold-ref-2826",
};

/** The surface arm that carries each transcript host. */
const TRANSCRIPT_ARMS: Record<string, SurfaceName> = {
  chat_thread: "chat",
  site_widget: "widget",
};

let stub: ReturnType<typeof installWidgetServiceStub> | null = null;

function installResolve() {
  stub = installWidgetServiceStub({
    lifecycle: (viewType) => LIFECYCLE_RESOLVE_ANSWERS.pending(viewType),
  });
  return stub;
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

// ---------------------------------------------------------------------------
// The two observers
// ---------------------------------------------------------------------------

/**
 * TRANSCRIPT observation — the kind's real carriage through the shared column.
 *
 * A root found inside the inline run card's subtree is a run_card mount and is
 * NOT counted here; that is exactly the mislabeling this program exists to stop.
 */
async function observedByTranscript(
  host: LifecycleCardHost,
  kind: LifecycleCardKind,
): Promise<boolean> {
  const arm = TRANSCRIPT_ARMS[host];
  if (!arm) throw new Error(`no conversation arm for host "${host}"`);
  installResolve();
  holdStateMock.mockImplementation(async () => (kind === "recommendation_hold" ? HELD : { state: "none" }));
  const messages =
    kind === "recommendation_hold"
      ? lifecycleHeldTranscript()
      : lifecycleDataPartTranscript(kind, `ref-${kind}`);
  const mounted = await mountSurface(arm, { messages });
  await settle();
  const root = mounted.container.querySelector<HTMLElement>(`[data-parity-surface="${arm}"]`);
  if (!root) throw new Error(`the ${arm} surface did not mount`);
  const anchors = [`[data-lifecycle-card="${kind}"]`, ...carriageRowFor(kind).ownerAnchors];
  const drawn = anchors.some((selector) =>
    Array.from(root.querySelectorAll(selector)).some(
      (el) => el.closest('[data-lifecycle-card-host="run_card"]') === null,
    ),
  );
  cleanup();
  stub?.restore();
  stub = null;
  return drawn;
}

/** The owner components a composition host may mount, by their production tag. */
const OWNER_COMPONENTS: Record<string, React.ComponentType<never>> = {
  ReviewGateCard: ReviewGateCard as unknown as React.ComponentType<never>,
  RecommendationHoldCard: RecommendationHoldCard as unknown as React.ComponentType<never>,
  LifecycleCard: LifecycleCard as unknown as React.ComponentType<never>,
};

/** Render one owner under one host declaration, exactly as the host declares it. */
function renderOwnerUnderHost(tag: string, host: LifecycleCardHost, kind: LifecycleCardKind) {
  const Component = OWNER_COMPONENTS[tag];
  if (!Component) {
    throw new Error(
      `the production source composes <${tag}> under ${host}, and this observer cannot render it — ` +
        "teach it the component rather than dropping the cell",
    );
  }
  const props =
    tag === "RecommendationHoldCard"
      ? { runId: "run-2826", agentPackageName: "@cinatra-ai/proof-agent" }
      : {
          view: { viewType: kind, schemaVersion: LIFECYCLE_VIEW_SCHEMA_VERSION, ref: `ref-${kind}` },
        };
  return render(
    <LifecycleCardSurfaceProvider host={host}>
      {React.createElement(Component, props as never)}
    </LifecycleCardSurfaceProvider>,
  );
}

/**
 * COMPOSITION observation — the source really composes the owner under this
 * host, AND that owner really draws its own anchors there.
 */
async function observedByComposition(
  host: LifecycleCardHost,
  kind: LifecycleCardKind,
  registryOwners: Record<string, string>,
): Promise<boolean> {
  const composed = new Set<string>();
  for (const file of HOST_COMPOSITION_SOURCES[host]) {
    for (const tag of scanHostCompositionOwners(readSource(file), host)) composed.add(tag);
  }
  const candidates = ownerTagsFor(kind, registryOwners).filter((tag) => composed.has(tag));
  if (candidates.length === 0) return false;

  installResolve();
  holdStateMock.mockImplementation(async () => (kind === "recommendation_hold" ? HELD : { state: "none" }));
  let drawn = false;
  for (const tag of candidates) {
    const mounted = renderOwnerUnderHost(tag, host, kind);
    await settle();
    const anchors = carriageRowFor(kind).ownerAnchors;
    if (anchors.every((selector) => mounted.container.querySelector(selector) !== null)) {
      drawn = true;
    }
    cleanup();
  }
  stub?.restore();
  stub = null;
  return drawn;
}

/** The whole observation: every kind against every declared host. */
async function observeHostParity(): Promise<ObservedHostParity> {
  const registryOwners = scanRegistryOwners(
    readSource("packages/chat/src/renderable-views/registry.tsx"),
  );
  const observed: Record<string, Partial<Record<LifecycleCardHost, HostObservationMethod>>> = {};
  for (const kind of LIFECYCLE_CARD_KINDS) {
    observed[kind] = {};
    for (const host of LIFECYCLE_CARD_HOSTS) {
      const method: HostObservationMethod = TRANSCRIPT_HOSTS.includes(host)
        ? "transcript"
        : "composition";
      const drawn =
        method === "transcript"
          ? await observedByTranscript(host, kind)
          : await observedByComposition(host, kind, registryOwners);
      if (drawn) observed[kind]![host] = method;
    }
  }
  return observed as ObservedHostParity;
}

let OBSERVED: ObservedHostParity = {};

beforeEach(() => {
  holdStateMock.mockImplementation(async () => ({ state: "none" }));
});

afterEach(() => {
  cleanup();
  stub?.restore();
  stub = null;
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// The ratchet, against what the product really renders
// ---------------------------------------------------------------------------

describe("the host set of every kind, read off rendered cards", () => {
  beforeEach(async () => {
    if (Object.keys(OBSERVED).length === 0) OBSERVED = await observeHostParity();
  });

  it("every kind renders on exactly the hosts the ratchet records", async () => {
    const violations = evaluateHostParity({ observed: OBSERVED });
    expect(violations.map((v) => `${v.code}: ${v.detail}`)).toEqual([]);
  });

  it("the observation is not empty — every kind reaches at least one host", () => {
    for (const kind of LIFECYCLE_CARD_KINDS) {
      expect(Object.keys(OBSERVED[kind] ?? {}).length, `${kind} rendered nowhere`).toBeGreaterThan(0);
    }
  });

  it(`${MANDATORY_HOST} is recorded or explicitly owed for every kind — never nowhere`, () => {
    for (const kind of LIFECYCLE_CARD_KINDS) {
      const row = LIFECYCLE_HOST_PARITY_RATCHET[kind];
      const owed = row.owed.some((cell) => cell.host === MANDATORY_HOST);
      expect(MANDATORY_HOST in row.hosts || owed, `${kind} neither records nor owes ${MANDATORY_HOST}`).toBe(true);
      // An owed cell always names the slice that lands it — an unnamed
      // obligation is indistinguishable from a waiver.
      for (const cell of row.owed) expect(cell.tracking.length).toBeGreaterThan(0);
    }
  });

  it("the review card is the kind that really reaches all four hosts", () => {
    expect(Object.keys(OBSERVED.artifact_review_gate ?? {}).sort()).toEqual(
      [...LIFECYCLE_CARD_HOSTS].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// The observation cannot be produced by editing a list
// ---------------------------------------------------------------------------

describe("an edited array or a bare provider changes nothing", () => {
  it("a provider that composes NOTHING contributes no owner — a host string is not a mount", () => {
    const source = `
      <LifecycleCardSurfaceProvider host="run_card">
      </LifecycleCardSurfaceProvider>
    `;
    expect(scanHostCompositionOwners(source, "run_card")).toEqual([]);
  });

  it("the scanner reads the owner a provider really wraps, and only inside it", () => {
    const source = `
      <LifecycleCardSurfaceProvider host="page_gate_region">
        <ReviewGateCard view={view} />
      </LifecycleCardSurfaceProvider>
      <SomeOtherCard />
    `;
    expect(scanHostCompositionOwners(source, "page_gate_region")).toEqual(["ReviewGateCard"]);
    expect(scanHostCompositionOwners(source, "run_card")).toEqual([]);
  });

  it("claiming a host in the ratchet that nothing renders FAILS — the array is not the evidence", () => {
    const edited = {
      ...LIFECYCLE_HOST_PARITY_RATCHET,
      verification_summary: {
        hosts: {
          ...LIFECYCLE_HOST_PARITY_RATCHET.verification_summary.hosts,
          run_card: "composition" as HostObservationMethod,
        },
        owed: LIFECYCLE_HOST_PARITY_RATCHET.verification_summary.owed,
      },
    };
    const violations = evaluateHostParity({ observed: OBSERVED, ratchet: edited });
    expect(violations.map((v) => v.code)).toContain("host-lost");
  });

  it("the DECLARED per-host list claims cells the product does not produce", () => {
    // `lifecycleViewTypesForHost` answers all three data-part kinds for all four
    // hosts — twelve cells. The render-observed set is strictly smaller, which is
    // the whole reason a declaration cannot stand in for an observation.
    const declared = LIFECYCLE_CARD_HOSTS.flatMap((host) =>
      lifecycleViewTypesForHost(host).map((kind) => `${kind}@${host}`),
    );
    const observedCells = LIFECYCLE_DATA_PART_VIEW_TYPES.flatMap((kind) =>
      Object.keys(OBSERVED[kind] ?? {}).map((host) => `${kind}@${host}`),
    );
    expect(declared.length).toBe(12);
    expect(observedCells.length).toBeLessThan(declared.length);
    for (const cell of observedCells) expect(declared).toContain(cell);
  });
});

// ---------------------------------------------------------------------------
// The ratchet's red directions, each demonstrated
// ---------------------------------------------------------------------------

describe("the ratchet goes red in every direction it claims to", () => {
  it("a kind that LOSES a host fails", () => {
    const lost: ObservedHostParity = {
      ...OBSERVED,
      artifact_review_gate: { chat_thread: "transcript", site_widget: "transcript", run_card: "composition" },
    };
    const violations = evaluateHostParity({ observed: lost });
    expect(violations.some((v) => v.code === "host-lost" && v.host === "page_gate_region")).toBe(true);
  });

  it("a cell observed by a WEAKER method than it was ratcheted with fails", () => {
    const weakened: ObservedHostParity = {
      ...OBSERVED,
      artifact_review_gate: {
        ...(OBSERVED.artifact_review_gate ?? {}),
        site_widget: "composition",
      },
    };
    expect(evaluateHostParity({ observed: weakened }).some((v) => v.code === "method-changed")).toBe(
      true,
    );
  });

  it("a NEW host that nobody recorded fails — growth is not silent either", () => {
    const grown: ObservedHostParity = {
      ...OBSERVED,
      verification_summary: {
        ...(OBSERVED.verification_summary ?? {}),
        run_card: "composition",
      },
    };
    expect(evaluateHostParity({ observed: grown }).some((v) => v.code === "host-unratcheted")).toBe(
      true,
    );
  });

  it("an OWED cell that starts drawing fails, so the row must be struck", () => {
    const landed: ObservedHostParity = {
      ...OBSERVED,
      recommendation_hold: {
        ...(OBSERVED.recommendation_hold ?? {}),
        site_widget: "transcript",
      },
    };
    const violations = evaluateHostParity({ observed: landed });
    expect(violations.some((v) => v.code === "owed-cell-observed" && v.host === "site_widget")).toBe(
      true,
    );
    // …and it names the slice that owed it, so the striker knows what landed.
    expect(violations.find((v) => v.code === "owed-cell-observed")?.detail).toContain("2790");
  });

  it("a kind with NO conversation cell at all fails the mandatory-host rule", () => {
    const stripped = {
      ...LIFECYCLE_HOST_PARITY_RATCHET,
      recommendation_hold: {
        hosts: LIFECYCLE_HOST_PARITY_RATCHET.recommendation_hold.hosts,
        owed: LIFECYCLE_HOST_PARITY_RATCHET.recommendation_hold.owed.filter(
          (cell) => cell.host !== MANDATORY_HOST,
        ),
      },
    };
    expect(
      evaluateHostParity({ observed: OBSERVED, ratchet: stripped }).some(
        (v) => v.code === "mandatory-host-missing",
      ),
    ).toBe(true);
  });

  it("a missing ratchet row fails rather than passing by omission", () => {
    const withoutVerification = Object.fromEntries(
      Object.entries(LIFECYCLE_HOST_PARITY_RATCHET).filter(
        ([kind]) => kind !== "verification_summary",
      ),
    );
    expect(
      evaluateHostParity({ observed: OBSERVED, ratchet: withoutVerification }).some(
        (v) => v.code === "no-ratchet-row",
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The shape the anchor contract records
// ---------------------------------------------------------------------------

describe("the ratchet's recorded shape", () => {
  it("serialises every kind with sorted hosts and owed cells", () => {
    const expectations = hostParityExpectations();
    expect(Object.keys(expectations).sort()).toEqual([...LIFECYCLE_CARD_KINDS].sort());
    expect(expectations.recommendation_hold.owed).toEqual(["chat_thread", "site_widget"]);
    expect(expectations.artifact_review_gate.hosts.page_gate_region).toBe("composition");
  });
});
