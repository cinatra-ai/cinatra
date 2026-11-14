// @vitest-environment jsdom
// DOM guards only: actual computed width is asserted by the browser spec.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

vi.mock("lucide-react", () => {
  const StubIcon: React.FC = () => null;
  return new Proxy({} as Record<string, React.FC>, {
    get: (_target, prop) => {
      if (prop === "__esModule") return true;
      if (prop === "then") return undefined;
      if (typeof prop === "symbol") return undefined;
      return StubIcon;
    },
    has: () => true,
    ownKeys: () => ["Check", "ClipboardCheck", "Info", "Pause", "ScanSearch", "SkipForward", "default"],
    getOwnPropertyDescriptor: () => ({
      enumerable: true,
      configurable: true,
      value: StubIcon,
    }),
  });
});

vi.mock("@/lib/cinatra-toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// The generated manifests are build artifacts whose `import()` targets are the
// cloned extension packages (absent in a partial worktree). Stubbed empty — the
// same idiom as schema-field-renderer-floor-bypass.test.tsx; a step rail needs
// neither map.
vi.mock("@/lib/generated/field-renderer-components", () => ({
  GENERATED_FIELD_RENDERER_COMPONENTS: {},
}));

vi.mock("@/lib/generated/extensions.server", () => ({
  STATIC_EXTENSION_MANIFEST: {},
  GENERATED_CONNECTOR_ENTRY_MODULES: {},
  GENERATED_CONNECTOR_MCP_MODULES: {},
  GENERATED_DEV_SETUP_MODULES: {},
  GENERATED_WIDGET_STREAM_AGENTS: {},
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("../orchestrator-actions", () => ({
  cancelOrchestratorAction: vi.fn(async () => ({ ok: true })),
  resumeStoppedOrchestratorAction: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../run-actions", () => ({
  startDevChildPreviewRun: vi.fn(async () => ({ ok: false })),
  buildSubmissionMapByStepIndex: vi.fn(async () => []),
  createAndTriggerRun: vi.fn(async () => ({ ok: true, runId: "run-next" })),
  readRunOutputEvidence: vi.fn(async () => ({
    ok: true,
    outputs: [],
    hasTranscript: false,
    hasStepResults: false,
  })),
}));

vi.mock("../run-recommendation-actions", () => ({
  getRunRecommendationHoldStateAction: vi.fn(async () => ({ state: "none" })),
  decideRunRecommendationAction: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../run-name-actions", () => ({
  ensureOrCheckRunNameAction: vi.fn(async () => ({ ok: true, title: "Run 1" })),
}));

vi.mock("../hitl-actions", () => ({
  approveReviewTask: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: (_runId: string, opts: { initialStatus?: string }) => ({
    status: opts?.initialStatus ?? "completed",
    interruptContext: null,
    messages: [],
    streamedText: "",
    presentationHint: null,
    dataPartFrames: [],
    error: null,
  }),
}));

vi.mock("../use-runtime-field-renderer-bindings", () => ({
  useRuntimeFieldRendererBindings: () => ({ bindings: {}, loading: false }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

import { RunPageRailWidthFixtures } from "../../../../src/app/design-fixtures/run-step-rail/run-step-rail-fixtures";

const HOSTS = [
  { id: "run-surface-rail-width-host", column: "[data-run-step-rail-column]" },
  { id: "orchestrator-rail-width-host", column: "[data-run-step-rail]" },
] as const;

function hostColumn(container: HTMLElement, id: string, selector: string) {
  const host = container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
  const column = host.querySelector<HTMLElement>(selector)!;
  expect(host).not.toBeNull();
  expect(column).not.toBeNull();
  return { host, column };
}

function toggle(container: HTMLElement) {
  fireEvent.click(container.querySelector("button")!);
}

for (const { id, column: selector } of HOSTS) {
  describe(`${id}: width belongs to the real host`, () => {
    for (const state of ["ordinary", "transient", "restored"] as const) {
      it(`keeps the 196px nonshrinking column in the ${state} reading`, () => {
        const { container } = render(<RunPageRailWidthFixtures />);
        if (state !== "ordinary") toggle(container);
        if (state === "restored") toggle(container);
        const { host, column } = hostColumn(container, id, selector);
        expect(host.querySelectorAll('[data-rail-kind="step"]')).toHaveLength(state === "transient" ? 1 : 3);
        expect(column.classList.contains("w-[196px]")).toBe(true);
        expect(column.classList.contains("shrink-0")).toBe(true);
        if (id === "run-surface-rail-width-host") {
          const panel = host.querySelector<HTMLElement>("[data-run-step-rail]")!;
          expect(panel.classList.contains("w-[196px]")).toBe(true);
          expect(panel.classList.contains("w-52")).toBe(false);
        }
      });
    }

    it("changes real rows without replacing the production column", () => {
      const { container } = render(<RunPageRailWidthFixtures />);
      const original = hostColumn(container, id, selector);
      expect(original.host.textContent).toContain("Collect sources");
      toggle(container);
      const transient = hostColumn(container, id, selector);
      expect(transient.column).toBe(original.column);
      expect(transient.host.querySelectorAll('[data-rail-kind="step"]')).toHaveLength(1);
      expect(transient.host.textContent).toContain("Go");
      expect(transient.host.textContent).not.toContain("Collect sources");
      toggle(container);
      const restored = hostColumn(container, id, selector);
      expect(restored.column).toBe(original.column);
      expect(restored.host.querySelectorAll('[data-rail-kind="step"]')).toHaveLength(3);
      expect(restored.host.textContent).toContain("Collect sources");
    });
  });
}
