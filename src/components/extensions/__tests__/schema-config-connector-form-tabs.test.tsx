// @vitest-environment jsdom
//
// Renderer coverage for the tabbed schema-config setup surface (design spec:
// app-connectors §II — Setup + custom tabs, reserved Help tab LAST). The tab
// grouping is a generic core primitive; no connector is named. The §II layout
// contract this file locks (owner-reported host defects, 2026-07-10):
//  - the tablist is PAGE-HEADER chrome (TabsListRow above the content columns,
//    never inside the fields column), with the Setup panel owning the
//    two-column grid when the host passes an `aside` status card;
//  - the form never re-renders the page header (`surface.title` /
//    `surface.description` are dropped — the page chrome owns them);
//  - a role-less named action renders as its button ONLY (no FieldLabel
//    echoing the identical text);
//  - the reserved Help tab is read-only prose sitting DIRECTLY on the page
//    ground: no card, panel or chrome wraps it (§II draws none), the advisories
//    render as titled sections straight inside the Narrow wrapper, and
//    input-bearing kinds are NOT rendered (they also never enter the
//    `collectFormInputs()` live-DOM scan);
//  - every OTHER panel stays force-mounted so `collectFormInputs()` still sees
//    inputs on inactive tabs.

import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSchemaConfig } from "@/lib/extension-schema-config";
import { SchemaConfigConnectorForm } from "@/components/extensions/schema-config-connector-form";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  // Advisory sections probe on mount; answer every action POST deterministically.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ result: { ready: true } }), { status: 200 })) as unknown as typeof fetch,
  );
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function surfaceOf(raw: unknown) {
  const parsed = parseSchemaConfig(raw);
  if (!parsed.ok) throw new Error(`fixture invalid: ${parsed.errors.join("; ")}`);
  return parsed.surface;
}
async function renderForm(props: React.ComponentProps<typeof SchemaConfigConnectorForm>) {
  await act(async () => {
    root.render(<SchemaConfigConnectorForm {...props} />);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

const tabbedRaw = {
  // The declared title/description duplicate the page header — the renderer
  // must DROP them (§II: "the form drops the connector blurb").
  title: "Acme Widgets Suite",
  description: "Connect Acme so agents can run.",
  fields: [{ kind: "text", key: "apiKey", label: "API key" }],
  tabs: [
    // Declared with Help FIRST on purpose — the parser must normalize it last.
    {
      id: "help",
      label: "Help",
      fields: [
        {
          kind: "advisory",
          label: "Connect Acme",
          tone: "info",
          probeActionId: "helpContentReady",
          whenReady: "Create a key and paste it on the Setup tab.",
          whenNotReady: "Create a key and paste it on the Setup tab.",
        },
        {
          kind: "advisory",
          label: "About uploads",
          tone: "warning",
          probeActionId: "helpContentReady",
          whenReady: "Uploads are retained by the vendor.",
          whenNotReady: "Uploads are retained by the vendor.",
        },
        // Input-bearing kind on the READ-ONLY Help tab — must NOT render.
        { kind: "text", key: "helpNote", label: "Note" },
      ],
    },
    {
      id: "shell",
      label: "Local shell",
      fields: [
        { kind: "text", key: "shellPath", label: "Path" },
        { kind: "named-action", label: "Save shell settings", actionId: "saveShell" },
      ],
    },
  ],
};

describe("SchemaConfigConnectorForm — tabbed surface", () => {
  it("renders a tablist: Setup first, declared tab next, Help LAST", async () => {
    await renderForm({ installId: "i1", packageName: "@x/y", surface: surfaceOf(tabbedRaw) });
    const tablist = container.querySelector('[role="tablist"]');
    expect(tablist).toBeTruthy();
    const tabLabels = [...container.querySelectorAll('[role="tab"]')].map((t) => t.textContent);
    expect(tabLabels).toEqual(["Setup", "Local shell", "Help"]);
  });

  it("hoists the tablist ABOVE the Setup panel's two-column grid (header chrome, not content-column chrome)", async () => {
    await renderForm({
      installId: "i1",
      packageName: "@x/y",
      surface: surfaceOf(tabbedRaw),
      aside: <div data-testid="status-card">status</div>,
    });
    const tablist = container.querySelector('[role="tablist"]')!;
    const columns = container.querySelector('[data-conformance-id="connector-setup"]')!;
    expect(columns).toBeTruthy();
    // The two-column grid lives INSIDE the Setup tabpanel, and the tablist sits
    // OUTSIDE (above) it — the §II "tablist beneath the page header" contract.
    expect(columns.closest('[role="tabpanel"]')).toBeTruthy();
    expect(tablist.closest('[role="tabpanel"]')).toBeNull();
    expect(columns.contains(tablist)).toBe(false);
    // The aside status card renders in the grid's right column.
    expect(columns.querySelector('[data-testid="status-card"]')).toBeTruthy();
  });

  it("drops surface.title / surface.description (the page header owns them)", async () => {
    await renderForm({ installId: "i1", packageName: "@x/y", surface: surfaceOf(tabbedRaw) });
    expect(container.textContent).not.toContain("Acme Widgets Suite");
    expect(container.textContent).not.toContain("Connect Acme so agents can run.");
    expect(container.querySelector("legend")).toBeNull();
  });

  it("renders a role-less named action as its button ONLY — no FieldLabel echoing the button text", async () => {
    await renderForm({ installId: "i1", packageName: "@x/y", surface: surfaceOf(tabbedRaw) });
    const matches = [...container.querySelectorAll("button, label, [data-slot='field-label']")]
      .filter((el) => el.textContent === "Save shell settings");
    expect(matches).toHaveLength(1);
    expect(matches[0].tagName).toBe("BUTTON");
  });

  it("narrows custom-tab content to the Narrow width (max-w-xl), per §II", async () => {
    await renderForm({ installId: "i1", packageName: "@x/y", surface: surfaceOf(tabbedRaw) });
    const shellInput = container.querySelector('input[name="shellPath"]')!;
    expect(shellInput.closest(".max-w-xl")).toBeTruthy();
  });

  // Chrome the drawing does not draw around the Help prose: a card/panel slot,
  // a project paint utility (soft-panel/glass/card-*), or a wrapper painting a
  // frame (rounded corners, a border/ring, a filled ground, a shadow) or inset
  // padding that would lift the prose off the page ground. Variant prefixes are
  // stripped (`md:bg-card` paints exactly as `bg-card` does) and the zeroing
  // resets (`bg-transparent`, `border-0`, `p-0`, …) paint nothing at all.
  const PAINT_RESET =
    /^(bg-transparent|bg-none|border-0|ring-0|shadow-none|rounded-none|p-0|px-0|py-0|pt-0|pb-0|pl-0|pr-0|ps-0|pe-0|divide-x-0|divide-y-0)$/;
  const PAINT_UTILITY = /^(rounded|border|ring|shadow|bg|divide|p|px|py|pt|pb|pl|pr|ps|pe)(-|$)/;
  const PAINT_PROJECT = /^(soft-panel|soft-panel-flush|glass|card)(-|$)/;
  const PAINT_ARBITRARY = /^\[(background|border|box-shadow|padding|outline)/;
  function paintedClasses(el: Element): string[] {
    return [...el.classList].filter((raw) => {
      const bare = raw.includes(":") ? raw.slice(raw.lastIndexOf(":") + 1) : raw;
      if (PAINT_RESET.test(bare)) return false;
      return PAINT_UTILITY.test(bare) || PAINT_PROJECT.test(bare) || PAINT_ARBITRARY.test(bare);
    });
  }
  function helpPanelOf() {
    const sections = [...container.querySelectorAll('[data-testid="help-section"]')];
    expect(sections.length).toBeGreaterThan(0);
    const panel = sections[0].closest('[role="tabpanel"]');
    expect(panel).toBeTruthy();
    return { sections, panel: panel as HTMLElement };
  }

  it("renders NOTHING the drawing does not draw on the Help tab — no card, panel or chrome wrapping the prose", async () => {
    await renderForm({ installId: "i1", packageName: "@x/y", surface: surfaceOf(tabbedRaw) });
    const { sections, panel } = helpPanelOf();
    expect(sections).toHaveLength(2);
    expect(sections[0].textContent).toContain("Connect Acme");
    expect(sections[1].textContent).toContain("About uploads");
    // No card/panel component renders anywhere on the Help tab.
    expect(panel.querySelector('[data-testid="help-card"]')).toBeNull();
    expect(panel.querySelector('[data-slot="card"]')).toBeNull();
    expect(panel.querySelector('[data-slot="card-content"]')).toBeNull();
    expect(panel.querySelector('[data-slot="card-header"]')).toBeNull();
    expect(panel.querySelector('[data-slot="alert"]')).toBeNull();
    // The advisories do NOT render as separate Alert cards on the Help tab.
    expect(panel.querySelector('[data-testid="schema-config-advisory"]')).toBeNull();
    // Nor does the prose section itself, nor any element between it and the tab
    // panel (the panel included), paint chrome around the prose.
    for (const section of sections) {
      for (let el: Element | null = section; el && el !== panel.parentElement; el = el.parentElement) {
        expect(paintedClasses(el), `${el.tagName}.${el.className} paints chrome around the Help prose`).toEqual([]);
      }
    }
    // Input-bearing kinds are NOT rendered on the read-only Help tab — so they
    // are also invisible to the collectFormInputs() live-DOM scan.
    expect(container.querySelector('input[name="helpNote"]')).toBeNull();
  });

  it("renders the Help prose AT the Narrow width flush under the tablist, Help last, read-only (no form controls)", async () => {
    await renderForm({ installId: "i1", packageName: "@x/y", surface: surfaceOf(tabbedRaw) });
    const { sections, panel } = helpPanelOf();
    // Help is the LAST tab, and this panel is the one its trigger controls.
    const tabs = [...container.querySelectorAll('[role="tab"]')];
    const last = tabs[tabs.length - 1];
    expect(last.textContent).toBe("Help");
    expect(last.getAttribute("aria-controls")).toBe(panel.getAttribute("id"));
    // The prose sits AT the Narrow width (max-w-xl · 576px): ONE such wrapper,
    // the panel's DIRECT child and the section's DIRECT container, so nothing
    // stands between the tab strip and the prose. Its class list is exactly the
    // Narrow width plus the section rhythm the removed card used to supply — no
    // inset, and no `mx-auto`/`ml-*` offset that would break the flush edge
    // (§II: read-only how-to directly on the page ground).
    const narrowAll = panel.querySelectorAll(".max-w-xl");
    expect(narrowAll).toHaveLength(1);
    const narrow = narrowAll[0];
    expect(narrow.parentElement).toBe(panel);
    expect([...narrow.classList].sort()).toEqual(["flex", "flex-col", "gap-4", "max-w-xl"]);
    for (const section of sections) expect(section.parentElement).toBe(narrow);
    expect(panel.textContent).toContain("Create a key and paste it on the Setup tab.");
    expect(panel.textContent).toContain("Uploads are retained by the vendor.");
    // Read-only: no form element and no form control of any kind on the Help tab.
    expect(panel.querySelector("form")).toBeNull();
    expect(panel.querySelectorAll("input, textarea, select, button, [role='switch']")).toHaveLength(0);
  });

  it("the Help-tab chrome guard reads real paint as chrome and layout/resets as none", () => {
    const el = document.createElement("div");
    for (const painted of [
      "soft-panel",
      "soft-panel-flush",
      "glass",
      "card-surface",
      "rounded-xl",
      "border",
      "ring-1",
      "shadow-sm",
      "bg-card",
      "md:bg-card",
      "data-[state=active]:bg-card",
      "px-4",
      "p-3",
      "divide-y",
    ]) {
      el.className = painted;
      expect(paintedClasses(el), `${painted} must read as chrome`).toEqual([painted]);
    }
    for (const bare of [
      "flex",
      "flex-col",
      "gap-4",
      "max-w-xl",
      "text-sm",
      "font-medium",
      "outline-none",
      "flex-1",
      "pointer-events-none",
      "bg-transparent",
      "border-0",
      "ring-0",
      "shadow-none",
      "rounded-none",
      "p-0",
    ]) {
      el.className = bare;
      expect(paintedClasses(el), `${bare} is not chrome`).toEqual([]);
    }
  });

  it("force-mounts the non-Help panels so inactive-tab inputs stay collectable", async () => {
    await renderForm({ installId: "i1", packageName: "@x/y", surface: surfaceOf(tabbedRaw) });
    // Setup is the active tab, yet the input from the (inactive) shell tab is
    // still in the DOM — this is what keeps collectFormInputs() whole.
    expect(container.querySelector('input[name="apiKey"]')).toBeTruthy();
    expect(container.querySelector('input[name="shellPath"]')).toBeTruthy();
  });

  it("defaults to the Setup tab (exactly one active panel; inactive hidden via data-state)", async () => {
    // jsdom applies no Tailwind CSS, so visibility rides on Radix's data-state
    // (the renderer hides inactive panels with `data-[state=inactive]:hidden`).
    await renderForm({ installId: "i1", packageName: "@x/y", surface: surfaceOf(tabbedRaw) });
    const panels = [...container.querySelectorAll('[role="tabpanel"]')];
    expect(panels).toHaveLength(3);
    const active = panels.filter((p) => p.getAttribute("data-state") === "active");
    expect(active).toHaveLength(1);
    expect(active[0].querySelector('input[name="apiKey"]')).toBeTruthy();
    // Every inactive panel carries the hide hook so it is not shown.
    for (const p of panels) {
      if (p.getAttribute("data-state") === "inactive") {
        expect(p.className).toContain("data-[state=inactive]:hidden");
      }
    }
  });
});

describe("SchemaConfigConnectorForm — flat surface (back-compat)", () => {
  it("renders NO tablist when the connector declares no tabs", async () => {
    const surface = surfaceOf({ fields: [{ kind: "text", key: "apiKey", label: "API key" }] });
    await renderForm({ installId: "i1", packageName: "@x/y", surface });
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(container.querySelector('input[name="apiKey"]')).toBeTruthy();
  });

  it("renders the two-column grid when the host passes an aside (flat surface)", async () => {
    const surface = surfaceOf({ fields: [{ kind: "text", key: "apiKey", label: "API key" }] });
    await renderForm({
      installId: "i1",
      packageName: "@x/y",
      surface,
      aside: <div data-testid="status-card">status</div>,
      setupFooter: <div data-testid="sharing">sharing</div>,
    });
    const columns = container.querySelector('[data-conformance-id="connector-setup"]')!;
    expect(columns).toBeTruthy();
    expect(columns.querySelector('input[name="apiKey"]')).toBeTruthy();
    expect(columns.querySelector('[data-testid="status-card"]')).toBeTruthy();
    // The setup footer renders with the setup surface, outside the grid.
    const footer = container.querySelector('[data-testid="sharing"]')!;
    expect(footer).toBeTruthy();
    expect(columns.contains(footer)).toBe(false);
  });
});
