// @vitest-environment jsdom
//
// OrgSwitcher — the compact active-organization context block at the top of
// the sidebar (cinatra#1502). Renders the REAL component under jsdom (Radix
// DropdownMenu + sidebar primitives) and drives it with real events,
// asserting the full state matrix:
//
//   - always-visible tier: active-org name in the trigger, fallback label;
//   - lazy tier: fetch on FIRST open only (cache survives open/close),
//     alphabetical rows, active-org check marker;
//   - switching: Better Auth setActive + router.refresh + cache invalidation,
//     no-op on the already-active row, error-result → toast (no refresh);
//   - create item gated by canCreateOrganizations;
//   - loading skeletons / "Couldn't load — Retry" (retry re-invokes and
//     recovers, never a stuck-loading state) / empty degenerate case.
//
//   pnpm exec vitest run src/components/__tests__/org-switcher.test.tsx

import "./access-picker-jsdom-shims";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { listMemberOrganizations, setActive, refresh, toastError } = vi.hoisted(() => ({
  listMemberOrganizations: vi.fn(),
  setActive: vi.fn(),
  refresh: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/components/org-switcher-actions", () => ({
  listMemberOrganizations,
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: { organization: { setActive } },
}));

vi.mock("@/lib/cinatra-toast", () => ({
  toast: { error: toastError, success: vi.fn() },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
}));

// next/link → a plain anchor so hrefs are assertable without a Next router.
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) =>
    React.createElement("a", { href, ...rest }, children),
}));

import { OrgSwitcher } from "@/components/org-switcher";
import { SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";

const TWO_ORGS = {
  organizations: [
    { id: "org-a", name: "Alpha Works" },
    { id: "org-b", name: "Beta Labs" },
  ],
  activeOrganizationId: "org-a",
};

function renderSwitcher(
  props: Partial<React.ComponentProps<typeof OrgSwitcher>> = {},
) {
  return render(
    <TooltipProvider>
      <SidebarProvider>
        <OrgSwitcher activeOrgName="Alpha Works" {...props} />
      </SidebarProvider>
    </TooltipProvider>,
  );
}

/** Radix DropdownMenuTrigger opens on pointerdown (mouse path). */
function openMenu() {
  const trigger = screen.getByTestId("org-switcher-trigger");
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(trigger);
}

function closeMenu() {
  fireEvent.keyDown(document.body, { key: "Escape" });
}

beforeEach(() => {
  vi.clearAllMocks();
  listMemberOrganizations.mockResolvedValue(TWO_ORGS);
  setActive.mockResolvedValue({ data: {}, error: null });
});

afterEach(() => {
  cleanup();
});

describe("OrgSwitcher — always-visible tier", () => {
  it("renders the server-resolved active-org name in the trigger", () => {
    renderSwitcher({ activeOrgName: "Alpha Works" });
    expect(screen.getByTestId("org-switcher-label").textContent).toBe("Alpha Works");
  });

  it("falls back to a neutral label when no active-org name resolved", () => {
    renderSwitcher({ activeOrgName: null });
    expect(screen.getByTestId("org-switcher-label").textContent).toBe(
      "Select organization",
    );
  });
});

describe("OrgSwitcher — lazy list tier", () => {
  it("fetches on first open, lists orgs in server order, and marks the active org", async () => {
    renderSwitcher();
    expect(listMemberOrganizations).not.toHaveBeenCalled();

    openMenu();
    expect(listMemberOrganizations).toHaveBeenCalledTimes(1);

    const rowA = await screen.findByTestId("org-switcher-org-org-a");
    const rowB = screen.getByTestId("org-switcher-org-org-b");
    expect(rowA.textContent).toContain("Alpha Works");
    expect(rowB.textContent).toContain("Beta Labs");
    // Server order preserved (alphabetical from the action).
    expect(
      rowA.compareDocumentPosition(rowB) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Active marker on the active row only.
    expect(rowA.querySelector('[data-testid="org-switcher-active-check"]')).toBeTruthy();
    expect(rowB.querySelector('[data-testid="org-switcher-active-check"]')).toBeNull();
  });

  it("caches the list across open/close (no refetch on re-open)", async () => {
    renderSwitcher();
    openMenu();
    await screen.findByTestId("org-switcher-org-org-a");
    closeMenu();
    await waitFor(() =>
      expect(screen.queryByTestId("org-switcher-org-org-a")).toBeNull(),
    );

    openMenu();
    await screen.findByTestId("org-switcher-org-org-a");
    expect(listMemberOrganizations).toHaveBeenCalledTimes(1);
  });

  it("shows skeleton rows while the fetch is pending", async () => {
    let resolveFetch: (value: typeof TWO_ORGS) => void = () => {};
    listMemberOrganizations.mockImplementationOnce(
      () => new Promise((resolve) => (resolveFetch = resolve)),
    );
    renderSwitcher();
    openMenu();
    expect(await screen.findByTestId("org-switcher-loading")).toBeTruthy();
    expect(screen.queryByTestId("org-switcher-org-org-a")).toBeNull();

    resolveFetch(TWO_ORGS);
    await screen.findByTestId("org-switcher-org-org-a");
    expect(screen.queryByTestId("org-switcher-loading")).toBeNull();
  });

  it("shows a Retry row on failure; Retry re-invokes the fetch and recovers", async () => {
    listMemberOrganizations.mockRejectedValueOnce(new Error("boom"));
    renderSwitcher();
    openMenu();

    const retry = await screen.findByTestId("org-switcher-retry");
    expect(retry.textContent).toContain("Couldn't load");
    expect(listMemberOrganizations).toHaveBeenCalledTimes(1);

    fireEvent.click(retry);
    expect(listMemberOrganizations).toHaveBeenCalledTimes(2);
    // The default mockResolvedValue takes over — the list recovers in place.
    await screen.findByTestId("org-switcher-org-org-a");
    expect(screen.queryByTestId("org-switcher-retry")).toBeNull();
  });

  it("empty degenerate case renders ONLY the All organizations leaf", async () => {
    listMemberOrganizations.mockResolvedValue({
      organizations: [],
      activeOrganizationId: null,
    });
    renderSwitcher({ activeOrgName: null, canCreateOrganizations: true });
    openMenu();

    const leaf = await screen.findByTestId("org-switcher-all");
    expect(leaf.getAttribute("href")).toBe("/organizations");
    // No org rows, no create item — even though the flag is true.
    expect(screen.queryByTestId("org-switcher-create")).toBeNull();
    expect(document.querySelector('[data-testid^="org-switcher-org-"]')).toBeNull();
  });
});

describe("OrgSwitcher — switching", () => {
  it("selecting a non-active org calls Better Auth setActive, refreshes, and clears the cache", async () => {
    renderSwitcher();
    openMenu();
    const rowB = await screen.findByTestId("org-switcher-org-org-b");

    fireEvent.click(rowB);
    await waitFor(() => expect(setActive).toHaveBeenCalledTimes(1));
    expect(setActive).toHaveBeenCalledWith({ organizationId: "org-b" });
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(toastError).not.toHaveBeenCalled();

    // Cache cleared: the next open refetches against the new session state.
    openMenu();
    await waitFor(() => expect(listMemberOrganizations).toHaveBeenCalledTimes(2));
  });

  it("selecting the already-active org is a no-op (no setActive, no refresh)", async () => {
    renderSwitcher();
    openMenu();
    const rowA = await screen.findByTestId("org-switcher-org-org-a");

    fireEvent.click(rowA);
    await waitFor(() =>
      expect(screen.queryByTestId("org-switcher-org-org-a")).toBeNull(),
    );
    expect(setActive).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("a setActive error result surfaces a toast and does NOT refresh or clear the cache", async () => {
    setActive.mockResolvedValue({ data: null, error: { status: 403 } });
    renderSwitcher();
    openMenu();
    const rowB = await screen.findByTestId("org-switcher-org-org-b");

    fireEvent.click(rowB);
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(refresh).not.toHaveBeenCalled();

    // Cache intact: re-open does not refetch.
    openMenu();
    await screen.findByTestId("org-switcher-org-org-b");
    expect(listMemberOrganizations).toHaveBeenCalledTimes(1);
  });
});

describe("OrgSwitcher — create affordance gating", () => {
  it("shows the create item (linking to /organizations/new) when permitted", async () => {
    renderSwitcher({ canCreateOrganizations: true });
    openMenu();
    await screen.findByTestId("org-switcher-org-org-a");
    const create = screen.getByTestId("org-switcher-create");
    expect(create.getAttribute("href")).toBe("/organizations/new");
    expect(screen.getByTestId("org-switcher-all").getAttribute("href")).toBe(
      "/organizations",
    );
  });

  it("omits the create item when the flag is false", async () => {
    renderSwitcher({ canCreateOrganizations: false });
    openMenu();
    await screen.findByTestId("org-switcher-org-org-a");
    expect(screen.queryByTestId("org-switcher-create")).toBeNull();
    // The All organizations leaf is still present.
    expect(screen.getByTestId("org-switcher-all")).toBeTruthy();
  });
});
