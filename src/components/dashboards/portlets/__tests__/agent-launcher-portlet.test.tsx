// @vitest-environment jsdom
//
// cinatra#2535 — the launcher's "View run" link 404'd: it built
// `/agents/runs/<runId>` (not a route) instead of the canonical
// `/agents/[vendor]/[packageName]/[runId]`. This pins the built href to the
// shared `buildAgentInstancePath` shape (the same helper the chat-dispatch
// and notification-href call sites already use), fed from whichever agent
// identity the launcher actually ran — `agentPackage`, falling back to
// `agentRef` — matching `launchAgentAction`'s own resolution order.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const launchAgentAction = vi.fn();
vi.mock("@/lib/dashboards/portlet-actions", () => ({
  launchAgentAction: (...args: unknown[]) => launchAgentAction(...args),
}));

import { AgentLauncherPortlet } from "../agent-launcher-portlet";
import type { PortletComponentProps } from "../types";

function baseProps(config: Record<string, unknown>): PortletComponentProps {
  return {
    instanceId: "inst-1",
    config,
    inputs: {},
    boundInputs: [],
    rowContext: {},
    onOutput: vi.fn(),
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AgentLauncherPortlet — run link", () => {
  it("builds the canonical /agents/[vendor]/[packageName]/[runId] href from agentPackage (scoped)", async () => {
    launchAgentAction.mockResolvedValue({ ok: true, runId: "086f2a2d-59b2-4d15-bb76-8caedde7b69a" });
    render(<AgentLauncherPortlet {...baseProps({ agentPackage: "@cinatra-ai/blog-draft-writer-agent" })} />);

    fireEvent.click(screen.getByRole("button", { name: /run agent/i }));

    const link = await waitFor(() => screen.getByRole("link", { name: /view run/i }));
    expect(link.getAttribute("href")).toBe(
      "/agents/cinatra-ai/blog-draft-writer-agent/086f2a2d-59b2-4d15-bb76-8caedde7b69a",
    );
  });

  it("falls back to agentRef when agentPackage is absent", async () => {
    launchAgentAction.mockResolvedValue({ ok: true, runId: "run-2" });
    render(<AgentLauncherPortlet {...baseProps({ agentRef: "@cinatra-ai/social-outreach-agent" })} />);

    fireEvent.click(screen.getByRole("button", { name: /run agent/i }));

    const link = await waitFor(() => screen.getByRole("link", { name: /view run/i }));
    expect(link.getAttribute("href")).toBe("/agents/cinatra-ai/social-outreach-agent/run-2");
  });

  it("never builds the legacy /agents/runs/<id> shape", async () => {
    launchAgentAction.mockResolvedValue({ ok: true, runId: "run-3" });
    render(<AgentLauncherPortlet {...baseProps({ agentPackage: "@cinatra-ai/blog-draft-writer-agent" })} />);

    fireEvent.click(screen.getByRole("button", { name: /run agent/i }));

    const link = await waitFor(() => screen.getByRole("link", { name: /view run/i }));
    expect(link.getAttribute("href")).not.toMatch(/^\/agents\/runs\//);
  });
});
