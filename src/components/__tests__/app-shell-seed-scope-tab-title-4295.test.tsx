// @vitest-environment jsdom
/**
 * The tab title on a seed-id scope route, in the real shell (cinatra#4295).
 *
 * The shell's title effect reads the path by position: a seed scope id
 * (`/teams/team-rob-hardware`) makes the route id-bearing, so the shell writes
 * no title and the route's own server title stands; a seed-shaped slug at any
 * other position (`team-connector`) is a name and never suppresses the title.
 * On a percent-encoded address the names the route publishes for the canonical
 * path still reach the trail and the tab.
 *
 * Same harness as connector-route-tab-title.test.tsx: the real shell around
 * the real publisher island (`<CrumbContributions/>`, a child of the shell),
 * reading the live `document.title` and the trail's own leaf crumb.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { clearCrumbContributions } from "@/lib/breadcrumb-contributions";

const pathnameRef = { current: "/" };

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameRef.current,
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => ({ data: null, isPending: false }),
    useListOrganizations: () => ({ data: [], isPending: false }),
    useActiveOrganization: () => ({ data: null, isPending: false }),
  },
}));
vi.mock("@daveyplate/better-auth-ui", () => ({
  CreateOrganizationDialog: () => null,
}));
vi.mock("@cinatra-ai/notifications/client", () => ({
  NotificationsProvider: ({ children }: { children?: React.ReactNode }) => (
    <>{children}</>
  ),
  NotificationsBellTrigger: () => null,
}));
vi.mock("@/components/app-sidebar", () => ({ AppSidebar: () => null }));
vi.mock("@/components/theme-switch", () => ({ ThemeSwitch: () => null }));
vi.mock("@/components/configuration-topbar-cog", () => ({
  ConfigurationTopbarCog: () => null,
}));

import { AppShell } from "@/components/app-shell";
import { CrumbContributions } from "@/components/crumb-contributions";
import { CrumbEpochProvider } from "@/components/crumb-epoch-context";

const EPOCH = "u1:o1";
const SERVER_TITLE = "Route title | Cinatra";
const RUN_ID = "9c0dfce6-b2cb-4dab-8a01-661ca3288b9a";
const TEAM = "/teams/team-rob-hardware";

const mountRoute = (
  pathname: string,
  entries: readonly { prefix: string; label: string }[] = [],
) => {
  pathnameRef.current = pathname;
  return render(
    <CrumbEpochProvider value={EPOCH}>
      <AppShell connectionReady crumbEpoch={EPOCH}>
        {entries.length > 0 ? <CrumbContributions entries={entries} /> : null}
        <div>the page</div>
      </AppShell>
    </CrumbEpochProvider>,
  );
};

const crumbTexts = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-slot="breadcrumb-item"]')].map((el) => el.textContent);

const leafCrumbText = (container: HTMLElement) => {
  const pages = container.querySelectorAll('[data-slot="breadcrumb-page"]');
  return pages[pages.length - 1]?.textContent ?? null;
};

/** jsdom ships no matchMedia; the sidebar's mobile hook reads it on mount. */
const NO_MATCH_MEDIA = Symbol("absent");
let priorMatchMedia: unknown = NO_MATCH_MEDIA;

beforeEach(() => {
  priorMatchMedia = "matchMedia" in window ? window.matchMedia : NO_MATCH_MEDIA;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
  // The route's own server-rendered title, already in the tab.
  document.title = SERVER_TITLE;
  clearCrumbContributions();
});

afterEach(() => {
  cleanup();
  clearCrumbContributions();
  pathnameRef.current = "/";
  document.title = "";
  if (priorMatchMedia === NO_MATCH_MEDIA) {
    delete (window as unknown as Record<string, unknown>).matchMedia;
  } else {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: priorMatchMedia,
    });
  }
  vi.clearAllMocks();
});

describe("cinatra#4295 — the tab title on a seed-id scope route in the shell", () => {
  it("a seed scope id is id-bearing: the shell leaves the route's title", () => {
    const { container } = mountRoute(TEAM);
    expect(leafCrumbText(container)).toBe("team-rob…");
    expect(document.title).toBe(SERVER_TITLE);
    expect(document.title).not.toMatch(/Team Rob Hardware|team-rob/);
  });

  it("the same holds on the percent-encoded address, and the published name is drawn", () => {
    const { container } = mountRoute("/%74eams/team-rob-hardware", [
      { prefix: TEAM, label: "Hardware Engineering" },
    ]);
    expect(leafCrumbText(container)).toBe("Hardware Engineering");
    expect(document.title).toBe(SERVER_TITLE);
  });

  it("an encoded scoped run takes the run name published for the canonical path", () => {
    const run = `${TEAM}/agents/acme/planner/${RUN_ID}`;
    const { container } = mountRoute(`/%74eams/team-rob-hardware/agents/acme/planner/${RUN_ID}`, [
      { prefix: TEAM, label: "Hardware Engineering" },
      { prefix: run, label: "Weekly plan" },
    ]);
    expect(crumbTexts(container)).toEqual(["Hardware Engineering", "Agents", "Weekly plan"]);
    expect(document.title).toBe("Weekly plan | Cinatra");
  });

  it("a seed-shaped connector slug is a name: the published connector name is the title", () => {
    const { container } = mountRoute("/connectors/acme/team-connector/setup", [
      { prefix: "/connectors/acme", label: "Acme" },
      { prefix: "/connectors/acme/team-connector", label: "Team Connector Pro" },
      { prefix: "/connectors/acme/team-connector/setup", label: "Team Connector Pro" },
    ]);
    expect(leafCrumbText(container)).toBe("Team Connector Pro");
    expect(document.title).toBe("Team Connector Pro | Cinatra");
  });

  it("a seed-shaped name outside the scope id position does not suppress the title", () => {
    const { container } = mountRoute("/configuration/marketplace/acme/team-connector");
    expect(leafCrumbText(container)).toBe("Team Connector");
    expect(document.title).toBe("Team Connector | Cinatra");
  });
});
