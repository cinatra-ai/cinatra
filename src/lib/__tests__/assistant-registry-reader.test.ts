// Unit tests for the assistant registry reader's PURE pieces (cinatra#1874 W1
// item 6): the audience matcher + the four-seam audience-context resolver. The
// DB join + live audience filtering + bare-name fallback are proven against real
// Postgres in `integration/assistant-registry-reader.integration.test.ts` (AC#5).

import { describe, it, expect, vi } from "vitest";
import {
  matchesAssistantAudience,
  resolveAssistantAudienceContext,
  isBuiltinAssistantByPackage,
  type AssistantAudienceContext,
  type AssistantAudienceContextDeps,
} from "@/lib/assistant-registry-reader";

function ctx(over: Partial<AssistantAudienceContext> = {}): AssistantAudienceContext {
  return {
    userId: "u1",
    isPlatformAdmin: false,
    orgIds: new Set(),
    teamIds: new Set(),
    projectIds: new Set(),
    ...over,
  };
}

describe("matchesAssistantAudience — subject-kind semantics", () => {
  it("workspace is the universal grant (visible to any actor)", () => {
    expect(matchesAssistantAudience([{ subjectKind: "workspace", subjectId: null }], ctx())).toBe(true);
  });

  it("admin requires platform admin", () => {
    const grants = [{ subjectKind: "admin", subjectId: null }];
    expect(matchesAssistantAudience(grants, ctx({ isPlatformAdmin: false }))).toBe(false);
    expect(matchesAssistantAudience(grants, ctx({ isPlatformAdmin: true }))).toBe(true);
  });

  it("organization requires the subject org in the actor's org set", () => {
    const grants = [{ subjectKind: "organization", subjectId: "org-A" }];
    expect(matchesAssistantAudience(grants, ctx({ orgIds: new Set(["org-B"]) }))).toBe(false);
    expect(matchesAssistantAudience(grants, ctx({ orgIds: new Set(["org-A"]) }))).toBe(true);
  });

  it("team requires the subject team in the actor's team set", () => {
    const grants = [{ subjectKind: "team", subjectId: "team-A" }];
    expect(matchesAssistantAudience(grants, ctx({ teamIds: new Set(["team-X"]) }))).toBe(false);
    expect(matchesAssistantAudience(grants, ctx({ teamIds: new Set(["team-A"]) }))).toBe(true);
  });

  it("project requires the subject project in the actor's project grant set", () => {
    const grants = [{ subjectKind: "project", subjectId: "proj-A" }];
    expect(matchesAssistantAudience(grants, ctx({ projectIds: new Set(["proj-Z"]) }))).toBe(false);
    expect(matchesAssistantAudience(grants, ctx({ projectIds: new Set(["proj-A"]) }))).toBe(true);
  });

  it("no grant rows → invisible (fail-closed); unknown kind never grants", () => {
    expect(matchesAssistantAudience([], ctx({ isPlatformAdmin: true }))).toBe(false);
    expect(
      matchesAssistantAudience([{ subjectKind: "galaxy", subjectId: "x" }], ctx({ isPlatformAdmin: true })),
    ).toBe(false);
  });

  it("any matching row among several grants is enough", () => {
    const grants = [
      { subjectKind: "admin", subjectId: null },
      { subjectKind: "team", subjectId: "team-A" },
    ];
    expect(matchesAssistantAudience(grants, ctx({ teamIds: new Set(["team-A"]) }))).toBe(true);
  });
});

describe("resolveAssistantAudienceContext — four-seam wiring", () => {
  function deps(over: Partial<AssistantAudienceContextDeps> = {}): AssistantAudienceContextDeps {
    return {
      isOrgMember: vi.fn().mockResolvedValue(true),
      readTeamsForUser: vi.fn().mockResolvedValue([{ id: "team-1" }, { id: "team-2" }]),
      readProjectGrantsForUser: vi.fn().mockResolvedValue([{ projectId: "proj-1" }]),
      ...over,
    };
  }

  it("member of the active org: org/team/project seams all populate", async () => {
    const d = deps();
    const out = await resolveAssistantAudienceContext(
      { userId: "u1", activeOrgId: "org-A", isPlatformAdmin: false },
      d,
    );
    expect(out.orgIds).toEqual(new Set(["org-A"]));
    expect(out.teamIds).toEqual(new Set(["team-1", "team-2"]));
    expect(out.projectIds).toEqual(new Set(["proj-1"]));
    expect(d.readTeamsForUser).toHaveBeenCalledWith("u1", "org-A");
    // project grants are hinted with the resolved team ids.
    expect(d.readProjectGrantsForUser).toHaveBeenCalledWith("u1", "org-A", {
      teamIds: ["team-1", "team-2"],
    });
  });

  it("isPlatformAdmin passes straight through", async () => {
    const out = await resolveAssistantAudienceContext(
      { userId: "u1", activeOrgId: "org-A", isPlatformAdmin: true },
      deps(),
    );
    expect(out.isPlatformAdmin).toBe(true);
  });

  it("no active org → empty membership sets, no seam queries", async () => {
    const d = deps();
    const out = await resolveAssistantAudienceContext(
      { userId: "u1", activeOrgId: null, isPlatformAdmin: false },
      d,
    );
    expect(out.orgIds.size).toBe(0);
    expect(out.teamIds.size).toBe(0);
    expect(out.projectIds.size).toBe(0);
    expect(d.isOrgMember).not.toHaveBeenCalled();
    expect(d.readTeamsForUser).not.toHaveBeenCalled();
    expect(d.readProjectGrantsForUser).not.toHaveBeenCalled();
  });

  it("stale active org (not a current member) → no team/project widening", async () => {
    const d = deps({ isOrgMember: vi.fn().mockResolvedValue(false) });
    const out = await resolveAssistantAudienceContext(
      { userId: "u1", activeOrgId: "org-STALE", isPlatformAdmin: false },
      d,
    );
    expect(out.orgIds.size).toBe(0);
    expect(out.teamIds.size).toBe(0);
    expect(out.projectIds.size).toBe(0);
    expect(d.readTeamsForUser).not.toHaveBeenCalled();
    expect(d.readProjectGrantsForUser).not.toHaveBeenCalled();
  });
});

describe("isBuiltinAssistantByPackage — first-party built-in recognition (cinatra#2031)", () => {
  // Minimal fake of the drizzle read chain used by the reader:
  // db.select({...}).from(t).where(c).limit(1) → Promise<rows>.
  function fakeDb(rows: Array<{ id: string }>) {
    const where = vi.fn();
    const chain = {
      select: () => chain,
      from: () => chain,
      where: (...a: unknown[]) => {
        where(...a);
        return chain;
      },
      limit: () => Promise.resolve(rows),
    };
    return { db: chain as unknown as Parameters<typeof isBuiltinAssistantByPackage>[2], whereSpy: where };
  }

  it("true when an agent_kind='assistant' template links the principal to the reserved package", async () => {
    const { db } = fakeDb([{ id: "tmpl-1" }]);
    await expect(
      isBuiltinAssistantByPackage("wp-principal", "@cinatra-ai/wordpress-assistant", db),
    ).resolves.toBe(true);
  });

  it("false when no matching template row exists (installed / unknown principal)", async () => {
    const { db } = fakeDb([]);
    await expect(
      isBuiltinAssistantByPackage("installed-principal", "@cinatra-ai/wordpress-assistant", db),
    ).resolves.toBe(false);
  });

  it("fails closed for an empty principal id or package (no query issued)", async () => {
    const { db, whereSpy } = fakeDb([{ id: "tmpl-1" }]);
    await expect(isBuiltinAssistantByPackage("", "@cinatra-ai/wordpress-assistant", db)).resolves.toBe(false);
    await expect(isBuiltinAssistantByPackage("wp-principal", "", db)).resolves.toBe(false);
    expect(whereSpy).not.toHaveBeenCalled();
  });
});
