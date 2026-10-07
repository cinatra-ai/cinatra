// @vitest-environment jsdom
//
// MORE DETAILS, OPENED BY A SIGNED-IN MEMBER WHO IS NOT AN ADMINISTRATOR
// (cinatra#3529, the S2 leftover of cinatra#2808).
//
// The acceptance: "A non-administrator member fixture opens More details on an
// agent card and the detail modal renders the package's name, vendor and detail
// body; a rendered test pins it."
//
// `scope-agent-member-details.test.tsx` pins the modal's content with a loader
// the test INJECTS, so it never runs the loader a scope tab actually uses. This
// file runs the production road instead, end to end below the card:
//
//   ScopeAgentsTab (the body every scope's Agents page renders)
//     -> AgentAllCard, with NO loader override
//     -> AgentDetailModal's DEFAULT loader, the member-gated server action
//        `getAgentMarketplaceDetailAction`
//     -> the REAL `requireAuthSession` in `@/lib/auth-session`
//     -> the storefront read, `loadPublicMarketplaceDetail`.
//
// The reader is a plain member: their session's role is `user`. The seams
// replaced here are the ones the gates stand ON, never the gates themselves:
// the Better Auth round-trip, `next/headers`, `next/navigation`'s `redirect`
// (a throw carrying Next's own `NEXT_REDIRECT` digest), and the storefront
// fetch. So if the card's modal were ever wired back to the ADMIN-gated action
// (`getPublicMarketplaceDetailAction`, the shared modal's own default), the real
// `requireAdminSession` would refuse this member and the modal would never draw
// the package; the first case below proves this very session IS refused there,
// so the fixture cannot pass by being an administrator in disguise.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => {
  /** Next's redirect control-flow signal: thrown, with the digest the modal's
   *  redirect check reads. */
  class RedirectSignal extends Error {
    readonly target: string;
    readonly digest: string;
    constructor(target: string) {
      super(`NEXT_REDIRECT:${target}`);
      this.name = "RedirectSignal";
      this.target = target;
      this.digest = `NEXT_REDIRECT;replace;${target};307;`;
    }
  }
  return {
    RedirectSignal,
    getSession: vi.fn(),
    loadPublicMarketplaceDetail: vi.fn(),
  };
});

vi.mock("next/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/navigation")>();
  return {
    ...actual,
    redirect: (target: string) => {
      throw new h.RedirectSignal(target);
    },
  };
});
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ cookie: "cinatra.session_token=member-token" }),
}));
vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: h.getSession } },
  ensureGoogleAvatarSync: async () => false,
  ensureInitialAdminBootstrap: async () => false,
  ensureDefaultOrganizationMembership: async () => false,
  ensureAssistantBootstrap: async () => undefined,
}));
vi.mock("@/lib/better-auth-db", () => ({
  betterAuthDb: {},
  betterAuthMembers: {},
  betterAuthUsers: {},
  betterAuthSessions: {},
  readTeamsForUser: async () => [],
  readProjectGrantsForUser: async () => [],
}));
vi.mock("@/lib/authz/enforce", () => ({
  buildActorContext: () => undefined,
}));
vi.mock("@cinatra-ai/notifications/perf-log", () => ({
  notifPerf: () => undefined,
  notifPerfNote: () => undefined,
  notifPerfNow: () => 0,
}));
// The storefront fetch, and nothing else of the detail road.
vi.mock("@/lib/marketplace-browse", () => ({
  loadPublicMarketplaceDetail: h.loadPublicMarketplaceDetail,
}));

import { ScopeAgentsTab } from "@/components/scope-surfaces/scope-agents-tab";
import {
  getAgentMarketplaceDetailAction,
  getPublicMarketplaceDetailAction,
} from "@/lib/marketplace-detail-actions";
import type { MarketplaceDetailLoadResult } from "@/lib/marketplace-detail-view";
import { buildScopeSurfaceAgentRows } from "@/lib/scope-surface-rows";

const PACKAGE = "@northwind/field-notes-agent";
const NAME = "Field Notes Agent";
const VENDOR = "Northwind Research Labs";
const BODY =
  "Field Notes Agent turns a week of site visits into one dated report, with every claim traced to the note it came from.";

/** A plain member of organization A: Better Auth's role string is `user`. */
const MEMBER_SESSION = {
  user: { id: "user-member", role: "user", image: "https://avatars.example.test/member.png" },
  session: { activeOrganizationId: "org-a" },
};

const DETAIL: MarketplaceDetailLoadResult = {
  ok: true,
  detail: {
    packageName: PACKAGE,
    displayName: NAME,
    kindLabel: "Agent",
    cost: "Free, Open Source",
    license: "Apache-2.0",
    latestVersion: "1.2.0",
    freshnessAt: null,
    installCount: 120,
    permalink: null,
    sdkAbiRange: null,
    readmeMarkdown: null,
    longDescription: BODY,
    description: "Turns site visits into a dated report.",
    iconUrl: null,
    compatibleUpTo: "0.2.0",
    changelog: [],
    dependencies: [],
    ratingSummary: { average: 0, total: 0, counts: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 } },
    reviews: [],
    vendor: { name: VENDOR, slug: "northwind", storeUrl: null },
  },
};

/** The member's Agents tab rows for organization A, built exactly as the
 *  loader builds them from an eligible install. */
function memberTabRows() {
  return buildScopeSurfaceAgentRows({ kind: "organization", id: "org-a" }, [
    {
      packageName: PACKAGE,
      displayName: NAME,
      description: "Turns site visits into a dated report.",
      version: "1.2.0",
      status: "active",
      installId: "install-field-notes",
      executionOrgIds: ["org-a"],
    },
  ]);
}

beforeEach(() => {
  h.getSession.mockResolvedValue(MEMBER_SESSION);
  h.loadPublicMarketplaceDetail.mockResolvedValue(DETAIL);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the fixture reader is a real non-administrator", () => {
  it("is REFUSED by the admin-gated detail action, which never reads the storefront", async () => {
    await expect(getPublicMarketplaceDetailAction(PACKAGE)).rejects.toMatchObject({
      target: "/not-authorized",
    });
    expect(h.loadPublicMarketplaceDetail).not.toHaveBeenCalled();
  });

  it("is ADMITTED by the member-gated action the agent card uses", async () => {
    await expect(getAgentMarketplaceDetailAction(PACKAGE)).resolves.toEqual(DETAIL);
    expect(h.loadPublicMarketplaceDetail).toHaveBeenCalledWith(PACKAGE);
  });

  it("a reader with no session is sent to sign-in and the storefront is never read", async () => {
    h.getSession.mockResolvedValue(null);
    await expect(getAgentMarketplaceDetailAction(PACKAGE)).rejects.toMatchObject({
      target: expect.stringMatching(/^\/sign-in/),
    });
    expect(h.loadPublicMarketplaceDetail).not.toHaveBeenCalled();
  });
});

describe("a member opens More details on a scope's agent card", () => {
  it("draws the package's own name, vendor and detail body in the detail modal", async () => {
    const { container } = render(<ScopeAgentsTab rows={memberTabRows()} />);

    // The member's card carries no link into the admin-only /configuration tree.
    for (const anchor of Array.from(container.querySelectorAll("a"))) {
      expect(anchor.getAttribute("href") ?? "").not.toContain("/configuration");
    }

    fireEvent.click(screen.getByText("More details"));
    const dialog = await screen.findByRole("dialog");

    // THE DETAIL BODY, from the storefront read the member gate let through.
    await waitFor(() => {
      expect(dialog.textContent).toContain(BODY);
    });
    // THE NAME.
    expect(dialog.textContent).toContain(NAME);
    // THE VENDOR, in the modal's own byline and resolved as a known vendor.
    const byline = dialog.querySelector('[data-slot="marketplace-modal-byline"]');
    expect(byline?.getAttribute("data-vendor-state")).toBe("known");
    expect(byline?.textContent).toContain(VENDOR);

    // The road it took: this card's own package, read once, behind the member's
    // own session.
    expect(h.loadPublicMarketplaceDetail).toHaveBeenCalledTimes(1);
    expect(h.loadPublicMarketplaceDetail).toHaveBeenCalledWith(PACKAGE);
    expect(h.getSession).toHaveBeenCalled();
  });

  it("stays details-only for the member: no install, update or restore action", async () => {
    render(<ScopeAgentsTab rows={memberTabRows()} />);
    fireEvent.click(screen.getByText("More details"));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => {
      expect(dialog.textContent).toContain(BODY);
    });
    for (const word of ["Install now", "Install", "Update", "Restore", "Uninstall"]) {
      const hit = Array.from(dialog.querySelectorAll("button, a")).some(
        (el) => (el.textContent ?? "").trim() === word,
      );
      expect(hit).toBe(false);
    }
  });
});
