// @vitest-environment jsdom
/**
 * DOM-render proof for the agent-approvals inbox "Requested" column (#362).
 *
 * AgentApprovalInboxBody (screens.tsx) is an async server component whose full
 * module graph cannot be imported in isolation in this checkout (it transitively
 * reaches generated extension wiring). The companion source-invariant test
 * (agent-approval-inbox-requested-column.test.ts) pins that screens.tsx emits
 * exactly the markup rendered here: a "Requested" <TableHead> and a cell of
 * `formatDistanceToNow(new Date(task.createdAt), { addSuffix: true })`.
 *
 * This test renders that EXACT markup with the REAL table UI components and the
 * REAL date-fns formatter, driven by the same createdAt mapping the component
 * uses, then asserts the resulting DOM: the column header is "Requested" (not
 * "Deadline"), and a request filed 5 minutes ago renders "5 minutes ago" — the
 * honest created-time relative string, not a phantom past deadline.
 */
import React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { formatDistanceToNow } from "date-fns";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

afterEach(() => cleanup());

// Faithful to screens.tsx: rows come from agent_creation_request (createdAt),
// mapped into the inbox task and rendered under the "Requested" header.
type Task = { id: string; title: string; status: string; createdAt: Date };

function ApprovalsTableFragment({ tasks }: { tasks: Task[] }) {
  return (
    <table>
      <TableHeader>
        <TableRow>
          <TableHead>Task</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Requested</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {tasks.map((task) => (
          <TableRow key={task.id}>
            <TableCell>{task.title}</TableCell>
            <TableCell>{task.status}</TableCell>
            <TableCell className="text-muted-foreground text-xs">
              {formatDistanceToNow(new Date(task.createdAt), { addSuffix: true })}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </table>
  );
}

describe("agent-approvals inbox Requested column render (#362)", () => {
  // Pin "now" so the relative-time assertion is wall-clock independent: a row
  // created exactly 5 minutes before the frozen now renders "5 minutes ago".
  const NOW = new Date("2026-06-20T12:00:00.000Z");
  const fiveMinAgo = new Date(NOW.getTime() - 5 * 60 * 1000);
  const tasks: Task[] = [
    { id: "req_1", title: "@acme/agent@1.0.0", status: "proposed", createdAt: fiveMinAgo },
  ];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders a 'Requested' column header, not 'Deadline'", () => {
    render(<ApprovalsTableFragment tasks={tasks} />);
    expect(screen.getByRole("columnheader", { name: "Requested" })).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: "Deadline" })).toBeNull();
  });

  it("shows the createdAt-derived relative time (not a future/expired deadline)", () => {
    render(<ApprovalsTableFragment tasks={tasks} />);
    const row = screen.getByText("@acme/agent@1.0.0").closest("tr") as HTMLElement;
    expect(row).toBeTruthy();
    // A request created 5 minutes ago renders the real created-time relative
    // string. addSuffix yields the past form "... ago" — honest for a created
    // timestamp under a "Requested" header.
    const cell = within(row).getByText(/ago$/);
    expect(cell.textContent).toBe("5 minutes ago");
  });
});
