// @vitest-environment jsdom
//
// The instance's own open vendor application waits on a marketplace moderator.
// The application drawing's "Marketplace approval states" block (specs/app.html
// V.1) draws that as the approval's pending pill "Awaiting others" (`pill idle`
// with a dot): "the viewer's own application or submission". It is not the
// Running pill, and the pill shows its own label, never the raw state word
// (cinatra#4296).
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("../vendor-application-actions", () => ({
  cancelVendorApplicationAction: vi.fn(),
  refreshVendorApplicationStatusAction: vi.fn(),
}));

import type { InstanceIdentity } from "@/lib/instance-identity-store";

import { VendorApplicationStatusCard } from "../vendor-application-status-card";

afterEach(cleanup);

describe("VendorApplicationStatusCard: the pending pill", () => {
  it("draws Awaiting others as the idle status pill with a dot, not the Running pill", () => {
    const identity = {
      vendorState: "applied",
      vendorApplicationId: "app-1",
      vendorScope: "acme",
    } as unknown as InstanceIdentity;
    const { container } = render(<VendorApplicationStatusCard identity={identity} />);
    const pills = Array.from(container.querySelectorAll<HTMLElement>('[data-slot="status-pill"]'));
    expect(pills).toHaveLength(1);
    expect(pills[0].getAttribute("data-status")).toBe("idle");
    expect(pills[0].getAttribute("data-glyph")).toBe("dot");
    expect(pills[0].textContent).toBe("Awaiting others");
    expect(container.querySelector('[data-slot="status-pill"][data-status="running"]')).toBeNull();
  });
});
