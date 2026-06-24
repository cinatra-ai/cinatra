// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from "vitest";

import {
  inertSiblingsAlongAncestorChain,
  resolveDcModalEscapeClose,
  type DcModalEscapeState,
} from "../components/dc-modal-a11y-helpers";

/**
 * Hermetic tests for the inert-siblings-along-active-dialog-ancestor-
 * chain helper.
 *
 * Uses vitest's jsdom environment (see file-top pragma) so `document`,
 * `HTMLElement`, and friends are global. We don't depend on
 * drizzle-cube/client, the dashboard store, or a live React tree.
 *
 * Asserts the behaviour needed for active modal isolation: walk the FULL
 * ancestor chain and inert every sibling at every level, so dashboard
 * controls under the same ancestor branch as the dialog still get inert.
 *
 *   1. Deep dialog under body > dashboard-shell > grid > dialog —
 *      EVERY sibling at every level is inerted: page-shell siblings of
 *      dashboard-shell, grid's sibling portlets, dialog's sibling
 *      nodes inside grid.
 *   2. Cleanup restores the original `inert` state on every touched
 *      element.
 *   3. Elements that already had `inert` keep it after cleanup.
 *   4. Detached dialog (null) is a no-op.
 *   5. Non-HTMLElement siblings (text nodes, comments) are skipped.
 */

function buildDeepDom(): void {
  document.body.innerHTML = `
    <div id="app-shell">
      <nav id="sidebar"><button id="sidebar-btn">side</button></nav>
      <main id="content"></main>
    </div>
    <div id="dashboard-shell">
      <header id="dash-toolbar"><button id="toolbar-btn">edit</button></header>
      <div id="grid">
        <div id="portlet-1"><button id="portlet-1-btn">refresh</button></div>
        <div id="portlet-2"><button id="portlet-2-btn">refresh</button></div>
        <div role="dialog" aria-modal="true" id="edit-modal">
          <button id="modal-btn">x</button>
        </div>
      </div>
    </div>
    <div id="toaster"></div>
  `;
}

describe("inertSiblingsAlongAncestorChain modal isolation", () => {
  beforeEach(() => {
    buildDeepDom();
  });

  it("inerts every sibling at every ancestor level and leaves the dialog's chain interactive", () => {
    const body = document.body;
    const dialog = document.getElementById("edit-modal")!;
    expect(dialog).toBeTruthy();

    inertSiblingsAlongAncestorChain(body, dialog);

    // body-level siblings of dashboard-shell:
    expect(document.getElementById("app-shell")!.hasAttribute("inert")).toBe(true);
    expect(document.getElementById("toaster")!.hasAttribute("inert")).toBe(true);

    // dashboard-shell stays interactive (it's on the dialog's chain):
    expect(document.getElementById("dashboard-shell")!.hasAttribute("inert")).toBe(false);

    // dashboard-shell siblings of grid:
    expect(document.getElementById("dash-toolbar")!.hasAttribute("inert")).toBe(true);

    // grid stays interactive:
    expect(document.getElementById("grid")!.hasAttribute("inert")).toBe(false);

    // grid's sibling portlets (NOT the dialog) get inert:
    expect(document.getElementById("portlet-1")!.hasAttribute("inert")).toBe(true);
    expect(document.getElementById("portlet-2")!.hasAttribute("inert")).toBe(true);

    // The dialog itself remains interactive:
    expect(dialog.hasAttribute("inert")).toBe(false);
  });

  it("cleanup restores original inert state on every element it set", () => {
    const body = document.body;
    const dialog = document.getElementById("edit-modal")!;

    const cleanup = inertSiblingsAlongAncestorChain(body, dialog);
    expect(document.getElementById("app-shell")!.hasAttribute("inert")).toBe(true);
    expect(document.getElementById("portlet-1")!.hasAttribute("inert")).toBe(true);

    cleanup();
    expect(document.getElementById("app-shell")!.hasAttribute("inert")).toBe(false);
    expect(document.getElementById("toaster")!.hasAttribute("inert")).toBe(false);
    expect(document.getElementById("portlet-1")!.hasAttribute("inert")).toBe(false);
    expect(document.getElementById("portlet-2")!.hasAttribute("inert")).toBe(false);
    expect(document.getElementById("dash-toolbar")!.hasAttribute("inert")).toBe(false);
  });

  it("pre-existing inert attribute is preserved after cleanup", () => {
    const body = document.body;
    const dialog = document.getElementById("edit-modal")!;

    // Pre-existing inert on a sibling that our helper will touch.
    document.getElementById("toaster")!.setAttribute("inert", "");
    document.getElementById("portlet-1")!.setAttribute("inert", "");

    const cleanup = inertSiblingsAlongAncestorChain(body, dialog);
    cleanup();

    // app-shell + toaster + portlet-1 + portlet-2 + dash-toolbar were touched:
    // - app-shell: was NOT inert → restored to NOT inert ✓
    // - toaster: WAS inert → still inert ✓
    // - portlet-1: WAS inert → still inert ✓
    // - portlet-2: was NOT inert → restored to NOT inert ✓
    // - dash-toolbar: was NOT inert → restored to NOT inert ✓
    expect(document.getElementById("app-shell")!.hasAttribute("inert")).toBe(false);
    expect(document.getElementById("toaster")!.hasAttribute("inert")).toBe(true);
    expect(document.getElementById("portlet-1")!.hasAttribute("inert")).toBe(true);
    expect(document.getElementById("portlet-2")!.hasAttribute("inert")).toBe(false);
    expect(document.getElementById("dash-toolbar")!.hasAttribute("inert")).toBe(false);
  });

  it("returns a no-op cleanup when dialog is null", () => {
    const body = document.body;
    const cleanup = inertSiblingsAlongAncestorChain(body, null);
    // Nothing should be inerted.
    expect(document.getElementById("app-shell")!.hasAttribute("inert")).toBe(false);
    expect(document.getElementById("portlet-1")!.hasAttribute("inert")).toBe(false);
    // Cleanup must not throw.
    expect(() => cleanup()).not.toThrow();
  });

  it("returns a no-op cleanup when dialog is detached from root", () => {
    const body = document.body;
    const orphan = document.createElement("div");
    orphan.setAttribute("role", "dialog");
    orphan.setAttribute("aria-modal", "true");
    // Detached — not appended to body or any descendant.

    const cleanup = inertSiblingsAlongAncestorChain(body, orphan);
    // Nothing was inerted because we never reached `body`.
    expect(document.getElementById("app-shell")!.hasAttribute("inert")).toBe(false);
    expect(() => cleanup()).not.toThrow();
  });

  it("skips non-HTMLElement siblings (text nodes, comments)", () => {
    const body = document.body;
    body.appendChild(document.createTextNode("trailing whitespace"));
    body.appendChild(document.createComment("vendor tag"));
    const dialog = document.getElementById("edit-modal")!;

    // Should not throw.
    expect(() => inertSiblingsAlongAncestorChain(body, dialog)).not.toThrow();
    // And actual HTMLElements still get inerted.
    expect(document.getElementById("app-shell")!.hasAttribute("inert")).toBe(true);
  });
});

/**
 * Resolver behind the uniform ESC-to-close behaviour (cinatra#438).
 *
 * The point of the resolver is that ESC must close WHICHEVER dashboard
 * modal is open — including the hand-rolled `TextPortletModal` ("Add
 * text") that ships no ESC handler of its own. These tests pin the
 * mapping from each open flag to its close action, the no-modal no-op,
 * and the deterministic precedence under the (DC-impossible but
 * defensive) double-open case.
 */
describe("resolveDcModalEscapeClose", () => {
  function makeState(
    overrides: Partial<DcModalEscapeState> = {},
  ): DcModalEscapeState {
    return {
      isPortletModalOpen: false,
      isTextModalOpen: false,
      isFilterConfigModalOpen: false,
      deleteConfirmPortletId: null,
      closePortletModal: vi.fn(),
      closeTextModal: vi.fn(),
      closeFilterConfigModal: vi.fn(),
      closeDeleteConfirm: vi.fn(),
      ...overrides,
    };
  }

  it("returns null when no modal is open", () => {
    expect(resolveDcModalEscapeClose(makeState())).toBeNull();
  });

  it("routes ESC to closePortletModal when the portlet modal is open", () => {
    const state = makeState({ isPortletModalOpen: true });
    expect(resolveDcModalEscapeClose(state)).toBe(state.closePortletModal);
  });

  it("routes ESC to closeTextModal when the text modal is open (the gap in #438)", () => {
    const state = makeState({ isTextModalOpen: true });
    expect(resolveDcModalEscapeClose(state)).toBe(state.closeTextModal);
  });

  it("routes ESC to closeFilterConfigModal when the filter config modal is open", () => {
    const state = makeState({ isFilterConfigModalOpen: true });
    expect(resolveDcModalEscapeClose(state)).toBe(state.closeFilterConfigModal);
  });

  it("routes ESC to closeDeleteConfirm when a delete confirmation is pending", () => {
    const state = makeState({ deleteConfirmPortletId: "p1" });
    expect(resolveDcModalEscapeClose(state)).toBe(state.closeDeleteConfirm);
  });

  it("treats an empty-string delete id as an open confirmation (only null means closed)", () => {
    const state = makeState({ deleteConfirmPortletId: "" });
    expect(resolveDcModalEscapeClose(state)).toBe(state.closeDeleteConfirm);
  });

  it("prefers portlet → text → filter → delete on a (defensive) double-open", () => {
    const state = makeState({
      isPortletModalOpen: true,
      isTextModalOpen: true,
      isFilterConfigModalOpen: true,
      deleteConfirmPortletId: "p1",
    });
    expect(resolveDcModalEscapeClose(state)).toBe(state.closePortletModal);
  });
});
