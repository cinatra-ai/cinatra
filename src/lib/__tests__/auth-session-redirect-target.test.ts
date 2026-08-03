/**
 * cinatra#2359 — `requireAuthSession()` (and the shared `signInRedirectTarget()`
 * helper every ad hoc gate now calls) is the app-wide chokepoint: when there
 * is no session, it must redirect to `/sign-in?next=<the forwarded current
 * path>` instead of the old bare `/sign-in`. The forwarded path arrives via
 * `CURRENT_PATH_HEADER`, set by `guardAppRoute` (see
 * auth-route-guard-next-param.test.ts for that half). This file proves the
 * consuming half: `requireAuthSession()` reads that header and builds the
 * `next`-qualified redirect, re-validating it (never trusting the header
 * blindly) so a malformed/hostile value still degrades to the bare
 * `/sign-in`.
 *
 * `signInRedirectTarget()` returns a STRING rather than performing the
 * redirect itself — every call site does `redirect(await
 * signInRedirectTarget())` directly, because TypeScript only narrows a
 * preceding `if (!session)` check away when `redirect()` (typed `never`) is
 * called AT the call site; narrowing does not propagate through an
 * intermediate async wrapper that redirects on the caller's behalf.
 *
 * Follows the mock-shape convention of auth-session-request-cache.test.ts
 * (#704) — `next/headers` and `next/navigation` are mocked directly; the
 * heavier better-auth/db module graph is stubbed to trivial shapes so only
 * getAuthSession()'s ONE decision (session vs. no session) drives the test.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  session: null as null | Record<string, unknown>,
  currentHeaders: null as null | Headers,
}));

vi.mock("next/headers", () => ({
  headers: async () => {
    if (!state.currentHeaders) {
      throw new Error("headers() called outside a request scope");
    }
    return state.currentHeaders;
  },
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));

vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: async () => state.session,
    },
  },
  ensureGoogleAvatarSync: async () => false,
  ensureInitialAdminBootstrap: async () => false,
  ensureDefaultOrganizationMembership: async () => false,
  ensureAssistantBootstrap: async () => undefined,
}));

vi.mock("@/lib/better-auth-db", () => ({
  betterAuthDb: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) },
  betterAuthMembers: {},
  betterAuthUsers: {},
  betterAuthSessions: {},
  readTeamsForUser: async () => [],
  readProjectGrantsForUser: async () => [],
}));

import { requireAuthSession, signInRedirectTarget } from "@/lib/auth-session";
import { CURRENT_PATH_HEADER } from "@/lib/auth-redirect-target";

/** Begin a fresh request carrying the given forwarded current-path header (or none). */
function newRequest(currentPath?: string): void {
  const headers = new Headers();
  if (currentPath !== undefined) headers.set(CURRENT_PATH_HEADER, currentPath);
  state.currentHeaders = headers;
}

async function expectRedirect(fn: () => Promise<unknown>, destination: string) {
  await expect(fn()).rejects.toThrow(`REDIRECT:${destination}`);
}

beforeEach(() => {
  state.session = null;
  state.currentHeaders = null;
});

describe("requireAuthSession — preserves the forwarded target (cinatra#2359)", () => {
  it("redirects to /sign-in?next=<forwarded path> when no session and a path was forwarded", async () => {
    newRequest("/connectors/my-connector");
    await expectRedirect(() => requireAuthSession(), "/sign-in?next=%2Fconnectors%2Fmy-connector");
  });

  it("preserves a forwarded path that itself carries a query string", async () => {
    newRequest("/artifacts/abc-123?tab=history");
    await expectRedirect(
      () => requireAuthSession(),
      "/sign-in?next=%2Fartifacts%2Fabc-123%3Ftab%3Dhistory",
    );
  });

  it("falls back to bare /sign-in when no path was forwarded (e.g. a pre-fix edge cache)", async () => {
    newRequest(); // no CURRENT_PATH_HEADER set
    await expectRedirect(() => requireAuthSession(), "/sign-in");
  });

  it("SECURITY: falls back to bare /sign-in when the forwarded header is somehow a protocol-relative URL", async () => {
    // Defense in depth: guardAppRoute always overwrites this header with its
    // own trusted value, so this should never happen in production — but
    // requireAuthSession must not blindly trust it regardless.
    newRequest("//evil.com");
    await expectRedirect(() => requireAuthSession(), "/sign-in");
  });

  it("SECURITY: falls back to bare /sign-in when the forwarded header is an absolute URL", async () => {
    newRequest("https://evil.com");
    await expectRedirect(() => requireAuthSession(), "/sign-in");
  });

  it("SECURITY: falls back to bare /sign-in when the forwarded header carries the backslash trick", async () => {
    newRequest("/\\evil.com");
    await expectRedirect(() => requireAuthSession(), "/sign-in");
  });

  it("returns the session and does not redirect when a session exists", async () => {
    newRequest("/connectors/my-connector");
    state.session = { user: { id: "user-1" } };
    const session = await requireAuthSession();
    expect(session).toEqual({ user: { id: "user-1" } });
  });
});

describe("signInRedirectTarget — the shared helper every ad hoc gate calls", () => {
  it("resolves to /sign-in?next=<forwarded path>", async () => {
    newRequest("/agents/vendor/pkg/instance/review/task");
    expect(await signInRedirectTarget()).toBe(
      "/sign-in?next=%2Fagents%2Fvendor%2Fpkg%2Finstance%2Freview%2Ftask",
    );
  });

  it("falls back to bare /sign-in with no forwarded header", async () => {
    newRequest();
    expect(await signInRedirectTarget()).toBe("/sign-in");
  });
});
