import { describe, it, expect } from "vitest";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { buildCinatraOrganizationPlugin } from "../better-auth-plugins";
import {
  buildBeforeCreateTeamEnsureSlug,
  ensureUniqueTeamSlug,
} from "../better-auth-org-hooks";

// ---------------------------------------------------------------------------
// cinatra#1494 regression: creating an organization with teams enabled AND a
// required `team.slug` must succeed. Better Auth's create-organization path
// creates a DEFAULT team supplying only { name, organizationId } — no slug —
// so `public.team.slug` (NOT NULL, CHECK-constrained, unique per org) trips
// `null value in column "slug" ... violates not-null constraint`, 500s the
// request, and leaves a partially-created org. The
// `organizationHooks.beforeCreateTeam` hook (src/lib/better-auth-org-hooks.ts,
// wired in src/lib/auth.ts, threaded through the shared factory in
// src/lib/better-auth-plugins.ts) supplies a CHECK-conforming, unique-per-org
// slug — and is strictly FILL-ONLY-WHEN-ABSENT, because the hook is
// plugin-wide (it also fires on the public create-team endpoint) and both
// routes spread the hook's returned data AFTER the caller's teamData, i.e. a
// returned slug would OVERRIDE a caller-supplied one.
//
// The in-memory adapter has no NOT NULL / CHECK enforcement (that's Postgres'
// job — which is exactly why the missing slug reached the DB), so the
// integration tests assert on the ROW the routes write: with the hook the
// default team carries a valid slug; without it the slug is absent (the
// pre-fix state Postgres rejected); an explicit create-team slug is preserved
// byte-exactly.
// ---------------------------------------------------------------------------

// Mirrors the live `public.team.slug` CHECK constraint (see
// src/app/teams/new/team-slug.ts / better-auth-db.ts).
const TEAM_SLUG_CHECK = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

type TeamRow = { name?: string; slug?: string | null; organizationId?: string };
type MemberRow = { userId?: string; role?: string; organizationId?: string };
type TeamMemberRow = { userId?: string; teamId?: string };

// The in-memory adapter throws "Model <x> not found" unless the model's array
// exists, so seed every model the emailAndPassword + organization(teams)
// surface touches.
function makeDb(): Record<string, unknown[]> {
  return {
    user: [],
    account: [],
    session: [],
    verification: [],
    organization: [],
    member: [],
    invitation: [],
    team: [],
    teamMember: [],
  };
}

// Hook wired to read taken slugs from the SAME memory db the adapter writes,
// mirroring how the runtime default dep reads public.team via drizzle.
function makeHook(db: Record<string, unknown[]>) {
  return buildBeforeCreateTeamEnsureSlug({
    listTeamSlugsForOrg: async (organizationId) =>
      (db.team as TeamRow[])
        .filter((t) => t.organizationId === organizationId)
        .map((t) => String(t.slug ?? ""))
        .filter(Boolean),
  });
}

function makeAuth(db: Record<string, unknown[]>, withHook: boolean) {
  return betterAuth({
    appName: "Cinatra",
    secret: "test-secret-cinatra-1494-abcdefghijklmnop",
    emailAndPassword: { enabled: true },
    database: memoryAdapter(db),
    plugins: [
      buildCinatraOrganizationPlugin(
        withHook
          ? { organizationHooks: { beforeCreateTeam: makeHook(db) } }
          : {},
      ),
    ],
  });
}

async function seedOwner(auth: ReturnType<typeof makeAuth>): Promise<string> {
  const res = await auth.api.signUpEmail({
    body: {
      email: `owner-${crypto.randomUUID()}@example.test`,
      password: "correct-horse-battery-staple",
      name: "Org Owner",
    },
  });
  return res.user.id;
}

// Hook with an injectable taken-slug set for pure unit tests.
function hookWithTaken(taken: string[] = []) {
  return buildBeforeCreateTeamEnsureSlug({
    listTeamSlugsForOrg: async () => taken,
  });
}

describe("beforeCreateTeamEnsureSlug (unit)", () => {
  it("preserves a caller-supplied slug (fill-only-when-absent: returns undefined)", async () => {
    // Both crud routes only merge when the response has a "data" key, so a
    // void return is the verified leave-untouched shape.
    const out = await hookWithTaken(["default"])({
      team: { name: "Growth", organizationId: "org_1", slug: "my-explicit" },
      organization: { id: "org_1", name: "Acme Corp", slug: "acme-corp" },
    } as never);
    expect(out).toBeUndefined();
  });

  it("derives the slug primarily from the team name", async () => {
    const out = (await hookWithTaken()({
      team: { name: "Acme Corp", organizationId: "org_1" },
      organization: { id: "org_1", name: "Acme Corp", slug: "different-org" },
    } as never)) as { data: { slug: string } };
    expect(out.data.slug).toBe("acme-corp");
    expect(out.data.slug).toMatch(TEAM_SLUG_CHECK);
  });

  it("falls back to the org slug when the name yields no base", async () => {
    const out = (await hookWithTaken()({
      team: { name: "!!!", organizationId: "org_1" },
      organization: { id: "org_1", name: "!!!", slug: "acme-corp" },
    } as never)) as { data: { slug: string } };
    expect(out.data.slug).toBe("acme-corp");
    expect(out.data.slug).toMatch(TEAM_SLUG_CHECK);
  });

  it("falls back to 'team' when name AND org slug yield no base", async () => {
    const out = (await hookWithTaken()({
      team: { name: "!!!", organizationId: "org_1" },
      organization: { id: "org_1", name: "!!!", slug: "" },
    } as never)) as { data: { slug: string } };
    expect(out.data.slug).toBe("team");
    expect(out.data.slug).toMatch(TEAM_SLUG_CHECK);
  });

  it("disambiguates against the org's taken slugs with a -2/-3 suffix", async () => {
    const hook = hookWithTaken(["acme-corp", "acme-corp-2"]);
    const out = (await hook({
      team: { name: "Acme Corp", organizationId: "org_1" },
      organization: { id: "org_1", name: "Acme Corp", slug: "acme-corp" },
    } as never)) as { data: { slug: string } };
    expect(out.data.slug).toBe("acme-corp-3");
    expect(out.data.slug).toMatch(TEAM_SLUG_CHECK);
  });
});

describe("ensureUniqueTeamSlug (unit)", () => {
  it("returns the base untouched when free", () => {
    expect(ensureUniqueTeamSlug("alpha", new Set())).toBe("alpha");
  });

  it("appends the first free numeric suffix", () => {
    expect(ensureUniqueTeamSlug("alpha", new Set(["alpha"]))).toBe("alpha-2");
    expect(
      ensureUniqueTeamSlug("alpha", new Set(["alpha", "alpha-2", "alpha-3"])),
    ).toBe("alpha-4");
  });

  it("keeps suffixed candidates within the 63-char CHECK ceiling", () => {
    const base = "a".repeat(57); // toTeamSlugBase's max base length
    const out = ensureUniqueTeamSlug(base, new Set([base]));
    expect(out.length).toBeLessThanOrEqual(63);
    expect(out).toMatch(TEAM_SLUG_CHECK);
    expect(out.endsWith("-2")).toBe(true);
  });
});

describe("organization creation with teams enabled + required team.slug", () => {
  it("creates the default team WITH a slug (cinatra#1494)", async () => {
    const db = makeDb();
    const auth = makeAuth(db, true);
    const userId = await seedOwner(auth);

    const org = await auth.api.createOrganization({
      body: { name: "Acme Corp", slug: "acme-corp", userId },
    });
    expect(org).toBeTruthy();

    const teams = (db.team ?? []) as TeamRow[];
    expect(teams).toHaveLength(1);
    expect(teams[0].slug).toBe("acme-corp");
    expect(teams[0].slug ?? "").toMatch(TEAM_SLUG_CHECK);

    // The whole org create committed consistently: org + owner member +
    // default team + team membership all present (no partial write).
    expect((db.organization ?? []) as unknown[]).toHaveLength(1);
    const members = (db.member ?? []) as MemberRow[];
    expect(
      members.some((m) => m.userId === userId && m.role === "owner"),
    ).toBe(true);
    const teamMembers = (db.teamMember ?? []) as TeamMemberRow[];
    expect(teamMembers.some((m) => m.userId === userId)).toBe(true);
  });

  it("without the hook the default team row carries no slug (pre-fix NOT NULL violation)", async () => {
    const db = makeDb();
    const auth = makeAuth(db, false);
    const userId = await seedOwner(auth);

    await auth.api.createOrganization({
      body: { name: "Beta Inc", slug: "beta-inc", userId },
    });

    const teams = (db.team ?? []) as TeamRow[];
    expect(teams).toHaveLength(1);
    // Absent slug — the exact value Postgres rejected with
    // `null value in column "slug" ... violates not-null constraint`.
    expect(teams[0].slug ?? null).toBeNull();
  });

  it("preserves an explicit slug on a second team created via createTeam", async () => {
    const db = makeDb();
    const auth = makeAuth(db, true);
    const userId = await seedOwner(auth);
    const org = await auth.api.createOrganization({
      body: { name: "Acme Corp", slug: "acme-corp", userId },
    });

    // Server-side create-team WITH an explicit slug. The hook fires on this
    // route too, and its returned data would OVERRIDE the body slug (both
    // routes spread hook data last) — fill-only-when-absent must leave it.
    const created = await auth.api.createTeam({
      body: {
        name: "Growth",
        organizationId: org!.id,
        slug: "growth-squad",
      },
    });
    expect(created).toBeTruthy();

    const teams = (db.team ?? []) as TeamRow[];
    expect(teams).toHaveLength(2);
    const second = teams.find((t) => t.name === "Growth");
    expect(second?.slug).toBe("growth-squad");
    // The default team's slug is untouched and distinct.
    const first = teams.find((t) => t.name === "Acme Corp");
    expect(first?.slug).toBe("acme-corp");
  });

  it("rejects a slugless createTeam at body validation (before insert)", async () => {
    // team.slug is a REQUIRED additionalField, so better-auth's zod body
    // schema on /organization/create-team requires it (toZodSchema only
    // relaxes required:false fields). A slugless call therefore never reaches
    // the hook/adapter — the same-derived-slug collision scenario is
    // unreachable via the public API; the hook's uniqueness handling is
    // defense-in-depth for internal callers (covered by the unit tests above).
    const db = makeDb();
    const auth = makeAuth(db, true);
    const userId = await seedOwner(auth);
    const org = await auth.api.createOrganization({
      body: { name: "Acme Corp", slug: "acme-corp", userId },
    });

    await expect(
      auth.api.createTeam({
        body: { name: "Growth", organizationId: org!.id } as never,
      }),
    ).rejects.toThrow();

    // No partial write: still only the default team.
    expect((db.team ?? []) as TeamRow[]).toHaveLength(1);
  });
});
