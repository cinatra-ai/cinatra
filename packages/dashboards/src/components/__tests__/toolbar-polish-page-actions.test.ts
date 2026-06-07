// @vitest-environment jsdom
//
// Covers the route-scoped primary-action injection in
// `polishDashboardToolbarsIn` — the /agents + /projects DC-toolbar action
// anchors. The existing
// `toolbar-polish.test.ts` only covers the Edit/Save relabel; the
// PAGE_ACTIONS routing (which anchors get injected on which route, in what
// order, and the negative case that guards against leaking actions into
// other dashboards) was otherwise untested. Visual placement still needs
// owner verification — the routing + idempotency logic is jsdom-testable.

import { describe, expect, test } from "vitest";

import { polishDashboardToolbarsIn } from "../use-dashboard-toolbar-polish";

/** Mount a DC-shaped toolbar inside a shell tagged with `pageAnchor`
 *  (omit for the no-anchor negative case). */
function mountShell(pageAnchor?: string): HTMLElement {
  const shell = document.createElement("div");
  shell.setAttribute("data-cinatra-dashboard-shell", "true");
  if (pageAnchor !== undefined) {
    shell.setAttribute("data-cinatra-page-anchor", pageAnchor);
  }

  const gridContainer = document.createElement("div");
  gridContainer.className = "dashboard-grid-container dc:w-full";

  const toolbar = document.createElement("div");
  toolbar.className =
    "dc:mb-4 dc:flex dc:justify-between dc:items-center dc:sticky dc:top-0";

  // A pre-existing DC child so we can assert the injected anchors land
  // BEFORE it (firstChild insertion).
  const dcChild = document.createElement("div");
  dcChild.className = "dc:flex dc:items-center dc:gap-4";
  dcChild.setAttribute("data-dc-native", "true");
  toolbar.appendChild(dcChild);

  gridContainer.appendChild(toolbar);
  shell.appendChild(gridContainer);
  document.body.appendChild(shell);
  return shell;
}

function injectedAnchors(shell: HTMLElement) {
  return [
    ...shell.querySelectorAll<HTMLAnchorElement>(
      "[data-cinatra-dc-toolbar] > a[data-cinatra-page-action]",
    ),
  ].map((a) => ({
    id: a.getAttribute("data-cinatra-page-action"),
    href: a.getAttribute("href"),
    text: a.textContent?.trim(),
  }));
}

describe("polishDashboardToolbarsIn — route-scoped page-action injection", () => {
  test("agents: injects Run agent then Create agent at the toolbar's left", () => {
    const shell = mountShell("agents");
    polishDashboardToolbarsIn(shell);

    expect(injectedAnchors(shell)).toEqual([
      { id: "run-agent", href: "/agents/run", text: "Run agent" },
      { id: "create-agent", href: "/chat?mode=create-agent", text: "Create agent" },
    ]);

    // Anchors precede the pre-existing DC child (firstChild insertion order).
    const toolbar = shell.querySelector("[data-cinatra-dc-toolbar]")!;
    expect(toolbar.children[0].getAttribute("data-cinatra-page-action")).toBe("run-agent");
    expect(toolbar.children[1].getAttribute("data-cinatra-page-action")).toBe("create-agent");
    expect(toolbar.children[2].getAttribute("data-dc-native")).toBe("true");

    document.body.innerHTML = "";
  });

  test("projects: injects exactly one New project anchor", () => {
    const shell = mountShell("projects");
    polishDashboardToolbarsIn(shell);

    expect(injectedAnchors(shell)).toEqual([
      { id: "new-project", href: "/projects/new", text: "New project" },
    ]);

    document.body.innerHTML = "";
  });

  test("teams: injects exactly one New team anchor", () => {
    const shell = mountShell("teams");
    polishDashboardToolbarsIn(shell);

    expect(injectedAnchors(shell)).toEqual([
      { id: "new-team", href: "/teams/new", text: "New team" },
    ]);

    document.body.innerHTML = "";
  });

  test("no page-anchor: injects nothing (guards against leaking into other dashboards)", () => {
    const shell = mountShell(undefined);
    polishDashboardToolbarsIn(shell);

    expect(injectedAnchors(shell)).toEqual([]);

    document.body.innerHTML = "";
  });

  test("unknown page-anchor: injects nothing", () => {
    const shell = mountShell("nonexistent-surface");
    polishDashboardToolbarsIn(shell);

    expect(injectedAnchors(shell)).toEqual([]);

    document.body.innerHTML = "";
  });

  test("idempotent: running twice does not duplicate the anchors", () => {
    const shell = mountShell("agents");
    polishDashboardToolbarsIn(shell);
    polishDashboardToolbarsIn(shell);

    expect(injectedAnchors(shell).map((a) => a.id)).toEqual(["run-agent", "create-agent"]);

    document.body.innerHTML = "";
  });
});
