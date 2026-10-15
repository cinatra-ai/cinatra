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
//  - the reserved Help tab is read-only: advisories form bare labeled prose and
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

// The renderer reads the app router so a successful action can refresh the
// page's SERVER half (the Sharing tab node the host composes from the live
// connection identity rows). jsdom mounts the form outside any app-router
// context, where `useRouter` throws its invariant, so it is stubbed here.
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: () => {},
    push: () => {},
    replace: () => {},
    prefetch: () => {},
    back: () => {},
    forward: () => {},
  }),
}));


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
  it("renders a tablist: Setup first, Sharing SECOND, declared tab next, Help LAST", async () => {
    await renderForm({ installId: "i1", packageName: "@x/y", surface: surfaceOf(tabbedRaw) });
    const tablist = container.querySelector('[role="tablist"]');
    expect(tablist).toBeTruthy();
    const tabLabels = [...container.querySelectorAll('[role="tab"]')].map((t) => t.textContent);
    expect(tabLabels).toEqual(["Setup", "Sharing", "Local shell", "Help"]);
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

  it("renders §II design201 Help as bare read-only labeled prose (inputs dropped)", async () => {
    await renderForm({ installId: "i1", packageName: "@x/y", surface: surfaceOf(tabbedRaw) });
    const prose = container.querySelector('[data-testid="help-prose"]')!;
    expect(prose).toBeTruthy();
    expect(container.querySelector('[data-testid="help-card"]')).toBeNull();
    expect(prose.closest('[data-slot="card"]')).toBeNull();
    expect(prose.querySelector('[data-slot="card-content"], [data-testid="schema-config-advisory"]')).toBeNull();
    const sections = prose.querySelectorAll('[data-testid="help-section"]');
    expect(sections).toHaveLength(2);
    expect([...sections].map((s) => s.querySelector("h3")?.textContent)).toEqual(["Connect Acme", "About uploads"]);
    expect([...sections].map((s) => s.querySelector("p")?.textContent?.trim())).toEqual([
      "Create a key and paste it on the Setup tab.", "Uploads are retained by the vendor.",
    ]);
    expect(prose.querySelector('input, select, textarea, button, [role="switch"], form')).toBeNull();
    expect(container.querySelector('input[name="helpNote"]')).toBeNull();
  });

  it("pins §II design201 Narrow/section/type contracts while Sharing remains separate", async () => {
    await renderForm({ installId: "i1", packageName: "@x/y", surface: surfaceOf(tabbedRaw), sharingTab: <div data-testid="shared-content">Shared</div> });
    const prose = container.querySelector('[data-testid="help-prose"]')!;
    expect(prose.classList.contains("max-w-xl")).toBe(true); // Narrow 576px; browser pin below.
    expect(prose.classList.contains("gap-5")).toBe(true); // 20px between sections.
    expect(prose.closest('[data-slot="tabs"]')?.classList.contains("gap-6")).toBe(true); // 24px below the tab row.
    for (const section of prose.querySelectorAll('[data-testid="help-section"]')) {
      expect(section.classList.contains("gap-1")).toBe(true); // heading-over-paragraph 4px.
      const heading = section.querySelector("h3")!;
      expect(heading.className).toContain("font-display"); // Archivo: drawing --font-sans, app --font-display.
      expect(heading.className).toContain("font-semibold");
      expect(heading.className).toContain("leading-5");
      expect(section.querySelector("p")?.className).toContain("leading-6");
    }
    expect(prose.querySelector('[data-testid="shared-content"]')).toBeNull();
    expect(container.querySelector('[data-testid="shared-content"]')?.closest('[role="tabpanel"]')).not.toBe(prose.closest('[role="tabpanel"]'));
  });

  it.each([["ready", true], ["not ready", false], ["failed", null]] as const)("preserves the literal Help text selection when the probe is %s", async (_name, ready) => {
    const copy = { whenReady: "Ready: use the Setup tab.", whenNotReady: "Not ready: connect first." };
    vi.stubGlobal("fetch", vi.fn(async () => ready === null
      ? new Response("unavailable", { status: 503 })
      : new Response(JSON.stringify({ result: { ready } }), { status: 200 })));
    await renderForm({ installId: "i1", packageName: "@x/y", surface: surfaceOf({ fields: [{ kind: "text", key: "setupNote", label: "Setup note" }], tabs: [{ id: "help", label: "Help", fields: [{ kind: "advisory", label: "Next step", tone: "info", probeActionId: "helpReady", ...copy }] }] }) });
    const section = container.querySelector('[data-testid="help-section"]')!;
    expect(section.querySelector("h3")?.textContent).toBe("Next step");
    expect(section.querySelector("p")?.textContent?.trim()).toBe(ready === true ? copy.whenReady : copy.whenNotReady);
  });

  it("keeps the Help heading while the existing readiness probe is pending", async () => {
    let answer!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { answer = resolve; })));
    await renderForm({ installId: "i1", packageName: "@x/y", surface: surfaceOf({ fields: [{ kind: "text", key: "setupNote", label: "Setup note" }], tabs: [{ id: "help", label: "Help", fields: [{ kind: "advisory", label: "Next step", tone: "info", probeActionId: "helpReady", whenReady: "Ready", whenNotReady: "Not ready" }] }] }) });
    const section = container.querySelector('[data-testid="help-section"]')!;
    expect(section.querySelector("h3")?.textContent).toBe("Next step");
    expect(section.querySelector("p")?.textContent?.trim()).toBe("");
    await act(async () => { answer(new Response(JSON.stringify({ result: { ready: true } }), { status: 200 })); });
    expect(section.querySelector("p")?.textContent?.trim()).toBe("Ready");
  });

  it("treats markup-looking connector Help as literal text, without links or executable nodes", async () => {
    const text = '<img src=x onerror="alert(1)"> [Console](javascript:alert(1)) - a literal step';
    await renderForm({ installId: "i1", packageName: "@x/y", surface: surfaceOf({ fields: [{ kind: "text", key: "setupNote", label: "Setup note" }], tabs: [{ id: "help", label: "Help", fields: [{ kind: "advisory", label: "Literal content", tone: "info", probeActionId: "helpReady", whenReady: text, whenNotReady: text }] }] }) });
    const prose = container.querySelector('[data-testid="help-prose"]')!;
    expect(prose.querySelector("p")?.textContent?.trim()).toBe(text);
    expect(prose.querySelector("a, img, script, iframe, ul, ol")).toBeNull();
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
    // Setup, the fixed Sharing panel, the declared tab, Help.
    expect(panels).toHaveLength(4);
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
  it("carries the two FIXED tabs even when the connector declares none of its own", async () => {
    // §II: "Two tabs are fixed and every connector carries both: Setup first
    // and Sharing second. The strip is therefore never absent; a custom tab
    // extends it rather than introducing it."
    const surface = surfaceOf({ fields: [{ kind: "text", key: "apiKey", label: "API key" }] });
    await renderForm({
      installId: "i1",
      packageName: "@x/y",
      surface,
      sharingTab: <div data-testid="sharing">sharing</div>,
    });
    const tabLabels = [...container.querySelectorAll('[role="tab"]')].map((t) => t.textContent);
    expect(tabLabels).toEqual(["Setup", "Sharing"]);
    expect(container.querySelector('input[name="apiKey"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="sharing"]')).toBeTruthy();
  });

  it("puts the sharing content on the Sharing PANEL — never inside the Setup panel", async () => {
    // §II: "sharing is decided on its own tab, never inside Setup."
    const surface = surfaceOf({ fields: [{ kind: "text", key: "apiKey", label: "API key" }] });
    await renderForm({
      installId: "i1",
      packageName: "@x/y",
      surface,
      aside: <div data-testid="status-card">status</div>,
      sharingTab: <div data-testid="sharing">sharing</div>,
    });
    const panels = [...container.querySelectorAll('[role="tabpanel"]')];
    expect(panels.length).toBe(2);
    const [setupPanel, sharingPanel] = panels;
    expect(setupPanel.querySelector('input[name="apiKey"]')).toBeTruthy();
    expect(setupPanel.querySelector('[data-testid="sharing"]')).toBeNull();
    expect(sharingPanel.querySelector('[data-testid="sharing"]')).toBeTruthy();
    expect(sharingPanel.querySelector('input[name="apiKey"]')).toBeNull();
  });

  it("renders the two-column grid when the host passes an aside (flat surface)", async () => {
    const surface = surfaceOf({ fields: [{ kind: "text", key: "apiKey", label: "API key" }] });
    await renderForm({
      installId: "i1",
      packageName: "@x/y",
      surface,
      aside: <div data-testid="status-card">status</div>,
      sharingTab: <div data-testid="sharing">sharing</div>,
    });
    const columns = container.querySelector('[data-conformance-id="connector-setup"]')!;
    expect(columns).toBeTruthy();
    expect(columns.querySelector('input[name="apiKey"]')).toBeTruthy();
    expect(columns.querySelector('[data-testid="status-card"]')).toBeTruthy();
    // The sharing content is NOT part of the setup body at all.
    const sharing = container.querySelector('[data-testid="sharing"]')!;
    expect(sharing).toBeTruthy();
    expect(columns.contains(sharing)).toBe(false);
  });
});
