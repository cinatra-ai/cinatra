// @vitest-environment jsdom
//
// Live-render contract for the access picker's §VI containment (cinatra#1607
// AC2/AC3): parentScope / allowedScopes narrow the offered rows, and an
// out-of-scope selection is reconciled away with the invalidation surfaced
// inline (§6.6). Driven through a real jsdom render + open so the wiring is
// exercised, not just the pure algebra (covered in access-containment.test.ts).
//
//   pnpm exec vitest run src/components/__tests__/access-combobox-containment.test.tsx

import "./access-picker-jsdom-shims";
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  AccessCombobox,
  type AvailableScopes,
  type AccessComboboxProps,
} from "@/components/access-combobox";

const NESTED: AvailableScopes = {
  orgs: [
    { id: "org-acme", name: "Acme Corp", teams: [{ id: "team-rev", name: "Revenue" }, { id: "team-eng", name: "Engineering" }] },
    { id: "org-beta", name: "Beta LLC", teams: [{ id: "team-ops", name: "Ops" }] },
  ],
  projects: [{ id: "proj-atlas", name: "Atlas" }],
  canGrantWorkspace: true,
};

const FLAT: AccessComboboxProps["availableScopes"] = {
  projects: [{ id: "proj-atlas", name: "Atlas" }],
  teams: [{ id: "team-rev", name: "Revenue" }, { id: "team-eng", name: "Engineering" }],
  orgName: "Acme Corp",
  orgId: "org-acme",
  workspaceExposed: true,
};

afterEach(() => cleanup());

function openSingle() {
  fireEvent.click(screen.getByRole("combobox"));
}
const rowTexts = () =>
  screen.getAllByRole("option").map((o) => (o.textContent ?? "").replace(/\s+/g, " ").trim());

describe("single-mode containment (spec §6.1)", () => {
  it("org parent → only that org's teams/projects + Personal; org row + workspace excluded", () => {
    render(
      <AccessCombobox
        value="owner"
        onValueChange={() => {}}
        availableScopes={FLAT}
        isAdmin
        parentScope={{ kind: "org", id: "org-acme" }}
      />,
    );
    openSingle();
    const texts = rowTexts();
    expect(texts.some((t) => /Personal:.*Only me/.test(t))).toBe(true);
    expect(texts.some((t) => /Project:.*Atlas/.test(t))).toBe(true);
    expect(texts.some((t) => /Team:.*Revenue/.test(t))).toBe(true);
    // org row + workspace/admin are excluded under an org parent (strict descendants)
    expect(texts.some((t) => /Anyone in|Organization:/.test(t))).toBe(false);
    expect(texts.some((t) => /Workspace:/.test(t))).toBe(false);
  });

  it("leaf parent → Personal only (fail closed)", () => {
    render(
      <AccessCombobox
        value="owner"
        onValueChange={() => {}}
        availableScopes={FLAT}
        isAdmin
        parentScope={{ kind: "team", id: "team-rev" }}
      />,
    );
    openSingle();
    const texts = rowTexts();
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatch(/Personal:.*Only me/);
  });

  it("no parent (default) → all options render, no reconciliation callback", () => {
    const onValueChange = vi.fn();
    render(<AccessCombobox value="owner" onValueChange={onValueChange} availableScopes={FLAT} isAdmin />);
    openSingle();
    const texts = rowTexts();
    expect(texts.some((t) => /Workspace:.*All/.test(t))).toBe(true);
    expect(texts.some((t) => /Organization:.*Acme Corp/.test(t))).toBe(true);
    expect(onValueChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("§6.6 reconciliation: an out-of-scope value is cleared to empty + surfaced inline", () => {
    const onValueChange = vi.fn();
    render(
      <AccessCombobox
        value="workspace"
        onValueChange={onValueChange}
        availableScopes={FLAT}
        isAdmin
        parentScope={{ kind: "org", id: "org-acme" }}
      />,
    );
    expect(onValueChange).toHaveBeenCalledWith("");
    expect(screen.getByRole("status").textContent).toMatch(/no longer available/i);
  });
});

describe("multi-mode containment (spec §6.1 / §6.6)", () => {
  it("org parent → only that org's teams + Personal offered", () => {
    render(
      <AccessCombobox
        selectionMode="multiple"
        value={["owner"]}
        onChange={() => {}}
        scopes={NESTED}
        parentScope={{ kind: "org", id: "org-acme" }}
      />,
    );
    fireEvent.click(screen.getByRole("combobox"));
    const texts = rowTexts();
    expect(texts.some((t) => /Personal:.*Only me/.test(t))).toBe(true);
    expect(texts.some((t) => /Team:.*Revenue/.test(t))).toBe(true);
    // Beta's team (another org) is not a descendant; org/workspace rows excluded
    expect(texts.some((t) => /Ops/.test(t))).toBe(false);
    expect(texts.some((t) => /Organization:|Workspace:/.test(t))).toBe(false);
  });

  it("§6.6 reconciliation: out-of-scope tokens dropped, kept ones retained, surfaced inline", () => {
    const onChange = vi.fn();
    render(
      <AccessCombobox
        selectionMode="multiple"
        value={["team:team-rev", "team:team-ops", "workspace"]}
        onChange={onChange}
        scopes={NESTED}
        parentScope={{ kind: "org", id: "org-acme" }}
      />,
    );
    expect(onChange).toHaveBeenCalledWith(["team:team-rev"]);
    expect(screen.getByRole("status").textContent).toMatch(/no longer in scope/i);
  });
});
