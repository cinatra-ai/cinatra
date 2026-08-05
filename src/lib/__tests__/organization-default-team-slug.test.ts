import { describe, it, expect } from "vitest";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { buildCinatraOrganizationPlugin } from "../better-auth-plugins";
import {
  buildBeforeCreateTeamEnsureSlug,
  ensureUniqueTeamSlug,
} from "../better-auth-org-hooks";

// ---------------------------------------------------------------------------
// cinatra#2461: creating an organization must create NO team. Better Auth's
// create-organization route auto-creates a same-name default team whenever
// `teams.enabled` is on and `teams.defaultTeam.enabled` is not explicitly
// false (upstream gates on `!== false`, so omission means ON) — a phantom
// "default" team the user never asked for. `cinatraOrganizationOptions` now
// pins `defaultTeam: { enabled: false }`; the integration tests below create
// real orgs through the plugin against the in-memory adapter and assert the
// team/teamMember tables stay EMPTY while the org + owner member commit
// consistently.
//
// cinatra#1494 context (the hook these tests also cover): public.team.slug is
// NOT NULL + CHECK-constrained, and the auto-created default team used to
// arrive slug-less and 500 the request — the
// `organizationHooks.beforeCreateTeam` hook (src/lib/better-auth-org-hooks.ts,
// wired in src/lib/auth.ts, threaded through the shared factory in
// src/lib/better-auth-plugins.ts) supplies a CHECK-conforming, unique-per-org
// slug. With the default team gone, org creation no longer exercises the
// hook; it stays wired as defense-in-depth for create-team callers, and it is
// strictly FILL-ONLY-WHEN-ABSENT because the routes spread the hook's
// returned data AFTER the caller's teamData (a returned slug would OVERRIDE a
// caller-supplied one). The unit suites below pin that contract; the
// integration suite asserts on the ROWS the routes write (the in-memory
// adapter has no NOT NULL / CHECK enforcement — that's Postgres' job).
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

describe("organization creation with teams enabled + defaultTeam disabled", () => {
  it("creates NO team on org creation — org + owner member commit consistently (cinatra#2461)", async () => {
    const db = makeDb();
    const auth = makeAuth(db, true);
    const userId = await seedOwner(auth);

    const org = await auth.api.createOrganization({
      body: { name: "Acme Corp", slug: "acme-corp", userId },
    });
    expect(org).toBeTruthy();

    // The #2461 regression: zero team rows, zero team memberships — a team
    // exists only when a user explicitly creates one.
    expect((db.team ?? []) as TeamRow[]).toHaveLength(0);
    expect((db.teamMember ?? []) as TeamMemberRow[]).toHaveLength(0);

    // The org create still committed consistently: org + owner member
    // present (no 500, no partial write) with the default team disabled.
    expect((db.organization ?? []) as unknown[]).toHaveLength(1);
    const members = (db.member ?? []) as MemberRow[];
    expect(
      members.some((m) => m.userId === userId && m.role === "owner"),
    ).toBe(true);
  });

  it("creates NO team regardless of the slug hook being wired (the gate is config, not the hook)", async () => {
    const db = makeDb();
    const auth = makeAuth(db, false);
    const userId = await seedOwner(auth);

    await auth.api.createOrganization({
      body: { name: "Beta Inc", slug: "beta-inc", userId },
    });

    expect((db.team ?? []) as TeamRow[]).toHaveLength(0);
    expect((db.organization ?? []) as unknown[]).toHaveLength(1);
  });

  it("preserves an explicit slug on a team created via createTeam (the org's FIRST team)", async () => {
    const db = makeDb();
    const auth = makeAuth(db, true);
    const userId = await seedOwner(auth);
    const org = await auth.api.createOrganization({
      body: { name: "Acme Corp", slug: "acme-corp", userId },
    });

    // Server-side create-team WITH an explicit slug. The hook fires on this
    // route, and its returned data would OVERRIDE the body slug (the route
    // spreads hook data last) — fill-only-when-absent must leave it.
    const created = await auth.api.createTeam({
      body: {
        name: "Growth",
        organizationId: org!.id,
        slug: "growth-squad",
      },
    });
    expect(created).toBeTruthy();

    // Exactly the one explicitly-created team — no auto-created sibling.
    const teams = (db.team ?? []) as TeamRow[];
    expect(teams).toHaveLength(1);
    expect(teams[0].name).toBe("Growth");
    expect(teams[0].slug).toBe("growth-squad");
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

    // No partial write: still zero teams (none auto-created, none from the
    // rejected call).
    expect((db.team ?? []) as TeamRow[]).toHaveLength(0);
  });
});
