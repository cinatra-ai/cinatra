// cinatra#408 — the OBO actor resolver's platform-admin SUPPRESSION for the
// public-site widget path, plus the load-bearing END-TO-END actor assertion
// (design test #13a): for a `public_site_widget` carrier run the actor handed
// to the MCP boundary / token mint is NEVER `platform_admin`, only `member`
// (or null). Resolver-only suppression (codex-converged O2) means the boundary's
// platform-admin immediate-allow is never reached for this path.
//
// The drizzle chain `betterAuthDb.select().from(<table>).where().limit()` is
// stubbed: the FIRST query reads betterAuthUsers (role row), the SECOND reads
// betterAuthMembers (membership row). We discriminate by the table passed to
// `from()` so a single resolver call drives both reads deterministically.

import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted; share the table sentinels + mutable fixture holder via
// vi.hoisted so the factory can reference them without a TDZ error.
const { USERS, MEMBERS, fixtures } = vi.hoisted(() => ({
  USERS: { id: "users.id", role: "users.role" } as const,
  MEMBERS: {
    id: "members.id",
    userId: "members.userId",
    organizationId: "members.organizationId",
  } as const,
  fixtures: {
    userRow: undefined as { id: string; role: string | null } | undefined,
    memberRow: undefined as { id: string } | undefined,
  },
}));

vi.mock("@/lib/better-auth-db", () => ({
  betterAuthDb: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: () =>
            Promise.resolve(
              table === USERS
                ? fixtures.userRow
                  ? [fixtures.userRow]
                  : []
                : fixtures.memberRow
                  ? [fixtures.memberRow]
                  : [],
            ),
        }),
      }),
    }),
  },
  betterAuthUsers: USERS,
  betterAuthMembers: MEMBERS,
}));

import { resolveAgentRunMcpActor } from "@/lib/agent-run-actor-resolve";

const TRIPLE = { runId: "run_1", runBy: "u_1", orgId: "org_1" };

// Convenience accessors so the test bodies stay readable.
function setUser(row: { id: string; role: string | null } | undefined): void {
  fixtures.userRow = row;
}
function setMember(row: { id: string } | undefined): void {
  fixtures.memberRow = row;
}

beforeEach(() => {
  fixtures.userRow = undefined;
  fixtures.memberRow = undefined;
});

describe("resolveAgentRunMcpActor — platform-admin (default path, unchanged)", () => {
  it("returns platform_admin for an admin user regardless of membership (no sourceType)", async () => {
    setUser({ id: "u_1", role: "admin" });
    setMember(undefined); // not a member
    const actor = await resolveAgentRunMcpActor(TRIPLE);
    expect(actor?.platformRole).toBe("platform_admin");
  });

  it("returns platform_admin for an admin user on a NON-widget sourceType", async () => {
    setUser({ id: "u_1", role: "admin" });
    const actor = await resolveAgentRunMcpActor({ ...TRIPLE, sourceType: "content_editor_dispatch" });
    expect(actor?.platformRole).toBe("platform_admin");
  });

  it("returns member for a non-admin member", async () => {
    setUser({ id: "u_1", role: "user" });
    setMember({ id: "m_1" });
    const actor = await resolveAgentRunMcpActor(TRIPLE);
    expect(actor?.platformRole).toBe("member");
  });

  it("returns null for a non-admin non-member (boundary denies, never elevates)", async () => {
    setUser({ id: "u_1", role: "user" });
    setMember(undefined);
    const actor = await resolveAgentRunMcpActor(TRIPLE);
    expect(actor).toBeNull();
  });
});

describe("resolveAgentRunMcpActor — public_site_widget suppression (cinatra#408)", () => {
  it("SUPPRESSES platform_admin for an admin user on the widget path → resolves member (if a member)", async () => {
    setUser({ id: "u_1", role: "admin" }); // platform admin...
    setMember({ id: "m_1" }); // ...who IS also an org member
    const actor = await resolveAgentRunMcpActor({ ...TRIPLE, sourceType: "public_site_widget" });
    // The admin short-circuit is suppressed; they resolve as a plain member,
    // gated by per-user rights downstream (#409) — NOT platform_admin.
    expect(actor?.platformRole).toBe("member");
    expect(actor?.platformRole).not.toBe("platform_admin");
  });

  it("an admin who is NOT an org member resolves to null on the widget path (denied, no bypass)", async () => {
    setUser({ id: "u_1", role: "admin" });
    setMember(undefined); // not a member of this org
    const actor = await resolveAgentRunMcpActor({ ...TRIPLE, sourceType: "public_site_widget" });
    expect(actor).toBeNull();
  });

  it("a comma-roled admin (e.g. 'user,admin') is ALSO suppressed on the widget path", async () => {
    setUser({ id: "u_1", role: "user,admin" });
    setMember({ id: "m_1" });
    const actor = await resolveAgentRunMcpActor({ ...TRIPLE, sourceType: "public_site_widget" });
    expect(actor?.platformRole).toBe("member");
  });

  // ---- design test #13a — the LOAD-BEARING end-to-end actor assertion --------
  it("(#13a) the actor object reaching the MCP boundary is NOT platform_admin for a public_site_widget run", async () => {
    setUser({ id: "u_1", role: "admin" });
    setMember({ id: "m_1" });
    const actor = await resolveAgentRunMcpActor({ ...TRIPLE, sourceType: "public_site_widget" });
    // This is the exact object handed to buildLlmMcpServerToolForAgentRun →
    // enforceMcpBoundary. Asserting on the ACTOR (not merely "resolver returned
    // member") proves the boundary's platform-admin immediate-allow
    // (mcp-boundary.ts:207) is never reached for this path.
    expect(actor).not.toBeNull();
    expect(actor!.platformRole).not.toBe("platform_admin");
    expect(actor!.userId).toBe("u_1");
    expect(actor!.delegation).toBe("agent_run");
  });
});
