// @vitest-environment jsdom
//
// MORE DETAILS, FOR A MEMBER (cinatra#2808, per-scope surfaces S2).
//
// The acceptance: "A non-admin member fixture opens More details and asserts
// that the bound `design/specs/app-extensions.html` §II package content — name,
// vendor, and detail body — renders in `MarketplaceDetailModal`."
//
// The §II drawing rules the modal is reached FROM THE CARD — "Clicking More
// details on a ListingCard opens this modal" — and that it is details-only:
// "it carries no footer and no install/update/restore action of its own". Both
// are asserted below, on a row built exactly as a member-facing scope tab builds
// it: NO admin-only detail href at all, so the affordance is the modal itself
// and never a link into `/configuration`.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// The modal's DEFAULT loader is the member-gated server action, whose module
// reaches the host's generated extension registry. Every case here injects its
// own loader, so the default is stubbed rather than pulled into the render.
vi.mock("@/lib/marketplace-detail-actions", () => ({
  getAgentMarketplaceDetailAction: async () => ({ ok: false, reason: "error" }),
}));

import { AgentAllCard } from "@/components/extensions/agent-all-card";
import { buildScopeSurfaceAgentRows } from "@/lib/scope-surface-rows";
import type { MarketplaceDetailLoadResult } from "@/lib/marketplace-detail-view";

afterEach(() => {
  cleanup();
  vi.resetModules();
  vi.restoreAllMocks();
});

const PACKAGE = "@acme/research-assistant";

/** The §II body the storefront serves for this package. */
const DETAIL: MarketplaceDetailLoadResult = {
  ok: true,
  detail: {
    packageName: PACKAGE,
    displayName: "Research Assistant",
    kindLabel: "Agent",
    cost: "Free, Open Source",
    license: "Apache-2.0",
    latestVersion: "0.4.2",
    freshnessAt: null,
    installCount: 8000,
    permalink: null,
    sdkAbiRange: null,
    readmeMarkdown: null,
    longDescription:
      "Research Assistant gathers sources, summarises long documents and returns cited answers.",
    description: "Gathers sources, summarises, and cites answers.",
    iconUrl: null,
    compatibleUpTo: "0.2.0",
    changelog: [],
    dependencies: [],
    ratingSummary: { average: 0, total: 0, counts: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 } },
    reviews: [],
    vendor: { name: "Cinatra", slug: "cinatra", storeUrl: null },
  },
};

/** A member's row: the scope tab mints NO admin-only detail href. */
function memberRow() {
  const [row] = buildScopeSurfaceAgentRows({ kind: "organization", id: "org-a" }, [
    {
      packageName: PACKAGE,
      displayName: "Research Assistant",
      description: "Gathers sources, summarises, and cites answers.",
      version: "0.4.2",
      status: "active",
      installId: "install-research",
      executionOrgIds: ["org-a"],
    },
  ]);
  return row!;
}

describe("a member's More details on a scope card", () => {
  it("offers the control with NO link into the admin-only marketplace route", () => {
    const row = memberRow();
    expect(row.detailHref).toBeNull();
    const { container } = render(<AgentAllCard row={row} loadDetail={async () => DETAIL} />);
    expect(screen.getByText("More details")).toBeTruthy();
    for (const anchor of Array.from(container.querySelectorAll("a"))) {
      expect(anchor.getAttribute("href") ?? "").not.toContain("/configuration");
    }
  });

  it("opens the ratified detail modal with the package's OWN §II content", async () => {
    render(<AgentAllCard row={memberRow()} loadDetail={async () => DETAIL} />);

    fireEvent.click(screen.getByText("More details"));

    const dialog = await screen.findByRole("dialog");
    // NAME …
    await waitFor(() => {
      expect(dialog.textContent).toContain("Research Assistant");
    });
    // … VENDOR …
    await waitFor(() => {
      expect(dialog.textContent).toContain("Cinatra");
    });
    // … and the DETAIL BODY.
    await waitFor(() => {
      expect(dialog.textContent).toContain(
        "Research Assistant gathers sources, summarises long documents and returns cited answers.",
      );
    });
  });

  // The loader is keyed by the package — a modal that asked for some OTHER
  // package's detail would still have rendered the fixture above, so the key
  // itself is asserted (convergence round, cinatra#2808).
  it("asks the loader for THIS card's own package", async () => {
    const loadDetail = vi.fn(async () => DETAIL);
    const row = memberRow();
    render(<AgentAllCard row={row} loadDetail={loadDetail} />);
    fireEvent.click(screen.getByText("More details"));
    await screen.findByRole("dialog");
    await waitFor(() => {
      expect(loadDetail).toHaveBeenCalledWith(row.packageName);
    });
  });

  it("is DETAILS-ONLY: the dialog carries no install / update / restore action", async () => {
    render(<AgentAllCard row={memberRow()} loadDetail={async () => DETAIL} />);
    fireEvent.click(screen.getByText("More details"));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => {
      expect(dialog.textContent).toContain("Research Assistant");
    });
    for (const word of ["Install now", "Install", "Update", "Restore", "Uninstall"]) {
      const hit = Array.from(dialog.querySelectorAll("button, a")).some(
        (el) => (el.textContent ?? "").trim() === word,
      );
      expect(hit).toBe(false);
    }
  });

  it("creates NO second modal and NO new detail page — one dialog, the ratified one", async () => {
    render(<AgentAllCard row={memberRow()} loadDetail={async () => DETAIL} />);
    fireEvent.click(screen.getByText("More details"));
    await screen.findByRole("dialog");
    await waitFor(() => {
      expect(screen.getByRole("dialog").textContent).toContain("Research Assistant");
    });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });
});
