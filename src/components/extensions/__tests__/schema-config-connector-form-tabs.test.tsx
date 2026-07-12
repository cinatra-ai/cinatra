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
//  - the reserved Help tab is read-only: advisories merge into ONE card and
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

  it("renders the Help tab as ONE card of read-only sections (advisories merged, inputs dropped)", async () => {
    await renderForm({ installId: "i1", packageName: "@x/y", surface: surfaceOf(tabbedRaw) });
    const cards = container.querySelectorAll('[data-testid="help-card"]');
    expect(cards).toHaveLength(1);
    const sections = cards[0].querySelectorAll('[data-testid="help-section"]');
    expect(sections).toHaveLength(2);
    expect(sections[0].textContent).toContain("Connect Acme");
    expect(sections[1].textContent).toContain("About uploads");
    // The advisories do NOT render as separate Alert cards on the Help tab.
    expect(cards[0].querySelector('[data-testid="schema-config-advisory"]')).toBeNull();
    // Input-bearing kinds are NOT rendered on the read-only Help tab — so they
    // are also invisible to the collectFormInputs() live-DOM scan.
    expect(container.querySelector('input[name="helpNote"]')).toBeNull();
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
