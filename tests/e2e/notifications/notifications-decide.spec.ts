/**
 * Unified /notifications v2 — inline decide round-trip (cinatra#1561, E11),
 * spec §II ("decided-row-disappears"). Rejecting the actionable Inbox approval
 * from its inline affordance runs the SAME shared `decideApprovalRow` server
 * action the retired /configuration/approvals page used, carrying the CAS token
 * captured at render; on success the row drops optimistically and stays gone on
 * reload (E5's pending-only predicate). The reject path is the one the harness
 * can stage end-to-end on a bare instance (no publish side effects, unlike
 * approve). The decided proposal transitions proposed → rejected in
 * `agent_creation_request`.
 */
import { expect, test } from "@playwright/test";

import { gotoFeed } from "./spec-utils";
import { reseedMainViewer } from "./reseed";

const INBOX_APPROVAL = "Quarterly Revenue Analyst";

test.describe.configure({ timeout: 120_000 });

// Reset the pending approval set before each test so the reject below always
// has a fresh actionable Inbox row to decide, independent of order / retries.
test.beforeEach(async () => {
  await reseedMainViewer();
});

test.describe("§II — inline decide round-trip (reject → row disappears)", () => {
  test("§II · rejecting the actionable Inbox approval removes it, and it stays gone on reload", async ({
    page,
  }) => {
    await gotoFeed(page);

    const inboxRow = page
      .locator('[data-conformance-id="approval-row"]')
      .filter({ hasText: INBOX_APPROVAL });
    await expect(inboxRow).toHaveCount(1);

    // Open the inline reject affordance → a required reason appears.
    await inboxRow.getByRole("button", { name: "Reject" }).click();
    const reason = inboxRow.getByLabel("Reason for rejection");
    await expect(reason).toBeVisible();
    await reason.fill("Not aligned with the approved agent catalog (E11 conformance).");

    // Confirm — the shared decide server action rejects the proposal (CAS match).
    await inboxRow.getByRole("button", { name: "Confirm rejection" }).click();

    // §II decided-row-disappears: the row drops optimistically.
    await expect(inboxRow).toHaveCount(0, { timeout: 20_000 });

    // Durable — the pending-only predicate keeps it gone after a fresh load.
    await gotoFeed(page);
    await expect(
      page.locator('[data-conformance-id="approval-row"]').filter({ hasText: INBOX_APPROVAL }),
    ).toHaveCount(0);
    // The Needs-action chip has nothing left to act on.
    await expect(
      page.locator('[data-conformance-id="notifications-filters"]').getByRole("button", {
        name: /^Needs action/,
      }),
    ).not.toContainText("1");
  });
});
