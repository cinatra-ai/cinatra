// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";

// cinatra#2020 S5 PR-4 — the confirmation card: renders from the persisted-row
// data shape, one-click decide with the PER-ACTION token, indeterminate
// rendering for interrupted executions, and nothing at all when quiet.

const listPendingToolConfirmations = vi.fn(async () => ({ rows: [] as unknown[] }));
const decidePendingToolCall = vi.fn(
  async (_id: never, _action: never, _token: never) => ({ outcome: "refused" }) as const,
);
vi.mock("../pending-call-actions", () => ({
  listPendingToolConfirmations: () => listPendingToolConfirmations(),
  decidePendingToolCall: (id: string, action: string, token: string) =>
    decidePendingToolCall(id as never, action as never, token as never),
}));

import { PendingToolConfirmationCards } from "../pending-tool-confirmation-card";

function pendingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "cipc_1",
    connectorKey: "wordpress",
    toolName: "core/delete-post",
    serverId: "wps_1",
    instanceId: "inst-1",
    instanceLabel: "My Site",
    argsPreview: '{\n  "id": 7\n}',
    status: "pending",
    failureCode: null,
    resultSummary: null,
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    confirmToken: "tok-confirm",
    rejectToken: "tok-reject",
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("PendingToolConfirmationCards", () => {
  it("renders nothing when the viewer has no cards", async () => {
    const { container } = render(<PendingToolConfirmationCards />);
    await waitFor(() => expect(listPendingToolConfirmations).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  it("renders a pending card with tool/server/label, the redacted preview, and the three actions", async () => {
    listPendingToolConfirmations.mockResolvedValue({ rows: [pendingRow()] });
    render(<PendingToolConfirmationCards />);
    await screen.findByText(/Destructive action needs your confirmation/);
    expect(screen.getByText(/core\/delete-post · wps_1 · My Site/)).toBeDefined();
    expect(screen.getByText(/"id": 7/)).toBeDefined();
    expect(screen.getByRole("button", { name: "Confirm" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Deny" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDefined();
  });

  it("Confirm sends the CONFIRM token; Deny sends the REJECT-family token", async () => {
    listPendingToolConfirmations
      .mockResolvedValueOnce({ rows: [pendingRow()] })
      // Post-decide refresh returns the server's decided state.
      .mockResolvedValue({
        rows: [
          pendingRow({
            status: "executed",
            resultSummary: { ok: true },
            confirmToken: null,
            rejectToken: null,
          }),
        ],
      });
    decidePendingToolCall.mockResolvedValue({
      outcome: "decided",
      id: "cipc_1",
      status: "executed",
      alreadyDecided: false,
      failureCode: null,
      resultSummary: { ok: true },
    } as never);
    render(<PendingToolConfirmationCards />);
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(decidePendingToolCall).toHaveBeenCalledWith("cipc_1", "confirm", "tok-confirm"),
    );
    await screen.findByText(/Executed\./);

    cleanup();
    vi.clearAllMocks();
    listPendingToolConfirmations.mockResolvedValue({ rows: [pendingRow()] });
    decidePendingToolCall.mockResolvedValue({
      outcome: "decided",
      id: "cipc_1",
      status: "denied",
      alreadyDecided: false,
      failureCode: null,
      resultSummary: null,
    } as never);
    render(<PendingToolConfirmationCards />);
    fireEvent.click(await screen.findByRole("button", { name: "Deny" }));
    await waitFor(() =>
      expect(decidePendingToolCall).toHaveBeenCalledWith("cipc_1", "deny", "tok-reject"),
    );
  });

  it("renders an INTERRUPTED execution as outcome-unknown, never an ordinary failure", async () => {
    listPendingToolConfirmations.mockResolvedValue({
      rows: [
        pendingRow({
          status: "failed",
          failureCode: "execution_interrupted",
          confirmToken: null,
          rejectToken: null,
        }),
      ],
    });
    render(<PendingToolConfirmationCards />);
    await screen.findByText(/Outcome unknown/);
    expect(screen.getByText(/Verify on the site before retrying/)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
  });

  it("a pollSignal bump triggers a refresh", async () => {
    listPendingToolConfirmations.mockResolvedValue({ rows: [] });
    const { rerender } = render(<PendingToolConfirmationCards pollSignal={0} />);
    await waitFor(() => expect(listPendingToolConfirmations).toHaveBeenCalledTimes(1));
    rerender(<PendingToolConfirmationCards pollSignal={1} />);
    await waitFor(() => expect(listPendingToolConfirmations).toHaveBeenCalledTimes(2));
  });
});
