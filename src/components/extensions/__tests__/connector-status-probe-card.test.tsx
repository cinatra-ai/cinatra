// @vitest-environment jsdom
//
// Model-A connection-status card (design/specs/app-connectors.html §II, "One
// connection", right column · epic #1101). Proves the four card states:
//   - seeded Connected  (resolveConnectorBadgeState → connected:true)
//   - seeded Disconnected (connected:false)
//   - Checking… transient on Check (indigo spinner) while the probe runs
//   - resolves to Connected (probe ok) / Disconnected (probe !ok)
// and that Check POSTs the connector's OWN declared status-probe action id to the
// host action endpoint. No plug/unplug pair is rendered (ruling pending).

import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorStatusProbeCard } from "@/components/extensions/connector-status-probe-card";

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

function badge() {
  return container.querySelector<HTMLElement>('[data-slot="connection-status-badge"]');
}
function checkButton() {
  return Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent?.includes("Check"),
  );
}

async function render(props: React.ComponentProps<typeof ConnectorStatusProbeCard>) {
  await act(async () => {
    root.render(<ConnectorStatusProbeCard {...props} />);
  });
}

describe("ConnectorStatusProbeCard — Model-A status card (#1101)", () => {
  it("seeds Connected from the badge state, with the seeded label", async () => {
    await render({
      installId: "inst-1",
      actionId: "connectionStatus",
      initialConnected: true,
      connectedLabel: "Connected",
    });
    expect(badge()?.getAttribute("data-status")).toBe("connected");
    expect(container.textContent).toContain("Connected");
    // The heading is the extension-detail info-card heading.
    expect(container.textContent).toContain("Connection status");
    // Check is present (probe declared).
    expect(checkButton()).toBeTruthy();
  });

  it("seeds Disconnected when the badge state is not connected", async () => {
    await render({
      installId: "inst-1",
      actionId: "connectionStatus",
      initialConnected: false,
    });
    expect(badge()?.getAttribute("data-status")).toBe("disconnected");
  });

  it("Check shows the Checking… transient, POSTs the declared action id, then resolves Connected", async () => {
    let resolveFetch!: (v: Response) => void;
    const fetchMock = vi.fn().mockImplementation(
      () => new Promise<Response>((res) => (resolveFetch = res)),
    );
    vi.stubGlobal("fetch", fetchMock);

    await render({
      installId: "inst-42",
      actionId: "connectionStatus",
      initialConnected: false,
    });

    // Press Check — badge swaps to the transient "checking" state immediately.
    await act(async () => {
      checkButton()!.click();
    });
    expect(badge()?.getAttribute("data-status")).toBe("checking");
    expect(container.textContent).toContain("Checking…");

    // It POSTed the connector's OWN declared probe id to the host endpoint.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/extensions/inst-42/actions/connectionStatus");
    expect(init.method).toBe("POST");

    // Probe resolves ok → Connected.
    await act(async () => {
      resolveFetch(new Response("{}", { status: 200 }));
      await Promise.resolve();
    });
    expect(badge()?.getAttribute("data-status")).toBe("connected");
  });

  it("resolves Disconnected when the probe returns not-ok", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    await render({
      installId: "inst-9",
      actionId: "connectionStatus",
      initialConnected: true,
    });
    await act(async () => {
      checkButton()!.click();
      await Promise.resolve();
    });
    expect(badge()?.getAttribute("data-status")).toBe("disconnected");
  });

  // cinatra#3214 — the drawing carries "the Check action beneath it" on EVERY
  // connector's setup page, so a connector that declares no `status-probe` no
  // longer loses the control. Nothing is invented: with no declared probe the
  // card re-runs the HOST's own shipped readiness road (the same
  // `resolveConnectorBadgeState` signal that seeded it and paints the
  // connector's /connectors card), and with neither road it renders the
  // drawing's disabled treatment rather than a control that cannot answer.
  it("runs the host's shipped readiness road when the connector declares no status-probe", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const recheck = vi.fn().mockResolvedValue({ connected: true, connectedLabel: "2" });
    await render({
      installId: "inst-1",
      actionId: undefined,
      initialConnected: false,
      recheck,
    });
    const check = checkButton();
    expect(check).toBeTruthy();
    expect(check!.disabled).toBe(false);

    await act(async () => {
      check!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The host road ran, and no connector action id was invented for it.
    expect(recheck).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(badge()?.getAttribute("data-status")).toBe("connected");
    expect(badge()?.textContent?.trim()).toBe("2");
  });

  it("renders Check in the drawing's disabled treatment when there is no road at all", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await render({
      installId: "inst-1",
      actionId: undefined,
      initialConnected: false,
    });
    const check = checkButton();
    expect(check).toBeTruthy();
    expect(check!.disabled).toBe(true);
    expect(check!.getAttribute("aria-disabled")).toBe("true");

    await act(async () => {
      check!.click();
      await Promise.resolve();
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(badge()?.getAttribute("data-status")).toBe("disconnected");
  });

  it("degrades to Disconnected when the host readiness road throws", async () => {
    const recheck = vi.fn().mockRejectedValue(new Error("readiness read blew up"));
    await render({
      installId: "inst-1",
      actionId: undefined,
      initialConnected: true,
      connectedLabel: "2",
      recheck,
    });
    await act(async () => {
      checkButton()!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(badge()?.getAttribute("data-status")).toBe("disconnected");
  });
});
