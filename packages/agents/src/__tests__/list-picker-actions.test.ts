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
 *   - Capability ABSENT (connector not installed/active) degrades to `[]`
 *     and logs one fixed line;
 *   - a search that answers no list returns `[]` and logs one fixed line; a
 *     non-empty answer logs nothing;
 *   - a search that THROWS is rejected with the fixed words "the CRM list
 *     search failed" and no `cause`, so the picker shows its existing load
 *     error instead of an empty list. The one log line names only the error's
 *     class from a fixed list (anything else is `UnknownError`) and an
 *     in-range integer code; the message, `data` and `cause` are never logged
 *     or carried.
 */
import { inspect } from "node:util";
import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest";

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

// Local stand-ins for the error classes a CRM connector throws. Only their
// `name` and `code` matter to the loader, which reads them generically and
// never imports a connector.
class TwentyMcpError extends Error {
  code: unknown;
  data: unknown;
  constructor(code: unknown, message: string, data?: unknown) {
    super(message);
    this.name = "TwentyMcpError";
    this.code = code;
    this.data = data;
  }
}
class TwentyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TwentyConfigError";
  }
}
class TwentyToolContractError extends Error {
  code: unknown;
  constructor(code: unknown, message: string) {
    super(message);
    this.name = "TwentyToolContractError";
    this.code = code;
  }
}

// Marker words that must never reach a log line or the rejection.
const MESSAGE_MARKER = "upstream-message-must-not-be-logged";
const DATA_MARKER = "body-must-not-be-logged";
const GETTER_MARKER = "getter-marker-must-not-be-logged";

const FAILED_WORDS = "the CRM list search failed";
const failedLine = (detail: string) =>
  `[list-picker] the CRM list search failed (${detail}); the picker shows the load error`;
const ABSENT_LINE =
  "[list-picker] no crm-list-reader capability is registered; the picker offers no lists";
const EMPTY_LINE = "[list-picker] the CRM list search answered no lists";

let warnSpy: MockInstance<typeof console.warn>;

/** Every argument the loader handed to console.warn, as one string. */
function everythingLogged(): string {
  return warnSpy.mock.calls.map((args) => args.map((a) => String(a)).join(" ")).join("\n");
}

/** The `[list-picker]` lines the loader wrote. */
function listPickerLines(): unknown[] {
  return warnSpy.mock.calls
    .map((args) => args[0])
    .filter((first) => typeof first === "string" && first.startsWith("[list-picker]"));
}

/** The loader's rejection; fails when the loader resolves instead. */
async function rejectionOf(pending: Promise<unknown>): Promise<unknown> {
  let resolved: unknown;
  try {
    resolved = await pending;
  } catch (rejection) {
    return rejection;
  }
  throw new Error(
    `the loader resolved (${JSON.stringify(resolved)}) instead of rejecting with the load error`,
  );
}

/** Asserts the fixed rejection and the one fixed line for `detail`. */
async function expectFailedLoad(thrown: unknown, detail: string): Promise<unknown> {
  searchMock.mockRejectedValueOnce(thrown);
  const rejection = await rejectionOf(fetchAvailableLists(RUN_ID));
  expect(rejection).toBeInstanceOf(Error);
  expect((rejection as Error).message).toBe(FAILED_WORDS);
  expect(Object.prototype.hasOwnProperty.call(rejection, "cause")).toBe(false);
  expect(warnSpy).toHaveBeenCalledTimes(1);
  expect(warnSpy).toHaveBeenCalledWith(failedLine(detail));
  return rejection;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveCrmListReader).mockImplementation(() => ({ searchLists: searchMock }));
  enforceRunAccessMock.mockResolvedValue(undefined);
  readAgentRunByIdMock.mockResolvedValue({ id: RUN_ID });
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
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

  it("T5: returns [] when the crm-list-reader capability is ABSENT, logs the fixed absent line and never searches", async () => {
    vi.mocked(resolveCrmListReader).mockReturnValueOnce(null);

    expect(await fetchAvailableLists(RUN_ID)).toEqual([]);
    expect(searchMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(ABSENT_LINE);
  });

  it("T6: returns [] when the search answers no lists and logs the fixed empty-answer line once", async () => {
    searchMock.mockResolvedValueOnce([]);

    expect(await fetchAvailableLists(RUN_ID)).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(EMPTY_LINE);
  });

  it("T7: maps a non-empty answer one to one and writes no [list-picker] line", async () => {
    searchMock.mockResolvedValueOnce([
      { id: "v1", slug: "leaders", name: "Leaders", objectType: "contact" },
    ]);

    expect(await fetchAvailableLists(RUN_ID)).toEqual([
      {
        id: "v1",
        name: "Leaders",
        memberCount: null,
        lastUpdated: null,
        memberType: "contact",
      },
    ]);
    expect(listPickerLines()).toEqual([]);
  });
});

describe("fetchAvailableLists — a failed search shows the load error", () => {
  it("T1: rejects a refused search with the fixed words, no cause, and one line naming only its class and code", async () => {
    await expectFailedLoad(
      new TwentyMcpError(401, MESSAGE_MARKER, DATA_MARKER),
      "TwentyMcpError, code 401",
    );

    const logged = everythingLogged();
    expect(logged).not.toContain(MESSAGE_MARKER);
    expect(logged).not.toContain(DATA_MARKER);
  });

  it("T2: the rejection carries no upstream class, message or data and no own cause", async () => {
    const rejection = await expectFailedLoad(
      new TwentyMcpError(401, MESSAGE_MARKER, DATA_MARKER),
      "TwentyMcpError, code 401",
    );

    const shown = inspect(rejection, { depth: 10 });
    expect(shown).toContain(FAILED_WORDS);
    expect(shown).not.toContain("TwentyMcpError");
    expect(shown).not.toContain(MESSAGE_MARKER);
    expect(shown).not.toContain(DATA_MARKER);
    expect(Object.prototype.hasOwnProperty.call(rejection, "cause")).toBe(false);
  });

  it.each([["name"], ["code"]])(
    "T3: a throwing %s getter logs (UnknownError) and the getter's error escapes nowhere",
    async (key) => {
      const err = new TwentyMcpError(401, MESSAGE_MARKER, DATA_MARKER);
      Object.defineProperty(err, key, {
        get() {
          throw new Error(GETTER_MARKER, { cause: DATA_MARKER });
        },
      });

      const rejection = await expectFailedLoad(err, "UnknownError");

      const shown = everythingLogged() + "\n" + inspect(rejection, { depth: 10 });
      expect(shown).not.toContain(GETTER_MARKER);
      expect(shown).not.toContain(DATA_MARKER);
    },
  );

  it("T4: a non-string name logs exactly (UnknownError) with no code", async () => {
    const err = new TwentyMcpError(401, MESSAGE_MARKER, DATA_MARKER);
    Object.defineProperty(err, "name", { value: { toString: () => MESSAGE_MARKER } });

    await expectFailedLoad(err, "UnknownError");
    expect(everythingLogged()).not.toContain(MESSAGE_MARKER);
  });

  it.each([["name_must_not_be_logged"], ["tokenAbc123Secret"]])(
    "T9: a name outside the class list (%s) logs exactly (UnknownError) and is written nowhere",
    async (name) => {
      const err = new TwentyMcpError(401, MESSAGE_MARKER, DATA_MARKER);
      err.name = name;

      const rejection = await expectFailedLoad(err, "UnknownError");

      expect(everythingLogged()).not.toContain(name);
      expect(inspect(rejection, { depth: 10 })).not.toContain(name);
    },
  );

  it.each([
    ["a rejected string", DATA_MARKER as unknown],
    ["a plain object", { name: "TwentyMcpError", code: 401 } as unknown],
  ])("T10: %s that is not an Error logs exactly (UnknownError)", async (_label, thrown) => {
    const rejection = await expectFailedLoad(thrown, "UnknownError");

    expect(everythingLogged()).not.toContain(DATA_MARKER);
    expect(inspect(rejection, { depth: 10 })).not.toContain(DATA_MARKER);
  });

  it.each([["TwentyMcpError" + "X".repeat(60)], ["A".repeat(200)]])(
    "T11: an overlong name logs exactly (UnknownError)",
    async (name) => {
      const err = new TwentyMcpError(401, MESSAGE_MARKER, DATA_MARKER);
      err.name = name;

      await expectFailedLoad(err, "UnknownError");
    },
  );

  it.each([
    ["NaN", Number.NaN as unknown],
    ["Infinity", Number.POSITIVE_INFINITY as unknown],
    ["-Infinity", Number.NEGATIVE_INFINITY as unknown],
    ["401.5", 401.5 as unknown],
    ["123456789", 123456789 as unknown],
    ["-40000", -40000 as unknown],
    ["the string '401'", "401" as unknown],
  ])("T12: the code %s is not written: the line reads (TwentyMcpError)", async (_label, code) => {
    const err = new TwentyMcpError(401, MESSAGE_MARKER, DATA_MARKER);
    Object.defineProperty(err, "code", { value: code });

    await expectFailedLoad(err, "TwentyMcpError");
  });

  it.each([
    ["Error", new Error(MESSAGE_MARKER) as unknown, "Error"],
    ["TwentyConfigError", new TwentyConfigError(MESSAGE_MARKER) as unknown, "TwentyConfigError"],
    ["SyntaxError", new SyntaxError(MESSAGE_MARKER) as unknown, "SyntaxError"],
    [
      "TwentyToolContractError",
      new TwentyToolContractError(-32603, MESSAGE_MARKER) as unknown,
      "TwentyToolContractError, code -32603",
    ],
    [
      "TwentyMcpError",
      new TwentyMcpError(-32000, MESSAGE_MARKER, DATA_MARKER) as unknown,
      "TwentyMcpError, code -32000",
    ],
  ])("T13: a listed class (%s) logs its own class and an in-range code", async (_label, thrown, detail) => {
    await expectFailedLoad(thrown, detail as string);
    expect(everythingLogged()).not.toContain(MESSAGE_MARKER);
  });
});
