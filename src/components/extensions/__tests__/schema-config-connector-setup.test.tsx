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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSchemaConfig } from "@/lib/extension-schema-config";
import { SchemaConfigConnectorSetup } from "@/components/extensions/schema-config-connector-setup";

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
});
