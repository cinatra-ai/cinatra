// @vitest-environment jsdom
//
// Live-render proof of "trigger ≡ row, verbatim" (cinatra#2372, mkt-install
// S1; app-permissions.html c-3.1) for the flat single-select AccessCombobox —
// driven through a real jsdom render + open, not just the pure model (covered
// separately in access-scope-flat.test.ts, against access-scope.ts). Covers
// all six scope kinds PLUS
// the degenerate cases the issue calls out by name: a mismatched org id, an
// empty-tail org token, an org token with no active org in scope, and a
// nameless active org — and the workspace-row tooltip's hover/focus
// reachability with its exact new copy.
//
//   pnpm exec vitest run src/components/__tests__/access-combobox-trigger-equals-row.test.tsx

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

// Both the trigger's <Type>: <name> pair and each row's are TWO adjacent
// spans (the prefix span's own text already carries the trailing ":"; only a
// CSS flex `gap` separates it from the name span — no literal space
// character). Read them as "prefix + ': ' + name" for a human-legible
// assertion string; because the row and trigger are built by the exact same
// two-span construction (rowLabel), this is the real DOM shape either way —
// the point of "verbatim" is that trigger and row produce the SAME text, not
// that either contains a literal space character.
function readTwoSpanLabel(root: Element): string {
  const spans = root.querySelectorAll(":scope > span, :scope > div > span");
  const texts = Array.from(spans).map((s) => (s.textContent ?? "").trim());
  if (texts.length < 2) return (root.textContent ?? "").trim();
  const [prefix, name] = texts;
  // prefix already ends in ":" (rowLabel renders "{prefix}:").
  return `${prefix} ${name}`;
}

function triggerText() {
  const btn = screen.getByRole("combobox");
  const labelWrap = btn.querySelector("span.flex.items-center.min-w-0.gap-1") as Element;
  return readTwoSpanLabel(labelWrap ?? btn);
}

function rowText(o: Element): string {
  const labelWrap = o.querySelector("div.flex.items-center.w-full > span.flex") as Element | null;
  return readTwoSpanLabel(labelWrap ?? o);
}

function openAndRowTexts() {
  fireEvent.click(screen.getByRole("combobox"));
  return screen.getAllByRole("option").map(rowText);
}

// The SELECTED row is the one whose checkmark is visible (renderCheckmark
// flips the Check svg to opacity-100 only for the row whose value equals the
// current selection) — anchoring on it, not on list containment, so a trigger
// rendering the WRONG row's text cannot pass just because the list also
// happens to contain a matching row somewhere (review T3).
function openAndSelectedRowText(): string {
  fireEvent.click(screen.getByRole("combobox"));
  const selectedRows = screen
    .getAllByRole("option")
    .filter((o) => o.querySelector("svg.opacity-100") !== null);
  expect(selectedRows).toHaveLength(1);
  return rowText(selectedRows[0]);
}

// The row whose text should equal the trigger's is the CHECKED/selected row —
// there is exactly one for a real value; for a degenerate/synthetic value the
// list carries two org-shaped rows, and the SYNTHETIC one (never the
// always-rendered real org row) must be the checked one that equals the
// trigger.
function assertTriggerEqualsSelectedRow(expected: string) {
  expect(triggerText()).toBe(expected);
  expect(openAndSelectedRowText()).toBe(expected);
}

describe("AccessCombobox — trigger ≡ row, verbatim, casing included (all six kinds)", () => {
  it("owner -> 'Personal: Only me'", () => {
    render(<AccessCombobox value="owner" onValueChange={() => {}} availableScopes={SCOPES} isAdmin />);
    assertTriggerEqualsSelectedRow("Personal: Only me");
  });

  it("workspace -> 'Workspace: All' (not the retired 'Whole Workspace')", () => {
    render(<AccessCombobox value="workspace" onValueChange={() => {}} availableScopes={SCOPES} isAdmin />);
    assertTriggerEqualsSelectedRow("Workspace: All");
  });

  it("admin -> 'Workspace: Admins only'", () => {
    render(<AccessCombobox value="admin" onValueChange={() => {}} availableScopes={SCOPES} isAdmin />);
    assertTriggerEqualsSelectedRow("Workspace: Admins only");
  });

  it("org:<activeOrgId> -> 'Organization: Acme Corp' (not the retired 'Anyone in Acme Corp')", () => {
    render(<AccessCombobox value="org:org-acme" onValueChange={() => {}} availableScopes={SCOPES} isAdmin />);
    assertTriggerEqualsSelectedRow("Organization: Acme Corp");
  });

  it("team:<id> -> 'Team: Revenue', no uppercase transform (the old TEAM: bug) and no org prefix", () => {
    render(<AccessCombobox value="team:t1" onValueChange={() => {}} availableScopes={SCOPES} isAdmin />);
    assertTriggerEqualsSelectedRow("Team: Revenue");
    expect(triggerText()).not.toContain("TEAM");
    expect(triggerText()).not.toContain("Acme");
  });

  it("project:<id> -> 'Project: Atlas'", () => {
    render(<AccessCombobox value="project:p1" onValueChange={() => {}} availableScopes={SCOPES} isAdmin />);
    assertTriggerEqualsSelectedRow("Project: Atlas");
  });
});

describe("AccessCombobox — trigger ≡ row for degenerate/legacy values (c-3.11)", () => {
  it("a mismatched org id -> 'Organization: the organization', selected — the real active-org row still renders, unselected", () => {
    render(
      <AccessCombobox
        value="org:org-OTHER"
        onValueChange={() => {}}
        availableScopes={SCOPES}
        isAdmin
      />,
    );
    expect(triggerText()).toBe("Organization: the organization");
    // Anchored on the CHECKED row (review T3): the synthetic row — not the
    // real org row also present in the list — is the selected one.
    expect(openAndSelectedRowText()).toBe("Organization: the organization");
    // The real active-org row is STILL rendered (just not selected/checked).
    expect(screen.getAllByRole("option").map(rowText)).toContain("Organization: Acme Corp");
    expect(triggerText()).not.toContain("Acme");
  });

  it("an empty-tail org: token -> the same synthetic neutral row (checked)", () => {
    render(<AccessCombobox value="org:" onValueChange={() => {}} availableScopes={SCOPES} isAdmin />);
    expect(triggerText()).toBe("Organization: the organization");
    expect(openAndSelectedRowText()).toBe("Organization: the organization");
  });

  it("an org token with no active org in scope -> the same synthetic neutral row", () => {
    const noOrgScopes: AccessComboboxProps["availableScopes"] = {
      projects: [],
      teams: [],
      orgName: "Acme Corp",
      workspaceExposed: true,
    };
    render(<AccessCombobox value="org:org-acme" onValueChange={() => {}} availableScopes={noOrgScopes} isAdmin />);
    expect(triggerText()).toBe("Organization: the organization");
  });

  it("a nameless active org -> 'Organization: Your organization' (capital Y — matches the row's historical fallback)", () => {
    const namelessScopes: AccessComboboxProps["availableScopes"] = { ...SCOPES, orgName: "" };
    render(<AccessCombobox value="org:org-acme" onValueChange={() => {}} availableScopes={namelessScopes} isAdmin />);
    assertTriggerEqualsSelectedRow("Organization: Your organization");
  });

  it("an unhydrated team selection -> 'Team: Unknown team', selected", () => {
    render(<AccessCombobox value="team:ghost" onValueChange={() => {}} availableScopes={SCOPES} isAdmin />);
    assertTriggerEqualsSelectedRow("Team: Unknown team");
  });

  it("synthetic rows are DISPLAY-ONLY: the degenerate checked row is aria-disabled and never fires onValueChange", () => {
    let committed: string | null = null;
    render(
      <AccessCombobox
        value="org:org-OTHER"
        onValueChange={(v) => {
          committed = v;
        }}
        availableScopes={SCOPES}
        isAdmin
      />,
    );
    fireEvent.click(screen.getByRole("combobox"));
    const synthRow = screen
      .getAllByRole("option")
      .find((o) => rowText(o) === "Organization: the organization") as HTMLElement;
    expect(synthRow).toBeTruthy();
    expect(synthRow.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(synthRow);
    expect(committed).toBeNull();
  });
});

describe("AccessCombobox — the PRODUCTION no-active-org shape (orgId: '' via `activeOrgId ?? \"\"`) — cinatra#2372 AC2", () => {
  // The wiring the defect shipped on: install-target-picker.ts /
  // screens.tsx pass `activeOrgId ?? ""`, so the picker receives orgId ""
  // (NOT undefined) and the org row's own value is the empty-tail "org:".
  const PROD_NO_ORG_SCOPES: AccessComboboxProps["availableScopes"] = {
    projects: [],
    teams: [],
    orgName: "",
    orgId: "",
    workspaceExposed: false,
  };

  it("the org row renders DISPLAY-ONLY (aria-disabled, no commit) — a platform admin gets no enabled 'org:' row", () => {
    let committed: string | null = null;
    render(
      <AccessCombobox
        value=""
        onValueChange={(v) => {
          committed = v;
        }}
        availableScopes={PROD_NO_ORG_SCOPES}
        isAdmin
        installMode
      />,
    );
    const rows = openAndRowTexts();
    expect(rows).toContain("Organization: the organization");
    const orgRow = screen
      .getAllByRole("option")
      .find((o) => rowText(o) === "Organization: the organization") as HTMLElement;
    expect(orgRow.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(orgRow);
    expect(committed).toBeNull();
  });

  it("a stored empty-tail 'org:' selection renders checked but stays display-only — no duplicate org rows", () => {
    render(
      <AccessCombobox
        value="org:"
        onValueChange={() => {}}
        availableScopes={PROD_NO_ORG_SCOPES}
        isAdmin
        installMode
      />,
    );
    expect(triggerText()).toBe("Organization: the organization");
    expect(openAndSelectedRowText()).toBe("Organization: the organization");
    const orgShaped = screen
      .getAllByRole("option")
      .filter((o) => rowText(o) === "Organization: the organization");
    expect(orgShaped).toHaveLength(1);
    expect((orgShaped[0] as HTMLElement).getAttribute("aria-disabled")).toBe("true");
  });
});

describe("AccessCombobox — the workspace-row tooltip is reachable by hover AND focus, exact new copy (cinatra#2372)", () => {
  it("hover reveals the exact tooltip string on a non-admin's disabled Workspace: All row", async () => {
    render(<AccessCombobox value="owner" onValueChange={() => {}} availableScopes={SCOPES} isAdmin={false} />);
    fireEvent.click(screen.getByRole("combobox"));
    // The reachability fix: the wrapper span (NOT the disabled CommandItem)
    // carries aria-disabled + tabIndex=0 and receives the pointer/focus events.
    const wrapper = document.querySelector('span[aria-disabled="true"][tabindex="0"]');
    expect(wrapper).not.toBeNull();
    fireEvent.pointerEnter(wrapper as Element);
    fireEvent.mouseEnter(wrapper as Element);
    const tooltips = await screen.findAllByText("Only platform admins can select Workspace: All.");
    expect(tooltips.length).toBeGreaterThan(0);
  });

  it("focus (keyboard) ALSO reveals the same tooltip — the span is in the tab order (tabIndex 0)", async () => {
    render(<AccessCombobox value="owner" onValueChange={() => {}} availableScopes={SCOPES} isAdmin={false} />);
    fireEvent.click(screen.getByRole("combobox"));
    const wrapper = document.querySelector('span[aria-disabled="true"][tabindex="0"]') as Element;
    expect(wrapper).not.toBeNull();
    fireEvent.focus(wrapper);
    const tooltips = await screen.findAllByText("Only platform admins can select Workspace: All.");
    expect(tooltips.length).toBeGreaterThan(0);
  });

  it("the retired copy ('scope this to the whole workspace') is gone", () => {
    render(<AccessCombobox value="owner" onValueChange={() => {}} availableScopes={SCOPES} isAdmin={false} />);
    fireEvent.click(screen.getByRole("combobox"));
    expect(screen.queryByText(/scope this to the whole workspace/i)).toBeNull();
  });
});

describe("AccessCombobox — the helper line is gone from the picker itself", () => {
  it("never renders 'Targets you cannot install at are disabled.' (that copy lived in the DIALOG wrapper, removed there — cinatra#2372)", () => {
    render(
      <AccessCombobox
        value="team:t1"
        onValueChange={() => {}}
        availableScopes={SCOPES}
        isAdmin={false}
        installMode
      />,
    );
    fireEvent.click(screen.getByRole("combobox"));
    expect(screen.queryByText(/Targets you cannot install at are disabled/i)).toBeNull();
  });
});
