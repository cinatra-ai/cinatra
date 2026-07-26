// cinatra#1913 — the save actions return a TYPED result instead of throwing
// into the client: `invalid-config` carries the validator's card-naming copy
// in `message`; other classified failures keep their bare reason; unexpected
// errors still rethrow (error boundary, not silent). Pinned on the agents
// action — every save action shares the same classify + mapping shape.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../store/db", () => ({
  auditEvents: {},
  dashboardRevisions: {},
  dashboards: {},
  getDashboardsDb: () => {
    throw new Error("unexpected direct db access in this test");
  },
}));

const upsertDashboardConfig = vi.fn();
vi.mock("../mutation-service", async (importOriginal) => {
  const original = await importOriginal<typeof import("../mutation-service")>();
  return {
    ...original,
    upsertDashboardConfig: (...a: unknown[]) => upsertDashboardConfig(...a),
  };
});

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: async () => ({ user: { id: "user-1" } }),
  // cinatra#1939 S3: the save actions mint a session org-write authority from
  // the resolved membership role before calling the (mocked) writer.
  resolveOrgRoleForUser: async () => "member",
}));
vi.mock("../auth/security-context", () => ({
  buildSecurityContextFromSession: () => ({
    userId: "user-1",
    organizationId: "org-1",
    teamIds: [],
  }),
}));

import { saveAgentsDashboardAction } from "../actions";
import { DashboardConfigInvalidError, DashboardForbiddenError } from "../mutation-service";

beforeEach(() => {
  upsertDashboardConfig.mockReset();
});

describe("save actions — typed results (cinatra#1913)", () => {
  it("success → { ok: true }", async () => {
    upsertDashboardConfig.mockResolvedValue({ id: "d" });
    await expect(saveAgentsDashboardAction({})).resolves.toEqual({ ok: true });
  });

  it("invalid config → { ok:false, reason:'invalid-config' } WITH the card-naming copy", async () => {
    upsertDashboardConfig.mockRejectedValue(
      new DashboardConfigInvalidError(
        'portlet "analytics": card "Demo": This portlet mixes fields from multiple data sources.',
      ),
    );
    const result = await saveAgentsDashboardAction({});
    expect(result).toEqual({
      ok: false,
      reason: "invalid-config",
      // The error class prefixes its copy — the card-naming tail is verbatim.
      message:
        'DashboardConfig validation failed: portlet "analytics": card "Demo": This portlet mixes fields from multiple data sources.',
    });
  });

  it("classified non-config failure → bare reason, no message", async () => {
    upsertDashboardConfig.mockRejectedValue(
      new DashboardForbiddenError("dashboards.update", "d"),
    );
    await expect(saveAgentsDashboardAction({})).resolves.toEqual({
      ok: false,
      reason: "denied",
    });
  });

  it("unexpected failure still rethrows (never silently mapped)", async () => {
    upsertDashboardConfig.mockRejectedValue(new Error("connection reset"));
    await expect(saveAgentsDashboardAction({})).rejects.toThrow("connection reset");
  });
});
