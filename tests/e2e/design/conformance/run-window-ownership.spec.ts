import { expect, test } from "@playwright/test";
import {
  RUN_WINDOW_OWNERSHIP_HOSTS, OWNERSHIP_INPUT, OWNERSHIP_REVIEW_ANSWER,
} from "../../../../src/app/design-fixtures/conformance/run-window-ownership-fixture-data";
import { assertRunWindowOwnership, readRunWindowOwnership } from "./run-window-ownership";

// Required design-conformance-functional already discovers this spec. The
// existing allowlisted static harness query is used, not authenticated pages.
for (const palette of ["cinatra", "dark"] as const) {
  for (const host of RUN_WINDOW_OWNERSHIP_HOSTS) {
    test(`run-window ownership — ${host} — ${palette}`, async ({ page }) => {
      await page.addInitScript((theme) => window.localStorage.setItem("theme", theme), palette);
      await page.route("**/api/lifecycle-views/resolve", (route) => route.fulfill({
        json: OWNERSHIP_REVIEW_ANSWER,
      }));
      await page.route("**/api/agents/runs/conformance-window-run", (route) => route.fulfill({
        json: { status: "pending_approval", error: null, messages: [],
          hitlContext: OWNERSHIP_INPUT, reviewGate: { ref: null, awaiting: false } },
      }));
      // No model, decision or runtime server action may execute in this static
      // ownership reading. The real components retain their ordinary read
      // failure posture; run/resolve reads above are the only admitted answers.
      await page.route("**/design-fixtures/conformance?runWindowHost=*", (route) =>
        route.request().headers()["next-action"] ? route.abort("blockedbyclient") : route.continue());
      await page.goto(`/design-fixtures/conformance?runWindowHost=${host}`, { waitUntil: "domcontentloaded" });
      const root = page.locator(`[data-run-window-ownership-host="${host}"]`);
      await expect(root).toHaveCount(1);
      await expect(root.locator('[data-lifecycle-card-host]').first()).toBeVisible();
      await expect.poll(() => root.evaluate(readRunWindowOwnership)).toMatchObject({
        rootPresent: true, promptsInCards: 0, composersInCards: 0,
        windows: host === "chat" ? 0 : 1, ownedWindows: host === "chat" ? 0 : 1,
        composers: host === "chat" ? 1 : 0,
      });
      assertRunWindowOwnership(await root.evaluate(readRunWindowOwnership), host);
      if (host === "run") {
        await expect(root.locator('[data-lifecycle-card="agent_hitl_screen"]')).toBeVisible();
        await expect(root.getByLabel(/^Subject\s*\*$/)).toBeVisible();
      } else {
        await expect(root.locator('[data-lifecycle-card="artifact_review_gate"]')).toBeVisible();
        // The approved subordinate rationale survives; it is not a prompt.
        await expect(root.locator('[data-testid="review-rationale"]')).toHaveCount(1);
      }
    });
  }
}
