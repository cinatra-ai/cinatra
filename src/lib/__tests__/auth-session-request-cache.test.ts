// #704 — the session double-read TOCTOU class.
//
// `getAuthSession()` is called INDEPENDENTLY by authorization and delegation
// paths inside the same request. Before this fix each call re-ran the full
// better-auth round-trip, so two reads in one request could observe two
// DIFFERENT sessions when a concurrent org-switch (or sign-out) landed between
// them. The fix memoizes the snapshot per request, keyed on the request's
// headers object.
//
// Mechanism under test: `getAuthSession()` keys a module-level WeakMap on the
// object returned by `await headers()`. `next/headers` hands back the SAME
// sealed headers instance for the whole request store (in Route Handlers,
// Server Components, and Server Actions alike), so within one request every
// call site shares ONE snapshot — the identical object reference — while a new
// request carries a new headers object and therefore observes fresh state.
// (React `cache()` was rejected because it only memoizes inside the RSC render
// tree; Route Handlers such as the `/api/mcp` getSession path run outside that
// dispatcher and would keep double-reading.)
//
// The mock models exactly that request-stable identity: `headers()` returns the
// SAME `state.currentHeaders` object until a test starts a "new request", and
// throws when no request is active (the background/off-request failure mode).

import { describe, it, expect, vi, beforeEach } from "vitest";

type Session = {
  user: { id: string; image?: string; role?: string };
  session: { activeOrganizationId: string };
};

const state = vi.hoisted(() => ({
  session: null as null | Record<string, unknown>,
  getSessionCalls: 0,
  // The request-stable headers object, or null = no request active (background).
  currentHeaders: null as null | object,
}));

vi.mock("next/headers", () => ({
  headers: async () => {
    if (!state.currentHeaders) {
      // Mirrors Next's behavior when headers() is reached with no request store
      // — the pre-existing failure mode for background callers.
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

// Break the heavy better-auth boot graph and hand back a controllable session.
// getSession increments a counter so we can prove the round-trip is deduped.
vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: async () => {
        state.getSessionCalls++;
        return state.session;
      },
    },
  },
  ensureGoogleAvatarSync: async () => false,
  ensureInitialAdminBootstrap: async () => false,
  ensureDefaultOrganizationMembership: async () => false,
  ensureAssistantBootstrap: async () => undefined,
}));

// getAuthSession() touches none of these, but the module imports them at load
// time — stub to trivial shapes so the module graph resolves without the real
// DB layer.
vi.mock("@/lib/better-auth-db", () => ({
  betterAuthDb: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) },
  betterAuthMembers: {},
  betterAuthUsers: {},
  betterAuthSessions: {},
  readTeamsForUser: async () => [],
  readProjectGrantsForUser: async () => [],
}));

import { getAuthSession } from "@/lib/auth-session";

/** Begin a fresh request: install a new request-stable headers object. */
function newRequest(): void {
  state.currentHeaders = new Headers();
}

/** Enter the background / off-request state: headers() will throw. */
function noRequest(): void {
  state.currentHeaders = null;
}

function fastPathSession(orgId: string): Session {
  // avatar + non-"user" role + active org all present → the enrichment /
  // re-get branch is skipped, so a snapshot is exactly ONE getSession call.
  return {
    user: { id: "user-1", image: "https://example.test/a.png", role: "admin" },
    session: { activeOrganizationId: orgId },
  };
}

beforeEach(() => {
  state.session = null;
  state.getSessionCalls = 0;
  state.currentHeaders = null;
});

describe("#704 getAuthSession per-request snapshot (double-read TOCTOU)", () => {
  it("returns the IDENTICAL snapshot for two reads in one request, even when a concurrent org-switch lands between them", async () => {
    newRequest();
    state.session = fastPathSession("org-A") as unknown as Record<string, unknown>;

    const first = await getAuthSession();
    // Simulate a concurrent org-switch (or sign-out) landing between the two
    // independent reads: mutate the underlying session source.
    state.session = fastPathSession("org-B") as unknown as Record<string, unknown>;
    const second = await getAuthSession();

    // Identity, not just equality — both reads share ONE object reference.
    expect(first).toBe(second);
    // The org-switch that landed mid-request did NOT leak into the second read.
    expect((second as unknown as Session).session.activeOrganizationId).toBe("org-A");
    // The better-auth round-trip ran exactly once for the whole request.
    expect(state.getSessionCalls).toBe(1);
  });

  it("deduplicates CONCURRENT in-flight reads to one snapshot (the TOCTOU race itself)", async () => {
    newRequest();
    state.session = fastPathSession("org-A") as unknown as Record<string, unknown>;

    // Two reads fire before the first resolves — authorization and delegation
    // racing. They must resolve to the identical snapshot from ONE round-trip.
    const [a, b] = await Promise.all([getAuthSession(), getAuthSession()]);

    expect(a).toBe(b);
    expect(state.getSessionCalls).toBe(1);
  });

  it("observes FRESH state in a NEW request (memo is per-request, not process-global)", async () => {
    newRequest();
    state.session = fastPathSession("org-A") as unknown as Record<string, unknown>;
    const readA = await getAuthSession();

    newRequest(); // new request store → new headers object → new memo key
    state.session = fastPathSession("org-B") as unknown as Record<string, unknown>;
    const readB = await getAuthSession();

    expect((readA as unknown as Session).session.activeOrganizationId).toBe("org-A");
    expect((readB as unknown as Session).session.activeOrganizationId).toBe("org-B");
    // A new request is a new snapshot — never the memoized prior-request object.
    expect(readA).not.toBe(readB);
    // One round-trip per request.
    expect(state.getSessionCalls).toBe(2);
  });

  it("a background caller wrapping getAuthSession() in .catch() still resolves when headers() throws off-request", async () => {
    // The real non-request failure mode: headers() throws with no request store.
    // getAuthSession() throws BEFORE touching the memo (no leak), and the throw
    // stays catchable — email-system.ts / notifications.ts rely on catching it.
    noRequest();
    state.session = fastPathSession("org-A") as unknown as Record<string, unknown>;

    const result = await getAuthSession().catch(() => null);
    expect(result).toBeNull();
    // No round-trip attempted without a request store.
    expect(state.getSessionCalls).toBe(0);
  });
});
