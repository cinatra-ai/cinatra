// cinatra#2811 (fix leg 2): the nested and flat dashboard-detail routes read
// their address segments the same way the workspace surface does, so they carry
// the same defect and take the same repair.
//
// The framework hands a dynamic segment to a page ALREADY percent-escaped: it
// decodes the raw path segment when it matches the route
// (next/dist/shared/lib/router/utils/route-matcher.js:19), then re-escapes the
// value on its way to user code
// (next/dist/shared/lib/router/utils/get-dynamic-param.js:58, whose own comment
// calls it "the value that is passed to user code"). An identifier that carries
// punctuation, such as the composed Overview of an entity, therefore never
// equals the stored one unless the page decodes the segment first.
//
// These cases hand each page the segment as the runtime hands it and read the
// props the page passes on: the identifier must be decoded, the current path
// must stay the escaped address, and a segment that is not a valid escape
// sequence must pass through rather than throw.
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  metadataCalls: [] as Array<{ id: string; anchor: unknown }>,
}));

vi.mock("@/app/dashboards/[id]/dashboard-detail-screen", () => ({
  DashboardDetailScreen: () => null,
  dashboardDetailMetadata: async (id: string, anchor?: unknown) => {
    state.metadataCalls.push({ id, anchor });
    return { title: "Dashboard" };
  },
}));

import TeamDashboardDetailPage, {
  generateMetadata as teamMetadata,
} from "../teams/[teamId]/dashboards/[dashboardId]/page";
import OrganizationDashboardDetailPage, {
  generateMetadata as organizationMetadata,
} from "../organizations/[id]/dashboards/[dashboardId]/page";
import FlatDashboardDetailPage, {
  generateMetadata as flatMetadata,
} from "../dashboards/[id]/page";

type ScreenProps = {
  id: string;
  currentPath: string;
  expectedAnchor?: { entityType: string; entityId: string };
};

const TEAM_OVERVIEW_ID = "dash:team:t1:overview";
const ORG_OVERVIEW_ID = "dash:organization:org-a:overview";

const props = (element: unknown) => (element as { props: ScreenProps }).props;

beforeEach(() => {
  state.metadataCalls = [];
});

describe("the team dashboard page reads its segments as the runtime hands them", () => {
  it("decodes the escaped identifier and keeps the escaped address as the current path", async () => {
    const segment = encodeURIComponent(TEAM_OVERVIEW_ID);
    const p = props(
      await TeamDashboardDetailPage({
        params: Promise.resolve({ teamId: "t1", dashboardId: segment }),
      }),
    );
    expect(p.id).toBe(TEAM_OVERVIEW_ID);
    expect(p.currentPath).toBe(`/teams/t1/dashboards/${segment}`);
    expect(p.expectedAnchor).toEqual({ entityType: "team", entityId: "t1" });
  });

  it("reads a plainly punctuated address to the same identifier", async () => {
    const p = props(
      await TeamDashboardDetailPage({
        params: Promise.resolve({ teamId: "t1", dashboardId: TEAM_OVERVIEW_ID }),
      }),
    );
    expect(p.id).toBe(TEAM_OVERVIEW_ID);
  });

  it("keeps a plain identifier untouched", async () => {
    const p = props(
      await TeamDashboardDetailPage({
        params: Promise.resolve({ teamId: "t1", dashboardId: "d-1" }),
      }),
    );
    expect(p.id).toBe("d-1");
    expect(p.currentPath).toBe("/teams/t1/dashboards/d-1");
  });

  it("passes a segment that is not a valid escape sequence through, rather than throwing", async () => {
    const p = props(
      await TeamDashboardDetailPage({
        params: Promise.resolve({ teamId: "t1", dashboardId: "dash%ZZteam" }),
      }),
    );
    expect(p.id).toBe("dash%ZZteam");
  });

  it("hands the decoded identifier to the metadata gate", async () => {
    await teamMetadata({
      params: Promise.resolve({ teamId: "t1", dashboardId: encodeURIComponent(TEAM_OVERVIEW_ID) }),
    });
    expect(state.metadataCalls).toEqual([
      { id: TEAM_OVERVIEW_ID, anchor: { entityType: "team", entityId: "t1" } },
    ]);
  });
});

describe("the organization dashboard page reads its segments as the runtime hands them", () => {
  it("decodes the escaped identifier and keeps the escaped address as the current path", async () => {
    const segment = encodeURIComponent(ORG_OVERVIEW_ID);
    const p = props(
      await OrganizationDashboardDetailPage({
        params: Promise.resolve({ id: "org-a", dashboardId: segment }),
      }),
    );
    expect(p.id).toBe(ORG_OVERVIEW_ID);
    expect(p.currentPath).toBe(`/organizations/org-a/dashboards/${segment}`);
    expect(p.expectedAnchor).toEqual({ entityType: "organization", entityId: "org-a" });
  });

  it("reads a plainly punctuated address to the same identifier", async () => {
    const p = props(
      await OrganizationDashboardDetailPage({
        params: Promise.resolve({ id: "org-a", dashboardId: ORG_OVERVIEW_ID }),
      }),
    );
    expect(p.id).toBe(ORG_OVERVIEW_ID);
  });

  it("passes a segment that is not a valid escape sequence through, rather than throwing", async () => {
    const p = props(
      await OrganizationDashboardDetailPage({
        params: Promise.resolve({ id: "org-a", dashboardId: "%E0%A4%A" }),
      }),
    );
    expect(p.id).toBe("%E0%A4%A");
  });

  it("hands the decoded identifier to the metadata gate", async () => {
    await organizationMetadata({
      params: Promise.resolve({ id: "org-a", dashboardId: encodeURIComponent(ORG_OVERVIEW_ID) }),
    });
    expect(state.metadataCalls).toEqual([
      { id: ORG_OVERVIEW_ID, anchor: { entityType: "organization", entityId: "org-a" } },
    ]);
  });
});

// The flat route feeds the SAME shared screen, which redirects an anchored row
// to its canonical address. A punctuated identifier typed here must reach that
// redirect rather than answer not-found, so this route reads its segment the
// same way.
describe("the flat dashboard page reads its segment as the runtime hands it", () => {
  it("decodes the escaped identifier and keeps the escaped address as the current path", async () => {
    const segment = encodeURIComponent(TEAM_OVERVIEW_ID);
    const p = props(
      await FlatDashboardDetailPage({ params: Promise.resolve({ id: segment }) }),
    );
    expect(p.id).toBe(TEAM_OVERVIEW_ID);
    expect(p.currentPath).toBe(`/dashboards/${segment}`);
  });

  it("hands the decoded identifier to the metadata gate", async () => {
    await flatMetadata({
      params: Promise.resolve({ id: encodeURIComponent(TEAM_OVERVIEW_ID) }),
    });
    expect(state.metadataCalls).toEqual([{ id: TEAM_OVERVIEW_ID, anchor: undefined }]);
  });
});
