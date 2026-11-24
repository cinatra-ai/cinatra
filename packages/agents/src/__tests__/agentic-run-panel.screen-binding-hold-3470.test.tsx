// @vitest-environment jsdom
/**
 * cinatra#3470 — THE RUN PANEL HOLDS A SCREEN WHOSE BINDING HAS NOT LOADED.
 *
 * The run page registers the bindings of runtime-installed agents after it
 * mounts (`useRuntimeFieldRendererBindings`). Until then, and for good after
 * that fetch failed, a declared screen's gate resolves to the schema fallback,
 * which can only approve. Nothing may send then: a send would resume the
 * screen with `{ approved: true }` alone, without its decision and its fields.
 * The run panel draws no Continue for a gate it resolves no renderer for, so
 * what is pinned is its published submit (the composer's road) and the
 * reason it shows, for a mid-run gate with no binding registered, whatever
 * its local id (`:output`, `:confirm`):
 *   - while the fetch has not answered, no Continue is available, the screen
 *     says why, and the published submit refuses with that reason;
 *   - after the fetch failed, the same;
 *   - when the fetch named a declared screen for the gate that the
 *     registration refused, the same;
 *   - when an installed agent declared a screen for the gate that the
 *     server's own validator refused, the same: the real server action
 *     reads the installed package from disk and names the refused screen;
 *   - once the fetch answered with nothing for the gate, it continues as before.
 *
 * The tests run in this order on purpose: the bindings' state belongs to the
 * page, and a later answer never takes back an earlier `loaded`.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run \
 *     src/__tests__/agentic-run-panel.screen-binding-hold-3470.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";
import { fieldRendererRegistry } from "../field-renderer-registry";

vi.mock("@cinatra-ai/sdk-ui", () => ({
  LoadingSpinner: () => null,
  PromptField: ({ placeholder }: { placeholder?: string }) => (
    <div data-testid="field-assist-prompt-stub">{placeholder}</div>
  ),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

vi.mock("lucide-react", () => {
  const StubIcon = () => null;
  return new Proxy({} as Record<string, () => null>, {
    get: (_t, prop) => {
      if (prop === "__esModule") return true;
      if (prop === "then") return undefined;
      if (typeof prop === "symbol") return undefined;
      return StubIcon;
    },
    has: () => true,
    ownKeys: () => ["ArrowRight", "Check", "Loader2", "default"],
    getOwnPropertyDescriptor: () => ({
      enumerable: true,
      configurable: true,
      value: StubIcon,
    }),
  });
});

const hitlActions = vi.hoisted(() => ({
  approveReviewTask: vi.fn(async () => ({ ok: true as const })),
  rejectReviewTask: vi.fn(async () => undefined),
}));
vi.mock("../hitl-actions", () => hitlActions);

vi.mock("../a2a-actions", () => ({
  getAgentBuilderTask: vi.fn(async () => null),
}));

/** What the page's fetch of the installed agents' bindings answers. */
const runtimeBindings = vi.hoisted(() => ({
  fetch: vi.fn(async (): Promise<unknown> => ({ bindings: [], refusedScreenIds: [] })),
}));

/**
 * The installed agents' folder the real server action reads, and a signed-in
 * reader for it. Only the folder, the session and the host's side-effect
 * imports are stubbed: the action, the collector and the validator are real.
 */
const installed = vi.hoisted(() => ({ dir: "" }));
vi.mock("../agent-runtime-mount", () => ({
  resolveAgentRuntimeMountDir: () => {
    if (!installed.dir) throw new Error("fixture: no installed agents folder");
    return installed.dir;
  },
}));
vi.mock("@/lib/register-host-connector-services", () => ({}));
vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: vi.fn(async () => ({ user: { id: "user-3470" } })),
  requireActorContext: vi.fn(async () => {
    throw new Error("fixture: not used here");
  }),
}));

/** The real `getRuntimeFieldRendererBindingsAction`, past the panel's mock. */
async function realRuntimeBindingsAction(): Promise<unknown> {
  const { __clearInstalledFieldRendererBindingsCache } = await import("../field-renderer-bindings.server");
  __clearInstalledFieldRendererBindingsCache();
  const actual = await vi.importActual<typeof import("../server-actions")>("../server-actions");
  return actual.getRuntimeFieldRendererBindingsAction();
}

vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({
    connectedApps: [],
    gmailAliases: [],
    runId: "run-3470",
  })),
  getAuditAvailabilityAction: vi.fn(async () => ({
    visible: false,
    promptCount: 0,
    skillCount: 0,
  })),
  getSkillsForAgentAction: vi.fn(async () => []),
  getRuntimeFieldRendererBindingsAction: () => runtimeBindings.fetch(),
}));

vi.mock("../agent-ui-override-registry", () => ({
  agentUIOverrideRegistry: { resolve: () => null },
}));

/** A runtime-installed agent's screen: mid-run by its suffix, no binding in the build. */
const RUNTIME_ID = "@cinatra-test/runtime-agent:output";
const REVIEW_TASK_ID = "wayflow-task-3470";
/** The gate the stream hands the panel (a test may name another). */
const gate = { xRenderer: RUNTIME_ID };
const HOLD_LOADING = "This step's screen is still loading.";
const HOLD_FAILED = "This step's screen could not be loaded. Reload the page to try again.";

vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: vi.fn(() => ({
    status: "pending_approval",
    error: null,
    presentationHint: null,
    isLive: true,
    interruptContext: {
      schema: { type: "object", properties: { decision: { type: "string", enum: ["approve", "revise"] } } },
      xRenderer: gate.xRenderer,
      values: { itemId: "item-1" },
      reviewTaskId: REVIEW_TASK_ID,
    },
    streamedText: "",
    dataPartFrames: [],
  })),
}));

type GateSubmit = (value: Record<string, unknown> | string | number | boolean) => Promise<void>;

async function mountGate() {
  const published: { submit: GateSubmit | null } = { submit: null };
  const { AgenticRunPanel } = await import("../agentic-run-panel");
  render(
    <AgenticRunPanel
      runId="run-3470"
      initialStatus="pending_approval"
      initialError={null}
      initialMessages={[]}
      agUiEnabled={true}
      templateId="tmpl-3470"
      onActiveGateChange={(_runId, gate) => {
        published.submit = gate?.submit ?? null;
      }}
    />,
  );
  return published;
}

function gateContinue(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('[data-action="submit-hitl-screen"]');
}

function holdReason(): string | null {
  return document.querySelector("[data-continue-hold-reason]")?.textContent ?? null;
}

async function expectHeld(reason: string, published: { submit: GateSubmit | null }) {
  await waitFor(() => expect(published.submit).not.toBeNull());
  await expect(published.submit!({ decision: "approve" })).rejects.toThrow(reason);
  expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
  await waitFor(() => expect(holdReason()).toBe(reason));
  expect(gateContinue()?.disabled ?? true).toBe(true);
}

beforeEach(() => {
  gate.xRenderer = RUNTIME_ID;
  ensureDefaultFieldRenderersRegistered();
  cleanup();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  fieldRendererRegistry.clear();
  ensureDefaultFieldRenderersRegistered();
});

describe("AgenticRunPanel — a screen whose binding has not loaded holds its Continue (cinatra#3470)", () => {
  it("holds the Continue while the installed agents' bindings are still loading", async () => {
    runtimeBindings.fetch.mockImplementation(() => new Promise(() => {}));
    const published = await mountGate();
    // red-first-expect: promise resolved "undefined" instead of rejecting
    await expectHeld(HOLD_LOADING, published);
  });

  it("holds the Continue of a declared screen whose id is not an :output id while the bindings are loading", async () => {
    // A declared screen may name any local id: the hold reads the binding, not the suffix.
    gate.xRenderer = "@cinatra-test/runtime-agent:confirm";
    runtimeBindings.fetch.mockImplementation(() => new Promise(() => {}));
    const published = await mountGate();
    // red-first-expect: promise resolved "undefined" instead of rejecting
    await expectHeld(HOLD_LOADING, published);
  });

  it("holds the Continue after the bindings fetch failed", async () => {
    runtimeBindings.fetch.mockImplementation(async () => {
      throw new Error("fixture: the bindings fetch failed");
    });
    const published = await mountGate();
    // red-first-expect: promise resolved "undefined" instead of rejecting
    await expectHeld(HOLD_FAILED, published);
  });

  it("holds the Continue when the gate's declared screen did not register", async () => {
    runtimeBindings.fetch.mockImplementation(async () => ({
      bindings: [
        // A screen the registration refuses: a card with no title and no sections.
        { id: RUNTIME_ID, kind: "linkedin-draft-review", priority: 90, midRunHitl: true, screen: { layout: "card" } },
      ],
      refusedScreenIds: [],
    }));
    const published = await mountGate();
    // red-first-expect: promise resolved "undefined" instead of rejecting
    await expectHeld(HOLD_FAILED, published);
  });

  it("holds the Continue when a declared :confirm screen did not register", async () => {
    gate.xRenderer = "@cinatra-test/confirm-agent:confirm";
    runtimeBindings.fetch.mockImplementation(async () => ({
      bindings: [
        { id: gate.xRenderer, kind: "linkedin-draft-review", priority: 90, midRunHitl: true, screen: { layout: "card" } },
      ],
      refusedScreenIds: [],
    }));
    const published = await mountGate();
    // red-first-expect: promise resolved "undefined" instead of rejecting
    await expectHeld(HOLD_FAILED, published);
  });

  it("holds the Continue when the server's validator refused the gate's declared screen", async () => {
    // Another installed agent: the screen above stays known to the page.
    gate.xRenderer = "@cinatra-test/refused-agent:output";
    installed.dir = mkdtempSync(join(tmpdir(), "hold-3470-"));
    try {
      const pkgDir = join(installed.dir, "@cinatra-test", "refused-agent");
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(
        join(pkgDir, "package.json"),
        JSON.stringify({
          name: "@cinatra-test/refused-agent",
          cinatra: {
            fieldRenderers: [
              // A card with no title: the server's validator drops it.
              { id: gate.xRenderer, kind: "linkedin-draft-review", priority: 90, midRunHitl: true, screen: { layout: "card" } },
            ],
          },
        }),
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      let answered: Promise<unknown> | null = null;
      runtimeBindings.fetch.mockImplementation(() => (answered = realRuntimeBindingsAction()));
      const published = await mountGate();
      // The page knew the bindings before (the tests above): wait until the
      // real action answered this page, as the operator's press would.
      await waitFor(() => expect(answered).not.toBeNull());
      // red-first-expect: expected [] to deeply equal { bindings: Any<Array>, …(1) }
      expect(await answered).toEqual({ bindings: expect.any(Array), refusedScreenIds: [gate.xRenderer] });
      await expectHeld(HOLD_FAILED, published);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("title is required"));
    } finally {
      rmSync(installed.dir, { recursive: true, force: true });
      installed.dir = "";
    }
  });

  it("continues as before once the bindings loaded with nothing for the gate", async () => {
    // Another agent's gate: the page still knows the refused screen above.
    gate.xRenderer = "@cinatra-test/other-agent:output";
    runtimeBindings.fetch.mockImplementation(async () => ({ bindings: [], refusedScreenIds: [] }));
    const published = await mountGate();
    await waitFor(() => expect(published.submit).not.toBeNull());
    await waitFor(() => expect(document.body.textContent).toContain("no renderer configured"));
    expect(holdReason()).toBeNull();
    await published.submit!({ decision: "approve" });
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
  });
});
