// @vitest-environment jsdom
/**
 * cinatra#3470: THE HOST'S ONE CONTINUE SENDS A DECLINE AS A DECLINE.
 *
 * On a declared publish step the agent's two choices only stage an answer, and
 * the host's one Continue beneath them sends it: "a decline is sent as a
 * decline, and nothing is posted" (design app-artifact-review I.4 and I.5).
 * Before this fix every Continue built `{ ...staged, approved: true }`, so a
 * staged `approved: false` left as an approval. Pinned here:
 *
 *   - the shared flag every mid-run Continue builds its payload with
 *     (`continueApprovalFlag`, used by the run panel, the stepper panel and the
 *     HITL screen card);
 *   - on the HITL screen card: a renderer that staged `approved: false` is sent
 *     with `approved: false`, and an untouched gate still continues as an
 *     approval;
 *   - end to end: a declared card's "decline" choice reaches the server action
 *     as `approved: false` with its carried keys.
 *
 * Harness mirrors agent-hitl-screen-card-boolean-4310.test.tsx.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/continue-sends-decline-3470.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

const screenStateMock = vi.fn();
vi.mock("../agent-hitl-screen-actions", () => ({
  getAgentHitlScreenStateAction: (input: { runId: string }) => screenStateMock(input),
}));

const approveMock = vi.fn(
  async (_taskId: string, _values?: unknown, _fieldName?: string) => ({ ok: true as const }),
);
vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: async () => ({
    connectedApps: [],
    gmailAliases: [],
  }),
}));

vi.mock("../hitl-actions", () => ({
  approveReviewTask: (taskId: string, values?: unknown, fieldName?: string) =>
    approveMock(taskId, values, fieldName),
  rejectReviewTask: vi.fn(async () => undefined),
}));

import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { fieldRendererRegistry, type FieldRendererProps } from "../field-renderer-registry";
import {
  ensureDefaultFieldRenderersRegistered,
  registerFieldRendererBindings,
} from "../register-default-renderers";
import { AgentHitlScreenCard } from "../agent-hitl-screen-card";
import { continueApprovalFlag } from "../hitl-gate-submit";
import { Button } from "@/components/ui/button";

const RUN_ID = "run-3470";
const TASK_ID = "task-3470";
const PROBE_ID = "@acme-test/probe-agent:confirm";
const DECLARED_ID = "@acme-test/publish-agent:confirm";

/** A mid-run renderer whose one control stages a decline. */
function DeclineProbe({ onChange }: FieldRendererProps) {
  return (
    <Button type="button" onClick={() => onChange({ approved: false, itemId: "item-1" })}>
      Fixture decline
    </Button>
  );
}

function asking(xRenderer: string, currentValues: Record<string, unknown> = {}) {
  return {
    state: "asking" as const,
    runId: RUN_ID,
    screenRef: "hitl-screen-ref-3470",
    gate: {
      reviewTaskId: TASK_ID,
      xRenderer,
      inputSchema: { type: "object" },
      currentValues,
      fieldName: undefined,
    },
  };
}

let current = asking(PROBE_ID);
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  fieldRendererRegistry.clear();
  ensureDefaultFieldRenderersRegistered();
  fieldRendererRegistry.register({
    id: PROBE_ID,
    priority: 100,
    condition: (_f, schema) => (schema as { "x-renderer"?: unknown })["x-renderer"] === PROBE_ID,
    renderer: DeclineProbe,
    credentialSafe: true,
    midRunHitl: true,
  });
  current = asking(PROBE_ID);
  screenStateMock.mockImplementation(async () => current);
  approveMock.mockClear();
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(current), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  fieldRendererRegistry.clear();
  ensureDefaultFieldRenderersRegistered();
  vi.clearAllMocks();
});

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 20));
    await Promise.resolve();
  });
}

function mount() {
  return render(
    <LifecycleCardSurfaceProvider host="run_card">
      <AgentHitlScreenCard runId={RUN_ID} wireRef={TASK_ID} />
    </LifecycleCardSurfaceProvider>,
  );
}

/** The site widget: no cookie session, a declared credential instead. */
function mountOnSiteWidget() {
  return render(
    <LifecycleCardSurfaceProvider
      host="site_widget"
      auth={{ headers: () => ({ Authorization: "Bearer cwu_site" }), credentials: "omit" }}
      frame={{ assistant: "a", instanceId: "i" }}
    >
      <AgentHitlScreenCard runId={RUN_ID} wireRef={TASK_ID} />
    </LifecycleCardSurfaceProvider>,
  );
}

/** A declared publish card with two choices (fixture words). */
function registerDeclaredPublishCard() {
  registerFieldRendererBindings([
    {
      id: DECLARED_ID,
      kind: "linkedin-draft-review",
      priority: 90,
      midRunHitl: true,
      screen: {
        layout: "card",
        title: "Fixture publish step",
        sections: [{ type: "words", key: "content" }],
        decisions: [
          { label: "Fixture do not send", answer: { approved: false } },
          { label: "Fixture send", answer: { approved: true } },
        ],
        carry: ["itemId", "revisionId"],
        requires: ["itemId", "revisionId"],
      },
    },
  ]);
  current = asking(DECLARED_ID, { itemId: "item-1", revisionId: "rev-1", content: "Fixture words" });
}

function button(container: HTMLElement, name: RegExp): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
    name.test(b.textContent ?? ""),
  );
}

async function pressContinue(container: HTMLElement) {
  await waitFor(() => expect(button(container, /^Continue/)).toBeDefined());
  fireEvent.click(button(container, /^Continue/)!);
  await waitFor(() => expect(approveMock).toHaveBeenCalledTimes(1));
  return (approveMock.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
}

describe("continueApprovalFlag (cinatra#3470)", () => {
  it("keeps a staged decline and continues everything else as an approval", () => {
    expect(continueApprovalFlag({ approved: false })).toBe(false);
    expect(continueApprovalFlag({ approved: true })).toBe(true);
    expect(continueApprovalFlag({})).toBe(true);
    expect(continueApprovalFlag({ approved: "false" })).toBe(true);
  });
});

describe("the HITL screen card's Continue (cinatra#3470)", () => {
  it("sends a staged decline as a decline", async () => {
    const { container } = mount();
    await settle();
    await waitFor(() => expect(button(container, /Fixture decline/)).toBeDefined());
    fireEvent.click(button(container, /Fixture decline/)!);
    await settle();
    expect(approveMock).not.toHaveBeenCalled();
    const payload = await pressContinue(container);
    expect(payload.approved).toBe(false);
    expect(payload.itemId).toBe("item-1");
  });

  it("an untouched gate still continues as an approval", async () => {
    const { container } = mount();
    await settle();
    const payload = await pressContinue(container);
    expect(payload.approved).toBe(true);
  });

  it("a declared card's decline reaches the server as a decline, with its carried keys", async () => {
    registerDeclaredPublishCard();
    const { container } = mount();
    await settle();
    await waitFor(() => expect(button(container, /Fixture do not send/)).toBeDefined());
    fireEvent.click(button(container, /Fixture do not send/)!);
    await settle();
    expect(approveMock).not.toHaveBeenCalled();
    const payload = await pressContinue(container);
    expect(payload).toMatchObject({ approved: false, itemId: "item-1", revisionId: "rev-1" });
  });
});

describe("a declared card on the site widget (cinatra#3470)", () => {
  it("is drawn on a credential-only host, and its Continue is not withheld", async () => {
    registerDeclaredPublishCard();
    const { container } = mountOnSiteWidget();
    await settle();
    await waitFor(() => expect(button(container, /Fixture do not send/)).toBeDefined());
    expect(button(container, /^Fixture send/)).toBeDefined();
    fireEvent.click(button(container, /Fixture do not send/)!);
    await settle();
    const go = container.querySelector<HTMLButtonElement>('[data-action="submit-hitl-screen"]');
    expect(go).not.toBeNull();
    expect(go!.disabled).toBe(false);
    expect(go!.getAttribute("title")).toBeNull();
  });
});
