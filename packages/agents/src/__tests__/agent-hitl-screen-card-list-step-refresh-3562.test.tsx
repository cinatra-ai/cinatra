// @vitest-environment jsdom
/**
 * cinatra#3562 — THE SCREEN CARD HANDS A WAITING LIST STEP ITS TRY AGAIN.
 *
 * On a host with the reader's own session, the card's `:list-picker` gate gets
 * the shared props contract's `onRequestRefresh`. A press reads the lists
 * again through the host's server read for that gate (run and review task),
 * and the renderer draws the answer in place. The press answers no gate. A
 * host without a session (the site widget) and a step of another renderer get
 * no prop.
 *
 * Harness mirrors agent-hitl-screen-card.test.tsx.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { LifecycleCardHost } from "@cinatra-ai/agent-ui-protocol/renderable-views";
import { Button } from "@/components/ui/button";
import type { FieldRendererProps } from "../field-renderer-registry";
import { registerFieldRendererBindings } from "../register-default-renderers";
import {
  __resetFieldRendererComponentMapForTests,
  __setFieldRendererComponentMapForTests,
} from "../field-renderer-components";

const screenStateMock = vi.fn();
vi.mock("../agent-hitl-screen-actions", () => ({
  getAgentHitlScreenStateAction: (input: { runId: string }) => screenStateMock(input),
}));

vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({ connectedApps: [] })),
}));

const hitlActions = vi.hoisted(() => ({
  approveReviewTask: vi.fn(async () => undefined),
  rejectReviewTask: vi.fn(async () => undefined),
}));
vi.mock("../hitl-actions", () => hitlActions);

const listActions = vi.hoisted(() => ({
  fetchAvailableLists: vi.fn(async () => []),
  readListStepContent: vi.fn(async () => ({
    lists: [{ id: "l-9", name: "Read again" }],
    listsRead: "ok" as const,
  })),
}));
vi.mock("../list-picker-actions", () => listActions);

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { fieldRendererRegistry } from "../field-renderer-registry";
import { AgentHitlScreenCard } from "../agent-hitl-screen-card";

const RUN_ID = "run-3562";
const LIST_STEP_ID = "@cinatra-test/pack-agent-refresh:list-picker";
const OTHER_STEP_ID = "@cinatra-test/pack-agent-refresh:output";

function askingOn(xRenderer: string) {
  return {
    state: "asking" as const,
    runId: RUN_ID,
    screenRef: "hitl-screen-ref-3562",
    gate: {
      reviewTaskId: "task-list-1",
      xRenderer,
      inputSchema: { type: "object" },
      currentValues: { lists: [], listsRead: "failed" },
      fieldName: undefined,
    },
  };
}

/** A pack-shaped list step: draws Try again only when the host offers it. */
function RefreshingStep({ value, onRequestRefresh }: FieldRendererProps) {
  const [shown, setShown] = React.useState<unknown>(value);
  return (
    <div>
      <p data-testid="offers-refresh">{onRequestRefresh ? "yes" : "no"}</p>
      {onRequestRefresh ? (
        <Button type="button" onClick={() => void onRequestRefresh().then(setShown)}>
          Try again
        </Button>
      ) : null}
      <p data-testid="shown">{JSON.stringify(shown)}</p>
    </div>
  );
}

const WIDGET_AUTH = {
  headers: () => ({ Authorization: "Bearer test-widget-credential" }),
  credentials: "omit" as const,
};

let originalFetch: typeof globalThis.fetch;
let asking: ReturnType<typeof askingOn>;

beforeEach(() => {
  fieldRendererRegistry.clear();
  for (const id of [LIST_STEP_ID, OTHER_STEP_ID]) {
    fieldRendererRegistry.register({
      id,
      priority: 90,
      condition: (_f, _s, ctx) => ctx.xRenderer === id,
      renderer: RefreshingStep,
      // Drawn on the widget too, so the widget case reads the prop, not a withheld region.
      credentialSafe: true,
    });
  }
  asking = askingOn(LIST_STEP_ID);
  screenStateMock.mockImplementation(async () => asking);
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(asking), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
});

afterEach(() => {
  fieldRendererRegistry.clear();
  globalThis.fetch = originalFetch;
  cleanup();
  vi.clearAllMocks();
});

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    await Promise.resolve();
  });
}

function mountOn(host: LifecycleCardHost) {
  const auth = host === "site_widget" ? WIDGET_AUTH : undefined;
  const frame = host === "site_widget" ? { assistant: "a", instanceId: "i" } : undefined;
  return render(
    <LifecycleCardSurfaceProvider host={host} auth={auth} frame={frame}>
      <AgentHitlScreenCard runId={RUN_ID} wireRef="task-list-1" />
    </LifecycleCardSurfaceProvider>,
  );
}

describe("AgentHitlScreenCard — a waiting list step's Try again (cinatra#3562)", () => {
  // red-first-expect: expected 'no' to be 'yes'
  it("reads the lists again for the gate and draws the answer, with no answer to the gate", async () => {
    mountOn("chat_thread");
    await settle();
    await waitFor(() => expect(screen.getByTestId("offers-refresh").textContent).toBe("yes"));

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() =>
      expect(screen.getByTestId("shown").textContent).toBe(
        JSON.stringify({ lists: [{ id: "l-9", name: "Read again" }], listsRead: "ok" }),
      ),
    );
    expect(listActions.readListStepContent).toHaveBeenCalledTimes(1);
    expect(listActions.readListStepContent).toHaveBeenCalledWith(RUN_ID, "task-list-1");
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
    expect(hitlActions.rejectReviewTask).not.toHaveBeenCalled();
  });

  it("a host without the reader's session offers no new read", async () => {
    mountOn("site_widget");
    await settle();
    await waitFor(() => expect(screen.getByTestId("offers-refresh").textContent).toBe("no"));
    expect(listActions.readListStepContent).not.toHaveBeenCalled();
  });

  it("a step of another renderer is offered no new read", async () => {
    asking = askingOn(OTHER_STEP_ID);
    mountOn("chat_thread");
    await settle();
    await waitFor(() => expect(screen.getByTestId("offers-refresh").textContent).toBe("no"));
  });
});

/**
 * THE PACK'S COMPONENT, RESOLVED AS A PINNED PACK'S IS. A binding whose
 * component is in the build's component map resolves, through the real
 * registration road (`registerFieldRendererBindings`), to the extension
 * wrapper that loads the pack-shipped component. The stand-in below takes the
 * place of the pack's list step; the prop must reach it through that road.
 */
const SHIPPED_STEP_ID = "@cinatra-test/pack-agent-shipped:list-picker";

describe("AgentHitlScreenCard — the prop reaches a pack-shipped component through the registry (cinatra#3562)", () => {
  // red-first-expect: Unable to find an element by: [data-testid="shipped-offers-refresh"]
  it("a list binding with a shipped component gets onRequestRefresh, and its press reads again", async () => {
    function ShippedListStep({ onRequestRefresh }: FieldRendererProps) {
      const [shown, setShown] = React.useState<unknown>(null);
      if (!onRequestRefresh) return <p data-testid="shipped-without-refresh">no Try again</p>;
      return (
        <div>
          <p data-testid="shipped-offers-refresh">yes</p>
          <Button type="button" onClick={() => void onRequestRefresh().then(setShown)}>
            Try again
          </Button>
          <p data-testid="shipped-shown">{JSON.stringify(shown)}</p>
        </div>
      );
    }
    __setFieldRendererComponentMapForTests({
      [SHIPPED_STEP_ID]: {
        resolution: "guardedOptional",
        packageName: "@cinatra-test/pack-agent-shipped",
        propsApiVersion: 1,
        load: async () => ({ default: ShippedListStep }),
      },
    });
    try {
      registerFieldRendererBindings([{ id: SHIPPED_STEP_ID, kind: "list-picker", priority: 80 }]);
      asking = askingOn(SHIPPED_STEP_ID);
      mountOn("chat_thread");
      await settle();
      await screen.findByTestId("shipped-offers-refresh", undefined, { timeout: 3000 });
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await waitFor(() =>
        expect(screen.getByTestId("shipped-shown").textContent).toBe(
          JSON.stringify({ lists: [{ id: "l-9", name: "Read again" }], listsRead: "ok" }),
        ),
      );
      expect(listActions.readListStepContent).toHaveBeenCalledWith(expect.any(String), "task-list-1");
    } finally {
      __resetFieldRendererComponentMapForTests();
    }
  });
});
