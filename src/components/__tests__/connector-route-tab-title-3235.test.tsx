// @vitest-environment jsdom
/**
 * THE CONNECTOR ROUTE'S TAB TITLE, IN THE SHELL (cinatra#3235, acceptance 8).
 *
 * A connector setup page mounted inside the shell used to put the humanized
 * LAST path segment in the browser tab — "Setup | Cinatra" on every connector
 * at once, the name of a tab strip drawn inside the page rather than the
 * connector the reader opened. This renders the real shell around a connector
 * route whose crumb contributions are published by the REAL publisher island
 * the route renders (`<CrumbContributions/>`, a child of the shell, exactly as
 * in the route tree), and reads the live `document.title` beside the trail's
 * own leaf crumb.
 *
 * The island publishing from a CHILD effect is the point: on the mount commit
 * the shell's title effect runs against a bus that has not been written yet,
 * so the shell must NOT fall through to the humanized segment in that window —
 * the last test here holds that line.
 */
import React, { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, act } from "@testing-library/react";

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

/** The route's own publication: the vendor, the connector, and its own path. */
const connectorEntries = (
  vendor: string,
  slug: string,
  subroute: string,
  displayName: string,
  vendorName: string,
) => [
  { prefix: `/connectors/${vendor}`, label: vendorName },
  { prefix: `/connectors/${vendor}/${slug}`, label: displayName },
  { prefix: `/connectors/${vendor}/${slug}/${subroute}`, label: displayName },
];

/**
 * The connector setup page as the route renders it: the publisher island with
 * the route's server-authorized entries, and the page's own tab strip drawn
 * INSIDE the page — switching it is client state at the very same address.
 */
function ConnectorSetupPage({
  entries,
  onTabs,
}: {
  readonly entries: readonly { prefix: string; label: string }[];
  readonly onTabs?: (select: (tab: string) => void) => void;
}) {
  const [tab, setTab] = useState("setup");
  onTabs?.(setTab);
  return (
    <>
      <CrumbContributions entries={entries} />
      <div>{`the connector ${tab} tab`}</div>
    </>
  );
}

const mountConnectorRoute = (
  vendor: string,
  slug: string,
  displayName: string,
  vendorName = "Cinatra",
  subroute = "setup",
  options: { readonly publish?: boolean } = {},
) => {
  const publish = options.publish ?? true;
  const pathname = `/connectors/${vendor}/${slug}/${subroute}`;
  pathnameRef.current = pathname;
  const entries = connectorEntries(vendor, slug, subroute, displayName, vendorName);
  let selectTab: ((tab: string) => void) | null = null;
  const view = render(
    <CrumbEpochProvider value={EPOCH}>
      <AppShell connectionReady crumbEpoch={EPOCH}>
        {publish ? (
          <ConnectorSetupPage
            entries={entries}
            onTabs={(select) => {
              selectTab = select;
            }}
          />
        ) : (
          <div>the connector setup page, its crumbs not published yet</div>
        )}
      </AppShell>
    </CrumbEpochProvider>,
  );
  return { ...view, switchTab: (tab: string) => act(() => selectTab?.(tab)) };
};

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
  document.title = "Cinatra";
  clearCrumbContributions();
});

afterEach(() => {
  cleanup();
  clearCrumbContributions();
  pathnameRef.current = "/";
  document.title = "";
  // Restore what this file replaced, so the package's full run is unaffected.
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

describe("cinatra#3235 — the tab title on a connector route in the shell", () => {
  it("writes the trail's leaf crumb, never the page's own tab strip", () => {
    const { container } = mountConnectorRoute(
      "cinatra-ai",
      "openai-connector",
      "OpenAI",
    );
    expect(leafCrumbText(container)).toBe("OpenAI");
    expect(document.title).toBe(`${leafCrumbText(container)} | Cinatra`);
    expect(document.title).toBe("OpenAI | Cinatra");
    expect(document.title).not.toBe("Setup | Cinatra");
  });

  it("names the second connector by its own name, not the shared word", () => {
    const { container } = mountConnectorRoute(
      "cinatra-ai",
      "google-appointment-schedules-connector",
      "Google Appointment Schedules",
    );
    expect(document.title).toBe("Google Appointment Schedules | Cinatra");
    expect(document.title).toBe(`${leafCrumbText(container)} | Cinatra`);
    expect(document.title).not.toBe("Setup | Cinatra");
  });

  it("keeps the title while the page's own tab strip is switched", () => {
    const { container, switchTab } = mountConnectorRoute(
      "cinatra-ai",
      "openai-connector",
      "OpenAI",
    );
    expect(document.title).toBe("OpenAI | Cinatra");
    // The tab strip is drawn INSIDE the page: selecting another tab is client
    // state at the very same address, and the page re-renders around it.
    switchTab("help");
    expect(container.textContent).toContain("the connector help tab");
    expect(document.title).toBe("OpenAI | Cinatra");
    expect(document.title).not.toBe("Setup | Cinatra");
  });

  it("re-asserts the title when the route's own metadata lands after the effect", async () => {
    mountConnectorRoute("cinatra-ai", "openai-connector", "OpenAI");
    // The route's <title> commits after the shell's effect on a client
    // transition; the tab has to keep mirroring the trail.
    const titleEl = document.createElement("title");
    titleEl.textContent = "Setup | Cinatra";
    document.head.appendChild(titleEl);
    document.title = "Setup | Cinatra";
    try {
      // The shell's re-assert rides a head MutationObserver — one task.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(document.title).toBe("OpenAI | Cinatra");
    } finally {
      titleEl.remove();
    }
  });

  it("leaves the server's title alone while the contribution has not landed", () => {
    // THE MOUNT WINDOW (cinatra#3235). The publisher island is a
    // CHILD of the shell, so there is always a commit in which the bus is still
    // empty on this route — and on a streamed or interrupted render it can last.
    // The shell must not fill that window with the humanized last segment: the
    // route's own generateMetadata has already titled the tab correctly.
    document.title = "OpenAI | Cinatra";
    mountConnectorRoute("cinatra-ai", "openai-connector", "OpenAI", "Cinatra", "setup", {
      publish: false,
    });
    expect(document.title).toBe("OpenAI | Cinatra");
    expect(document.title).not.toBe("Setup | Cinatra");
  });
});
