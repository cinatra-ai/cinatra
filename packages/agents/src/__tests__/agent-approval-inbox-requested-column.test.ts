/**
 * Regression: AgentApprovalInboxBody "Requested" column binding (issue #362).
 *
 * The agent-approvals inbox (AgentApprovalInboxBody in screens.tsx) reads rows
 * ONLY from `listAgentCreationRequests()`, backed by the `agent_creation_request`
 * table — which has NO deadline field and no join to `workflow_approval`. A
 * prior version mislabelled the last column "Deadline" while binding it to the
 * row's `created_at` (rendered relative), so a freshly filed request always read
 * "N minutes ago" as if already past-deadline.
 *
 * The honest fix relabels the column "Requested" and binds the cell to a
 * `createdAt` field (not a repurposed `expiresAt`). These assertions are scoped
 * to the AgentApprovalInboxBody source block so they do NOT touch the Workflows
 * approvals tab, where a real `deadlineUtc` deadline legitimately exists.
 *
 * Strategy: file-grep assertions, matching this package's render-test pattern
 * (no jsdom pipeline here).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";

const screensPath = path.resolve(__dirname, "..", "screens.tsx");

function readScreens(): string {
  return readFileSync(screensPath, "utf8");
}

/** Extract the AgentApprovalInboxBody function body so assertions don't bleed
 *  into the sibling AgentApprovalDetailScreen / workflow surfaces. */
function inboxBody(): string {
  const src = readScreens();
  const start = src.indexOf("export async function AgentApprovalInboxBody");
  expect(start).toBeGreaterThanOrEqual(0);
  const next = src.indexOf("export async function AgentApprovalDetailScreen", start);
  expect(next).toBeGreaterThan(start);
  return src.slice(start, next);
}

describe("AgentApprovalInboxBody Requested column (issue #362)", () => {
  it("labels the timestamp column 'Requested', not 'Deadline'", () => {
    const body = inboxBody();
    expect(body).toMatch(/<TableHead>Requested<\/TableHead>/);
    expect(body).not.toMatch(/<TableHead>Deadline<\/TableHead>/);
  });

  it("binds the column to a createdAt field, not a repurposed expiresAt", () => {
    const body = inboxBody();
    // Task type carries createdAt, populated from the row's createdAt.
    expect(body).toMatch(/createdAt:\s*Date;/);
    expect(body).toMatch(/createdAt:\s*new Date\(r\.createdAt\)/);
    // The render cell reads task.createdAt.
    expect(body).toMatch(/formatDistanceToNow\(new Date\(task\.createdAt\)/);
    // The misleading repurposed field is gone from this body.
    expect(body).not.toMatch(/expiresAt/);
  });
});
