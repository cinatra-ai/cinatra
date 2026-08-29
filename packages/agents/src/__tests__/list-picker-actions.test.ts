/**
 * Unit test for fetchAvailableLists (crm-list-reader capability backed).
 *
 * AUTHORIZATION (cinatra#3050). The loader is gated by the RUN's access, not by
 * a platform-administrator session. It used to open with
 * `requireAdminSession()`, which REDIRECTS a caller without the `admin` role to
 * `/not-authorized` — so the ordinary owner of a run was thrown off their own
 * run at the step this loader feeds. The run is the authority now: the caller's
 * session becomes a verified actor + role hints and the run identity threaded
 * from the renderer (`context.runId`) goes through `readAgentRunById`, the same
 * canonical `enforceRunAccess(…, "read", …)` seam the run page is drawn behind.
 *
 * `requireAdminSession` is wired to THROW here: if any production path still
 * reaches for it, these tests fail loudly rather than silently passing.
 *
 * Contract locked here:
 *   - the run-access gate fires FIRST — no CRM capability is resolved or called
 *     until it resolves, on every refusal path;
 *   - the gate receives the run id the renderer passed, the actor built from
 *     the session, and the role hints from the kernel actor context (including
 *     the actor's ACTIVE org, never the run's org);
 *   - a missing / blank / non-string run id takes the SAME hidden-run absence
 *     as an unknown one (`enforceRunAccess(null, …)`);
 *   - a refusal raised by the gate propagates unchanged (404 hidden /
 *     403 forbidden), never a redirect to an administrator screen;
 *   - LIST SCOPE IS UNCHANGED: the single call stays
 *     `searchLists({ query: "", objectType: "contact" })`;
 *   - CrmList[] is mapped 1:1 to AvailableListSummary[], with `memberCount`
 *     + `lastUpdated` set to null (the provider doesn't surface them)
 *     and `memberType` derived from `CrmList.objectType`;
 *   - Capability ABSENT (connector not installed/active) degrades to `[]`;
 *   - Upstream failures (no Twenty row, no bearer, network errors) degrade
 *     to `[]` rather than 500-ing the picker UI.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// --- mocks (must hoist BEFORE the source-under-test import) ---

const {
  requireAuthSessionMock,
  requireAdminSessionMock,
  requireActorContextMock,
} = vi.hoisted(() => ({
  // A plain, NON-ADMIN member session — the exact caller the old admin gate
  // redirected away from their own run.
  requireAuthSessionMock: vi.fn(async () => ({
    user: { id: "member-1", email: "member@example.com", role: "user" },
    session: { activeOrganizationId: "org-1" },
  })),
  requireAdminSessionMock: vi.fn(async () => {
    throw new Error(
      "requireAdminSession must not gate the list picker's loader (cinatra#3050)",
    );
  }),
  requireActorContextMock: vi.fn(async () => ({
    principalId: "member-1",
    organizationId: "org-1",
    orgRole: "member" as const,
    platformRole: "member" as const,
    teamIds: ["team-1"],
    teamRoles: { "team-1": "member" as const },
    projectGrants: [],
  })),
}));
vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: requireAuthSessionMock,
  requireAdminSession: requireAdminSessionMock,
  requireActorContext: requireActorContextMock,
}));

// A stand-in for the kernel's AuthzError carrying the two refusal shapes the
// run page gives: 404 "hidden" (the caller may not know the run exists) and
// 403 "forbidden" (an existing run the policy denies).
const { FakeAuthzError } = vi.hoisted(() => ({
  FakeAuthzError: class FakeAuthzError extends Error {
    statusCode: number;
    reason: string;
    constructor(init: { statusCode: number; reason: string; message: string }) {
      super(init.message);
      this.statusCode = init.statusCode;
      this.reason = init.reason;
    }
  },
}));

// The mock signatures are declared so the recorded `mock.calls` keep their
// arity — the assertions below read the run id, the actor and the role hints
// positionally.
const { enforceRunAccessMock, readAgentRunByIdMock } = vi.hoisted(() => ({
  enforceRunAccessMock:
    vi.fn<
      (run: unknown, actor: unknown, op: unknown, roles?: unknown) => Promise<void>
    >(),
  readAgentRunByIdMock:
    vi.fn<(id: unknown, actor?: unknown, roles?: unknown) => Promise<unknown>>(),
}));
vi.mock("../auth-policy", () => ({ enforceRunAccess: enforceRunAccessMock }));
vi.mock("../store", () => ({ readAgentRunById: readAgentRunByIdMock }));

vi.mock("@/lib/crm-integration-providers", () => ({
  resolveCrmListReader: vi.fn(),
}));

import { fetchAvailableLists } from "../list-picker-actions";
import { requireAdminSession } from "@/lib/auth-session";
import { resolveCrmListReader } from "@/lib/crm-integration-providers";

const RUN_ID = "run-1";

const searchMock = vi.fn();
vi.mocked(resolveCrmListReader).mockImplementation(() => ({ searchLists: searchMock }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveCrmListReader).mockImplementation(() => ({ searchLists: searchMock }));
  enforceRunAccessMock.mockResolvedValue(undefined);
  readAgentRunByIdMock.mockResolvedValue({ id: RUN_ID });
});

describe("fetchAvailableLists — run-access gate (cinatra#3050)", () => {
  it("authorizes the RUN for `read` with the caller's actor + role hints — no admin session", async () => {
    searchMock.mockResolvedValueOnce([]);

    await fetchAvailableLists(RUN_ID);

    expect(requireAdminSession).not.toHaveBeenCalled();
    expect(readAgentRunByIdMock).toHaveBeenCalledTimes(1);
    const [passedRunId, actor, roles] = readAgentRunByIdMock.mock.calls[0] as [
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(passedRunId).toBe(RUN_ID);
    expect(actor).toMatchObject({
      actorType: "human",
      source: "ui",
      userId: "member-1",
      organizationId: "org-1",
    });
    // A plain member: `user.role` is "user", so no platform_admin role is
    // synthesized from the session.
    expect(actor.roles).toEqual(["user"]);
    expect(roles).toMatchObject({
      platformRole: "member",
      orgRole: "member",
      // The actor's ACTIVE org — never the run's org, which would weaken the
      // cross-org guard.
      actorOrganizationId: "org-1",
    });
  });

  it("refuses a run the caller cannot read, and resolves NO CRM capability", async () => {
    readAgentRunByIdMock.mockRejectedValueOnce(
      new FakeAuthzError({
        statusCode: 403,
        reason: "forbidden",
        message: "Run access denied.",
      }),
    );

    await expect(fetchAvailableLists(RUN_ID)).rejects.toMatchObject({
      statusCode: 403,
      reason: "forbidden",
    });
    expect(resolveCrmListReader).not.toHaveBeenCalled();
    expect(searchMock).not.toHaveBeenCalled();
  });

  it("refuses an unknown run with the hidden-run absence, and resolves NO CRM capability", async () => {
    readAgentRunByIdMock.mockRejectedValueOnce(
      new FakeAuthzError({
        statusCode: 404,
        reason: "hidden",
        message: "Run not found.",
      }),
    );

    await expect(fetchAvailableLists("run-nobody-can-see")).rejects.toMatchObject({
      statusCode: 404,
      reason: "hidden",
    });
    expect(resolveCrmListReader).not.toHaveBeenCalled();
    expect(searchMock).not.toHaveBeenCalled();
  });

  it.each([["" as unknown], [undefined], [null], [42]])(
    "refuses a missing/malformed run id (%p) through the same hidden-run path — no DB read, no CRM",
    async (bad) => {
      enforceRunAccessMock.mockRejectedValueOnce(
        new FakeAuthzError({
          statusCode: 404,
          reason: "hidden",
          message: "Run not found.",
        }),
      );

      await expect(
        fetchAvailableLists(bad as string),
      ).rejects.toMatchObject({ statusCode: 404, reason: "hidden" });

      expect(enforceRunAccessMock).toHaveBeenCalledTimes(1);
      expect(enforceRunAccessMock.mock.calls[0][0]).toBeNull();
      expect(enforceRunAccessMock.mock.calls[0][2]).toBe("read");
      expect(readAgentRunByIdMock).not.toHaveBeenCalled();
      expect(resolveCrmListReader).not.toHaveBeenCalled();
      expect(searchMock).not.toHaveBeenCalled();
    },
  );

  it("propagates the sign-in redirect for an anonymous caller — no CRM read", async () => {
    requireAuthSessionMock.mockRejectedValueOnce(new Error("NEXT_REDIRECT"));

    await expect(fetchAvailableLists(RUN_ID)).rejects.toThrow(/NEXT_REDIRECT/);
    expect(resolveCrmListReader).not.toHaveBeenCalled();
    expect(searchMock).not.toHaveBeenCalled();
  });
});

describe("fetchAvailableLists", () => {
  it("calls searchLists with objectType:'contact' — list scope unchanged", async () => {
    searchMock.mockResolvedValueOnce([]);

    await fetchAvailableLists(RUN_ID);

    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(searchMock).toHaveBeenCalledWith({ query: "", objectType: "contact" });
  });

  it("maps CrmList[] to AvailableListSummary[] with objectType -> memberType + null counts/timestamps", async () => {
    searchMock.mockResolvedValueOnce([
      { id: "v1", slug: "leaders", name: "Leaders", objectType: "contact" },
      { id: "v2", slug: "customers", name: "Customers", objectType: "contact" },
    ]);

    const result = await fetchAvailableLists(RUN_ID);

    expect(result).toEqual([
      {
        id: "v1",
        name: "Leaders",
        memberCount: null,
        lastUpdated: null,
        memberType: "contact",
      },
      {
        id: "v2",
        name: "Customers",
        memberCount: null,
        lastUpdated: null,
        memberType: "contact",
      },
    ]);
  });

  it("degrades to [] when the reader throws (no CRM provider / no Twenty row / upstream unreachable)", async () => {
    searchMock.mockRejectedValueOnce(new Error("Twenty workspace row not configured"));

    expect(await fetchAvailableLists(RUN_ID)).toEqual([]);
  });

  it("returns an empty array when the reader returns no lists", async () => {
    searchMock.mockResolvedValueOnce([]);

    expect(await fetchAvailableLists(RUN_ID)).toEqual([]);
  });

  it("degrades to [] when the crm-list-reader capability is ABSENT (connector not installed/active)", async () => {
    vi.mocked(resolveCrmListReader).mockReturnValueOnce(null);

    expect(await fetchAvailableLists(RUN_ID)).toEqual([]);
    expect(searchMock).not.toHaveBeenCalled();
  });
});
