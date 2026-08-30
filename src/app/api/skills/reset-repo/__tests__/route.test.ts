/**
 * THE SKILLS REPOSITORY RESET ROUTE'S AUTHORIZATION GATE.
 *
 * `POST /api/skills/reset-repo` runs `pushSkillStoreToGitHub({ force: true })`,
 * which replaces the configured repository's content entirely and force-pushes
 * it. The effect is destructive and remote, and it destroys history that lives
 * outside this instance, so the route must establish WHO is asking before it
 * does anything else.
 *
 * TWO layers stand in front of the operation, and this file covers both of the
 * ones the handler owns:
 *
 *   - The app-wide route guard (`src/lib/auth-route-guard.ts`) does not list
 *     this path as public, so it 307s a request that carries no session cookie
 *     at all. It only checks that a cookie is PRESENT — it does not validate
 *     it and it does not read a role — so every authenticated caller, whatever
 *     their standing, reaches the handler.
 *   - The handler itself therefore carries the real gate, in two parts:
 *       1. `requireAdminSession()` runs as the FIRST statement, so a caller
 *          without platform-administrator standing is turned away before the
 *          runtime mode and the connection are even consulted, and can learn
 *          nothing about the instance's configuration from the response;
 *       2. the shared local-caller decision (`@/lib/local-caller-gate`) — a
 *          non-production build, a development runtime, a loopback SOCKET peer
 *          with no forwarded header from the caller, and this boot's 0600
 *          credential — which is what replaced the route's old `Host`-header
 *          origin check.
 *
 * The cookie-less arm below exercises the handler on its own, as defence in
 * depth: it pins that the handler refuses a session-less caller by itself, not
 * only because the outer guard happens to turn it away first.
 *
 * The real `requireAdminSession()` is under test, not a stand-in for it: the
 * seams mocked here are the session round-trip, `next/headers`, and
 * `next/navigation`'s `redirect`, so the guard's own comma-split role rule and
 * its two redirect destinations run for real. The local-caller gate, the peer
 * verdict and the boot credential are all real too — the credential is minted
 * into a throwaway instance directory per test.
 *
 * Every refusal is asserted by "the force-push never ran", not merely by the
 * status code, because the status code is not what is destructive.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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

import {
  BOOT_CREDENTIAL_HEADER,
  INSTANCE_DATA_DIR_ENV,
  mintBootCredential,
} from "@/lib/boot-credential";
import { localCallerRefusalMessage } from "@/lib/local-caller-gate";
import {
  CLIENT_FORWARDED_HEADER,
  NO_CLIENT_FORWARDED,
  SOCKET_PEER_HEADER,
} from "@/lib/request-peer";

import { POST } from "../route";

const ADMIN_COOKIE = "cinatra.session_token=admin-token";
const MEMBER_COOKIE = "cinatra.session_token=member-token";
/** Present, well-formed, and rejected by the auth round-trip (expired/revoked). */
const INVALID_COOKIE = "cinatra.session_token=revoked-token";

const LOCAL_URL = "http://127.0.0.1:3000/api/skills/reset-repo";
const REMOTE_URL = "https://app.example.test/api/skills/reset-repo";

/** The socket peer address the framework stamps for a call from this machine. */
const LOOPBACK_PEER = "127.0.0.1";
/** A peer address that is not this machine. */
const REMOTE_PEER = "2001:db8::1";

/**
 * The single refusal every non-local caller is told. Imported rather than
 * spelled out so a wording change in the gate does not silently stop this file
 * from checking that ALL of the gate's fences answer identically.
 */
const LOCAL_REFUSAL = localCallerRefusalMessage("/api/skills/reset-repo");

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

let dataDir: string;
let secret: string;

/** The stamps a call that really arrived on this machine's loopback carries. */
function localStamps(): Record<string, string> {
  return {
    [SOCKET_PEER_HEADER]: LOOPBACK_PEER,
    [CLIENT_FORWARDED_HEADER]: NO_CLIENT_FORWARDED,
    [BOOT_CREDENTIAL_HEADER]: secret,
  };
}

/**
 * A call from off the machine, dressed the way the OLD `Host`-header check
 * would have been satisfied by: a loopback-looking `Host` and a forwarded chain
 * the caller wrote itself. The boot credential is deliberately still present so
 * this shape isolates the CONNECTION fence.
 */
function remoteStamps(): Record<string, string> {
  return {
    host: "127.0.0.1:3000",
    "x-forwarded-for": "203.0.113.7",
    "x-forwarded-host": "app.example.test",
    [SOCKET_PEER_HEADER]: REMOTE_PEER,
    [CLIENT_FORWARDED_HEADER]: "x-forwarded-for,x-forwarded-host",
    [BOOT_CREDENTIAL_HEADER]: secret,
  };
}

async function callRoute(request: Request): Promise<Outcome> {
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

async function invoke(opts: {
  caller: Caller;
  runtimeMode: string;
  loopback: boolean;
}): Promise<Outcome> {
  vi.stubEnv("CINATRA_RUNTIME_MODE", opts.runtimeMode);
  const cookie = COOKIE_FOR[opts.caller];
  const cookieHeader: Record<string, string> = cookie ? { cookie } : {};
  h.currentHeaders.value = new Headers(cookieHeader);
  const request = new Request(opts.loopback ? LOCAL_URL : REMOTE_URL, {
    method: "POST",
    headers: {
      ...cookieHeader,
      ...(opts.loopback ? localStamps() : remoteStamps()),
    },
  });
  return callRoute(request);
}

/** An administrator's request with the local stamps overridden or removed. */
function adminRequest(stamps: Record<string, string>): Request {
  h.currentHeaders.value = new Headers({ cookie: ADMIN_COOKIE });
  return new Request(LOCAL_URL, {
    method: "POST",
    headers: { cookie: ADMIN_COOKIE, ...stamps },
  });
}

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

  dataDir = mkdtempSync(path.join(tmpdir(), "cinatra-reset-repo-"));
  // stubEnv rather than assignment: NODE_ENV is typed read-only, and
  // unstubAllEnvs restores every one of these without replacing process.env
  // itself (which would strand anything else holding a reference to it).
  vi.stubEnv(INSTANCE_DATA_DIR_ENV, dataDir);
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("CINATRA_RUNTIME_MODE", "development");
  secret = mintBootCredential(process.env);
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("POST /api/skills/reset-repo — the administrator gate runs first", () => {
  it("reads the session before it consults the runtime mode", async () => {
    // An administrator outside development mode: the local-caller refusal is
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
      body: { error: LOCAL_REFUSAL },
    });
    expect(h.pushSkillStoreToGitHub).not.toHaveBeenCalled();
  });

  it("tells a non-administrator nothing about the runtime mode or the connection rule", async () => {
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

  it("asks for the administrator BEFORE it looks at the connection", async () => {
    // A member arriving from off the machine with a wrong credential: the
    // answer must still be the administrator refusal, so the route never tells
    // an unprivileged caller which connection shapes it would have accepted.
    h.currentHeaders.value = new Headers({ cookie: MEMBER_COOKIE });
    const outcome = await callRoute(
      new Request(REMOTE_URL, {
        method: "POST",
        headers: {
          cookie: MEMBER_COOKIE,
          [SOCKET_PEER_HEADER]: REMOTE_PEER,
          [CLIENT_FORWARDED_HEADER]: NO_CLIENT_FORWARDED,
          [BOOT_CREDENTIAL_HEADER]: "wrong",
        },
      }),
    );

    expect(outcome).toEqual({ kind: "redirect", target: "/not-authorized" });
    expect(h.pushSkillStoreToGitHub).not.toHaveBeenCalled();
  });
});

describe("POST /api/skills/reset-repo — who is admitted", () => {
  it("runs the reset for an administrator in development mode over a local call", async () => {
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

  it("admits an admin whose role string carries several roles", async () => {
    // Better Auth stores roles comma-separated ("user,admin"). A naive
    // `role === "admin"` check would lock the real administrator out.
    const outcome = await invoke({
      caller: "administrator",
      runtimeMode: "development",
      loopback: true,
    });

    expect((outcome as { status: number }).status).toBe(200);
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
    // The handler's OWN answer to a session-less caller, exercised directly.
    // Over HTTP such a caller does not get this far — the path is not public,
    // so the outer guard redirects it first (true before this change too). The
    // point of the arm is that the handler does not depend on that.
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

  it("refuses the reset when the guard redirects, never turning that into a 500", async () => {
    // The redirect is a THROWN control-flow signal. If the gate ever moved
    // inside the handler's try/catch, this would come back as a 500 JSON body
    // instead of the signal, and the arm fails.
    const outcome = await invoke({
      caller: "member",
      runtimeMode: "development",
      loopback: true,
    });

    expect(outcome.kind).toBe("redirect");
  });
});

describe("POST /api/skills/reset-repo — the local-caller gate", () => {
  it("refuses an admin whose loopback `Host` is contradicted by the socket peer", async () => {
    const outcome = await callRoute(adminRequest(remoteStamps()));

    expect(outcome).toEqual({ kind: "json", status: 403, body: { error: LOCAL_REFUSAL } });
    expect(h.pushSkillStoreToGitHub).not.toHaveBeenCalled();
  });

  it("refuses an admin without the boot credential", async () => {
    const outcome = await callRoute(
      adminRequest({
        [SOCKET_PEER_HEADER]: LOOPBACK_PEER,
        [CLIENT_FORWARDED_HEADER]: NO_CLIENT_FORWARDED,
      }),
    );

    expect(outcome).toEqual({ kind: "json", status: 403, body: { error: LOCAL_REFUSAL } });
    expect(h.pushSkillStoreToGitHub).not.toHaveBeenCalled();
  });

  it("refuses an admin with a WRONG boot credential", async () => {
    const outcome = await callRoute(
      adminRequest({
        [SOCKET_PEER_HEADER]: LOOPBACK_PEER,
        [CLIENT_FORWARDED_HEADER]: NO_CLIENT_FORWARDED,
        [BOOT_CREDENTIAL_HEADER]: "wrong",
      }),
    );

    expect(outcome).toEqual({ kind: "json", status: 403, body: { error: LOCAL_REFUSAL } });
    expect(h.pushSkillStoreToGitHub).not.toHaveBeenCalled();
  });

  it("refuses an admin on an unstamped request", async () => {
    // No peer stamp at all: the gate must fail closed rather than read the
    // absence as "there was nothing suspicious about the connection".
    const outcome = await callRoute(
      adminRequest({ [BOOT_CREDENTIAL_HEADER]: secret }),
    );

    expect(outcome).toEqual({ kind: "json", status: 403, body: { error: LOCAL_REFUSAL } });
    expect(h.pushSkillStoreToGitHub).not.toHaveBeenCalled();
  });

  it("refuses outside a development runtime, admin and credential notwithstanding", async () => {
    vi.stubEnv("CINATRA_RUNTIME_MODE", "production");
    const outcome = await callRoute(adminRequest(localStamps()));

    expect(outcome).toEqual({ kind: "json", status: 403, body: { error: LOCAL_REFUSAL } });
    expect(h.pushSkillStoreToGitHub).not.toHaveBeenCalled();
  });

  it("refuses on a production BUILD even when the runtime mode says development", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const outcome = await callRoute(adminRequest(localStamps()));

    expect(outcome).toEqual({ kind: "json", status: 403, body: { error: LOCAL_REFUSAL } });
    expect(h.pushSkillStoreToGitHub).not.toHaveBeenCalled();
  });

  it("answers every refusal identically, so a prober cannot map the fences", async () => {
    const shapes: Record<string, string>[] = [
      remoteStamps(),
      { [SOCKET_PEER_HEADER]: LOOPBACK_PEER, [CLIENT_FORWARDED_HEADER]: NO_CLIENT_FORWARDED },
      { [BOOT_CREDENTIAL_HEADER]: secret },
    ];
    const answers = new Set<string>();
    for (const shape of shapes) {
      const outcome = await callRoute(adminRequest(shape));
      expect(outcome.kind).toBe("json");
      if (outcome.kind !== "json") return;
      answers.add(`${outcome.status}:${String(outcome.body.error)}`);
    }

    expect(answers.size).toBe(1);
    expect([...answers][0]).toBe(`403:${LOCAL_REFUSAL}`);
    expect(h.pushSkillStoreToGitHub).not.toHaveBeenCalled();
  });

  it("reports the push failure honestly rather than claiming success", async () => {
    h.pushSkillStoreToGitHub.mockRejectedValueOnce(new Error("remote rejected"));
    const outcome = await callRoute(adminRequest(localStamps()));

    expect(outcome).toEqual({
      kind: "json",
      status: 500,
      body: { error: "remote rejected" },
    });
  });
});

describe("POST /api/skills/reset-repo — the response matrix", () => {
  const CALLERS: Caller[] = ["administrator", "member", "invalid cookie", "no cookie"];
  const MODES = ["development", "production"];
  const ORIGINS = [
    { label: "local call", loopback: true },
    { label: "not a local call", loopback: false },
  ];

  for (const caller of CALLERS) {
    for (const runtimeMode of MODES) {
      for (const origin of ORIGINS) {
        it(`${caller} / ${runtimeMode} mode / ${origin.label}`, async () => {
          const outcome = await invoke({ caller, runtimeMode, loopback: origin.loopback });

          if (caller === "administrator") {
            if (runtimeMode !== "development" || !origin.loopback) {
              // Both the runtime fence and the connection fence answer with the
              // gate's one uniform refusal — an administrator learns only that
              // this is not a local call on a development instance, never which
              // of the two it was.
              expect(outcome).toEqual({
                kind: "json",
                status: 403,
                body: { error: LOCAL_REFUSAL },
              });
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
          // runtime mode and whatever the connection: the guard's redirect, and
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
