// @vitest-environment jsdom
/**
 * THE CHAT RUN CARD'S LINK IS PLATFORM-BUILT (cinatra#2729 defect 1), AND THE
 * CARD KEEPS THE GATE THE RUN API ALREADY HANDED IT (defect 2).
 *
 * The card used to drop the run API's `hitlContext` on the floor and render no
 * link at all, so the only run URL in the conversation was whatever the model
 * wrote — `/agents/runs/<runId>`, which has no page and 404s.
 *
 * `AgenticRunPanel` is stubbed: these pins are about what the WRAPPER derives
 * and forwards, and the panel's own rendering is pinned in the agents package.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { buildAgentInstancePath } from "@/lib/agent-url";

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

describe("InlineAgentRunCard — the run link", () => {
  it("renders the CANONICAL path the shared builder produces", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => seedResponse()));

    render(<InlineAgentRunCard runId={RUN_ID} />);

    const link = await screen.findByTestId("inline-run-page-link");
    expect(link.getAttribute("href")).toBe(buildAgentInstancePath(PACKAGE, RUN_ID));
    expect(link.getAttribute("href")).toBe(
      `/agents/cinatra-ai/blog-draft-writer-agent/${RUN_ID}`,
    );
  });

  it("never renders the API-shaped path the model used to guess", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => seedResponse()));

    render(<InlineAgentRunCard runId={RUN_ID} />);

    const link = await screen.findByTestId("inline-run-page-link");
    expect(link.getAttribute("href")).not.toBe(`/agents/runs/${RUN_ID}`);
  });

  it("renders NO link at all when the run's package is unknown", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => seedResponse({ agentPackageName: null })));

    render(<InlineAgentRunCard runId={RUN_ID} />);

    await screen.findByTestId("run-panel-stub");
    expect(screen.queryByTestId("inline-run-page-link")).toBeNull();
  });
});

describe("InlineAgentRunCard — the gate seed", () => {
  it("forwards the run API's own hitlContext to the panel", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => seedResponse()));

    render(<InlineAgentRunCard runId={RUN_ID} />);

    await waitFor(() => expect(panelProps.current).not.toBeNull());
    expect(panelProps.current!.initialHitlContext).toEqual(SETUP_GATE);
    expect(panelProps.current!.surface).toBe("chat");
  });

  it("forwards null when the run is not paused on a gate", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => seedResponse({ status: "running", hitlContext: null })),
    );

    render(<InlineAgentRunCard runId={RUN_ID} />);

    await waitFor(() => expect(panelProps.current).not.toBeNull());
    expect(panelProps.current!.initialHitlContext).toBeNull();
  });
});
