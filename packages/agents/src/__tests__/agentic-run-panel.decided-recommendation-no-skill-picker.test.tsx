// @vitest-environment jsdom
/**
 * NOTHING SELECTABLE INSIDE THE RUN CARD ONCE THE SKILLS ARE DECIDED.
 *
 * Plan sentences, verbatim (PLAN: Agents Lifecycle (A), section 6.2 step 3 and
 * section 6.4 step 4):
 *
 *   "The agentic run progress card appears once the skills are decided; no
 *    skill inside it can be selected."
 *
 * WHAT WAS WRONG. The panel drew `HitlSkillChips` at both of its HITL gates: a
 * "Skills (n)" disclosure listing every skill assigned to the agent, each one a
 * pressable button. Inside the run card of a run whose skills were ALREADY
 * decided on the recommendation card, that row reads as a second, live skill
 * choice — and it listed the skipped skill too, so it read as a choice that
 * disagreed with the one that was taken.
 *
 * WHAT REPLACES IT: nothing. The settled chips above the card already state
 * what was chosen, and the drawing puts no second reading inside the card.
 *
 * The row is UNTOUCHED for a run with no recommendation decision — that is a
 * different run in a different state, and this slice does not redraw it.
 *
 * Run: cd packages/agents && pnpm exec vitest run \
 *   src/__tests__/agentic-run-panel.decided-recommendation-no-skill-picker.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

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
    ownKeys: () => ["Circle", "CircleDot", "Loader2", "CheckCircle2", "XCircle", "default"],
    getOwnPropertyDescriptor: () => ({
      enumerable: true,
      configurable: true,
      value: StubIcon,
    }),
  });
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// The generated extension registry is a SERVER leaf the panel's graph reaches
// transitively. Nothing here measures it, and resolving it needs the installed
// extension packages, so it is replaced by its own empty shape — the same
// treatment `src/lib/execution/__tests__/run-environment-sources.test.ts` gives
// it, and it keeps this file runnable wherever the workspace is checked out.
vi.mock("@/lib/generated/extensions.server", () => ({
  STATIC_EXTENSION_MANIFEST: {},
  STATIC_EXTENSION_RECORDS: [],
  GENERATED_EXTENSION_SERVER_ENTRIES: {},
  GENERATED_CONNECTOR_ENTRY_MODULES: {},
  GENERATED_CONNECTOR_MCP_MODULES: {},
  GENERATED_CONNECTOR_PRIMITIVE_HANDLERS: {},
  GENERATED_EXTERNAL_MCP_TOOLBOXES: {},
  GENERATED_WIDGET_STREAM_AGENTS: {},
  GENERATED_CHAT_WIDGET_MODULES: {},
  GENERATED_CHAT_WIDGET_MANIFEST_MODULES: {},
  GENERATED_DEV_SETUP_MODULES: {},
}));
// Same reason, for the generated field-renderer registry: its entries are
// dynamic imports of installed extension packages, and no HITL renderer is
// under test here.
vi.mock("@/lib/generated/field-renderer-components", () => ({
  GENERATED_FIELD_RENDERER_COMPONENTS: {},
}));

/** The two skills the agent has assigned — what the disclosure row lists. */
const ASSIGNED_SKILLS = vi.hoisted(() => [
  { id: "s1", name: "Blog Writing Skill", description: "writes", content: "c1" },
  { id: "s2", name: "Web Research Skill", description: "researches", content: "c2" },
]);

const getSkillsForAgentAction = vi.hoisted(() => vi.fn(async () => ASSIGNED_SKILLS));
vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({})),
  getSkillsForAgentAction,
  getRunRecommendedSkillsAction: vi.fn(async () => []),
}));

vi.mock("../a2a-actions", () => ({
  getAgentBuilderTask: vi.fn(() => new Promise<never>(() => {})),
  sendAgentBuilderMessage: vi.fn(async () => ({})),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/agents",
  useSearchParams: () => new URLSearchParams(),
}));

/** The run's recommendation authority — the panel's own card resolves through it. */
const holdState = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
  /** When set, the read HANGS on this promise — the "not answered yet" window. */
  gate: null as Promise<void> | null,
}));
vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: async () => {
    if (holdState.gate) await holdState.gate;
    return holdState.current;
  },
  confirmRunRecommendationAction: async () => ({ ok: true, dispatched: true }),
  skipRunRecommendationAction: async () => ({ ok: true, dispatched: true }),
}));

const SKILL_PICKER = /^Skills \(/;

async function mountPanel(props: Record<string, unknown> = {}) {
  const mod = (await import("../agentic-run-panel")) as {
    AgenticRunPanel: React.ComponentType<Record<string, unknown>>;
  };
  return render(
    <mod.AgenticRunPanel
      runId="run-2890"
      taskId="t1"
      agentPackageName="@cinatra-ai/blog-draft-writer-agent"
      initialStatus="pending_approval"
      initialError={null}
      initialMessages={[]}
      agUiEnabled={false}
      traceId={null}
      inputParams={{}}
      templateId="tpl1"
      initialStreamedText=""
      {...props}
    />,
  );
}

beforeEach(() => {
  holdState.current = { state: "none" };
  holdState.gate = null;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the run card's skill picker and the recommendation decision", () => {
  it(
    "CONTROL: a run with no recommendation decision still lists its skills",
    { timeout: 30_000 },
    async () => {
      const { container } = await mountPanel();
      await waitFor(() => {
        expect(screen.queryByRole("button", { name: SKILL_PICKER })).not.toBeNull();
      });
      expect(container.querySelector("[data-hitl-skill-picker]")).not.toBeNull();
    },
  );

  it(
    "draws no skill picker for a run whose recommendation was confirmed",
    { timeout: 30_000 },
    async () => {
      holdState.current = {
        state: "confirmed",
        runId: "run-2890",
        skillNames: ["Blog Writing Skill"],
        decided: [{ skillId: "s1", name: "Blog Writing Skill", mark: "confirmed" }],
      };
      const { container } = await mountPanel();
      // The settled card resolves first; the picker must never appear beside it.
      await waitFor(() => {
        expect(container.querySelector("[data-run-recommendation-chip-row]")).not.toBeNull();
      });
      expect(screen.queryByRole("button", { name: SKILL_PICKER })).toBeNull();
      expect(container.querySelector("[data-hitl-skill-picker]")).toBeNull();
    },
  );

  it(
    "draws no skill picker for a run whose recommendation was skipped",
    { timeout: 30_000 },
    async () => {
      holdState.current = {
        state: "skipped",
        runId: "run-2890",
        decided: [{ skillId: "s2", name: "Web Research Skill", mark: "skipped" }],
      };
      const { container } = await mountPanel();
      await waitFor(() => {
        expect(container.querySelector("[data-run-recommendation-chip-row]")).not.toBeNull();
      });
      expect(screen.queryByRole("button", { name: SKILL_PICKER })).toBeNull();
      expect(container.querySelector("[data-hitl-skill-picker]")).toBeNull();
    },
  );

  it(
    "draws no skill picker while the run's recommendation is still being read",
    { timeout: 30_000 },
    async () => {
      // THE FLICKER ARM. The assigned-skills fetch and the recommendation read
      // are two independent round trips, and the skills one can win. A panel that
      // treats "not answered yet" as "no decision" then draws a pressable list of
      // this run's skills and withdraws it when the answer lands — the person saw
      // a choice they do not have. So the picker waits for the answer.
      let release = () => {};
      holdState.gate = new Promise<void>((r) => {
        release = () => r();
      });
      holdState.current = {
        state: "confirmed",
        runId: "run-2890",
        skillNames: ["Blog Writing Skill"],
        decided: [{ skillId: "s1", name: "Blog Writing Skill", mark: "confirmed" }],
      };
      const { container } = await mountPanel();
      await waitFor(() => {
        expect(screen.queryByText("Agentic Run Progress")).not.toBeNull();
      });
      // The assigned-skills fetch has answered and its render has run — this is
      // the window in which the OLD panel drew the picker, so waiting through it
      // is what gives this arm teeth.
      await waitFor(() => {
        expect(getSkillsForAgentAction).toHaveBeenCalled();
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });
      // The picker is NOT there, because the recommendation is still unanswered.
      // Read BOTH ways — by the row's own name and by its anchor — so this arm
      // has teeth against a tree where the anchor does not exist yet.
      expect(screen.queryByRole("button", { name: SKILL_PICKER })).toBeNull();
      expect(container.querySelector("[data-hitl-skill-picker]")).toBeNull();
      release();
      await waitFor(() => {
        expect(container.querySelector("[data-run-recommendation-chip-row]")).not.toBeNull();
      });
      expect(container.querySelector("[data-hitl-skill-picker]")).toBeNull();
    },
  );

  it(
    "draws no skill picker when the conversation says the decision was taken",
    { timeout: 30_000 },
    async () => {
      // The chat's inline card. There the CONVERSATION owns the recommendation
      // card, so the panel never mounts one of its own and is told instead.
      const { container } = await mountPanel({ recommendationDecided: true });
      await waitFor(() => {
        expect(screen.queryByText("Agentic Run Progress")).not.toBeNull();
      });
      expect(screen.queryByRole("button", { name: SKILL_PICKER })).toBeNull();
      expect(container.querySelector("[data-hitl-skill-picker]")).toBeNull();
    },
  );
});
