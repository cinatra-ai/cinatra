// @vitest-environment jsdom
/**
 * THE CONVERSATION HANDS THE PANEL THE SLUG "START NEW RUN" NEEDS
 * (cinatra#3002, fix leg 4).
 *
 * The fourth proof round read "Start new run" absent from the completion card
 * on the chat mount on all four of its frames. Two things withheld it, and this
 * file holds the wrapper's half: `InlineAgentRunCard` mounted `AgenticRunPanel`
 * with `templateId` (the builder's HITL-assist identifier) and no `agentId` at
 * all, so even with the panel's own surface gate gone the conversation had no
 * template slug to give the button.
 *
 * The slug is the one the run page's own route is built from —
 * `/agents/{vendor}/{packageName}` — i.e. the run's package name with its npm
 * scope marker removed. The seed already carries that package name for renderer
 * override resolution; this is the same value, in the form the run route and
 * `createAndTriggerRun` read.
 *
 * `AgenticRunPanel` is stubbed: these pins are about what the WRAPPER derives
 * and forwards; the drawn control is pinned in the agents package.
 *
 * Run:
 *   cd packages/chat && pnpm exec vitest run \
 *     src/__tests__/inline-agent-run-card-start-new-run.test.tsx
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { LifecycleCardSurfaceProvider } from "@cinatra-ai/agents/lifecycle-card-runtime";

const panelProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock("@cinatra-ai/agents/client-entry", () => ({
  AgenticRunPanel: (props: Record<string, unknown>) => {
    panelProps.current = props;
    return <div data-testid="run-panel-stub" />;
  },
}));

vi.mock("../use-agent-creation-progress", () => ({
  useAgentCreationProgress: () => [],
}));

import { InlineAgentRunCard } from "../inline-agent-run-card";

/** `/chat`'s own declaration — the host these pins are taken on. */
function chatThread(children: React.ReactNode) {
  return (
    <LifecycleCardSurfaceProvider host="chat_thread">{children}</LifecycleCardSurfaceProvider>
  );
}

const RUN_ID = "85bd2267-3f9a-4f0d-a1da-bb3a54f1a50d";
const PACKAGE = "@cinatra-ai/blog-draft-writer-agent";
/** The same package, in the form the run route and the run-create action read. */
const SLUG = "cinatra-ai/blog-draft-writer-agent";

function seedResponse(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      status: "completed",
      error: null,
      inputParams: {},
      templateId: "tmpl-1",
      agentPackageName: PACKAGE,
      agUiEnabled: true,
      taskId: null,
      traceId: null,
      messages: [],
      hitlContext: null,
      ...over,
    }),
  } as unknown as Response;
}

beforeEach(() => {
  panelProps.current = null;
  cleanup();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("InlineAgentRunCard — the template slug for Start new run (cinatra#3002)", () => {
  it("forwards the run's package as the panel's agentId, scope marker removed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => seedResponse()));

    render(chatThread(<InlineAgentRunCard runId={RUN_ID} />));

    await waitFor(() => expect(panelProps.current).not.toBeNull());
    expect(panelProps.current!.agentId).toBe(SLUG);
  });

  it("does NOT hand the builder's templateId over as the slug", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => seedResponse()));

    render(chatThread(<InlineAgentRunCard runId={RUN_ID} />));

    await waitFor(() => expect(panelProps.current).not.toBeNull());
    // templateId still rides for the HITL-assist endpoints, and is not the slug.
    expect(panelProps.current!.templateId).toBe("tmpl-1");
    expect(panelProps.current!.agentId).not.toBe("tmpl-1");
  });

  // CONVERGENCE ROUND, 2026-09-05: stripping the scope marker is not enough to
  // make a route. `/agents/{vendor}/{packageName}` needs TWO segments, and an
  // unscoped package name strips to one — a create that resolves by bare name
  // and then a navigation to a path with no page behind it. The shape is
  // checked, and an unusable one yields no control rather than a broken one.
  it("gives no slug when the package name carries no vendor segment", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => seedResponse({ agentPackageName: "blog-draft-writer-agent" })),
    );

    render(chatThread(<InlineAgentRunCard runId={RUN_ID} />));

    await waitFor(() => expect(panelProps.current).not.toBeNull());
    expect(panelProps.current!.agentId).toBeUndefined();
  });

  it("gives no slug when the package name has more than two segments", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => seedResponse({ agentPackageName: "@cinatra-ai/agents/nested" })),
    );

    render(chatThread(<InlineAgentRunCard runId={RUN_ID} />));

    await waitFor(() => expect(panelProps.current).not.toBeNull());
    expect(panelProps.current!.agentId).toBeUndefined();
  });

  it("gives no slug at all when the run's package is unknown", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => seedResponse({ agentPackageName: null })));

    render(chatThread(<InlineAgentRunCard runId={RUN_ID} />));

    await screen.findByTestId("run-panel-stub");
    await waitFor(() => expect(panelProps.current).not.toBeNull());
    // Better no control than one that routes nowhere — the card's documented
    // behaviour for a caller without a slug.
    expect(panelProps.current!.agentId).toBeUndefined();
  });
});
