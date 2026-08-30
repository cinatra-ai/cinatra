/**
 * THE SKILLS REPOSITORY RESET ROUTE'S AUTHORIZATION GATE.
 *
 * `POST /api/skills/reset-repo` runs `pushSkillStoreToGitHub({ force: true })`,
 * which replaces the configured repository's content entirely and force-pushes
 * it. The effect is destructive and remote, so the route must establish WHO is
 * asking before it does anything else.
 *
 * Two layers stand in front of the operation and this file is about the inner
 * one:
 *
 *   - The app-wide route guard (`src/lib/auth-route-guard.ts`) does not list
 *     this path as public, so it 307s a request that carries no session cookie
 *     at all. It only checks that a cookie is PRESENT — it does not validate
 *     it and it does not read a role — so every authenticated caller, whatever
 *     their standing, reaches the handler.
 *   - The handler itself must therefore carry the real gate. That is what is
 *     asserted here: `requireAdminSession()` runs as the FIRST statement, so a
 *     caller without platform-administrator standing is turned away before the
 *     runtime-mode and origin checks are even consulted, and can learn nothing
 *     about the instance's runtime configuration from the response.
 *
 * The cookie-less arm below therefore exercises the handler on its own, as
 * defence in depth: it pins that the handler refuses a session-less caller by
 * itself, not only because the outer guard happens to turn it away first.
 *
 * The real `requireAdminSession()` is under test, not a stand-in for it: the
 * seams mocked here are the session round-trip, `next/headers`, and
 * `next/navigation`'s `redirect`, so the guard's own comma-split role rule and
 * its two redirect destinations run for real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  /**
   * Stands in for the control-flow signal Next's `redirect()` throws. Modelling
   * it as a THROW (rather than a returned value) is load-bearing: the route
   * wraps its push call in try/catch, so a gate placed inside that block would
   * silently turn a redirect into a 500 JSON body. Every unauthorized arm below
   * asserts the call REJECTS with this signal, which fails if that ever happens.
   */
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
    pushSkillStoreToGitHub: vi.fn(),
    /** The headers object `next/headers` hands the session guard. */
    currentHeaders: { value: new Headers() },
    /** Cookie value -> the session the auth round-trip resolves for it. */
    sessionsByCookie: new Map<string, unknown>(),
    /** Ordered record of the checks the handler performed, for the ordering arm. */
    calls: [] as string[],
  };
});

vi.mock("@cinatra-ai/skills", () => ({
  pushSkillStoreToGitHub: (...args: unknown[]) => {
    h.calls.push("push");
    return h.pushSkillStoreToGitHub(...args);
  },
}));

vi.mock("next/navigation", () => ({
  redirect: (target: string) => {
    throw new h.RedirectSignal(target);
  },
}));

vi.mock("next/headers", () => ({
  headers: async () => h.currentHeaders.value,
}));

vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        h.calls.push("getSession");
        const cookie = headers.get("cookie");
        if (!cookie) return null;
        return h.sessionsByCookie.get(cookie) ?? null;
      },
    },
  },
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

import { POST } from "../route";

const ADMIN_COOKIE = "cinatra.session_token=admin-token";
const MEMBER_COOKIE = "cinatra.session_token=member-token";
/** Present, well-formed, and rejected by the auth round-trip (expired/revoked). */
const INVALID_COOKIE = "cinatra.session_token=revoked-token";

const LOOPBACK_URL = "http://127.0.0.1:3000/api/skills/reset-repo";
const REMOTE_URL = "https://app.example.test/api/skills/reset-repo";

type Caller = "administrator" | "member" | "invalid cookie" | "no cookie";

const COOKIE_FOR: Record<Caller, string | undefined> = {
  administrator: ADMIN_COOKIE,
  member: MEMBER_COOKIE,
  "invalid cookie": INVALID_COOKIE,
  "no cookie": undefined,
};

type Outcome =
  | { kind: "redirect"; target: string }
  | { kind: "json"; status: number; body: Record<string, unknown> };

async function invoke(opts: {
  caller: Caller;
  runtimeMode: string;
  loopback: boolean;
}): Promise<Outcome> {
  process.env.CINATRA_RUNTIME_MODE = opts.runtimeMode;
  const cookie = COOKIE_FOR[opts.caller];
  const headerInit: Record<string, string> = cookie ? { cookie } : {};
  h.currentHeaders.value = new Headers(headerInit);
  const request = new Request(opts.loopback ? LOOPBACK_URL : REMOTE_URL, {
    method: "POST",
    headers: headerInit,
  });
  try {
    const response = await POST(request);
    return {
      kind: "json",
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  } catch (error) {
    if (error instanceof h.RedirectSignal) {
      return { kind: "redirect", target: error.target };
    }
    throw error;
  }
}

const savedRuntimeMode = process.env.CINATRA_RUNTIME_MODE;

beforeEach(() => {
  h.calls.length = 0;
  h.pushSkillStoreToGitHub.mockReset();
  h.pushSkillStoreToGitHub.mockResolvedValue({ commitSha: "c0ffee1" });
  h.sessionsByCookie.clear();
  h.sessionsByCookie.set(ADMIN_COOKIE, {
    user: { id: "u-admin", role: "user,admin", image: "https://example.test/a.png" },
    session: { activeOrganizationId: "org-1" },
  });
  h.sessionsByCookie.set(MEMBER_COOKIE, {
    user: { id: "u-member", role: "user,member", image: "https://example.test/m.png" },
    session: { activeOrganizationId: "org-1" },
  });
  // INVALID_COOKIE is deliberately absent from the map: the round-trip resolves
  // it to no session, which is what a revoked or expired cookie looks like.
});

afterEach(() => {
  if (savedRuntimeMode === undefined) delete process.env.CINATRA_RUNTIME_MODE;
  else process.env.CINATRA_RUNTIME_MODE = savedRuntimeMode;
});

describe("POST /api/skills/reset-repo — the administrator gate runs first", () => {
  it("reads the session before it consults the runtime mode", async () => {
    // An administrator outside development mode: the runtime-mode refusal is
    // still the answer, but the session round-trip has already happened, which
    // pins the guard as the handler's FIRST statement.
    const outcome = await invoke({
      caller: "administrator",
      runtimeMode: "production",
      loopback: true,
    });

    expect(h.calls[0]).toBe("getSession");
    expect(outcome).toEqual({
      kind: "json",
      status: 403,
      body: { error: "Only available in development mode." },
    });
    expect(h.pushSkillStoreToGitHub).not.toHaveBeenCalled();
  });

  it("tells a non-administrator nothing about the runtime mode or the origin rule", async () => {
    // The same request an administrator would have answered with the 403 above.
    // A caller without standing must not be able to read the instance's runtime
    // configuration out of the difference.
    const outcome = await invoke({
      caller: "member",
      runtimeMode: "production",
      loopback: false,
    });

    expect(outcome).toEqual({ kind: "redirect", target: "/not-authorized" });
    expect(h.calls).not.toContain("push");
  });
});

describe("POST /api/skills/reset-repo — who is admitted", () => {
  it("runs the reset for an administrator in development mode over loopback", async () => {
    const outcome = await invoke({
      caller: "administrator",
      runtimeMode: "development",
      loopback: true,
    });

    expect(h.pushSkillStoreToGitHub).toHaveBeenCalledTimes(1);
    expect(h.pushSkillStoreToGitHub).toHaveBeenCalledWith({ force: true });
    expect(outcome).toEqual({
      kind: "json",
      status: 200,
      body: { success: true, commitSha: "c0ffee1" },
    });
  });

  it("sends a signed-in caller who is not a platform administrator to the not-authorized destination", async () => {
    const outcome = await invoke({
      caller: "member",
      runtimeMode: "development",
      loopback: true,
    });

    expect(outcome).toEqual({ kind: "redirect", target: "/not-authorized" });
    expect(h.pushSkillStoreToGitHub).not.toHaveBeenCalled();
  });

  it("sends a caller carrying NO session cookie to sign-in", async () => {
    const outcome = await invoke({
      caller: "no cookie",
      runtimeMode: "development",
      loopback: true,
    });

    expect(outcome.kind).toBe("redirect");
    expect((outcome as { target: string }).target).toMatch(/^\/sign-in(\?|$)/);
    expect(h.pushSkillStoreToGitHub).not.toHaveBeenCalled();
  });

  it("sends a caller carrying an INVALID session cookie to sign-in", async () => {
    // Separate from the arm above on purpose: the outer route guard only checks
    // that a cookie is present, so this is the caller it lets through. The
    // handler must resolve the cookie and refuse it on its own.
    const outcome = await invoke({
      caller: "invalid cookie",
      runtimeMode: "development",
      loopback: true,
    });

    expect(outcome.kind).toBe("redirect");
    expect((outcome as { target: string }).target).toMatch(/^\/sign-in(\?|$)/);
    expect(h.pushSkillStoreToGitHub).not.toHaveBeenCalled();
  });
});

describe("POST /api/skills/reset-repo — the response matrix", () => {
  const CALLERS: Caller[] = ["administrator", "member", "invalid cookie", "no cookie"];
  const MODES = ["development", "production"];
  const ORIGINS = [
    { label: "loopback", loopback: true },
    { label: "not loopback", loopback: false },
  ];

  for (const caller of CALLERS) {
    for (const runtimeMode of MODES) {
      for (const origin of ORIGINS) {
        it(`${caller} / ${runtimeMode} mode / ${origin.label}`, async () => {
          const outcome = await invoke({ caller, runtimeMode, loopback: origin.loopback });

          if (caller === "administrator") {
            if (runtimeMode !== "development") {
              expect(outcome).toEqual({
                kind: "json",
                status: 403,
                body: { error: "Only available in development mode." },
              });
              expect(h.pushSkillStoreToGitHub).not.toHaveBeenCalled();
              return;
            }
            if (!origin.loopback) {
              expect(outcome.kind).toBe("json");
              expect((outcome as { status: number }).status).toBe(403);
              expect(h.pushSkillStoreToGitHub).not.toHaveBeenCalled();
              return;
            }
            expect(outcome).toEqual({
              kind: "json",
              status: 200,
              body: { success: true, commitSha: "c0ffee1" },
            });
            expect(h.pushSkillStoreToGitHub).toHaveBeenCalledTimes(1);
            return;
          }

          // Every non-administrator cell answers the same way, whatever the
          // runtime mode and whatever the origin: the guard's redirect, and
          // nothing that distinguishes one instance configuration from another.
          const expected = caller === "member" ? "/not-authorized" : "/sign-in";
          expect(outcome.kind).toBe("redirect");
          expect((outcome as { target: string }).target.split("?")[0]).toBe(expected);
          expect(h.pushSkillStoreToGitHub).not.toHaveBeenCalled();
        });
      }
    }
  }
});
