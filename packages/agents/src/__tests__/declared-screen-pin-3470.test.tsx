// @vitest-environment jsdom
/**
 * cinatra#3470: a parked step is drawn, filled and submitted only under the
 * declared screen it opened under.
 *
 * Read through the PRODUCTION lookup: the installed agents are package
 * manifests in a temporary runtime mount, the park pins the step with the
 * host's own helper (`withDeclaredScreenPin`), and the readers are the HITL
 * screen core, the declared-card read of the assistant's fill and submit, and
 * the run page's runtime bindings read. Pinned here:
 *
 *   - a renderer updated while a step waits makes that step's screen
 *     unavailable, never the new revision's screen and never the fallback;
 *     a step opened with no screen is not drawn with one installed since,
 *     and an uninstalled renderer holds its step too;
 *   - a fresh binding read is made for each step: a read that settled "no
 *     screen" for an earlier step of the same id does not answer for a step
 *     opened after the agent was installed;
 *   - a conversation card that is handed the same declaration again after
 *     losing it never reads its dead registration: its Continue holds until
 *     the declaration is registered again.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/declared-screen-pin-3470.test.tsx
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen as dom, waitFor, within } from "@testing-library/react";

// The host seals each pin it writes with a key derived from the app secret.
process.env.BETTER_AUTH_SECRET ??= "x3470-placeholder-not-a-credential";

const mount = vi.hoisted(() => ({ dir: "" }));
vi.mock("../agent-runtime-mount", () => ({
  resolveAgentRuntimeMountDir: () => {
    if (!mount.dir) throw new Error("fixture mount unset");
    return mount.dir;
  },
}));
// The gate each fixture run is parked on, as the run's own derivation reads it.
const gates = vi.hoisted(() => new Map<string, Record<string, unknown>>());
vi.mock("../hitl-context", () => ({
  deriveRunHitlContext: async (run: { id: string }) => gates.get(run.id) ?? null,
}));
// The conversation card's read; each test says what answers it.
const screenStateMock = vi.hoisted(() => vi.fn());
vi.mock("../agent-hitl-screen-actions", () => ({
  getAgentHitlScreenStateAction: (input: { runId: string }) => screenStateMock(input),
}));
// The run page's runtime bindings read answers what the server answers, or,
// while `bindingReads.failFresh` is set, fails every fresh read it counts.
const bindingReads = vi.hoisted(() => ({ failFresh: false, freshFailed: 0 }));
vi.mock("../server-actions", async () => {
  const server = await import("../field-renderer-bindings.server");
  return {
    getFieldRendererContextForAgentBuilderAction: async () => ({ connectedApps: [], gmailAliases: [] }),
    getRuntimeFieldRendererBindingsAction: async (opts?: { fresh?: boolean }) => {
      if (opts?.fresh === true && bindingReads.failFresh) {
        bindingReads.freshFailed += 1;
        throw new Error("fixture bindings read down");
      }
      return (
        (server as { runtimeFieldRendererBindingsPayload?: (o?: { fresh?: boolean }) => unknown })
          .runtimeFieldRendererBindingsPayload?.(opts) ?? { bindings: [], refusedScreenIds: [] }
      );
    },
  };
});
vi.mock("../list-picker-actions", () => ({
  fetchAvailableLists: vi.fn(async () => []),
}));
const hitlActions = vi.hoisted(() => ({
  approveReviewTask: vi.fn(async (..._args: unknown[]) => ({ ok: true as const })),
  rejectReviewTask: vi.fn(async () => undefined),
}));
vi.mock("../hitl-actions", () => hitlActions);
// What the card's Continue is when its declaration is being registered: the
// probe reads it at the moment of the registration, before the entry exists.
const registration = vi.hoisted(() => ({ probe: null as null | (() => void) }));
vi.mock("../register-default-renderers", async (orig) => {
  const real = await orig<typeof import("../register-default-renderers")>();
  return {
    ...real,
    registerScopedDeclaredScreen: (...args: Parameters<typeof real.registerScopedDeclaredScreen>) => {
      registration.probe?.();
      return real.registerScopedDeclaredScreen(...args);
    },
  };
});

import * as bindingsServer from "../field-renderer-bindings.server";
import * as registry from "../field-renderer-registry";
import * as gateSubmit from "../hitl-gate-submit";
import { agentHitlScreenStateForRun } from "../agent-hitl-screen-core";
import { AgentHitlScreenCard } from "../agent-hitl-screen-card";
import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";

// Read through the modules, so a tree without a reader answers nothing.
const server = bindingsServer as unknown as {
  __clearInstalledFieldRendererBindingsCache: () => void;
  withDeclaredScreenPin?: (schema: Record<string, unknown>, x: string) => Record<string, unknown>;
  readDeclaredHitlCard?: (x: string, stepSchema: unknown) => unknown;
  stepDeclarationStanding?: (x: string, stepSchema: unknown, opts?: { fresh?: boolean }) => unknown;
};
const reg = registry as unknown as {
  readRuntimeRendererBindings?: (freshFor?: string) => Promise<boolean>;
  runtimeRendererBindingsLoad?: () => unknown;
  requestFreshRendererBindingRead?: (x: string, step?: unknown) => void;
  rendererStepOf?: (key: string, schema: Record<string, unknown>) => unknown;
  subscribeRuntimeRendererBindings?: (listener: () => void) => () => void;
  declaredHitlCardOf?: (x: string) => unknown;
};
const submitRules = gateSubmit as unknown as {
  rendererBindingHoldReason?: (x: string, load: unknown, step?: unknown) => string | null;
};

const ID = "@acme-test/pin-agent:confirm";

// Fixture declarations of one binding id across a package revision.
const EARLIER = {
  layout: "card",
  title: "Fixture earlier revision",
  decisionLabel: "Fixture earlier decision",
  decisions: [
    { label: "Fixture earlier hold", answer: { approved: false } },
    { label: "Fixture earlier send", answer: { approved: true } },
  ],
  carry: ["itemId"],
};
const LATER = {
  layout: "card",
  title: "Fixture later revision",
  decisionLabel: "Fixture later decision",
  decisions: [{ label: "Fixture later send", answer: { approved: true, route: "later" } }],
  carry: ["revisionId"],
};
const VALUE = { itemId: "item-1", revisionId: "rev-1" };

/** Install (or update) the fixture agent with `screen` declared for `id`. */
function install(screen: unknown, id = ID): void {
  const [pkg] = id.split(":");
  const [scope, name] = pkg!.slice(1).split("/");
  const dir = join(mount.dir, scope!, name!);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: pkg,
      cinatra: {
        fieldRenderers: [{ id, kind: "linkedin-draft-review", priority: 90, midRunHitl: true, screen }],
      },
    }),
  );
  server.__clearInstalledFieldRendererBindingsCache();
}

function uninstall(id = ID): void {
  const [pkg] = id.split(":");
  rmSync(join(mount.dir, ...pkg!.slice(1).split("/")), { recursive: true, force: true });
  server.__clearInstalledFieldRendererBindingsCache();
}

/** The gate schema the park writes for a step of `id` opened now. */
function parkedSchema(id = ID): Record<string, unknown> {
  const base = { type: "object" };
  return server.withDeclaredScreenPin?.(base, id) ?? base;
}

function runParkedOn(runId: string, reviewTaskId: string, inputSchema: Record<string, unknown>) {
  gates.set(runId, {
    xRenderer: ID,
    childRunId: null,
    reviewTaskId,
    inputSchema,
    currentValues: VALUE,
  });
  return { id: runId, lifecycleMoment: null, lifecycleCardKind: null, lifecycleCardRef: null } as never;
}

beforeEach(() => {
  mount.dir = mkdtempSync(join(tmpdir(), "declared-screen-pin-"));
  server.__clearInstalledFieldRendererBindingsCache();
  gates.clear();
  hitlActions.approveReviewTask.mockClear();
  registration.probe = null;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  rmSync(mount.dir, { recursive: true, force: true });
  mount.dir = "";
  server.__clearInstalledFieldRendererBindingsCache();
  vi.restoreAllMocks();
});

describe("a parked step keeps the declared screen it opened under (cinatra#3470)", () => {
  it("the HITL screen core and the assistant's card read answer the step's own revision, or unavailable", async () => {
    install(EARLIER);
    const openedUnderEarlier = parkedSchema();
    const earlierRun = runParkedOn("run-earlier", "task-earlier", openedUnderEarlier);
    const first = await agentHitlScreenStateForRun(earlierRun);
    // red-first-expect: expected undefined to deeply equal 'Fixture earlier revision'
    expect(first.state === "asking" ? (first.declaredScreen?.screen as { title?: string } | undefined)?.title : null).toEqual(
      "Fixture earlier revision",
    );

    // The agent is updated while the step waits.
    install(LATER);
    const changed = await agentHitlScreenStateForRun(earlierRun);
    expect(changed).toMatchObject({ state: "asking", declaredScreenUnavailable: true });
    expect(changed.state === "asking" && "declaredScreen" in changed).toBe(false);
    expect(server.readDeclaredHitlCard?.(ID, openedUnderEarlier)).toBe("unavailable");

    // A step opened after the update has the later revision.
    const openedUnderLater = parkedSchema();
    const laterRun = runParkedOn("run-later", "task-later", openedUnderLater);
    const later = await agentHitlScreenStateForRun(laterRun);
    expect(later.state === "asking" ? later.declaredScreen?.screen : null).toMatchObject({
      title: "Fixture later revision",
    });
    expect(server.readDeclaredHitlCard?.(ID, openedUnderLater)).toMatchObject({ title: "Fixture later revision" });

    // A step that opened with no screen is not drawn with the one installed since.
    const plainRun = runParkedOn("run-plain", "task-plain", { type: "object" });
    expect(await agentHitlScreenStateForRun(plainRun)).toMatchObject({ declaredScreenUnavailable: true });
    expect(server.readDeclaredHitlCard?.(ID, { type: "object" })).toBe("unavailable");

    // Uninstalled while the step waits: unavailable, never the fallback.
    uninstall();
    expect(await agentHitlScreenStateForRun(laterRun)).toMatchObject({ declaredScreenUnavailable: true });
    expect(server.readDeclaredHitlCard?.(ID, openedUnderLater)).toBe("unavailable");
    // Only the host writes the pin: one the gate's schema carries is replaced.
    install(EARLIER);
    const forgedSeal = `h1:${"0".repeat(64)}`;
    expect(
      server.withDeclaredScreenPin?.({ "x-declared-screen": "forged", "x-declared-screen-seal": forgedSeal }, ID),
    ).toEqual({
      "x-declared-screen": openedUnderEarlier["x-declared-screen"],
      "x-declared-screen-seal": openedUnderEarlier["x-declared-screen-seal"],
    });
    uninstall();
    expect(
      server.withDeclaredScreenPin?.(
        { type: "object", "x-declared-screen": "forged", "x-declared-screen-seal": forgedSeal },
        ID,
      ),
    ).toEqual({
      type: "object",
    });
  });

  it("a conversation card of a step opened under the earlier revision holds; the later step's card draws its own", async () => {
    install(EARLIER);
    const earlierRun = runParkedOn("run-earlier", "task-earlier", parkedSchema());
    install(LATER);
    const laterRun = runParkedOn("run-later", "task-later", parkedSchema());
    const runs = new Map([
      ["run-earlier", earlierRun],
      ["run-later", laterRun],
    ]);
    screenStateMock.mockImplementation(async (input: { runId: string }) =>
      agentHitlScreenStateForRun(runs.get(input.runId)!),
    );
    const view = render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <div data-testid="earlier">
          <AgentHitlScreenCard runId="run-earlier" wireRef="task-earlier" />
        </div>
        <div data-testid="later">
          <AgentHitlScreenCard runId="run-later" wireRef="task-later" />
        </div>
      </LifecycleCardSurfaceProvider>,
    );
    const earlier = within(dom.getByTestId("earlier"));
    const later = within(dom.getByTestId("later"));
    // red-first-expect: expected 0 to be greater than 0
    await waitFor(() => expect(later.queryAllByRole("radio").length).toBeGreaterThan(0));
    await waitFor(() => expect(earlier.getByText(/could not be loaded/i)).toBeTruthy());
    // The earlier step is never drawn with the later revision's decision.
    expect(earlier.queryByText("Fixture later decision")).toBeNull();
    expect(earlier.queryAllByRole("radio")).toHaveLength(0);
    const held = earlier.getByRole("button", { name: /^continue$/i }) as HTMLButtonElement;
    expect(held.disabled).toBe(true);
    await act(async () => {
      fireEvent.click(held);
      await new Promise((r) => setTimeout(r, 20));
    });
    // The later step answers with its own revision.
    fireEvent.click(later.getByRole("radio", { name: "Fixture later send" }));
    await act(async () => {
      fireEvent.click(later.getByRole("button", { name: /^continue$/i }));
      await new Promise((r) => setTimeout(r, 20));
    });
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    expect(hitlActions.approveReviewTask.mock.calls[0]![0]).toBe("task-later");
    expect(hitlActions.approveReviewTask.mock.calls[0]![1]).toMatchObject({ route: "later", approved: true });
    view.unmount();
    // No card's declaration is left behind for any other surface to resolve.
    expect(registry.fieldRendererRegistry.list().filter((e) => e.id.startsWith(ID))).toEqual([]);
  });
});

describe("the run page reads its bindings fresh for each step (cinatra#3470)", () => {
  const FRESH_ID = "@acme-test/fresh-step-agent:confirm";
  const hold = (step: unknown) =>
    submitRules.rendererBindingHoldReason?.(FRESH_ID, reg.runtimeRendererBindingsLoad?.(), step) ?? null;

  it("a step opened after the agent was installed is not settled by an earlier step's 'no screen'", async () => {
    // The page read its bindings while nothing declares the id.
    await reg.readRuntimeRendererBindings?.();
    const stepBefore = reg.rendererStepOf?.("task-before", parkedSchema(FRESH_ID));
    // red-first-expect: expected null to be 'This step\'s screen is still loading.'
    expect(hold(stepBefore)).toBe("This step's screen is still loading.");
    reg.requestFreshRendererBindingRead?.(FRESH_ID, stepBefore);
    // The fresh read made for that step settles it: no screen.
    await waitFor(() => expect(hold(stepBefore)).toBeNull());

    // The agent is installed with a declared screen while the page stays open,
    // and the run parks on a later step of the same id.
    install(LATER, FRESH_ID);
    const stepAfter = reg.rendererStepOf?.("task-after", parkedSchema(FRESH_ID));
    // The earlier step's read is no answer for it: it is held, not a fallback.
    expect(hold(stepAfter)).toBe("This step's screen is still loading.");
    reg.requestFreshRendererBindingRead?.(FRESH_ID, stepAfter);
    await waitFor(() => expect(hold(stepAfter)).toBeNull());
    expect(reg.declaredHitlCardOf?.(FRESH_ID)).toMatchObject({ title: "Fixture later revision" });
    // The earlier step opened with no screen: the one installed since is not its own.
    expect(hold(stepBefore)).toBe(
      "This step's screen was changed after the step opened, so it cannot be answered. Stop the run to end it.",
    );
  });
});

describe("a step whose fresh read keeps failing is asked a bounded number of times (cinatra#3470)", () => {
  const FAIL_ID = "@acme-test/fail-agent:confirm";
  const hold = (step: unknown) =>
    submitRules.rendererBindingHoldReason?.(FAIL_ID, reg.runtimeRendererBindingsLoad?.(), step) ?? null;

  it("every render and notification asks no further read, and the step is held as could not be loaded", async () => {
    install(EARLIER, FAIL_ID);
    const parked = parkedSchema(FAIL_ID);
    // The agent is updated: the page's answer pins another declaration than
    // the step's, so the step waits for a read made for it.
    install(LATER, FAIL_ID);
    await reg.readRuntimeRendererBindings?.();
    const step = reg.rendererStepOf?.("task-fail", parked);
    // red-first-expect: expected null to be 'This step\'s screen is still loading.'
    expect(hold(step)).toBe("This step's screen is still loading.");
    bindingReads.failFresh = true;
    bindingReads.freshFailed = 0;
    vi.useFakeTimers();
    // A host asks again on every notification and every render, as the run
    // page's effect does. The listener stops itself so a loop still ends.
    let notified = 0;
    const unsubscribe = reg.subscribeRuntimeRendererBindings?.(() => {
      notified += 1;
      if (notified < 200) reg.requestFreshRendererBindingRead?.(FAIL_ID, step);
    });
    try {
      reg.requestFreshRendererBindingRead?.(FAIL_ID, step);
      for (let render = 0; render < 30; render += 1) {
        await vi.advanceTimersByTimeAsync(1_000);
        reg.requestFreshRendererBindingRead?.(FAIL_ID, step);
      }
      expect(bindingReads.freshFailed).toBeLessThanOrEqual(3);
      expect(bindingReads.freshFailed).toBeGreaterThanOrEqual(1);
      expect(hold(step)).toBe("This step's screen could not be loaded. Reload the page to try again.");
    } finally {
      unsubscribe?.();
      vi.useRealTimers();
      bindingReads.failFresh = false;
      uninstall(FAIL_ID);
      await reg.readRuntimeRendererBindings?.();
    }
  });
});

describe("a conversation card never reads a registration it gave up (cinatra#3470)", () => {
  it("a declaration that goes away and comes back holds the Continue until it is registered again", async () => {
    const asking = (declared: boolean) => ({
      state: "asking" as const,
      runId: "run-back",
      screenRef: null,
      gate: {
        reviewTaskId: "task-back",
        xRenderer: ID,
        inputSchema: { type: "object", properties: { note: { type: "string" } } },
        currentValues: VALUE,
        fieldName: null,
      },
      ...(declared
        ? { declaredScreen: { id: ID, kind: "linkedin-draft-review", priority: 90, midRunHitl: true, screen: EARLIER } }
        : {}),
    });
    const reads = [asking(true), asking(false), asking(true)];
    screenStateMock.mockImplementation(async () => reads.shift() ?? asking(true));
    const { container } = render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <AgentHitlScreenCard runId="run-back" wireRef="task-back" />
      </LifecycleCardSurfaceProvider>,
    );
    const card = within(container);
    // red-first-expect: expected 0 to be greater than 0
    await waitFor(() => expect(card.queryAllByRole("radio").length).toBeGreaterThan(0));
    // The declaration goes away …
    await act(async () => {
      fireEvent.focus(window);
      await new Promise((r) => setTimeout(r, 20));
    });
    await waitFor(() => expect(card.queryAllByRole("radio")).toHaveLength(0));
    // … and the same one comes back. Until it is registered again, the card
    // draws no control that sends and never the step as a gate with no
    // renderer: what it registered before is gone.
    const drawnAtRegistration: string[] = [];
    registration.probe = () => {
      const enabled = Array.from(container.querySelectorAll("button"))
        .filter((b) => !(b as HTMLButtonElement).disabled)
        .map((b) => b.textContent ?? "");
      drawnAtRegistration.push(
        enabled.length > 0
          ? `a control that sends: ${enabled.join(", ")}`
          : (container.textContent ?? "").includes("no renderer configured")
            ? "a gate with no renderer"
            : "held",
      );
    };
    await act(async () => {
      fireEvent.focus(window);
      await new Promise((r) => setTimeout(r, 20));
    });
    await waitFor(() => expect(card.queryAllByRole("radio").length).toBeGreaterThan(0));
    expect(drawnAtRegistration).toEqual(["held"]);
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
  });
});

describe("a conversation card never resolves a binding registered under its step's renderer id (cinatra#3470)", () => {
  it("a run page's registration of the later revision is not drawn for a step opened under the earlier one", async () => {
    install(EARLIER);
    const earlierRun = runParkedOn("run-collide", "task-collide", parkedSchema());
    install(LATER);
    // A run page read the installed agents: the later revision is registered
    // under the renderer id itself, for every surface of this browser.
    await reg.readRuntimeRendererBindings?.();
    screenStateMock.mockImplementation(async () => agentHitlScreenStateForRun(earlierRun));
    try {
      const { container } = render(
        <LifecycleCardSurfaceProvider host="chat_thread">
          <AgentHitlScreenCard runId="run-collide" wireRef="task-collide" />
        </LifecycleCardSurfaceProvider>,
      );
      const card = within(container);
      // red-first-expect: Unable to find role="button" and name `/^continue$/i`
      await waitFor(() => expect(card.getByRole("button", { name: /^continue$/i })).toBeTruthy());
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
      expect(card.queryByText("Fixture later decision")?.textContent ?? null).toBeNull();
      expect(card.queryAllByRole("radio")).toHaveLength(0);
      expect(card.getByText(/could not be loaded/i)).toBeTruthy();
      const held = card.getByRole("button", { name: /^continue$/i }) as HTMLButtonElement;
      expect(held.disabled).toBe(true);
      await act(async () => {
        fireEvent.click(held);
        await new Promise((r) => setTimeout(r, 20));
      });
      expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
    } finally {
      cleanup();
      // The run page's registration is withdrawn by its next complete read.
      uninstall();
      await reg.readRuntimeRendererBindings?.();
    }
  });

  it("a failed binding read holds the Continue even over a binding registered under the id", async () => {
    install(LATER);
    await reg.readRuntimeRendererBindings?.();
    try {
      const failed = {
        status: "failed",
        announcedIds: new Set<string>(),
        freshlyReadIds: "every",
        refusedIds: new Set<string>(),
      };
      // red-first-expect: expected null to be 'This step\'s screen could not be load
      expect(submitRules.rendererBindingHoldReason?.(ID, failed) ?? null).toBe(
        "This step's screen could not be loaded. Reload the page to try again.",
      );
      // The binding was registered under the id: the hold is not its absence.
      expect(registry.fieldRendererRegistry.list().some((e) => e.id === ID)).toBe(true);
    } finally {
      uninstall();
      await reg.readRuntimeRendererBindings?.();
    }
  });
});

describe("an installed screen of a bundled renderer id supersedes its generated binding (cinatra#3470)", () => {
  // A bundled renderer id: the generated map carries it, with no screen.
  const BUNDLED_ID = "@cinatra-ai/blog-linkedin-publish-agent:draft-review";
  const hold = (step: unknown) =>
    submitRules.rendererBindingHoldReason?.(BUNDLED_ID, reg.runtimeRendererBindingsLoad?.(), step) ?? null;

  it("the park pins it, the server reads it, the run page draws it, and uninstalling it brings back the bundled entry", async () => {
    ensureDefaultFieldRenderersRegistered();
    const bundled = registry.fieldRendererRegistry.list().find((e) => e.id === BUNDLED_ID);
    expect(bundled?.declaredScreen).toBeUndefined();
    // A runtime revision of the bundled agent adds a declared screen.
    install(LATER, BUNDLED_ID);
    const parked = parkedSchema(BUNDLED_ID);
    // red-first-expect: expected undefined to match object { title: 'Fixture later revision' }
    expect(server.readDeclaredHitlCard?.(BUNDLED_ID, parked)).toMatchObject({ title: "Fixture later revision" });
    expect(String(parked["x-declared-screen"])).toMatch(/^sha256:/);
    expect(server.stepDeclarationStanding?.(BUNDLED_ID, parked, { fresh: true })).toBe("matches");
    // A step opened under the generated binding (no screen) is not answered
    // without the screen installed since.
    expect(server.readDeclaredHitlCard?.(BUNDLED_ID, { type: "object" })).toBe("unavailable");
    expect(server.stepDeclarationStanding?.(BUNDLED_ID, { type: "object" }, { fresh: true })).toBe("changed");

    // The run page registers the installed screen over the bundled entry.
    await reg.readRuntimeRendererBindings?.();
    expect(reg.declaredHitlCardOf?.(BUNDLED_ID)).toMatchObject({ title: "Fixture later revision" });
    expect(hold(reg.rendererStepOf?.("task-bundled", parked))).toBeNull();

    // Uninstalled: the bundled entry is registered again, not left absent.
    uninstall(BUNDLED_ID);
    await reg.readRuntimeRendererBindings?.();
    expect(registry.fieldRendererRegistry.list().filter((e) => e.id === BUNDLED_ID)).toEqual([bundled]);
    expect(server.readDeclaredHitlCard?.(BUNDLED_ID, { type: "object" })).toBeNull();
  });

  it("a step opened under the generated binding is held while the binding read is loading or has failed", () => {
    ensureDefaultFieldRenderersRegistered();
    // The generated binding is registered at once, before any read answered.
    expect(registry.fieldRendererRegistry.list().some((e) => e.id === BUNDLED_ID)).toBe(true);
    // A step parked with no screen (no pin): an installed revision may declare one now.
    const step = reg.rendererStepOf?.("task-bundled-unread", { type: "object" });
    const at = (status: "loading" | "failed") =>
      submitRules.rendererBindingHoldReason?.(
        BUNDLED_ID,
        { status, announcedIds: new Set<string>(), freshlyReadIds: new Set<string>(), refusedIds: new Set<string>() },
        step,
      ) ?? null;
    // red-first-expect: expected null to be 'This step\'s screen is still loading.'
    expect(at("loading")).toBe("This step's screen is still loading.");
    // red-first-expect: expected null to be 'This step\'s screen could not be load
    expect(at("failed")).toBe("This step's screen could not be loaded. Reload the page to try again.");
  });

  it("a refused installed screen of a bundled id holds its step, never the generated binding", async () => {
    // A card with no title: the validator refuses the installed declaration.
    install({ layout: "card" }, BUNDLED_ID);
    try {
      // red-first-expect: expected undefined to be 'unavailable'
      expect(server.readDeclaredHitlCard?.(BUNDLED_ID, parkedSchema(BUNDLED_ID))).toBe("unavailable");
      await reg.readRuntimeRendererBindings?.();
      expect(hold(reg.rendererStepOf?.("task-bundled-refused", { type: "object" }))).toBe(
        "This step's screen could not be loaded. Reload the page to try again.",
      );
    } finally {
      uninstall(BUNDLED_ID);
      await reg.readRuntimeRendererBindings?.();
    }
  });
});

describe("only the package that owns a bundled renderer id may supersede its screen (cinatra#3470)", () => {
  const BUNDLED_ID = "@cinatra-ai/blog-linkedin-publish-agent:draft-review";
  /** Mount `<vendor>/<slug>` with a manifest named `name` that declares `screen` for the bundled id. */
  function mountForeign(vendor: string, slug: string, name: string): void {
    const dir = join(mount.dir, vendor, slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name,
        cinatra: {
          fieldRenderers: [
            { id: BUNDLED_ID, kind: "linkedin-draft-review", priority: 90, midRunHitl: true, screen: LATER },
          ],
        },
      }),
    );
    server.__clearInstalledFieldRendererBindingsCache();
  }

  it("a foreign package's screen for a bundled id never supersedes the generated binding", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    ensureDefaultFieldRenderersRegistered();
    const bundled = registry.fieldRendererRegistry.list().find((e) => e.id === BUNDLED_ID);
    // Another package, and a manifest that claims the owner's name from another mount directory.
    for (const [vendor, slug, name] of [
      ["acme-test", "foreign-agent", "@acme-test/foreign-agent"],
      ["acme-test", "forged-agent", "@cinatra-ai/blog-linkedin-publish-agent"],
    ] as const) {
      mountForeign(vendor, slug, name);
      const parked = parkedSchema(BUNDLED_ID);
      // red-first-expect: expected undefined to be null
      expect(server.readDeclaredHitlCard?.(BUNDLED_ID, parked)).toBeNull();
      expect(parked["x-declared-screen"]).toBeUndefined();
      expect(server.stepDeclarationStanding?.(BUNDLED_ID, { type: "object" }, { fresh: true })).toBe("matches");
      await reg.readRuntimeRendererBindings?.();
      expect(registry.fieldRendererRegistry.list().filter((e) => e.id === BUNDLED_ID)).toEqual([bundled]);
      expect(
        submitRules.rendererBindingHoldReason?.(
          BUNDLED_ID,
          reg.runtimeRendererBindingsLoad?.(),
          reg.rendererStepOf?.(`task-foreign-${slug}`, parked),
        ),
      ).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("the declaration is refused"));
      rmSync(join(mount.dir, vendor), { recursive: true, force: true });
      server.__clearInstalledFieldRendererBindingsCache();
      warn.mockClear();
    }
  });
});

describe("a declaration that could not be read at the park is never pinned as no screen (cinatra#3470)", () => {
  const UNREAD_ID = "@acme-test/unread-agent:confirm";
  const hold = (step: unknown) =>
    submitRules.rendererBindingHoldReason?.(UNREAD_ID, reg.runtimeRendererBindingsLoad?.(), step) ?? null;

  it("the step is held while it cannot be read, then answered under the declaration that reads cleanly", async () => {
    // The agent's manifest cannot be parsed: the scan is incomplete.
    const dir = join(mount.dir, "acme-test", "unread-agent");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), "{ not json");
    server.__clearInstalledFieldRendererBindingsCache();
    const parked = parkedSchema(UNREAD_ID);
    // red-first-expect: expected undefined to be 'unknown'
    expect(parked["x-declared-screen"]).toBe("unknown");
    expect(server.stepDeclarationStanding?.(UNREAD_ID, parked, { fresh: true })).toBe("unknown");
    expect(server.readDeclaredHitlCard?.(UNREAD_ID, parked)).toBe("unavailable");

    // The manifest is readable again, and declares a screen.
    install(EARLIER, UNREAD_ID);
    expect(server.stepDeclarationStanding?.(UNREAD_ID, parked, { fresh: true })).toBe("matches");
    expect(server.readDeclaredHitlCard?.(UNREAD_ID, parked)).toMatchObject({ title: "Fixture earlier revision" });
    gates.set("run-unread", {
      xRenderer: UNREAD_ID,
      childRunId: null,
      reviewTaskId: "task-unread",
      inputSchema: parked,
      currentValues: VALUE,
    });
    const state = await agentHitlScreenStateForRun({
      id: "run-unread",
      lifecycleMoment: null,
      lifecycleCardKind: null,
      lifecycleCardRef: null,
    } as never);
    expect(state.state === "asking" ? (state.declaredScreen?.screen as { title?: string } | undefined)?.title : null).toBe(
      "Fixture earlier revision",
    );

    // The run page waits for a read made for the step, then draws it.
    await reg.readRuntimeRendererBindings?.();
    const step = reg.rendererStepOf?.("task-unread", parked);
    expect(hold(step)).toBe("This step's screen is still loading.");
    reg.requestFreshRendererBindingRead?.(UNREAD_ID, step);
    await waitFor(() => expect(hold(step)).toBeNull());
    expect(reg.declaredHitlCardOf?.(UNREAD_ID)).toMatchObject({ title: "Fixture earlier revision" });
    uninstall(UNREAD_ID);
    await reg.readRuntimeRendererBindings?.();
  });
});

describe("a runtime registration gives back the entry it replaced (cinatra#3470)", () => {
  it("uninstalling the installed binding that shadowed a host-owned renderer restores that renderer", async () => {
    const HOST_ID = "@acme-test/host-owned:confirm";
    const builtIn = { id: HOST_ID, priority: 10, condition: () => false, renderer: () => null };
    registry.fieldRendererRegistry.register(builtIn as never);
    try {
      install(LATER, HOST_ID);
      await reg.readRuntimeRendererBindings?.();
      // red-first-expect: expected undefined to match object { title: 'Fixture later revision' }
      expect(reg.declaredHitlCardOf?.(HOST_ID)).toMatchObject({ title: "Fixture later revision" });
      uninstall(HOST_ID);
      await reg.readRuntimeRendererBindings?.();
      expect(registry.fieldRendererRegistry.list().filter((e) => e.id === HOST_ID)).toEqual([builtIn]);
    } finally {
      (registry.fieldRendererRegistry as { unregisterEntry?: (e: never) => void }).unregisterEntry?.(builtIn as never);
    }
  });
});

describe("a step that declares no screen is never drawn with a screen an earlier read registered (cinatra#3470)", () => {
  it("a screen removed since a run page registered it is not drawn for a later step of the same id, and the page's registry drops it", async () => {
    install(LATER);
    // A run page read the installed agents: the declared screen is registered
    // under the renderer id itself, for every surface of this browser.
    await reg.readRuntimeRendererBindings?.();
    // red-first-expect: expected undefined to match object { title: 'Fixture later revision' }
    expect(reg.declaredHitlCardOf?.(ID)).toMatchObject({ title: "Fixture later revision" });
    // The screen is removed (the binding stays, with no screen), and a later
    // step of the same id opens with none.
    install(undefined);
    const laterRun = runParkedOn("run-removed", "task-removed", parkedSchema());
    screenStateMock.mockImplementation(async () => agentHitlScreenStateForRun(laterRun));
    try {
      const { container } = render(
        <LifecycleCardSurfaceProvider host="chat_thread">
          <AgentHitlScreenCard runId="run-removed" wireRef="task-removed" />
        </LifecycleCardSurfaceProvider>,
      );
      const card = within(container);
      await waitFor(() => expect(screenStateMock).toHaveBeenCalled());
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
      expect(card.queryAllByRole("radio")).toHaveLength(0);
      expect(card.queryByText("Fixture later decision")?.textContent ?? null).toBeNull();
      // The page's registry no longer holds the removed screen under the id.
      await waitFor(() => expect(reg.declaredHitlCardOf?.(ID)).toBeUndefined());
      expect(card.queryAllByRole("radio")).toHaveLength(0);
    } finally {
      cleanup();
      uninstall();
      await reg.readRuntimeRendererBindings?.();
    }
  });
});
