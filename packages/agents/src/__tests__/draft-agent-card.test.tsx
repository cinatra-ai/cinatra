// @vitest-environment jsdom
//
// cinatra#2653 — DraftAgentCard: the /agents row for a DRAFT template.
//
// Pinned rendered contract:
//   • the amber DRAFT status indicator renders (data-status="draft") — the
//     visual separator from run cards, which carry no spec line at all;
//   • the primary action is Publish (accessible name "Publish {name}"),
//     and NO Run affordance exists on a draft card;
//   • a successful publish calls the server action with the template id,
//     then refreshes the route (the row re-renders as a runnable card);
//   • a failed publish surfaces the action's error and does NOT refresh.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn(), replace: vi.fn() }),
}));

const publishAgentTemplateAction = vi.fn();
vi.mock("../publish-template-action", () => ({
  publishAgentTemplateAction: (...a: unknown[]) => publishAgentTemplateAction(...a),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("@/lib/cinatra-toast", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}));

// The real InstalledExtensionCard transitively imports
// `@cinatra-ai/registries/src/version-compare` (via the marketplace card
// model), which this package's vitest resolver cannot load. The shell's own
// rendering is pinned by the design-system card tests; THIS suite pins
// DraftAgentCard's contract, so a slot-faithful stand-in suffices: it renders
// the name plus the `status` and `actions` slots the draft card fills.
vi.mock("@/components/extensions/installed-extension-card", () => ({
  InstalledExtensionCard: (props: {
    name: string;
    status?: React.ReactNode;
    actions?: React.ReactNode;
  }) => (
    <div data-testid="card-shell">
      <span>{props.name}</span>
      {props.status}
      {props.actions}
    </div>
  ),
}));

import { DraftAgentCard } from "../draft-agent-card";

const row = {
  key: "local:tpl-1",
  name: "Everyday AI Blog Drafter",
  description: "Drafts a blog post from a topic.",
  version: "1.0.0",
  host: "local" as const,
  draft: { templateId: "tpl-1", staysListedAfterPublish: true },
};

beforeEach(() => {
  vi.clearAllMocks();
  publishAgentTemplateAction.mockResolvedValue({ ok: true, templateId: "tpl-1" });
});

afterEach(cleanup);

describe("DraftAgentCard (cinatra#2653)", () => {
  it("renders the DRAFT status indicator", () => {
    const { container } = render(<DraftAgentCard row={row} />);
    const indicator = container.querySelector(
      '[data-slot="installed-status-indicator"][data-status="draft"]',
    );
    expect(indicator).not.toBeNull();
    expect(indicator!.textContent).toMatch(/Draft/);
  });

  it("offers Publish as the primary action and no Run affordance", () => {
    render(<DraftAgentCard row={row} />);
    expect(
      screen.getByRole("button", { name: "Publish Everyday AI Blog Drafter" }),
    ).toBeTruthy();
    expect(screen.queryByText("Run")).toBeNull();
  });

  it("publishes via the server action and refreshes the route on success", async () => {
    render(<DraftAgentCard row={row} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Publish Everyday AI Blog Drafter" }),
    );
    await waitFor(() => expect(routerRefresh).toHaveBeenCalledTimes(1));
    expect(publishAgentTemplateAction).toHaveBeenCalledWith("tpl-1");
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("words the success toast honestly for a HITL-less agent (leaves the picker)", async () => {
    render(
      <DraftAgentCard
        row={{ ...row, draft: { templateId: "tpl-1", staysListedAfterPublish: false } }}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Publish Everyday AI Blog Drafter" }),
    );
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
    expect(String(toastSuccess.mock.calls[0][0])).toMatch(/leaves this picker/);
    expect(routerRefresh).toHaveBeenCalledTimes(1);
  });

  it("surfaces a refusal and does not refresh", async () => {
    publishAgentTemplateAction.mockResolvedValue({
      ok: false,
      error: "An assistant cannot be published.",
    });
    render(<DraftAgentCard row={row} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Publish Everyday AI Blog Drafter" }),
    );
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("An assistant cannot be published."),
    );
    expect(routerRefresh).not.toHaveBeenCalled();
  });
});
