// @vitest-environment jsdom
//
// cinatra#3214 — the SHARED connector setup shape, asserted on the shared host
// component rather than on one connector (acceptance item 10).
//
// The ratified drawing (specs/app-connectors.html §II "Connector setup page")
// draws ONE setup page for every schema-config connector: "a single generic
// form, never per-connector layout … splits into two columns: a wider left
// column holding the configuration fields, and a narrower right column holding
// the Connection status card", with "the status badge with both icon and label
// plus the Check action beneath it", and the pair that "sit[s] side by side,
// never stacked", where "Disconnect is disabled until the connector is
// connected".
//
// The host used to draw that shape ONLY for a connector that declares a
// `status-probe` field; a probe-less connector fell through to a bare
// single-column body — no card, no badge, no Check. These tests pin the shape
// for BOTH shapes of connector on the one component the route renders.

import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSchemaConfig } from "@/lib/extension-schema-config";
import { SchemaConfigConnectorSetup } from "@/components/extensions/schema-config-connector-setup";

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


// The flash-toast island reads the live router's search params; it is not what
// these tests assert, so it is stubbed to nothing.
vi.mock("@/components/search-param-toast", () => ({
  SearchParamToast: () => null,
}));

// Action outcomes toast through the canonical wrapper (cinatra#1109).
vi.mock("@/lib/cinatra-toast", () => {
  const base = vi.fn();
  const t = Object.assign(base, {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
    promise: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  });
  return { toast: t, cinatraToast: t };
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function surfaceOf(raw: unknown) {
  const parsed = parseSchemaConfig(raw);
  if (!parsed.ok) throw new Error(`fixture invalid: ${parsed.errors.join("; ")}`);
  return parsed.surface;
}

/** A connector that declares NO status-probe but DOES declare the role actions. */
const PROBE_LESS_SURFACE = {
  fields: [
    { kind: "text", key: "bookingPageUrl", label: "Booking page URL" },
    { kind: "named-action", label: "Connect", actionId: "saveConnection", role: "connect" },
    { kind: "named-action", label: "Disconnect", actionId: "clearConnection", role: "disconnect" },
  ],
};

/** A connector that declares its own status-probe (the key-based shape). */
const PROBE_SURFACE = {
  fields: [
    { kind: "status-probe", label: "Connection", actionId: "connectionStatus" },
    { kind: "secret", key: "apiKey", label: "API key" },
    { kind: "named-action", label: "Connect", actionId: "saveConnection", role: "connect" },
    { kind: "named-action", label: "Disconnect", actionId: "clearConnection", role: "disconnect" },
  ],
};

/** A record-list connector: no status-probe AND no role-tagged actions. */
const RECORD_LIST_SURFACE = {
  fields: [
    { kind: "text", key: "bookingPageUrl", label: "Booking page URL" },
    { kind: "named-action", label: "Add schedule", actionId: "addSchedule" },
  ],
};

type SetupProps = React.ComponentProps<typeof SchemaConfigConnectorSetup>;

async function renderSetup(props: Partial<SetupProps> & { surface: SetupProps["surface"] }) {
  await act(async () => {
    root.render(
      <SchemaConfigConnectorSetup
        displayName="Fixture Connector"
        installId="i1"
        packageName="@cinatra-ai/fixture-connector"
        isAdmin={false}
        initialValues={{}}
        connected={false}
        // The route's crumb-publisher island is a client island wired to the
        // shell's pathname/epoch context; this shape only mounts what it is
        // handed, so the shape's own tests hand it nothing to mount.
        crumbTrail={null}
        {...props}
      />,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
}

function columns() {
  return container.querySelector<HTMLElement>('[data-conformance-id="connector-setup"]');
}
function statusCard() {
  return container.querySelector<HTMLElement>('[data-slot="connection-status-card"]');
}
function badge() {
  return container.querySelector<HTMLElement>('[data-slot="connection-status-badge"]');
}
function checkButton() {
  return Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === "Check",
  );
}

describe("SchemaConfigConnectorSetup — the drawn shape for EVERY connector (#3214)", () => {
  it("draws the two columns for a connector that declares NO status-probe (item 2)", async () => {
    await renderSetup({ surface: surfaceOf(PROBE_LESS_SURFACE) });
    const grid = columns();
    expect(grid).toBeTruthy();
    // The drawn grid: a wider fields column and the narrower 236px status column.
    expect(grid!.className).toContain("sm:grid-cols-[minmax(0,1fr)_236px]");
    expect(grid!.getAttribute("data-state")).toBe("ready");
    // The fields live in the left column, the status card in the right one.
    const [left, right] = Array.from(grid!.children) as HTMLElement[];
    expect(left.querySelector('input[name="bookingPageUrl"]')).toBeTruthy();
    expect(right.querySelector('[data-slot="connection-status-card"]')).toBeTruthy();
  });

  it("holds to the Wide column and never spans full width (item 2)", async () => {
    await renderSetup({ surface: surfaceOf(PROBE_LESS_SURFACE) });
    // ConnectorSetupPage pins BOTH the header and the content to max-w-3xl.
    expect(container.querySelectorAll(".max-w-3xl").length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector(".max-w-7xl")).toBeNull();
  });

  it("carries the Connection status card with its heading and info-card chrome (item 3)", async () => {
    await renderSetup({ surface: surfaceOf(PROBE_LESS_SURFACE) });
    const card = statusCard();
    expect(card).toBeTruthy();
    expect(card!.textContent).toContain("Connection status");
  });

  it("carries the status badge with BOTH icon and label, and Check beneath it (item 4)", async () => {
    await renderSetup({
      surface: surfaceOf(PROBE_LESS_SURFACE),
      connected: true,
      connectedLabel: "2",
      recheck: async () => ({ connected: true, connectedLabel: "2" }),
    });
    const b = badge();
    expect(b).toBeTruthy();
    expect(b!.getAttribute("data-status")).toBe("connected");
    // Icon AND label — never a bare dot and never a bare word.
    expect(b!.querySelector("svg")).toBeTruthy();
    expect(b!.textContent?.trim()).toBe("2");
    // Check sits inside the same card, beneath the badge.
    const check = checkButton();
    expect(check).toBeTruthy();
    expect(statusCard()!.contains(check!)).toBe(true);
    expect(check!.disabled).toBe(false);
  });

  it("renders Connect and Disconnect side by side, never stacked (item 5)", async () => {
    await renderSetup({ surface: surfaceOf(PROBE_LESS_SURFACE) });
    const row = container.querySelector<HTMLElement>('[data-testid="connection-actions"]');
    expect(row).toBeTruthy();
    const connect = row!.querySelector<HTMLButtonElement>('[data-testid="connector-connect"]');
    const disconnect = row!.querySelector<HTMLButtonElement>('[data-testid="connector-disconnect"]');
    expect(connect).toBeTruthy();
    expect(disconnect).toBeTruthy();
    // One row, both buttons in it, Connect first — a flex row, not a stack.
    expect(row!.className).toContain("flex");
    expect(connect!.compareDocumentPosition(disconnect!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Each carries its own glyph (the joined plug / the unplug).
    expect(connect!.querySelector("svg")).toBeTruthy();
    expect(disconnect!.querySelector("svg")).toBeTruthy();
  });

  it("disables Disconnect while the connector is not connected (item 6)", async () => {
    await renderSetup({ surface: surfaceOf(PROBE_LESS_SURFACE), connected: false });
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="connector-disconnect"]')!.disabled,
    ).toBe(true);
    // Connect is always available (the drawing says so in as many words).
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="connector-connect"]')!.disabled,
    ).toBe(false);
  });

  it("enables Disconnect once the connector is connected (item 6)", async () => {
    await renderSetup({ surface: surfaceOf(PROBE_LESS_SURFACE), connected: true });
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="connector-disconnect"]')!.disabled,
    ).toBe(false);
  });

  it("opens the drawn confirmation dialog on Disconnect — never a bare prompt (item 7)", async () => {
    await renderSetup({ surface: surfaceOf(PROBE_LESS_SURFACE), connected: true });
    const disconnect = container.querySelector<HTMLButtonElement>(
      '[data-testid="connector-disconnect"]',
    );
    await act(async () => {
      disconnect!.click();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("Disconnect connector?");
    expect(
      document.body.querySelector('[data-testid="connector-disconnect-confirm"]'),
    ).toBeTruthy();
    expect(
      Array.from(document.body.querySelectorAll("button")).some(
        (b) => b.textContent?.trim() === "Cancel",
      ),
    ).toBe(true);
  });

  it("draws the same shape for a connector that declares NO role actions either", async () => {
    // The appointment-schedules shape: no status-probe, no connect/disconnect
    // road of its own. It still gets the two columns and the status card whose
    // reading is the host's own readiness signal; the host invents no connect
    // action it cannot run.
    await renderSetup({
      surface: surfaceOf(RECORD_LIST_SURFACE),
      connected: true,
      connectedLabel: "2",
      recheck: async () => ({ connected: true, connectedLabel: "2" }),
    });
    expect(columns()).toBeTruthy();
    expect(statusCard()).toBeTruthy();
    expect(badge()!.getAttribute("data-status")).toBe("connected");
    expect(checkButton()).toBeTruthy();
    expect(container.querySelector('[data-testid="connection-actions"]')).toBeNull();
    // Its own declared action still renders unchanged.
    expect(
      Array.from(container.querySelectorAll("button")).some(
        (b) => b.textContent?.trim() === "Add schedule",
      ),
    ).toBe(true);
  });

  it("keeps the probe-declaring shape: the probe is lifted, never rendered twice", async () => {
    await renderSetup({
      surface: surfaceOf(PROBE_SURFACE),
      statusProbeActionId: "connectionStatus",
    });
    expect(columns()).toBeTruthy();
    expect(statusCard()).toBeTruthy();
    // The inline status-probe row is suppressed in the fields column: exactly
    // one Check on the page, and it belongs to the card.
    const checks = Array.from(container.querySelectorAll("button")).filter(
      (b) => b.textContent?.trim() === "Check",
    );
    expect(checks).toHaveLength(1);
    expect(statusCard()!.contains(checks[0])).toBe(true);
  });

  it("shows the install CTA instead of the form when the connector is not installed", async () => {
    await renderSetup({ surface: surfaceOf(PROBE_LESS_SURFACE), installId: null });
    expect(columns()).toBeNull();
    expect(container.querySelector('[data-testid="connection-actions"]')).toBeNull();
  });

  it("gives the Install/Activate state the STANDALONE sharing node, never the tab's (#3374)", async () => {
    // That state draws no form and so no tab strip: mounting the tab-variant
    // node there would restyle a page this issue does not change.
    await renderSetup({
      surface: surfaceOf(PROBE_LESS_SURFACE),
      installId: null,
      sharing: <p data-testid="sharing-tab-node">tab</p>,
      sharingStandalone: <p data-testid="sharing-standalone-node">standalone</p>,
    });
    expect(container.querySelector('[data-testid="sharing-standalone-node"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="sharing-tab-node"]')).toBeNull();
  });

  it("gives the installed form the TAB sharing node, never the standalone one (#3374)", async () => {
    await renderSetup({
      surface: surfaceOf(PROBE_LESS_SURFACE),
      sharing: <p data-testid="sharing-tab-node">tab</p>,
      sharingStandalone: <p data-testid="sharing-standalone-node">standalone</p>,
    });
    expect(container.querySelector('[data-testid="sharing-tab-node"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="sharing-standalone-node"]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// cinatra#3297 — the disconnect confirmation as the ratified drawing draws it:
// design/specs/app-connectors.html §II, "Example — disconnect · confirmation"
// (design#201 at d479167a; byte-identical at design main 8a5d5013). Quoted
// from the drawing:
//
//   the box     background: var(--paper); border: 1px solid var(--line);
//               border-radius: 10px; box-shadow: 0 24px 60px
//               rgba(21,33,58,0.34); padding: 16px 18px 15px; max-width: 400px
//   the title   "Disconnect connector?" — font-family: var(--font-sans);
//               font-style: italic; font-weight: 800; color: var(--ink);
//               padding-bottom: 9px; border-bottom: 1px solid
//               var(--line-strong); margin-bottom: 10px
//   the text    color: var(--muted); line-height: 1.55
//   the row     display: flex; justify-content: flex-end; gap: 10px;
//               margin-top: 16px — `btn outline` Cancel, then `btn
//               destructive` Disconnect with its 14px unplug
//
// and the section's prose: "an AlertDialog on the --paper ground with a strong
// hairline header rule — a Cancel outline beside the red Disconnect confirm
// (same unplug icon)". The drawing's `.btn.outline` is "background:
// var(--surface); color: var(--ink); border-color: var(--line-strong)"; its
// `.btn.destructive` is "background: rgba(166,56,79,0.10); color: var(--red);
// border-color: rgba(166,56,79,0.24)".
//
// jsdom applies no stylesheet, so these cases grade the RECIPE the open dialog
// renders (its classes after the shared primitives' merge) and the ARITHMETIC
// of the tokens it names against the palette declarations of
// src/app/globals.css, where the drawing's --paper is the app's --background.
// ---------------------------------------------------------------------------

// Resolved from the vitest root (the repository root): the module URL of a
// transformed test file is not a file URL.
const GLOBALS = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

/** The last value a palette block of globals.css declares for a custom property. */
function tokenIn(selector: string, name: string): string {
  const lines = GLOBALS.split("\n");
  const start = lines.findIndex((line) => line.trim() === `${selector} {`);
  expect(start, `${selector} block not found in globals.css`).toBeGreaterThan(-1);
  const end = lines.findIndex((line, index) => index > start && line === "}");
  expect(end, `${selector} block never closes in globals.css`).toBeGreaterThan(start);
  const block = lines.slice(start, end).join("\n");
  const found = [...block.matchAll(new RegExp(`(?:^|\\s)${name}:\\s*([^;]+);`, "g"))];
  expect(found.length, `${selector} declares no ${name}`).toBeGreaterThan(0);
  return found[found.length - 1][1].trim();
}

function classesOf(element: Element): string[] {
  return (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

async function openDisconnectConfirm() {
  await renderSetup({ surface: surfaceOf(PROBE_LESS_SURFACE), connected: true });
  const disconnect = container.querySelector<HTMLButtonElement>('[data-testid="connector-disconnect"]');
  await act(async () => {
    disconnect!.click();
    await Promise.resolve();
  });
  const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]');
  expect(dialog, "the disconnect confirmation is open").not.toBeNull();
  const title = dialog!.querySelector<HTMLElement>('[data-slot="alert-dialog-title"]');
  const description = dialog!.querySelector<HTMLElement>('[data-slot="alert-dialog-description"]');
  const footer = dialog!.querySelector<HTMLElement>('[data-slot="alert-dialog-footer"]');
  expect(title && description && footer, "title, description and button row are drawn").toBeTruthy();
  const buttons = Array.from(footer!.querySelectorAll<HTMLButtonElement>("button"));
  const cancel = buttons.find((b) => b.textContent?.trim() === "Cancel");
  const confirm = dialog!.querySelector<HTMLButtonElement>('[data-testid="connector-disconnect-confirm"]');
  expect(cancel && confirm, "Cancel and the confirm are drawn").toBeTruthy();
  return { dialog: dialog!, title: title!, description: description!, footer: footer!, buttons, cancel: cancel!, confirm: confirm! };
}

describe("SchemaConfigConnectorSetup — the disconnect confirmation as §II draws it (cinatra#3297)", () => {
  it('"on the --paper ground": the dialog stands on the page ground in both palettes', async () => {
    const { dialog } = await openDisconnectConfirm();
    expect(classesOf(dialog)).toContain("bg-background");
    expect(classesOf(dialog)).not.toContain("bg-popover");
    // The drawing's --paper is #f1f1ed, the app's --background in the light
    // palette; the page itself is painted with --background in both palettes.
    expect(tokenIn(".cinatra", "--background")).toBe("#f1f1ed");
    expect(tokenIn(".dark", "--background")).not.toBe(tokenIn(".dark", "--surface"));
    expect(GLOBALS).toMatch(/\nbody \{[^}]*\n {2}background: var\(--background\);/);
  });

  it('"border-radius: 10px; padding: 16px 18px 15px; max-width: 400px; box-shadow: 0 24px 60px": the drawing\'s own box', async () => {
    const { dialog } = await openDisconnectConfirm();
    const tokens = classesOf(dialog);
    for (const token of [
      "border",
      "border-line",
      "rounded-[10px]",
      "p-[16px_18px_15px]",
      "max-w-[min(400px,calc(100%-2rem))]",
      "sm:max-w-[400px]",
      "shadow-[0_24px_60px_rgba(21,33,58,0.34)]",
    ]) {
      expect(tokens, `the box carries ${token}`).toContain(token);
    }
    for (const token of ["rounded-lg", "p-6", "max-w-[calc(100%-2rem)]", "sm:max-w-lg", "shadow-lg"]) {
      expect(tokens, `the shared box's ${token} gives way`).not.toContain(token);
    }
  });

  it('"padding-bottom: 9px; border-bottom: 1px solid var(--line-strong); margin-bottom: 10px": the strong hairline sits under the title, between the title and the description', async () => {
    const { dialog, title, description, footer } = await openDisconnectConfirm();
    const tokens = classesOf(title);
    for (const token of ["border-b", "border-line-strong", "pb-[9px]", "mb-[10px]"]) {
      expect(tokens, `the title carries ${token}`).toContain(token);
    }
    // cinatra#4123: the title and the text each stand in their own size
    // wrapper, the two wrappers side by side in the one plain block.
    const block = title.parentElement!.parentElement!;
    expect(description.parentElement!.parentElement).toBe(block);
    expect(title.parentElement!.nextElementSibling).toBe(description.parentElement);
    // No other line: no etched rule after the text (above the buttons), none
    // on the text block, the description or the button row.
    expect(dialog.querySelectorAll('.divider-etched-after, .divider-etched, [data-slot="alert-dialog-header"]')).toHaveLength(0);
    for (const element of [block, title.parentElement!, description.parentElement!, description, footer]) {
      expect(classesOf(element).filter((token) => /^border(-[trblxy])?$/.test(token))).toEqual([]);
    }
    expect(tokenIn(".cinatra", "--line-strong")).toBe("#15213a");
  });

  it('"display: flex; justify-content: flex-end; gap: 10px; margin-top: 16px": Cancel, then Disconnect, in one right-aligned row', async () => {
    const { dialog, footer, buttons } = await openDisconnectConfirm();
    const tokens = classesOf(footer);
    for (const token of ["flex", "flex-row", "justify-end", "gap-2.5"]) {
      expect(tokens, `the row carries ${token}`).toContain(token);
    }
    for (const token of ["flex-col-reverse", "gap-2"]) {
      expect(tokens, `the shared row's ${token} gives way`).not.toContain(token);
    }
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(["Cancel", "Disconnect"]);
    // The row's 16px above the text is the box's own 16px grid gap.
    expect(classesOf(dialog)).toEqual(expect.arrayContaining(["grid", "gap-4"]));
  });

  it('"a Cancel outline": the surface ground under the strong hairline border, ink text, in both palettes', async () => {
    const { cancel } = await openDisconnectConfirm();
    const tokens = classesOf(cancel);
    for (const token of ["bg-surface", "border-line-strong", "text-foreground", "dark:bg-surface", "dark:border-line-strong"]) {
      expect(tokens, `Cancel carries ${token}`).toContain(token);
    }
    for (const token of ["bg-background", "border-border", "dark:bg-input-fill/30", "dark:border-input"]) {
      expect(tokens, `the shared outline's ${token} gives way`).not.toContain(token);
    }
    expect(tokenIn(".cinatra", "--surface")).toBe("#f7f7f3");
  });

  it('"beside the red Disconnect confirm (same unplug icon)": the red on its tint, a border of the red at 24%, a 14px unplug', async () => {
    const { confirm } = await openDisconnectConfirm();
    const tokens = classesOf(confirm);
    for (const token of ["bg-destructive/10", "text-destructive", "border-destructive/24", "[&_svg:not([class*='size-'])]:size-3.5"]) {
      expect(tokens, `the confirm carries ${token}`).toContain(token);
    }
    for (const token of ["border-transparent", "[&_svg:not([class*='size-'])]:size-4"]) {
      expect(tokens, `the shared button's ${token} gives way`).not.toContain(token);
    }
    // The unplug is the trigger's own bare glyph: it carries no size of its
    // own, so the confirm's unsized-icon rule (14px) sets it.
    const icon = confirm.querySelector("svg");
    expect(icon, "the confirm carries its unplug").not.toBeNull();
    expect(classesOf(icon!).filter((token) => token.startsWith("size-"))).toEqual([]);
    // The drawing's red is rgba(166,56,79): the app's --cinatra-red, which is --destructive.
    expect(tokenIn(".cinatra", "--cinatra-red")).toBe("#a6384f");
    expect(tokenIn(".cinatra", "--destructive")).toBe("var(--cinatra-red)");
  });

  it('"font-style: italic; font-weight: 800; color: var(--ink)" over "color: var(--muted); line-height: 1.55": the title in the display face, the text muted', async () => {
    const { title, description } = await openDisconnectConfirm();
    const titleTokens = classesOf(title);
    for (const token of ["font-display", "italic", "font-extrabold", "text-foreground", "leading-normal"]) {
      expect(titleTokens, `the title carries ${token}`).toContain(token);
    }
    expect(titleTokens).not.toContain("font-semibold");
    expect(classesOf(description)).toEqual(expect.arrayContaining(["text-muted-foreground", "leading-[1.55]"]));
    expect(tokenIn(".cinatra", "--foreground")).toBe("#15213a");
    expect(tokenIn(".cinatra", "--muted")).toBe("#5a6477");
  });

  it("keeps the drawing's copy word for word", async () => {
    const { title, description, cancel, confirm } = await openDisconnectConfirm();
    expect(title.textContent).toBe("Disconnect connector?");
    expect(description.textContent?.replace(/\s+/g, " ").trim()).toBe(
      "Disconnect this connector and remove its saved configuration? It will stop working until you connect it again.",
    );
    expect(cancel.textContent?.trim()).toBe("Cancel");
    expect(confirm.textContent?.trim()).toBe("Disconnect");
  });
});

// ---------------------------------------------------------------------------
// cinatra#4123 — the confirmation's two type sizes, quoted from the same
// drawing (specs/app-connectors.html §II, "Example — disconnect ·
// confirmation", design main 8a5d5013):
//
//   the title   "font-size: 15px"
//   the text    "font-size: 13px; color: var(--muted); line-height: 1.55"
//
// The sizes are the named roles --text-confirm-title and --text-confirm-body,
// in BOTH token tables. The app lint bans a bracket size (text-[15px]) and the
// app's plain tailwind-merge reads an unknown text-* token as a colour, so a
// role token handed to the shared title's cn() would drop the title's colour
// or lose to the primitive's text-lg. The role therefore stands on a plain
// wrapper, and the title and the text take it through text-[length:inherit],
// which tailwind-merge reads as a size: the primitive's text-lg and text-sm
// are gone from the rendered class list.
// ---------------------------------------------------------------------------

const THEME = readFileSync(join(process.cwd(), "packages/design/src/theme.css"), "utf8");

describe("SchemaConfigConnectorSetup — the confirmation's 15px title and 13px text (cinatra#4123)", () => {
  for (const [table, text] of [
    ["src/app/globals.css", GLOBALS],
    ["packages/design/src/theme.css", THEME],
  ] as const) {
    it(`${table} names the drawing's sizes as roles: --text-confirm-title 15px, --text-confirm-body 13px`, () => {
      expect(text).toContain("--text-confirm-title: 15px;");
      expect(text).toContain("--text-confirm-body: 13px;");
    });
  }

  it('"font-size: 15px": the title takes the --text-confirm-title role and the shared text-lg gives way', async () => {
    const { title } = await openDisconnectConfirm();
    expect(classesOf(title.parentElement!)).toEqual(["text-confirm-title"]);
    const tokens = classesOf(title);
    expect(tokens).toContain("text-[length:inherit]");
    expect(tokens.filter((token) => /^text-(xs|sm|base|lg|xl|\d?xl|\[)/.test(token))).toEqual(["text-[length:inherit]"]);
    // The colour and the title's own line height survive the merge.
    for (const token of ["text-foreground", "leading-normal", "italic", "font-extrabold"]) {
      expect(tokens, `the title keeps ${token}`).toContain(token);
    }
  });

  it('"font-size: 13px; color: var(--muted); line-height: 1.55": the text takes the --text-confirm-body role and the shared text-sm gives way', async () => {
    const { description } = await openDisconnectConfirm();
    expect(classesOf(description.parentElement!)).toEqual(["text-confirm-body"]);
    const tokens = classesOf(description);
    expect(tokens).toContain("text-[length:inherit]");
    expect(tokens).not.toContain("text-sm");
    for (const token of ["text-muted-foreground", "leading-[1.55]"]) {
      expect(tokens, `the text keeps ${token}`).toContain(token);
    }
  });
});
