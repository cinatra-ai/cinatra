/**
 * Release Workflows browser e2e — hermetic management-surface smoke.
 *
 * Asserts the minimum bar that a real browser hitting a real Postgres would
 * catch and the unit/integration gate cannot: that the RSC pages render, the
 * workflows index list + the detail task list render the seeded tasks, and a
 * PAUSED, attempt-bearing workflow exposes the surviving editable surface
 * (Target-date control + lifecycle controls) — the "paused-edit with attempts"
 * UI. No LLM/connector keys required.
 *
 * The SVAR Gantt visualization/edit surface was removed in cinatra#321; the
 * management UI is now a plain task list + the Target-date control. The
 * per-task drag/resize/dependency editing the Gantt offered is gone (workflow
 * target dates stay editable), so this suite asserts the list + Sheet + the
 * controls, not chart bars.
 */
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

import { WORKFLOW_ID } from "./seed-data";

test.describe("release workflows surface", () => {
  test("lists the seeded paused workflow with status + ownership", async ({ page }) => {
    await page.goto("/workflows");
    await expect(page).toHaveURL(/\/workflows$/);

    // Page chrome.
    await expect(page.getByRole("heading", { name: "Workflows", level: 1 })).toBeVisible();
    await expect(page.getByText("AI-assisted, calendar-driven workflows.")).toBeVisible();

    // The index is a table — one row per workflow with columns Workflow /
    // Status / Ownership / Schedule. The seeded workflow row carries the name
    // link + the "On hold" StatusPill, plus a Schedule column header.
    await expect(page.getByRole("columnheader", { name: "Workflow" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Schedule" })).toBeVisible();
    const link = page.getByRole("link", { name: "E2E Paused Editable" }).first();
    await expect(link).toBeVisible();
    await expect(page.getByText("On hold").first()).toBeVisible();
  });

  test("renders the paused workflow's editable management surface", async ({ page }) => {
    await page.goto(`/workflows/${WORKFLOW_ID}`);

    // Header + paused state.
    await expect(page.getByRole("heading", { name: "E2E Paused Editable", level: 1 })).toBeVisible();
    await expect(page.getByText("On hold")).toBeVisible();

    // Paused + manageable ⇒ editable: Resume control + the Target-date control
    // appear (the Target control only renders when isEditable && targetAtUtc).
    await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Target/ })).toBeVisible();

    // The task list mounts with the seeded tasks. Target the rows via our
    // `data-task-row` hook (keyed by task key) so the assertion is unambiguous.
    await expect(page.locator('[data-task-row="build"]')).toBeVisible();
    await expect(page.locator('[data-task-row="ship"]')).toBeVisible();

    // Read-only audit section is present.
    await expect(page.getByText(/^Activity/)).toBeVisible();
  });

  // Durable coverage for the clickable task-list surface: the table columns
  // render and clicking a row opens the read-only detail Sheet.
  test("task list: columns render + click-to-inspect opens the detail Sheet", async ({ page }) => {
    await page.goto(`/workflows/${WORKFLOW_ID}`);

    await expect(page.locator('[data-task-row="build"]')).toBeVisible();
    await expect(page.locator('[data-task-row="ship"]')).toBeVisible();

    // The list column headers render.
    await expect(page.getByRole("columnheader", { name: "Task" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Status" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Start" })).toBeVisible();

    // Click-to-inspect: clicking a row opens the detail Sheet with the task's
    // title + type.
    await page.locator('[data-task-row="build"]').click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText("Build", { exact: true })).toBeVisible();
    await expect(sheet.getByText("Checkpoint", { exact: true })).toBeVisible();
  });

  // The task-list chrome is keyboard-operable (rows are role=button, the Sheet
  // is Escape-dismissable) and an axe scan of the list region is clean.
  test("task list accessibility: keyboard row activation, Escape, axe", async ({ page }) => {
    await page.goto(`/workflows/${WORKFLOW_ID}`);
    await expect(page.locator('[data-task-row="build"]')).toBeVisible();

    // Rows are keyboard-activatable (role=button, tabindex=0): focus + Enter
    // opens the Sheet.
    const buildRow = page.locator('[data-task-row="build"]');
    await buildRow.focus();
    await expect(buildRow).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toBeVisible();

    // Escape closes the detail Sheet (Radix Dialog).
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // axe: zero serious/critical violations on the task-list region. The scan
    // gates our own chrome (table, row buttons, Badges/StatusPills) + the
    // surrounding controls. color-contrast is disabled (mirrors the design
    // harness; token surfaces own their contrast at the call site).
    const results = await new AxeBuilder({ page })
      .include('[data-testid="workflow-task-list"]')
      .disableRules(["color-contrast"])
      .options({ resultTypes: ["violations"] })
      .analyze();
    const blocking = results.violations.filter(
      (v) =>
        v.id !== "color-contrast" &&
        (v.impact === "serious" || v.impact === "critical"),
    );
    expect(
      blocking,
      `axe serious/critical: ${JSON.stringify(
        blocking.map((b) => ({ id: b.id, nodes: b.nodes.map((n) => n.target) })),
        null,
        2,
      )}`,
    ).toHaveLength(0);
  });
});
