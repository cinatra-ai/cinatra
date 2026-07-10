// @vitest-environment jsdom
//
// Behavioural regression test for the multi-select access picker's TRIGGER
// (cinatra#1261). Renders the REAL AccessComboboxHierarchical in `multiple`
// mode under jsdom and drives the trigger with a real click, asserting the
// popover actually OPENS (aria-expanded → true, option rows rendered).
//
// This is the test that would have caught the shipped blocker: when a
// multi-selection summarises to a composed label (selection.length > 1) the
// trigger was wrapped `<PopoverTrigger asChild><TooltipProvider>…`, so
// PopoverTrigger's Slot merged the popover's open handler + ref onto
// <TooltipProvider> — which renders no DOM node and forwards nothing — and the
// multi-scope trigger could never be opened. A source-text/props-shape test
// cannot see that; only
// clicking a rendered 2+-selection trigger and observing the popover does.
//
// The single-selection open path (bare PopoverTrigger → Button) is asserted
// alongside as the control that was always working, so a future regression on
// EITHER trigger shape fails here.
//
//   pnpm exec vitest run \
//     src/components/__tests__/access-combobox-hierarchical-multi-open.test.tsx

import "./access-picker-jsdom-shims";
import { afterEach, describe, it, expect } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  AccessComboboxHierarchical,
  type AvailableScopes,
} from "@/components/access-combobox-hierarchical";

const SCOPES: AvailableScopes = {
  orgs: [
    {
      id: "org-acme",
      name: "Acme Corp",
      teams: [
        { id: "team-rev", name: "Revenue" },
        { id: "team-eng", name: "Engineering" },
      ],
    },
    { id: "org-beta", name: "Beta LLC", teams: [{ id: "team-ops", name: "Ops" }] },
  ],
  projects: [{ id: "proj-atlas", name: "Atlas" }],
  canGrantWorkspace: true,
};

afterEach(() => cleanup());

describe("AccessComboboxHierarchical multi-select trigger opens (cinatra#1261)", () => {
  it("opens the popover from a multi-scope trigger (2+ selections)", () => {
    // selection.length > 1 → the tooltip-wrapped trigger, the shape that was
    // broken. resolveAccessSummary renders the composed "1 project, 1 team".
    render(
      <AccessComboboxHierarchical
        multiple
        value={["team:team-rev", "project:proj-atlas"]}
        onChange={() => {}}
        scopes={SCOPES}
      />,
    );

    const trigger = screen.getByRole("combobox");
    expect(trigger.textContent ?? "").toMatch(/1 project, 1 team/i);
    // Popover starts closed.
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryAllByRole("option")).toHaveLength(0);

    fireEvent.click(trigger);

    // The regression: on the buggy nesting this stayed "false" and no options
    // rendered because the open handler landed on <TooltipProvider>.
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByRole("option").length).toBeGreaterThan(0);
    // The selectable "Only me" (owner) row is one of the rendered options.
    expect(
      screen.getAllByRole("option").some((o) => /only me/i.test(o.textContent ?? "")),
    ).toBe(true);
  });

  it("opens the popover from a single-selection trigger (control)", () => {
    // selection.length === 1 → the bare PopoverTrigger → Button path, which was
    // always working; asserted so a regression on either shape is caught here.
    render(
      <AccessComboboxHierarchical
        multiple
        value={["team:team-rev"]}
        onChange={() => {}}
        scopes={SCOPES}
      />,
    );

    const trigger = screen.getByRole("combobox");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);

    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByRole("option").length).toBeGreaterThan(0);
  });
});
