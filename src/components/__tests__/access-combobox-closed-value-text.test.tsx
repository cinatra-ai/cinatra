// @vitest-environment jsdom
//
// THE CLOSED VALUE READS EXACTLY AS THE ROW READS (cinatra#3204).
//
// The ratified drawing's Extensions §I.1 says of the install panel's picker:
// "The picker opens preselected to Workspace: All ... and its closed value
// renders exactly as the row reads, per the single-mode trigger ≡ row rule."
//
// `access-combobox-trigger-equals-row.test.tsx` proves the trigger and the row
// carry the SAME words. It cannot catch what this file catches, because it
// reads the two label spans separately and re-joins them with a space of its
// own — so a label whose DOM text is "Workspace:All" passes there and reads
// "Workspace:All" to everything that extracts text from the page: the browser
// walk, a copy-paste, a screen scrape, an assertion.
//
// Here the label is read the way a reader outside the component reads it: the
// element's own text, untouched. The space between the scope and the name is
// part of the label, not a flex gap that happens to look like one.
//
//   pnpm exec vitest run src/components/__tests__/access-combobox-closed-value-text.test.tsx

import "./access-picker-jsdom-shims";
import { afterEach, describe, it, expect } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AccessCombobox, type AccessComboboxProps } from "@/components/access-combobox";

afterEach(() => cleanup());

const SCOPES: AccessComboboxProps["availableScopes"] = {
  projects: [{ id: "p1", name: "Atlas" }],
  teams: [{ id: "t1", name: "Revenue" }],
  orgName: "Acme Corp",
  orgId: "org-acme",
  workspaceExposed: true,
};

/** The trigger's own text, exactly as the DOM holds it. */
function closedValueText(): string {
  return screen.getByRole("combobox").textContent ?? "";
}

/** The checked row's own text, exactly as the DOM holds it. */
function selectedRowText(): string {
  fireEvent.click(screen.getByRole("combobox"));
  const checked = screen
    .getAllByRole("option")
    .filter((o) => o.querySelector("svg.opacity-100") !== null);
  expect(checked).toHaveLength(1);
  return checked[0]!.textContent ?? "";
}

describe("AccessCombobox — the closed value's own DOM text carries the space", () => {
  it("the install default renders 'Workspace: All', not 'Workspace:All'", () => {
    render(
      <AccessCombobox
        value="workspace"
        onValueChange={() => {}}
        availableScopes={SCOPES}
        isAdmin
        installMode
      />,
    );
    expect(closedValueText()).toBe("Workspace: All");
    expect(closedValueText()).not.toContain("Workspace:All");
  });

  it("the row it mirrors carries the same space, so trigger and row are the same string", () => {
    render(
      <AccessCombobox value="workspace" onValueChange={() => {}} availableScopes={SCOPES} isAdmin />,
    );
    const trigger = closedValueText();
    expect(selectedRowText()).toBe(trigger);
    expect(trigger).toBe("Workspace: All");
  });

  it.each([
    ["admin", "Workspace: Admins only"],
    ["owner", "Personal: Only me"],
    ["org:org-acme", "Organization: Acme Corp"],
    ["team:t1", "Team: Revenue"],
    ["project:p1", "Project: Atlas"],
  ])("every scope kind reads '<Scope>: <name>' with the space (%s)", (value, expected) => {
    render(
      <AccessCombobox value={value} onValueChange={() => {}} availableScopes={SCOPES} isAdmin />,
    );
    expect(closedValueText()).toBe(expected);
  });
});
