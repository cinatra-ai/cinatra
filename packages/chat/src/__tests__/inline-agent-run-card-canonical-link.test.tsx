// @vitest-environment jsdom
/**
 * THE CHAT RUN CARD HAS NO LINK OUT ANY MORE (cinatra#2997), AND IT KEEPS THE
 * STATE THE RUN API HANDED IT (cinatra#2729 defect 2).
 *
 * THE LINK IS GONE, and this file is where its removal is held. The maintainer's
 * request for changes on pull request 2890, verbatim: "Also, the 'Open the run
 * page' link in the top right below the 'Agentic Run Progress' card should be
 * removed." The whole run lifecycle plays out in the card now — the placeholder
 * while the agent works, the review screen when the work opens one — so there is
 * nothing left in the conversation that a trip to the run page would answer.
 *
 * WHAT THIS FILE USED TO PIN, and why the pins are inverted rather than deleted.
 * cinatra#2729 defect 1 was a link the MODEL wrote (`/agents/runs/<runId>` — an
 * API path with no page behind it, so the one link out of the conversation
 * 404'd), replaced by a platform-built one. A defect about a wrong link is
 * closed for good by a card that draws none, so the strongest reading of those
 * pins is the negative one below: no link, on any seed, including the one whose
 * package name used to produce the canonical path.
 *
 * `AgenticRunPanel` is stubbed: these pins are about what the WRAPPER derives
 * and forwards, and the panel's own rendering is pinned in the agents package.
 *
 * THE CARD IS RENDERED UNDER ITS HOST DECLARATION (cinatra#2902). In production
 * it always is — `/chat` mounts the conversation list inside
 * `<LifecycleCardSurfaceProvider host="chat_thread">` and the widget inside its
 * own. The seed now asks with whichever credential that host declared, and a
 * subtree that declares nothing asks nothing, so a bare render would be testing
 * a surface that does not exist. Declaring `chat_thread` here states plainly
 * which one these pins are about; the request it produces is the first-party one
 * this file always exercised.
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

const SETUP_GATE = {
  xRenderer: "schema-field",
  childRunId: null,
  reviewTaskId: `setup-${RUN_ID}`,
  inputSchema: { type: "object", properties: { idea: { type: "string" } } },
  currentValues: {},
  fieldName: "idea",
};

function seedResponse(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      status: "pending_approval",
      error: null,
      inputParams: {},
      templateId: "tmpl-1",
      agentPackageName: PACKAGE,
      agUiEnabled: true,
      taskId: null,
      traceId: null,
      messages: [],
      hitlContext: SETUP_GATE,
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

describe("InlineAgentRunCard — the run-page link is gone (cinatra#2997)", () => {
  it("draws NO link out of the conversation, on a seed that used to produce one", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => seedResponse()));

    render(chatThread(<InlineAgentRunCard runId={RUN_ID} />));

    await screen.findByTestId("run-panel-stub");
    expect(screen.queryByTestId("inline-run-page-link")).toBeNull();
    expect(screen.queryByText(/Open the run page/i)).toBeNull();
  });

  it("draws no anchor at all — nothing links out, by any label", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => seedResponse()));

    const { container } = render(chatThread(<InlineAgentRunCard runId={RUN_ID} />));

    await screen.findByTestId("run-panel-stub");
    expect(container.querySelectorAll("a").length).toBe(0);
  });

  it("still draws none when the run's package is unknown", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => seedResponse({ agentPackageName: null })));

    render(chatThread(<InlineAgentRunCard runId={RUN_ID} />));

    await screen.findByTestId("run-panel-stub");
    expect(screen.queryByTestId("inline-run-page-link")).toBeNull();
  });
});

describe("InlineAgentRunCard — the gate seed", () => {
  it("forwards the run API's own hitlContext to the panel", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => seedResponse()));

    render(chatThread(<InlineAgentRunCard runId={RUN_ID} />));

    await waitFor(() => expect(panelProps.current).not.toBeNull());
    expect(panelProps.current!.initialHitlContext).toEqual(SETUP_GATE);
    expect(panelProps.current!.surface).toBe("chat");
  });

  it("forwards the run's own REVIEW SLOT to the panel (cinatra#2997)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        seedResponse({ reviewGate: { ref: "lcr-opaque-2997", awaiting: false } }),
      ),
    );

    render(chatThread(<InlineAgentRunCard runId={RUN_ID} />));

    await waitFor(() => expect(panelProps.current).not.toBeNull());
    // The server-minted ticket for this run's own review gate, so the panel's
    // first paint can be the review screen rather than a placeholder in front
    // of it.
    expect(panelProps.current!.initialReviewGate).toEqual({
      ref: "lcr-opaque-2997",
      awaiting: false,
    });
  });

  it("forwards null when the run has no review slot at all", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => seedResponse({ reviewGate: undefined })));

    render(chatThread(<InlineAgentRunCard runId={RUN_ID} />));

    await waitFor(() => expect(panelProps.current).not.toBeNull());
    expect(panelProps.current!.initialReviewGate).toBeNull();
  });

  it("forwards null when the run is not paused on a gate", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => seedResponse({ status: "running", hitlContext: null })),
    );

    render(chatThread(<InlineAgentRunCard runId={RUN_ID} />));

    await waitFor(() => expect(panelProps.current).not.toBeNull());
    expect(panelProps.current!.initialHitlContext).toBeNull();
  });
});
