import { expect, test, type Page } from "@playwright/test";

import {
  RUN_STEP_RAIL_CONFORMANCE_LABELS,
  RUN_STEP_RAIL_CONFORMANCE_PAUSED_POSITION,
  RUN_STEP_RAIL_CONFORMANCE_ROW_KINDS,
  RUN_STEP_RAIL_CONFORMANCE_ROW_STATUSES,
  RUN_STEP_RAIL_CONFORMANCE_SETTLED_POSITION,
  RUN_STEP_RAIL_CONFORMANCE_UPCOMING_POSITIONS,
} from "../../../../src/app/design-fixtures/conformance/run-step-rail-conformance-data";

const PALETTES = [
  { name: "light", theme: "cinatra" },
  { name: "dark", theme: "dark" },
] as const;
const FIXTURE = '[data-surface-id="run-step-rail"]';
const RAIL = '[data-conformance-id="run-step-rail"]';
const ROW = '[data-slot="stepper-item"]';
const TITLE = '[data-slot="stepper-title"]';

async function openRail(page: Page, theme: string): Promise<void> {
  // Follow next-themes initialization; changing a class after hydration would
  // bypass the application's palette path.
  await page.addInitScript((value) => {
    window.localStorage.setItem("theme", value);
  }, theme);
  await page.goto("/design-fixtures/conformance", { waitUntil: "domcontentloaded" });
  await expect(page.locator(`${FIXTURE} ${RAIL}`)).toBeVisible();
  await expect.poll(() => page.evaluate(
    (value) => document.documentElement.classList.contains(value)
      && !document.documentElement.classList.contains(value === "dark" ? "cinatra" : "dark"),
    theme,
  )).toBe(true);
  await page.evaluate(async () => { await document.fonts.ready; });
}

for (const palette of PALETTES) {
  test(`run rail computed title colors — ${palette.name}`, async ({ page }) => {
    await openRail(page, palette.theme);
    const rail = page.locator(`${FIXTURE} ${RAIL}`);
    const rows = rail.locator(ROW);
    await expect(rows).toHaveCount(5);
    await expect(rows).toHaveCount(RUN_STEP_RAIL_CONFORMANCE_LABELS.length);
    await expect(rail.locator(TITLE)).toHaveCount(5);

    for (const [index, label] of RUN_STEP_RAIL_CONFORMANCE_LABELS.entries()) {
      const row = rows.nth(index);
      await expect(row).toContainText(label);
      await expect(row.locator(TITLE)).toHaveCount(1);
      await expect(row.locator(TITLE)).toBeVisible();
      await expect(row.locator("[data-rail-kind]")).toHaveAttribute(
        "data-rail-kind", RUN_STEP_RAIL_CONFORMANCE_ROW_KINDS[index],
      );
      await expect(row.locator("[data-rail-status]")).toHaveAttribute(
        "data-rail-status", RUN_STEP_RAIL_CONFORMANCE_ROW_STATUSES[index],
      );
    }

    // Settled, active and upcoming titles must coexist on this one real rail.
    const states = ["completed", "completed", "completed", "active", "inactive"];
    for (const [index, state] of states.entries()) {
      await expect(rows.nth(index)).toHaveAttribute("data-state", state);
      await expect(rows.nth(index).locator(TITLE)).toHaveAttribute("data-state", state);
    }
    await expect(rail.locator(`${ROW}[data-state="active"]`)).toHaveCount(1);
    expect(RUN_STEP_RAIL_CONFORMANCE_PAUSED_POSITION).toBe(4);
    expect(RUN_STEP_RAIL_CONFORMANCE_SETTLED_POSITION).toBe(2);
    expect(RUN_STEP_RAIL_CONFORMANCE_UPCOMING_POSITIONS).toEqual([5]);
    await expect(rows.nth(1).locator('[data-rail-gate-history="true"]')).toHaveCount(1);
    await expect(rows.nth(3).locator('[data-rail-gate-pending="true"]')).toHaveCount(1);

    const reading = await rail.evaluate((element, selectors) => {
      const scopeStyle = getComputedStyle(element);
      // The browser resolves the palette's own tokens into its serialized
      // color format. These hidden oracle nodes never change title styling.
      const resolveColor = (token: string): string => {
        const probe = document.createElement("span");
        probe.hidden = true;
        probe.style.color = `var(${token})`;
        element.appendChild(probe);
        try {
          return getComputedStyle(probe).color;
        } finally {
          probe.remove();
        }
      };
      return {
        rawMuted: scopeStyle.getPropertyValue("--muted").trim(),
        rawForeground: scopeStyle.getPropertyValue("--foreground").trim(),
        muted: resolveColor("--muted"),
        foreground: resolveColor("--foreground"),
        titles: Array.from(element.querySelectorAll(selectors.row), (row) => {
          const title = row.querySelector(selectors.title);
          if (!title) throw new Error("Missing actual rail title");
          return {
            rowState: row.getAttribute("data-state"),
            titleState: title.getAttribute("data-state"),
            nodeColor: getComputedStyle(title).color,
          };
        }),
      };
    }, { row: ROW, title: TITLE });

    expect(reading.rawMuted).not.toBe("");
    expect(reading.rawForeground).not.toBe("");
    expect(reading.muted).not.toBe("");
    expect(reading.foreground).not.toBe("");
    expect(reading.muted).not.toBe(reading.foreground);
    expect(reading.titles).toHaveLength(5);
    for (const [index, title] of reading.titles.entries()) {
      expect(title.rowState).toBe(states[index]);
      expect(title.titleState).toBe(states[index]);
      expect(title.nodeColor, `title ${index + 1} in ${palette.name}`).toBe(
        index === 3 ? reading.foreground : reading.muted,
      );
    }
    expect(reading.titles[3].nodeColor).not.toBe(reading.titles[1].nodeColor);
    expect(reading.titles[3].nodeColor).not.toBe(reading.titles[4].nodeColor);
  });
}
