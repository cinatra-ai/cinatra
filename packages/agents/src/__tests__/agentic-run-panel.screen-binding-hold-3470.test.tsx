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
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
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
  fetch: vi.fn(async (_input?: { fresh?: boolean }): Promise<unknown> => ({ bindings: [], refusedScreenIds: [] })),
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
  getRuntimeFieldRendererBindingsAction: (input?: { fresh?: boolean }) => runtimeBindings.fetch(input),
}));

vi.mock("../agent-ui-override-registry", () => ({
  agentUIOverrideRegistry: { resolve: () => null },
}));

/** A runtime-installed agent's screen: mid-run by its suffix, no binding in the build. */
const RUNTIME_ID = "@cinatra-test/runtime-agent:output";
const REVIEW_TASK_ID = "wayflow-task-3470";
/** The gate the stream hands the panel (a test may name another, and its schema). */
const DECISION_SCHEMA = { type: "object", properties: { decision: { type: "string", enum: ["approve", "revise"] } } };
const gate: { xRenderer: string; schema: Record<string, unknown> } = { xRenderer: RUNTIME_ID, schema: DECISION_SCHEMA };
const HOLD_LOADING = "This step's screen is still loading.";
const HOLD_FAILED = "This step's screen could not be loaded. Reload the page to try again.";

vi.mock("../use-ag-ui-run-stream", () => ({
  useAgUiRunStream: vi.fn(() => ({
    status: "pending_approval",
    error: null,
    presentationHint: null,
    isLive: true,
    interruptContext: {
      schema: gate.schema,
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
  gate.schema = DECISION_SCHEMA;
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
      // red-first-expect: expected [] to deeply equal { bindings: Any<Array>, …(2) }
      expect(await answered).toEqual({
        bindings: expect.any(Array),
        refusedScreenIds: [gate.xRenderer],
        screenPins: {},
      });
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
    // Only a fresh read of the installed agents says the gate declares nothing.
    // red-first-expect: expected "vi.fn()" to be called with arguments
    await waitFor(() => expect(runtimeBindings.fetch).toHaveBeenCalledWith({ fresh: true }));
    // Once it answered, the gate continues as before.
    await waitFor(() => published.submit!({ decision: "approve" }));
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
  });

  // The page's bindings loaded before this gate arrived, and the answer it
  // reads now may be a cached scan taken before its agent was installed. A
  // gate whose id that answer does not name is held until a fresh read of the
  // installed agents answers for it.
  it("holds the Continue of a gate the loaded bindings do not name until a fresh read answers for it", async () => {
    gate.xRenderer = "@cinatra-test/late-agent:output";
    runtimeBindings.fetch.mockImplementation((input?: { fresh?: boolean }) =>
      input?.fresh === true
        ? new Promise(() => {})
        : Promise.resolve({ bindings: [], refusedScreenIds: [] }),
    );
    const published = await mountGate();
    await waitFor(() => expect(runtimeBindings.fetch).toHaveBeenCalled());
    // red-first-expect: promise resolved "undefined" instead of rejecting
    await expectHeld(HOLD_LOADING, published);
  });

  // A declared grouped setup form sends from its own control, which validates
  // the form first: the panel draws no Continue beside it, so nothing sends the
  // approval without the form's values.
  it("draws no outer Continue beside a declared grouped setup form, and its invalid form sends nothing", async () => {
    gate.xRenderer = "@cinatra-test/setup-agent:details";
    gate.schema = {
      type: "object",
      properties: { projectName: { type: "string", title: "Project name" } },
      required: ["projectName"],
    };
    runtimeBindings.fetch.mockImplementation(async () => ({
      bindings: [
        { id: gate.xRenderer, kind: "wayflow-setup-form", priority: 80, midRunHitl: true, screen: { layout: "kind" } },
      ],
      refusedScreenIds: [],
    }));
    await mountGate();
    const formSubmit = await waitFor(() => {
      const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
        /save & start run/i.test(b.textContent ?? ""),
      );
      expect(button).toBeDefined();
      return button!;
    });
    // red-first-expect: expected <button data-slot="button"
    expect(gateContinue()).toBeNull();
    await act(async () => {
      fireEvent.click(formSubmit);
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
  });

  // THE RUNTIME ANSWER IS THE WHOLE INSTALLED SET. An agent uninstalled, or a
  // screen refused, since an earlier read in the same page lifetime leaves no
  // usable renderer behind it; a registration this road did not make stays.
  it("unregisters a runtime binding a later answer no longer names, and keeps a static one", async () => {
    const removed = "@cinatra-test/removed-agent:output";
    const staticId = "@cinatra-test/static-agent:output";
    gate.xRenderer = removed;
    runtimeBindings.fetch.mockImplementation(async () => ({
      bindings: [{ id: removed, kind: "linkedin-draft-review", priority: 90, midRunHitl: true }],
      refusedScreenIds: [],
    }));
    await mountGate();
    const bound = (id: string) => fieldRendererRegistry.list().some((e) => e.id === id);
    // A tree whose read answers another shape registers nothing here.
    // red-first-expect: expected false to be true
    await waitFor(() => expect(bound(removed)).toBe(true));
    cleanup();
    // A registration the runtime road did not make.
    const { registerFieldRendererBindings } = await import("../register-default-renderers");
    registerFieldRendererBindings([{ id: staticId, kind: "linkedin-draft-review", priority: 90, midRunHitl: true }]);
    // The agent is uninstalled: the next answer names nothing.
    runtimeBindings.fetch.mockImplementation(async () => ({ bindings: [], refusedScreenIds: [] }));
    await mountGate();
    await waitFor(() => expect(runtimeBindings.fetch).toHaveBeenCalled());
    await waitFor(() => expect(bound(removed)).toBe(false));
    expect(bound(staticId)).toBe(true);
  });

  it("holds a screen the answer now refuses, over the binding an earlier answer registered", async () => {
    const refusedLater = "@cinatra-test/refused-later-agent:output";
    gate.xRenderer = refusedLater;
    // An earlier version of the agent declared a binding with no screen.
    runtimeBindings.fetch.mockImplementation(async () => ({
      bindings: [{ id: refusedLater, kind: "linkedin-draft-review", priority: 90, midRunHitl: true }],
      refusedScreenIds: [],
    }));
    await mountGate();
    // red-first-expect: expected false to be true
    await waitFor(() => expect(fieldRendererRegistry.list().some((e) => e.id === refusedLater)).toBe(true));
    cleanup();
    // The agent is upgraded to a screen the server's validator refuses.
    runtimeBindings.fetch.mockImplementation(async () => ({ bindings: [], refusedScreenIds: [refusedLater] }));
    const published = await mountGate();
    await waitFor(() => expect(holdReason()).toBe(HOLD_FAILED));
    await expectHeld(HOLD_FAILED, published);
  });

  it("holds a gate an answer that could not read every installed agent does not name", async () => {
    gate.xRenderer = "@cinatra-test/unread-agent:output";
    runtimeBindings.fetch.mockImplementation(async () => ({ bindings: [], refusedScreenIds: [], incomplete: true }));
    const published = await mountGate();
    // red-first-expect: expected null to be 'This step
    await waitFor(() => expect(holdReason()).toBe(HOLD_FAILED));
    expect(runtimeBindings.fetch).toHaveBeenCalledWith({ fresh: true });
    await expectHeld(HOLD_FAILED, published);
  });
});
