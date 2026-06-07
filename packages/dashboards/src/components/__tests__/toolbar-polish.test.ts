// @vitest-environment jsdom
//
// Validates the dashboards toolbar polish — the MutationObserver-based DOM
// patcher that relabels drizzle-cube's "Edit" / "Finish Editing" button to
// the owner-mandated "Edit dashboard" / "Save dashboard" wording. The
// observer also tags the button with `data-cinatra-save-dashboard` so
// scoped CSS in `dashboard-theme.css` can right-anchor it and draw the
// design-spec hairline separator.
//
// We exercise the pure DOM mutator (`polishDashboardToolbarsIn`) directly
// against fixtures that mirror DC's bundled markup at
// `node_modules/.../drizzle-cube/dist/client/chunks/DashboardEditModal-*.js`
// (toolbar root .dc:sticky · left group .dc:flex.dc:items-center.dc:gap-4 ·
// button with [svg, text] children). Hook-level wiring is integration-tested
// via the live UAT pass — the unit test guarantees the mutator never
// drifts away from the actual DC label values.

import { describe, expect, test } from "vitest";

import { polishDashboardToolbarsIn } from "../use-dashboard-toolbar-polish";

function mountDcToolbarFixture(mode: "view" | "edit"): HTMLElement {
  const shell = document.createElement("div");
  shell.setAttribute("data-cinatra-dashboard-shell", "true");

  // .dashboard-grid-container is DC's outer wrapper.
  const gridContainer = document.createElement("div");
  gridContainer.className = "dashboard-grid-container dc:w-full";

  // The toolbar root carries `dc:sticky` and (in edit mode) sits flex
  // justify-between with a leading "LEFT GROUP" + trailing "RIGHT GROUP".
  const toolbar = document.createElement("div");
  toolbar.className =
    "dc:mb-4 dc:flex dc:justify-between dc:items-center dc:sticky dc:top-0";

  // LEFT GROUP wrapper (gap-4) — Edit/Save button lives here.
  const leftGroup = document.createElement("div");
  leftGroup.className = "dc:flex dc:items-center dc:gap-4";

  const editSaveBtn = document.createElement("button");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "dc:w-4 dc:h-4 dc:mr-1.5");
  editSaveBtn.appendChild(svg);
  editSaveBtn.appendChild(
    document.createTextNode(mode === "view" ? "Edit" : "Finish Editing"),
  );
  leftGroup.appendChild(editSaveBtn);

  if (mode === "edit") {
    // RIGHT GROUP — the `gap-3` flex wrapper that ONLY renders in edit
    // mode (Color palette, Add Text, Add Portlet). The CSS uses its
    // presence as the signal that the leading hairline should render.
    const rightGroup = document.createElement("div");
    rightGroup.className = "dc:flex dc:items-center dc:gap-3";
    const addPortlet = document.createElement("button");
    addPortlet.appendChild(document.createTextNode("Add Portlet"));
    rightGroup.appendChild(addPortlet);
    toolbar.appendChild(leftGroup);
    toolbar.appendChild(rightGroup);
  } else {
    toolbar.appendChild(leftGroup);
  }

  gridContainer.appendChild(toolbar);
  shell.appendChild(gridContainer);
  document.body.appendChild(shell);
  return shell;
}

describe("polishDashboardToolbarsIn — DC toolbar relabel + tagging", () => {
  test("view mode: relabels 'Edit' to 'Edit dashboard' and tags the button + toolbar root", () => {
    const shell = mountDcToolbarFixture("view");
    polishDashboardToolbarsIn(shell);

    const btn = shell.querySelector("button");
    expect(btn).not.toBeNull();
    expect(btn?.textContent?.trim()).toBe("Edit dashboard");
    expect(btn?.getAttribute("data-cinatra-save-dashboard")).toBe("true");

    // Icon SVG is preserved as the first child node — the polish only
    // rewrites the trailing text node.
    const svg = btn?.querySelector("svg");
    expect(svg).not.toBeNull();

    // Toolbar root gets a semantic data-attribute + role for scoped CSS
    // and assistive tech (DC ships no aria role on the toolbar wrapper).
    const toolbar = shell.querySelector(".dashboard-grid-container > .dc\\:sticky");
    expect(toolbar?.getAttribute("data-cinatra-dc-toolbar")).toBe("true");
    expect(toolbar?.getAttribute("role")).toBe("toolbar");
    expect(toolbar?.getAttribute("aria-label")).toBe("Dashboard");

    document.body.innerHTML = "";
  });

  test("edit mode: relabels 'Finish Editing' to 'Save dashboard' and tags the button", () => {
    const shell = mountDcToolbarFixture("edit");
    polishDashboardToolbarsIn(shell);

    const btn = shell.querySelector("button");
    expect(btn).not.toBeNull();
    expect(btn?.textContent?.trim()).toBe("Save dashboard");
    expect(btn?.getAttribute("data-cinatra-save-dashboard")).toBe("true");

    // The other (Add Portlet) button stays untagged + unrenamed.
    const addPortlet = shell.querySelectorAll("button")[1];
    expect(addPortlet?.textContent?.trim()).toBe("Add Portlet");
    expect(addPortlet?.hasAttribute("data-cinatra-save-dashboard")).toBe(false);

    document.body.innerHTML = "";
  });

  test("idempotent: running the polish twice leaves the button correctly labeled", () => {
    const shell = mountDcToolbarFixture("view");
    polishDashboardToolbarsIn(shell);
    polishDashboardToolbarsIn(shell);

    const btn = shell.querySelector("button");
    expect(btn?.textContent?.trim()).toBe("Edit dashboard");

    document.body.innerHTML = "";
  });

  test("re-tags a freshly-mounted button that already carries the relabeled text", () => {
    // Simulates the DC re-render path where the button mounts with the new
    // label but no attribute (the previous polish ran on a now-detached
    // node). The hook must re-tag the freshly-rendered button so scoped
    // CSS can right-anchor it.
    const shell = mountDcToolbarFixture("view");
    const btn = shell.querySelector("button");
    // Pre-set the relabeled text without the tag.
    btn!.lastChild!.textContent = "Edit dashboard";
    expect(btn?.hasAttribute("data-cinatra-save-dashboard")).toBe(false);

    polishDashboardToolbarsIn(shell);

    expect(btn?.getAttribute("data-cinatra-save-dashboard")).toBe("true");
    expect(btn?.textContent?.trim()).toBe("Edit dashboard");

    document.body.innerHTML = "";
  });

  test("no-ops outside the dashboards shell: an unrelated 'Edit' button stays untouched", () => {
    // A button with the same text but living outside the
    // .dashboard-grid-container scope must not be relabeled.
    const outsider = document.createElement("button");
    outsider.appendChild(document.createTextNode("Edit"));
    document.body.appendChild(outsider);

    polishDashboardToolbarsIn(document.body);

    expect(outsider.textContent?.trim()).toBe("Edit");
    expect(outsider.hasAttribute("data-cinatra-save-dashboard")).toBe(false);

    document.body.innerHTML = "";
  });

  test("button with non-DC label is left alone", () => {
    const shell = mountDcToolbarFixture("view");
    // Replace the Edit text with something DC doesn't ship — the polish
    // should degrade to a no-op rather than wrongly tagging the button.
    const btn = shell.querySelector("button");
    btn!.lastChild!.textContent = "Configure";

    polishDashboardToolbarsIn(shell);

    expect(btn?.textContent?.trim()).toBe("Configure");
    expect(btn?.hasAttribute("data-cinatra-save-dashboard")).toBe(false);

    document.body.innerHTML = "";
  });
});
