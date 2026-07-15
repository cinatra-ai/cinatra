// @vitest-environment jsdom
//
// AppSidebar gating for the org-switcher block (cinatra#1502): the entire
// block renders at the top of the rail in multi-org mode and is hidden
// COMPLETELY in single-org mode — the same server-resolved `singleOrg` flag
// that hides the "Organizations" nav item. Renders the REAL AppSidebar under
// jsdom so the gating is proved at the composition site, not in isolation.
//
//   pnpm exec vitest run src/components/__tests__/app-sidebar-org-switcher.test.tsx

import "./access-picker-jsdom-shims";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@/components/org-switcher-actions", () => ({
  listMemberOrganizations: vi.fn().mockResolvedValue({
    organizations: [],
    activeOrganizationId: null,
  }),
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => ({ data: null, isPending: false }),
    organization: { setActive: vi.fn() },
    signOut: vi.fn(),
  },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/personal",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

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

import { AppSidebar } from "@/components/app-sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";

function renderSidebar(props: Partial<React.ComponentProps<typeof AppSidebar>> = {}) {
  return render(
    <TooltipProvider>
      <SidebarProvider>
        <AppSidebar connectionReady singleOrg={false} {...props} />
      </SidebarProvider>
    </TooltipProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe("AppSidebar — org-switcher block gating", () => {
  it("renders the switcher block (with the active-org name) in multi-org mode", () => {
    renderSidebar({ activeOrgName: "Alpha Works", canCreateOrganizations: true });
    expect(screen.getByTestId("org-switcher-trigger")).toBeTruthy();
    expect(screen.getByTestId("org-switcher-label").textContent).toBe("Alpha Works");
  });

  it("hides the entire block in single-org mode", () => {
    renderSidebar({ singleOrg: true, activeOrgName: "Alpha Works" });
    expect(screen.queryByTestId("org-switcher-trigger")).toBeNull();
  });
});
