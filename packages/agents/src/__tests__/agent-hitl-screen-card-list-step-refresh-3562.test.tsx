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
import { AgentHitlScreenCard, hitlGateKey, type AgentHitlScreenCarrier } from "../agent-hitl-screen-card";
import { GROUPED_SETUP_FORM_RENDERER_ID } from "../agent-builder-ids";

const RUN_ID = "run-3562";
const LIST_STEP_ID = "@cinatra-test/pack-agent-refresh:list-picker";
const OTHER_STEP_ID = "@cinatra-test/pack-agent-refresh:output";

function askingOn(xRenderer: string, currentValues: Record<string, unknown> = { lists: [], listsRead: "failed" }) {
  return {
    state: "asking" as const,
    runId: RUN_ID,
    screenRef: "hitl-screen-ref-3562",
    gate: {
      reviewTaskId: "task-list-1",
      xRenderer,
      inputSchema: { type: "object" },
      currentValues,
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

/**
 * THE SHIPPED LIST PICKER (cinatra#3562). A list binding with no shipped
 * component resolves, through the real registration road, to the host's own
 * `ListPickerRenderer`, the renderer the application mounts for the list step
 * today. It draws the design's failed-read alert with Try again, the loading
 * reading while the new read is pending, and the lists the read returns.
 */
const HOST_STEP_ID = "@cinatra-test/pack-agent-host:list-picker";

describe("AgentHitlScreenCard — the shipped list picker's Try again (cinatra#3562)", () => {
  function mountHostPicker() {
    __setFieldRendererComponentMapForTests({});
    registerFieldRendererBindings([{ id: HOST_STEP_ID, kind: "list-picker", priority: 80 }]);
    listActions.fetchAvailableLists.mockRejectedValue(new Error("search failed"));
  }

  afterEach(() => {
    listActions.fetchAvailableLists.mockImplementation(async () => []);
    __resetFieldRendererComponentMapForTests();
  });

  // red-first-expect: Unable to find role="alert"
  it("a failed first read draws the alert with Try again; a press reads again for the gate, draws the loading reading, then the lists", async () => {
    mountHostPicker();
    let resolveRead: (value: unknown) => void = () => {};
    listActions.readListStepContent.mockImplementationOnce(
      () => new Promise((resolve) => { resolveRead = resolve as (value: unknown) => void; }) as never,
    );
    asking = askingOn(HOST_STEP_ID);
    mountOn("chat_thread");
    await settle();
    const alert = await screen.findByRole("alert", undefined, { timeout: 3000 });
    expect(alert.textContent).toContain("This list could not be read.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByTestId("list-picker-loading")).toBeTruthy());
    expect(listActions.readListStepContent).toHaveBeenCalledTimes(1);
    expect(listActions.readListStepContent).toHaveBeenCalledWith(RUN_ID, "task-list-1");
    resolveRead({ lists: [{ id: "l-9", name: "Read again" }], listsRead: "ok" });
    await screen.findByText("Read again");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByTestId("list-picker-loading")).toBeNull();
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
    expect(hitlActions.rejectReviewTask).not.toHaveBeenCalled();
  });

  // red-first-expect: Unable to find role="alert"
  it("a failed re-read draws the alert again, with Try again", async () => {
    mountHostPicker();
    listActions.readListStepContent.mockResolvedValueOnce({ lists: [], listsRead: "failed" } as never);
    asking = askingOn(HOST_STEP_ID);
    mountOn("chat_thread");
    await settle();
    await screen.findByRole("alert", undefined, { timeout: 3000 });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(listActions.readListStepContent).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId("list-picker-loading")).toBeNull());
    expect(screen.getByRole("alert").textContent).toContain("This list could not be read.");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  // red-first-expect: expected "vi.fn()" to be called at least once
  it("a row picked after Try again is what the card's Continue sends, in the approval note", async () => {
    mountHostPicker();
    asking = askingOn(HOST_STEP_ID);
    mountOn("chat_thread");
    await settle();
    await screen.findByRole("alert", undefined, { timeout: 3000 });
    const continueButton = () => screen.getByRole("button", { name: /continue/i }) as HTMLButtonElement;
    expect(continueButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    fireEvent.click(await screen.findByText("Read again"));
    // The pick buffers into the card's Continue; nothing is sent on the pick.
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
    await waitFor(() => expect(continueButton().disabled).toBe(false));
    fireEvent.click(continueButton());
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    const [taskId, sent] = hitlActions.approveReviewTask.mock.calls[0] as unknown as [string, { approvalNote?: string; userResponse?: unknown }];
    expect(taskId).toBe("task-list-1");
    expect(sent.userResponse).toBeUndefined();
    expect(JSON.parse(sent.approvalNote ?? "{}")).toMatchObject({ type: "list", listId: "l-9", listName: "Read again" });
  });

  // red-first-expect: expected "vi.fn()" to be called at least once
  it("a restored choice the first read still offers is what Continue sends", async () => {
    __setFieldRendererComponentMapForTests({});
    registerFieldRendererBindings([{ id: HOST_STEP_ID, kind: "list-picker", priority: 80 }]);
    listActions.fetchAvailableLists.mockResolvedValue([{ id: "l-9", name: "Read again", memberCount: null, lastUpdated: null, memberType: "contact" }] as never);
    asking = askingOn(HOST_STEP_ID, { scope: "list", listId: "l-9", listName: "Read again", memberCount: 0 });
    mountOn("chat_thread");
    await settle();
    await screen.findByText("Read again", undefined, { timeout: 3000 });
    expect(screen.getByRole("button", { pressed: true })).toBeTruthy();
    const continueButton = () => screen.getByRole("button", { name: /continue/i }) as HTMLButtonElement;
    await waitFor(() => expect(continueButton().disabled).toBe(false));
    fireEvent.click(continueButton());
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalled());
    const sent = (hitlActions.approveReviewTask.mock.calls[0] as unknown[])[1] as { approvalNote?: string };
    expect(JSON.parse(sent.approvalNote ?? "{}")).toMatchObject({ type: "list", listId: "l-9", listName: "Read again" });
  });

  // A CARRIED PICK THE STEP NO LONGER OFFERS (cinatra#3562). The renderer
  // assumes nothing about what the host holds: the first good read writes the
  // reconciled pick, and a failed read leaves Continue unavailable through
  // the step's validity report.
  const CARRIED_A = { scope: "list", listId: "l-1", listName: "Carried A", memberCount: 3 };
  const LIST_A = { id: "l-1", name: "Carried A", memberCount: 3, lastUpdated: null, memberType: "contact" };
  const LIST_9 = { id: "l-9", name: "Read again", memberCount: null, lastUpdated: null, memberType: "contact" };
  function bindHostPicker() {
    __setFieldRendererComponentMapForTests({});
    registerFieldRendererBindings([{ id: HOST_STEP_ID, kind: "list-picker", priority: 80 }]);
  }
  // The card was moved mid-answer: its box carries the pick, typed into this
  // gate, and the gate's own values name none.
  async function mountCarried(buffered: Record<string, unknown>) {
    asking = askingOn(HOST_STEP_ID, {});
    const carrier: AgentHitlScreenCarrier = {
      current: { runId: RUN_ID, state: null, gateKey: hitlGateKey(asking.gate as unknown as Parameters<typeof hitlGateKey>[0]), buffered },
    };
    render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <AgentHitlScreenCard runId={RUN_ID} wireRef="task-list-1" carrier={carrier} />
      </LifecycleCardSurfaceProvider>,
    );
    await settle();
    return carrier;
  }
  const continueOf = () => screen.getByRole("button", { name: /continue/i }) as HTMLButtonElement;

  it("a carried pick a refreshed read no longer offers: Continue unavailable, nothing sent, and a new pick is what Continue sends", async () => {
    bindHostPicker();
    listActions.fetchAvailableLists.mockResolvedValue([LIST_9] as never);
    const carrier = await mountCarried(CARRIED_A);
    await screen.findByText("Read again", undefined, { timeout: 3000 });
    expect(screen.queryByRole("button", { pressed: true })).toBeNull();
    await waitFor(() => expect(continueOf().disabled).toBe(true));
    fireEvent.click(continueOf());
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
    // The card's buffer, and the box it carries, hold no carried pick.
    expect(carrier.current?.buffered.listId ?? "").toBe("");
    fireEvent.click(screen.getByText("Read again"));
    await waitFor(() => expect(continueOf().disabled).toBe(false));
    fireEvent.click(continueOf());
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    const sent = (hitlActions.approveReviewTask.mock.calls[0] as unknown[])[1] as { approvalNote?: string };
    const note = JSON.parse(sent.approvalNote ?? "{}");
    expect(note).toMatchObject({ type: "list", listId: "l-9", listName: "Read again" });
    expect(JSON.stringify(note)).not.toContain("l-1");
  });

  it("a carried pick and a failed read: Continue unavailable, nothing sent", async () => {
    bindHostPicker();
    listActions.fetchAvailableLists.mockRejectedValue(new Error("search failed"));
    await mountCarried(CARRIED_A);
    await screen.findByRole("alert", undefined, { timeout: 3000 });
    await waitFor(() => expect(continueOf().disabled).toBe(true));
    fireEvent.click(continueOf());
    await new Promise((r) => setTimeout(r, 0));
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
  });

  it("a carried pick the read still offers is what Continue sends", async () => {
    bindHostPicker();
    listActions.fetchAvailableLists.mockResolvedValue([LIST_A, LIST_9] as never);
    await mountCarried(CARRIED_A);
    await screen.findByText("Carried A", undefined, { timeout: 3000 });
    await waitFor(() => expect(continueOf().disabled).toBe(false));
    fireEvent.click(continueOf());
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    const sent = (hitlActions.approveReviewTask.mock.calls[0] as unknown[])[1] as { approvalNote?: string };
    expect(JSON.parse(sent.approvalNote ?? "{}")).toMatchObject({ type: "list", listId: "l-1", listName: "Carried A" });
  });
});

/**
 * A SETUP LIST STEP ON THE CARD (cinatra#3562). The card owns the setup send
 * (the list picker draws no submit of its own): the step's change stages, and
 * the card's own Continue submits what is staged. That Continue is held on
 * the step's validity report, as the mid-run one is.
 */
describe("AgentHitlScreenCard — a setup list step's Continue follows the step's validity report (cinatra#3562)", () => {
  const SETUP_TASK = `setup-${RUN_ID}`;
  const RESTORED_A = { scope: "list", listId: "l-1", listName: "Carried A", memberCount: 3 };
  const LIST_A = { id: "l-1", name: "Carried A", memberCount: 3, lastUpdated: null, memberType: "contact" };
  const LIST_9 = { id: "l-9", name: "Read again", memberCount: null, lastUpdated: null, memberType: "contact" };

  async function mountSetupListStep() {
    __setFieldRendererComponentMapForTests({});
    registerFieldRendererBindings([{ id: HOST_STEP_ID, kind: "list-picker", priority: 80 }]);
    asking = {
      ...askingOn(HOST_STEP_ID),
      gate: {
        reviewTaskId: SETUP_TASK,
        xRenderer: HOST_STEP_ID,
        inputSchema: {
          type: "object",
          properties: { targetList: { type: "object" } },
          required: ["targetList"],
        } as unknown as { type: string },
        currentValues: { targetList: RESTORED_A },
        fieldName: "targetList" as unknown as undefined,
      },
    };
    render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <AgentHitlScreenCard runId={RUN_ID} wireRef={SETUP_TASK} />
      </LifecycleCardSurfaceProvider>,
    );
    await settle();
  }
  const continueOf = () => screen.getByRole("button", { name: /continue/i }) as HTMLButtonElement;

  afterEach(() => {
    listActions.fetchAvailableLists.mockImplementation(async () => []);
    __resetFieldRendererComponentMapForTests();
  });

  // red-first-expect: expected false to be true
  it("a restored list the read no longer offers: Continue unavailable, a press sends nothing", async () => {
    listActions.fetchAvailableLists.mockResolvedValue([LIST_9] as never);
    await mountSetupListStep();
    await screen.findByText("Read again", undefined, { timeout: 3000 });
    await waitFor(() => expect(continueOf().disabled).toBe(true));
    fireEvent.click(continueOf());
    await settle();
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
  });

  // red-first-expect: expected false to be true
  it("a failed read: Continue unavailable, a press sends nothing", async () => {
    listActions.fetchAvailableLists.mockRejectedValue(new Error("search failed"));
    await mountSetupListStep();
    await screen.findByRole("alert", undefined, { timeout: 3000 });
    await waitFor(() => expect(continueOf().disabled).toBe(true));
    fireEvent.click(continueOf());
    await settle();
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
  });

  it("a restored list the read still offers is what Continue sends, under the field's name", async () => {
    listActions.fetchAvailableLists.mockResolvedValue([LIST_A, LIST_9] as never);
    await mountSetupListStep();
    await screen.findByText("Carried A", undefined, { timeout: 3000 });
    await waitFor(() => expect(continueOf().disabled).toBe(false));
    fireEvent.click(continueOf());
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    const [taskId, sent] = hitlActions.approveReviewTask.mock.calls[0] as unknown as [string, unknown];
    expect(taskId).toBe(SETUP_TASK);
    expect(JSON.stringify(sent)).toContain('"listId":"l-1"');
  });
});

/**
 * EVERY PRESS READS THE REPORT AGAIN (cinatra#3562). The card keeps the
 * renderer's validity reports in the store the run panel and the stepper use,
 * and each of its sends reads it at the press: a report the drawn Continue has
 * not caught up with holds the press too.
 */
describe("AgentHitlScreenCard — a press reads the step's validity report again (cinatra#3562)", () => {
  /** Writes an answer at mount; its button reports the answer unsendable and
   *  presses the card's Continue in the same turn, before the card redraws. */
  function WithdrawsThenPresses({ onChange, onValidityChange }: FieldRendererProps) {
    React.useLayoutEffect(() => {
      void onChange({ userResponse: "ok" });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return (
      <Button
        type="button"
        onClick={() => {
          onValidityChange?.(false);
          (document.querySelector('[data-action="submit-hitl-screen"]') as HTMLButtonElement | null)?.click();
        }}
      >
        Withdraw and press
      </Button>
    );
  }
  /** A grouped form: its own submit reports the answer unsendable, then submits. */
  function WithdrawsThenSubmits({ onChange, onValidityChange }: FieldRendererProps) {
    return (
      <Button
        type="button"
        onClick={() => {
          onValidityChange?.(false);
          void onChange({ topic: "x" });
        }}
      >
        Submit the form
      </Button>
    );
  }
  function bindOnly(id: string, renderer: (props: FieldRendererProps) => React.ReactElement) {
    fieldRendererRegistry.clear();
    fieldRendererRegistry.register({
      id,
      priority: 90,
      condition: (_f, _s, ctx) => ctx.xRenderer === id,
      renderer,
      credentialSafe: true,
    });
  }

  // red-first-expect: expected "vi.fn()" to not be called at all, but actually been called 1 times
  it("the mid-run Continue pressed before the card redraws sends nothing", async () => {
    bindOnly(OTHER_STEP_ID, WithdrawsThenPresses);
    asking = askingOn(OTHER_STEP_ID, {});
    mountOn("chat_thread");
    await settle();
    const continueOf = () => screen.getByRole("button", { name: /continue/i }) as HTMLButtonElement;
    await waitFor(() => expect(continueOf().disabled).toBe(false), { timeout: 3000 });
    fireEvent.click(screen.getByRole("button", { name: "Withdraw and press" }));
    await settle();
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
    expect(continueOf().disabled).toBe(true);
  });

  // red-first-expect: expected "vi.fn()" to not be called at all, but actually been called 1 times
  it("a grouped form's own submit made with its report false sends nothing", async () => {
    const GROUPED = `${GROUPED_SETUP_FORM_RENDERER_ID}:output`;
    bindOnly(GROUPED, WithdrawsThenSubmits);
    asking = askingOn(GROUPED, {});
    mountOn("chat_thread");
    await settle();
    fireEvent.click(await screen.findByRole("button", { name: "Submit the form" }, { timeout: 3000 }));
    await settle();
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
  });
});

/**
 * cinatra#3562 — THE BARE ALIAS `list-picker`. The shipped picker answers it
 * (a list binding registers it beside the qualified id), and the card treats
 * the step as a qualified one (`declaresListPicker`): the pick is lifted into
 * the note, no pick sends nothing, and Try again is offered and reads again.
 */
describe("AgentHitlScreenCard — the bare alias `list-picker` (cinatra#3562)", () => {
  const BARE_STEP_ID = "list-picker";
  const BARE_LIST_9 = { id: "l-9", name: "Read again", memberCount: null, lastUpdated: null, memberType: "contact" };
  const continueOf = () => screen.getByRole("button", { name: /continue/i }) as HTMLButtonElement;
  async function mountBare() {
    __setFieldRendererComponentMapForTests({});
    registerFieldRendererBindings([{ id: HOST_STEP_ID, kind: "list-picker", priority: 80 }]);
    asking = askingOn(BARE_STEP_ID, {});
    mountOn("chat_thread");
    await settle();
  }

  afterEach(() => {
    listActions.fetchAvailableLists.mockImplementation(async () => []);
    __resetFieldRendererComponentMapForTests();
  });

  // red-first-expect: expected {} to match object
  it("a pick is lifted into the note Continue sends", async () => {
    listActions.fetchAvailableLists.mockResolvedValue([BARE_LIST_9] as never);
    await mountBare();
    fireEvent.click(await screen.findByText("Read again", undefined, { timeout: 3000 }));
    await waitFor(() => expect(continueOf().disabled).toBe(false));
    fireEvent.click(continueOf());
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    const sent = (hitlActions.approveReviewTask.mock.calls[0] as unknown[])[1] as { approvalNote?: string };
    expect(JSON.parse(sent.approvalNote ?? "{}")).toMatchObject({ type: "list", listId: "l-9", listName: "Read again" });
  });

  it("no pick: Continue unavailable, nothing sent", async () => {
    listActions.fetchAvailableLists.mockResolvedValue([BARE_LIST_9] as never);
    await mountBare();
    await screen.findByText("Read again", undefined, { timeout: 3000 });
    await waitFor(() => expect(continueOf().disabled).toBe(true));
    fireEvent.click(continueOf());
    await settle();
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
  });

  it("a failed read offers Try again, and a press reads again for the gate", async () => {
    listActions.fetchAvailableLists.mockRejectedValue(new Error("search failed"));
    await mountBare();
    await screen.findByRole("alert", undefined, { timeout: 3000 });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("Read again");
    expect(listActions.readListStepContent).toHaveBeenCalledWith(RUN_ID, "task-list-1");
    expect(hitlActions.approveReviewTask).not.toHaveBeenCalled();
  });
});

/**
 * cinatra#3562 — TWO QUESTIONS DECIDE A LIST STEP'S ROAD. Whether the renderer
 * is the list picker (`declaresListPicker`: bare alias or qualified id), and
 * whether the pause is a mid-run step or a setup step (its review task id). On
 * a setup step the pick is sent under the field's name; on a mid-run step it
 * is lifted into the approval note.
 */
describe("AgentHitlScreenCard — a list step's road follows the pause, for the bare alias and a qualified id (cinatra#3562)", () => {
  const LIST_9 = { id: "l-9", name: "Read again", memberCount: null, lastUpdated: null, memberType: "contact" };
  const continueOf = () => screen.getByRole("button", { name: /continue/i }) as HTMLButtonElement;
  async function mountPausedAt(xRenderer: string, reviewTaskId: string, fieldName?: string) {
    __setFieldRendererComponentMapForTests({});
    registerFieldRendererBindings([{ id: HOST_STEP_ID, kind: "list-picker", priority: 80 }]);
    listActions.fetchAvailableLists.mockResolvedValue([LIST_9] as never);
    const base = askingOn(xRenderer, {});
    asking = {
      ...base,
      gate: {
        ...base.gate,
        reviewTaskId,
        ...(fieldName
          ? {
              inputSchema: {
                type: "object",
                properties: { [fieldName]: { type: "object" } },
                required: [fieldName],
              } as unknown as { type: string },
              fieldName: fieldName as unknown as undefined,
            }
          : {}),
      },
    };
    render(
      <LifecycleCardSurfaceProvider host="chat_thread">
        <AgentHitlScreenCard runId={RUN_ID} wireRef={reviewTaskId} />
      </LifecycleCardSurfaceProvider>,
    );
    await settle();
    fireEvent.click(await screen.findByText("Read again", undefined, { timeout: 3000 }));
    await waitFor(() => expect(continueOf().disabled).toBe(false));
    fireEvent.click(continueOf());
    await waitFor(() => expect(hitlActions.approveReviewTask).toHaveBeenCalledTimes(1));
    return hitlActions.approveReviewTask.mock.calls[0] as unknown as [string, Record<string, unknown>];
  }

  afterEach(() => {
    listActions.fetchAvailableLists.mockImplementation(async () => []);
    __resetFieldRendererComponentMapForTests();
  });

  for (const xRenderer of ["list-picker", HOST_STEP_ID]) {
    it(`${xRenderer} on a setup step: the pick is sent under the field's name`, async () => {
      const [taskId, sent] = await mountPausedAt(xRenderer, `setup-${RUN_ID}`, "targetList");
      expect(taskId).toBe(`setup-${RUN_ID}`);
      expect(sent.targetList).toMatchObject({ listId: "l-9", listName: "Read again" });
      expect(sent.listId).toBeUndefined();
      expect(sent.approvalNote).toBeUndefined();
    });

    it(`${xRenderer} on a mid-run step: the pick is lifted into the note`, async () => {
      const [taskId, sent] = await mountPausedAt(xRenderer, "wayflow-task-1");
      expect(taskId).toBe("wayflow-task-1");
      expect(JSON.parse(String(sent.approvalNote ?? "{}"))).toMatchObject({ type: "list", listId: "l-9", listName: "Read again" });
    });
  }
});
