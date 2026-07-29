/**
 * BEHAVIORAL end-to-end coverage for the ConnectorsPage multi-scope `?scope=`
 * OR-filter (cinatra#1074 W5): executes the REAL server component (auth/DB/
 * registry boundaries mocked; the scope pipeline — canonical parser, entry
 * fold, OR-predicate — is the REAL production code) and asserts which cards
 * reach <ConnectorsClient> for multi-scope and single-scope URLs, including
 * the runtime-only card path that pre-W5 bypassed the filter entirely.
 */
import { describe, it, expect, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";

const ACTOR = "user-actor";
const OTHER = "user-other";
const ORG = "o1";

const TEAM_PKG = "@cinatra-ai/team-connector";
const PROJ_PKG = "@cinatra-ai/project-connector";
const MINE_PKG = "@cinatra-ai/mine-connector";
const BARE_PKG = "@cinatra-ai/bare-connector"; // no connections at all
const ADMIN_PKG = "@cinatra-ai/admin-connector"; // catalog default-visibility "admin"
const RT_TEAM_PKG = "@cinatra-ai/rt-team-connector"; // runtime-only, team grant
const RT_BARE_PKG = "@cinatra-ai/rt-bare-connector"; // runtime-only, no entries

const CATALOG_PKGS = [TEAM_PKG, PROJ_PKG, MINE_PKG, BARE_PKG, ADMIN_PKG];

vi.mock("server-only", () => ({}));
vi.mock("@/lib/connector-readiness.server", () => ({}));
vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: vi.fn(async () => ({
    user: { id: ACTOR },
    session: { activeOrganizationId: ORG },
  })),
  getActorContext: vi.fn(async () => ({ userId: ACTOR, organizationId: ORG })),
}));
vi.mock("@/lib/better-auth-db", () => ({
  // ConnectorsPage is a UI scope picker (cinatra#1942 archive V1, Decision 4)
  // — it calls the active-only sibling, not the mixed authz/UI reader.
  readOrgsWithTeamsForUserActiveOnly: vi.fn(async () => [
    { id: ORG, name: "Org One", teams: [{ id: "t1", name: "Team One" }] },
  ]),
  readProjectsForUser: vi.fn(async () => [{ id: "p1", name: "Project One" }]),
}));
vi.mock("@/lib/generated/extensions.server", () => ({
  STATIC_EXTENSION_MANIFEST: {},
}));
vi.mock("../connectors-client", () => ({
  // Stub client component — the page test reads its `cards` prop off the
  // returned element tree (never DOM-rendered).
  ConnectorsClient: vi.fn(() => null),
}));
vi.mock("@cinatra-ai/extensions/connection-identity-store", () => ({
  listNangoConnectionsForScopeFilter: vi.fn(async () => [
    { id: "c-team", connectorPackageId: TEAM_PKG, organizationId: ORG, ownerUserId: OTHER },
    { id: "c-proj", connectorPackageId: PROJ_PKG, organizationId: ORG, ownerUserId: OTHER },
    { id: "c-mine", connectorPackageId: MINE_PKG, organizationId: ORG, ownerUserId: ACTOR },
    { id: "c-rt", connectorPackageId: RT_TEAM_PKG, organizationId: ORG, ownerUserId: OTHER },
  ]),
}));
vi.mock("@cinatra-ai/extensions/permissions-store", () => {
  const policyOf = (tokens: string[]) => ({
    runListVisibility: tokens,
    runDataVisibility: tokens,
    runExecuteVisibility: tokens,
    allowRunSharing: false,
  });
  return {
    readExtensionAccessPolicies: vi.fn(async () =>
      new Map([
        ["c-team", policyOf(["team:t1"])],
        ["c-proj", policyOf(["project:p1"])],
        ["c-mine", policyOf(["owner"])],
        ["c-rt", policyOf(["team:t1"])],
      ]),
    ),
  };
});
vi.mock("@/lib/connectors-registry.server", () => ({
  listConnectorRegistryEntries: vi.fn(() =>
    [TEAM_PKG, PROJ_PKG, MINE_PKG, BARE_PKG, ADMIN_PKG].map((packageId) => ({
      packageId,
      slug: packageId.split("/")[1]!,
      displayName: packageId,
      setupHref: `/connectors/x/${packageId.split("/")[1]}/setup`,
      readinessProbe: async () => ({ connected: false }),
    })),
  ),
}));
vi.mock("@/lib/installed-connectors.server", () => ({
  resolveInstalledCatalogConnectorIds: vi.fn(
    async (ids: string[]) => new Set(ids),
  ),
  listRuntimeOnlyConnectorCards: vi.fn(async () => [
    { packageName: RT_TEAM_PKG, vendor: "x", slug: "rt-team", displayName: "RT Team", logo: null },
    { packageName: RT_BARE_PKG, vendor: "x", slug: "rt-bare", displayName: "RT Bare", logo: null },
  ]),
}));
vi.mock("@/lib/connector-policy", () => ({
  isConnectorVisibleToActor: vi.fn(() => true),
}));
vi.mock("@/lib/connector-access-config-host", () => ({
  // PRODUCTION-FAITHFUL: the real helper fail-closes any package WITHOUT a
  // resolvable catalog declaration to "admin" — which includes every
  // runtime-only package. The page must therefore NOT feed runtime-only cards
  // through the catalog default-visibility axis (codex round-2 blocker).
  connectorCatalogDefaultVisibility: vi.fn((packageId: string) => {
    if (packageId === ADMIN_PKG) return "admin"; // declared admin-tier catalog card
    return CATALOG_PKGS.includes(packageId) ? "workspace" : "admin"; // fail-closed
  }),
}));
vi.mock("../readiness-fail-soft", () => ({
  resolveReadinessFailSoft: vi.fn(async () => ({ connected: false })),
}));

import { ConnectorsPage } from "../pages";
import { ConnectorsClient } from "../connectors-client";

/** Walk the (un-rendered) element tree for the stubbed <ConnectorsClient>. */
function findClientElement(node: ReactNode): ReactElement | null {
  if (node === null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findClientElement(child);
      if (found) return found;
    }
    return null;
  }
  const element = node as ReactElement;
  if (element.type === ConnectorsClient) return element;
  const props = element.props as { children?: ReactNode } | undefined;
  return props?.children !== undefined ? findClientElement(props.children) : null;
}

async function visibleSlugs(scope?: string): Promise<string[]> {
  const page = await ConnectorsPage({
    searchParams: Promise.resolve(scope === undefined ? {} : { scope }),
  });
  const client = findClientElement(page);
  expect(client).not.toBeNull();
  const cards = (client!.props as { cards: Array<{ slug: string }> }).cards;
  return cards.map((card) => card.slug).sort();
}

describe("ConnectorsPage multi-scope ?scope= OR-filter (behavioral, cinatra#1074 W5)", () => {
  it("default view shows every visible card, entries or not (incl. runtime-only)", async () => {
    expect(await visibleSlugs()).toEqual(
      [
        "team-connector",
        "project-connector",
        "mine-connector",
        "bare-connector",
        "admin-connector",
        "rt-team",
        "rt-bare",
      ].sort(),
    );
  });

  it("single-scope URLs keep working", async () => {
    expect(await visibleSlugs("team:t1")).toEqual(["rt-team", "team-connector"]);
    expect(await visibleSlugs("personal")).toEqual(["mine-connector"]);
  });

  it("a comma-separated multi-scope URL ORs across parents of different kinds", async () => {
    expect(await visibleSlugs("team:t1,project:p1")).toEqual([
      "project-connector",
      "rt-team",
      "team-connector",
    ]);
    expect(await visibleSlugs("personal,project:p1")).toEqual([
      "mine-connector",
      "project-connector",
    ]);
  });

  it("runtime-only cards honor the filter (the pre-W5 bypass is closed)", async () => {
    // rt-bare has NO scope entries: visible only under the default view.
    expect(await visibleSlugs("project:p1")).toEqual(["project-connector"]);
    expect((await visibleSlugs("team:t1")).includes("rt-bare")).toBe(false);
  });

  it("the admin filter matches admin-tier CATALOG cards only — never runtime-only cards (whose catalog visibility fail-closes to admin)", async () => {
    expect(await visibleSlugs("admin")).toEqual(["admin-connector"]);
    expect(await visibleSlugs("admin,team:t1")).toEqual([
      "admin-connector",
      "rt-team",
      "team-connector",
    ]);
  });

  it("invalid tokens drop; workspace-mixed collapses to the default (everything)", async () => {
    expect(await visibleSlugs("team:t1,team:evil,bogus")).toEqual(["rt-team", "team-connector"]);
    expect(await visibleSlugs("workspace,team:t1")).toEqual(await visibleSlugs());
    expect(await visibleSlugs("bogus")).toEqual(await visibleSlugs());
  });
});
