/**
 * Release Workflows browser e2e — hermetic management-surface smoke.
 *
 * Asserts the minimum bar that a real browser hitting a real Postgres would
 * catch and the unit/integration gate cannot: that the RSC pages render,
 * the SVAR Gantt mounts with the seeded tasks, and a PAUSED, attempt-bearing
 * workflow exposes the editable surface (Target-date control + edit affordances)
 * — the "paused-edit with attempts" UI. No LLM/connector keys required.
 */
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

import { WORKFLOW_ID } from "./seed-data";

test.describe("release workflows surface", () => {
  test("lists the seeded paused workflow with status + ownership", async ({ page }) => {
    await page.goto("/workflows");
    await expect(page).toHaveURL(/\/workflows$/);

    // Page chrome (generic, non-mustard heading — relabelled copy).
    await expect(page.getByRole("heading", { name: "Workflows", level: 1 })).toBeVisible();
    await expect(page.getByText("AI-assisted, calendar-driven workflows.")).toBeVisible();

    // The index is a SVAR Gantt — one row per
    // workflow, left grid columns Workflow / Status / Ownership. The seeded
    // workflow row carries the name link + the "On hold" StatusPill. The
    // "Target date" / "Release date" column headers are absent (the
    // window is expressed as a bar in the chart, not a grid column).
    const link = page.getByRole("link", { name: "E2E Paused Editable" }).first();
    await expect(link).toBeVisible();
    await expect(page.getByText("On hold").first()).toBeVisible();
    // The date column header is absent.
    await expect(page.getByRole("columnheader", { name: "Release date" })).toHaveCount(0);
    await expect(page.getByRole("columnheader", { name: "Target date" })).toHaveCount(0);
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

    // SVAR Gantt mounts with both seeded task bars (the succeeded `Build` with an
    // attempt and the idle `Ship`). Target the bar content via our own
    // `data-task-bar` hook (keyed by task key) rather than a bare text match —
    // the left-grid columns also render the title, so an unscoped getByText is
    // ambiguous and can resolve to a hidden grid cell.
    await expect(page.locator('[data-task-bar="build"]')).toBeVisible();
    await expect(page.locator('[data-task-bar="ship"]')).toBeVisible();

    // Read-only audit section is present.
    await expect(page.getByText(/^Activity/)).toBeVisible();
  });

  // Durable coverage for the clickable component surface. The smoke test
  // above only proves the bars mount; this exercises the interactions that
  // CAN be driven headless. Drag / resize / dependency-link editing are NOT
  // covered here — SVAR's pointer pipeline can't be synthesized reliably in
  // Playwright (real pointer events don't reach SVAR; `dragTo` uses the wrong
  // path), so those stay manual-only per the repo's SVAR testing note.
  test("Gantt component surface: grid columns, view switcher, click-to-inspect", async ({ page }) => {
    await page.goto(`/workflows/${WORKFLOW_ID}`);

    // Both seeded bars mounted (gate on SVAR client mount before interacting).
    await expect(page.locator('[data-task-bar="build"]')).toBeVisible();
    await expect(page.locator('[data-task-bar="ship"]')).toBeVisible();

    // Left-grid columns render. Headers carry the column labels; some
    // also host a filter input, so assert the stable label-bearing ones.
    await expect(page.getByRole("columnheader", { name: "Start" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Span" })).toBeVisible();

    // The view switcher is a compact `<Select>`. The trigger carries
    // aria-label="Timeline scale"; selecting "Year" updates the trigger's
    // accessible value.
    const viewTrigger = page.getByRole("combobox", { name: "Timeline scale" });
    await expect(viewTrigger).toBeVisible();
    await viewTrigger.click();
    await page.getByRole("option", { name: "Year" }).click();
    // The trigger reflects the new value (Radix Select stores it in the
    // trigger's `<span>` child rendered by <SelectValue />).
    await expect(viewTrigger).toContainText("Year");

    // Click-to-inspect: clicking a bar opens the read-only detail
    // Sheet with the task's title + type. Click the SVAR `.wx-bar` parent (which
    // carries the select handler) with `force` — SVAR's own `.wx-content`/scale
    // overlay sits over the bar, so Playwright's actionability check would
    // otherwise reject; the click still lands on the bar subtree and fires
    // select-task. (The `[data-task-bar]` span is for visibility/keying only.)
    await page.locator('.wx-bar[data-id=":build"]').click({ force: true });
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText("Build", { exact: true })).toBeVisible();
    await expect(sheet.getByText("Checkpoint", { exact: true })).toBeVisible();
  });

  // The Cinatra-owned chrome is keyboard-operable and the detail Sheet
  // is Escape-dismissable; an axe scan of the timeline region is clean.
  //
  // SVAR-owned keyboard limits are DOCUMENTED, not worked around: SVAR 2.6.1 renders
  // `.wx-bar` without `tabindex` (bars are pointer/right-click only), and its
  // grid header/filter (a pointer-triggered HeaderMenu) + right-click context
  // menu carry no keyboard handling. We therefore assert the keyboard surface
  // we own — not bar/menu Tab-reach — and do not inject synthetic tabindex.
  test("Gantt keyboard accessibility: focus order, fullscreen control, Escape, axe", async ({ page }) => {
    await page.goto(`/workflows/${WORKFLOW_ID}`);
    await expect(page.locator('[data-task-bar="build"]')).toBeVisible(); // gate on SVAR client mount

    // Fullscreen is a focusable, labelled control. This closes a concrete
    // a11y gap where a non-interactive Badge was not Tab-reachable.
    const fullscreen = page.getByRole("button", { name: "Toggle fullscreen (F)" });
    await expect(fullscreen).toBeVisible();

    // Tab order across the Cinatra-owned controls. The toolbar layout
    // is: Today · view Select · [Read-only badge if
    // !editable] · target-date + lifecycle (editable-conditional, in the
    // middle) · spacer · Fullscreen. We assert the durable head-and-tail
    // segments: focus Today (leftmost), Tab once and confirm we reach the
    // view trigger, then walk forward to Fullscreen (rightmost). Intermediate
    // stops (target-date, Resume, Cancel workflow) are editable-conditional
    // and not in scope for this a11y check.
    const today = page.getByRole("button", { name: "Today" });
    await today.focus();
    await expect(today).toBeFocused();
    await page.keyboard.press("Tab");
    const viewTrigger = page.getByRole("combobox", { name: "Timeline scale" });
    await expect(viewTrigger).toBeFocused();
    // Walk forward until Fullscreen is focused, capped at 10 hops (defense
    // against an infinite loop if the focus chain breaks).
    for (let i = 0; i < 10; i++) {
      if (await fullscreen.evaluate((el) => el === document.activeElement)) break;
      await page.keyboard.press("Tab");
    }
    await expect(fullscreen).toBeFocused();

    // Escape closes the detail Sheet (Radix Dialog). Open via a bar click, Esc.
    await page.locator('.wx-bar[data-id=":build"]').click({ force: true });
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // axe: zero serious/critical violations on the timeline region. The scan
    // gates OUR injected chrome (bar template, tooltip, context-menu items, grid
    // Badges/StatusPills) + the surrounding controls. color-contrast is disabled
    // (mirrors the design harness; token surfaces own their contrast at the call
    // site). Five SVAR-embed-internal rules are allowlisted ONLY on SVAR-owned
    // nodes — we can't fix the vanilla embed's DOM from outside it
    // (EXTERNAL_COMPONENT_BOUNDARY):
    //   - `label`: SVAR's grid filter `<input class="wx-input">` ships with no
    //     accessible name (empty placeholder/title, no <label>);
    //   - `scrollable-region-focusable`: SVAR's `.wx-chart` viewport is `tabindex="-1"`;
    //   - `aria-valid-attr-value`: SVAR's `.wx-row` uses `aria-rowindex="0"` (must be ≥1);
    //   - `aria-prohibited-attr`: SVAR's `.wx-grip` resize handle puts an `aria-label`
    //     on a `role="presentation"` element.
    //   - `aria-conditional-attr`: SVAR puts `aria-expanded` on `.wx-row[role="row"]`
    //     for hierarchical parents, but the grid container is `role="grid"`
    //     rather than `role="treegrid"` — `aria-expanded` on a row is only
    //     supported under `treegrid`. Vanilla SVAR 2.6.1 uses `grid`; this
    //     surfaces only when the workflow has hierarchy (the e2e seed adds
    //     `phase-1-release` summary + 2 leaf children).
    // Each is scoped to nodes whose markup carries SVAR's `wx-` class prefix, so
    // the same rule on any Cinatra-owned node still blocks.
    const SVAR_OWNED_RULES = new Set([
      "label",
      "scrollable-region-focusable",
      "aria-valid-attr-value",
      "aria-prohibited-attr",
      "aria-conditional-attr",
    ]);
    const allSvarOwned = (v: { nodes: { html: string }[] }) =>
      v.nodes.length > 0 && v.nodes.every((n) => /\bwx-/.test(n.html));
    const results = await new AxeBuilder({ page })
      .include('[data-testid="workflow-gantt"]')
      .disableRules(["color-contrast"])
      .options({ resultTypes: ["violations"] })
      .analyze();
    const blocking = results.violations.filter(
      (v) =>
        v.id !== "color-contrast" &&
        (v.impact === "serious" || v.impact === "critical") &&
        !(SVAR_OWNED_RULES.has(v.id) && allSvarOwned(v)),
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

  // Durable hierarchy e2e coverage. An earlier premise ("SVAR's summary
  // path bypasses our taskTemplate") was disproved against SVAR 2.6.1
  // (bundle index.es.js:966 — `o ? i(o, ...)` invokes our
  // template on summaries too). This test instead asserts against
  // (a) `.wx-bar.wx-summary[data-id=":<key>"]` — SVAR's own class marker
  //     for summary bars; `data-id` is on every bar regardless of type;
  // (b) `[data-task-bar]` on the leaf children — our template emits this
  //     attribute on every bar (summaries included), but using it on the
  //     leaves keeps the test resilient if SVAR's summary-render path ever
  //     changes upstream;
  // (c) the SVAR grid tree toggle (`.wx-toggle-icon`) for collapse/expand —
  //     SVAR delegates the click to the table container via
  //     `data-action="open-task"`, so `el.evaluate(el => el.click())`
  //     bubbles correctly. On collapse, SVAR rebuilds `_tasks` via
  //     `tasks.toArray()` which only descends children when `open === true`,
  //     so children are removed from the DOM (`toHaveCount(0)` is the right
  //     assertion, not `not.toBeVisible()`).
  test("Gantt hierarchy: summary parent renders + collapse hides children, expand restores", async ({ page }) => {
    await page.goto(`/workflows/${WORKFLOW_ID}`);
    // Gate on SVAR client mount via the flat leaves (always rendered with
    // data-task-bar regardless of hierarchy).
    await expect(page.locator('[data-task-bar="build"]')).toBeVisible();

    // 1. Both new leaf children render with `data-task-bar`. (Our
    //    `taskTemplate` emits this attribute on every bar — summaries too in
    //    SVAR 2.6.1 per bundle index.es.js:966 — but the leaves are the
    //    cleanest selector and stay resilient if SVAR's summary-render path
    //    ever changes upstream.)
    const designLeaf = page.locator('[data-task-bar="design-doc"]');
    const qaLeaf = page.locator('[data-task-bar="qa-pass"]');
    await expect(designLeaf).toBeVisible();
    await expect(qaLeaf).toBeVisible();

    // 2. The summary parent's `.wx-bar` shell renders with `data-id` AND
    //    SVAR's `.wx-summary` class marker. (SVAR 2.6.1 invokes our
    //    `taskTemplate` on summary bars too — the bundle at index.es.js:966
    //    calls `o ? i(o, ...)` for any non-milestone task — so summaries
    //    also carry the template's `data-task-bar`. We assert the SVAR-
    //    native class marker as the stronger summary-specific evidence.)
    const summaryBar = page.locator('.wx-bar.wx-summary[data-id=":phase-1-release"]');
    await expect(summaryBar).toBeVisible();

    // 3. Collapse: click the SVAR grid tree toggle on the parent row. The
    //    toggle lives in the left grid (`.wx-toggle-icon` on the parent row);
    //    SVAR's pointer pipeline is flaky in Playwright for drag/resize but
    //    a plain `el.click()` on the toggle icon fires its onclick handler
    //    reliably. Use `evaluate` so we sidestep Playwright's actionability
    //    checks (`.wx-content` overlays sit over the chart, not the grid).
    const parentRow = page.locator('[data-id=":phase-1-release"].wx-row, .wx-row[data-id=":phase-1-release"]').first();
    const toggle = parentRow.locator('.wx-toggle-icon').first();
    await expect(toggle).toBeVisible();
    await toggle.evaluate((el) => (el as HTMLElement).click());

    // Children disappear when collapsed (SVAR drops them from the DOM, not
    // just visually hides them — assert removal, not hidden state).
    await expect(designLeaf).toHaveCount(0);
    await expect(qaLeaf).toHaveCount(0);
    // Summary parent stays mounted (its rollup is what's visible while
    // children are collapsed).
    await expect(summaryBar).toBeVisible();

    // 4. Re-expand: click the same toggle a second time, children come back.
    await toggle.evaluate((el) => (el as HTMLElement).click());
    await expect(designLeaf).toBeVisible();
    await expect(qaLeaf).toBeVisible();
  });
});
