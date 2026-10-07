import { expect } from "@playwright/test";
import { SCOPE_SKILLS_MODEL } from "../../../../src/app/design-fixtures/conformance/scope-assignment-skills-fixture-data";
import type { SurfaceDriver } from "./contract";

const selectedRows = '[data-slot="scope-skills-row"]';

/** Extensions §VII / 0.15.5: the real agent page, not a second Skills drawing. */
export const AGENT_ASSIGNMENT_SKILLS_DRIVER: SurfaceDriver = {
  path: "/design-fixtures/conformance",
  root: (page) => page.locator('[data-surface-id="agent-assignment-skills"]'),
  present: async (_page, root) => {
    await expect(root.getByTestId("scope-assignment-page")).toBeVisible();
    await expect(root.getByRole("heading", { name: SCOPE_SKILLS_MODEL.displayName, exact: true })).toBeVisible();
    await expect(root.locator(selectedRows)).toHaveCount(2);
  },
  fields: {
    "scope-label": {
      source: "scope.label",
      assert: async (_page, root) => {
        await expect(root.locator('[data-slot="scope-assignment-scope"]')).toHaveText(SCOPE_SKILLS_MODEL.scopeLabel);
        await expect(root.getByTestId("scope-assignment-page")).toHaveAttribute("data-scope-kind", "team");
        await expect(root.getByTestId("scope-assignment-page")).toHaveAttribute("data-scope-id", "team_growth");
      },
    },
  },
  actions: {
    "search-skills": {
      outcome: "matching-skills-shown",
      run: async (page, root) => {
        const input = root.getByRole("combobox");
        // The list is portalled by the shipped typeahead. Read its accessible
        // listbox, rather than pretending it is a descendant of the mount.
        await expect(async () => {
          await input.click();
          await expect(page.getByRole("option", { name: /Budget Planning/ })).toBeVisible();
        }).toPass({ timeout: 30_000 });
        await input.fill("market");
        await expect(page.getByRole("option", { name: /Market Analysis/ })).toBeVisible();
        await expect(page.getByRole("option", { name: /Budget Planning|Blog Writing|Company Research/ })).toHaveCount(0);
        await expect(page.getByRole("option", { name: /Market Analysis/ })).toContainText("Market Toolkit · by Northstar");
        await expect(root.locator(selectedRows)).toHaveCount(2);
      },
    },
    "remove-skill": {
      outcome: "skill-unassigned",
      run: async (_page, root) => {
        await expect(async () => {
          const remove = root.getByRole("button", { name: "Remove Blog Writing", exact: true });
          // A click before hydration may be swallowed; once removed, the
          // control disappears and retry must read the reached outcome.
          if (await remove.count()) await remove.click();
          await expect(root.locator('[data-skill-id="sk_blog"]')).toHaveCount(0);
          await expect(root.locator('[data-skill-id="sk_research"]')).toContainText("Company Research");
          await expect(root.locator(selectedRows)).toHaveCount(1);
          await expect(root.locator('[data-slot="scope-skills-count"]')).toContainText("1 of 5 skills chosen");
        }).toPass({ timeout: 30_000 });
      },
    },
  },
  states: {
    "kind:agent": async (_page, root) => {
      await expect(root.getByTestId("scope-assignment-page")).toHaveAttribute("data-surface", "agent");
      await expect(root.getByRole("tablist", { name: "Assignment panes" })).toBeVisible();
      await expect(root.getByRole("tab", { name: "Skills", exact: true })).toHaveAttribute("aria-selected", "true");
      await expect(root.getByRole("tab", { name: "Artifacts", exact: true })).toHaveAttribute("aria-selected", "false");
      // The prompt is the production label. #3915 later prefixes it with the
      // scope for cross-scope accessibility; that change has its own tests.
      await expect(root.getByRole("combobox")).toHaveAccessibleName(/Which skills should this agent always use\?$/);
    },
  },
};
