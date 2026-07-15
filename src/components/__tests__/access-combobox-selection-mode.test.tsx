// @vitest-environment jsdom
//
// Consolidation contract for cinatra#1607 AC1: ONE access-picker component,
// AccessCombobox, parameterized by `selectionMode` ("single" | "multiple"),
// replacing the two former parallel pickers. This test proves the SAME
// component renders BOTH selection modes distinctly:
//
//   • selectionMode="single" (default) → the flat single-select combobox
//     (no checkboxes; a trailing Check marks the selection, closes on select),
//   • selectionMode="multiple"          → the checkbox multi-select picker
//     (each row leads with a Checkbox, stays open on toggle).
//
// Both are driven through a real jsdom render + click so the discriminated
// dispatch is exercised, not just its types. The source-text tail locks that
// the dispatcher branches on the discriminant and that no separate
// AccessComboboxHierarchical export survives.
//
//   pnpm exec vitest run \
//     src/components/__tests__/access-combobox-selection-mode.test.tsx

import "./access-picker-jsdom-shims";
import { readFileSync } from "node:fs";
import { afterEach, describe, it, expect } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as Mod from "@/components/access-combobox";
import {
  AccessCombobox,
  type AvailableScopes,
  type AccessComboboxProps,
} from "@/components/access-combobox";

const NESTED_SCOPES: AvailableScopes = {
  orgs: [
    {
      id: "org-acme",
      name: "Acme Corp",
      teams: [{ id: "team-rev", name: "Revenue" }],
    },
  ],
  projects: [{ id: "proj-atlas", name: "Atlas" }],
  canGrantWorkspace: true,
};

const FLAT_SCOPES: AccessComboboxProps["availableScopes"] = {
  projects: [{ id: "proj-atlas", name: "Atlas" }],
  teams: [{ id: "team-rev", name: "Revenue" }],
  orgName: "Acme Corp",
  orgId: "org-acme",
  workspaceExposed: true,
};

const SOURCE = readFileSync("src/components/access-combobox.tsx", "utf-8");

afterEach(() => cleanup());

describe("AccessCombobox — one component, two selectionMode variants (cinatra#1607 AC1)", () => {
  it("is a single exported component (no residual AccessComboboxHierarchical)", () => {
    expect(typeof Mod.AccessCombobox).toBe("function");
    expect(
      (Mod as Record<string, unknown>).AccessComboboxHierarchical,
    ).toBeUndefined();
  });

  it("selectionMode=\"single\" (default) renders the flat combobox — no flyout search, no aria-checked rows", () => {
    render(
      <AccessCombobox
        value="team:team-rev"
        onValueChange={() => {}}
        availableScopes={FLAT_SCOPES}
        isAdmin
      />,
    );
    const trigger = screen.getByRole("combobox");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    // Rows render...
    const options = screen.getAllByRole("option");
    expect(options.length).toBeGreaterThan(0);
    // ...single mode has NO flyout search (that is multi-only) and its rows are
    // single-select (no per-row aria-checked toggle state).
    expect(screen.queryByPlaceholderText("Search…")).toBeNull();
    expect(options.every((o) => !o.hasAttribute("aria-checked"))).toBe(true);
    // The selected team row hydrates by name.
    expect(options.some((o) => /revenue/i.test(o.textContent ?? ""))).toBe(true);
  });

  it("selectionMode=\"multiple\" renders the checkbox picker — flyout search + aria-checked rows", () => {
    render(
      <AccessCombobox
        selectionMode="multiple"
        value={["team:team-rev"]}
        onChange={() => {}}
        scopes={NESTED_SCOPES}
      />,
    );
    const trigger = screen.getByRole("combobox");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const options = screen.getAllByRole("option");
    expect(options.length).toBeGreaterThan(0);
    // Multi mode exposes the flyout search and marks each row's checkbox state
    // via aria-checked (the checked "team:team-rev" row among them).
    expect(screen.getByPlaceholderText("Search…")).toBeTruthy();
    expect(options.some((o) => o.getAttribute("aria-checked") === "true")).toBe(true);
  });

  it("dispatches on the selectionMode discriminant to one of two render bodies", () => {
    expect(SOURCE).toMatch(/props\.selectionMode === "multiple"/);
    expect(SOURCE).toMatch(/<AccessComboboxMultiSelect \{\.\.\.props\} \/>/);
    expect(SOURCE).toMatch(/<AccessComboboxSingleSelect \{\.\.\.props\} \/>/);
  });
});
