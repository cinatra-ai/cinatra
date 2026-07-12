import { describe, it, expect, vi, beforeEach } from "vitest";

// Fail-closed proof for the rollback ORCHESTRATOR (cinatra#1362). The DB
// primitives + SQL shape are proven mock-free in skill-lifecycle-store.test.ts;
// here we mock the DB + authz + hook seams to prove the orchestrator's
// authorization / concurrency / integrity GATING with no database.

const db = vi.hoisted(() => ({
  readSkillCatalogFromDatabase: vi.fn(),
  readSkillActiveRevisionFromDatabase: vi.fn(),
  readSkillRevisionContentForRollback: vi.fn(),
  applySkillRollbackInDatabase: vi.fn(),
  // unused-by-rollback exports skills-store also imports from @/lib/database:
  replaceSkillCatalogInDatabase: vi.fn(),
  readConnectorConfigFromDatabase: vi.fn(),
  writeConnectorConfigToDatabase: vi.fn(),
  getPostgresConnectionString: () => "postgres://test",
  postgresSchema: "cinatra",
}));
vi.mock("@/lib/database", () => db);

const { requireResourceAccess, buildSkillResourceRef } = vi.hoisted(() => ({
  requireResourceAccess: vi.fn(),
  buildSkillResourceRef: vi.fn((x: unknown) => x),
}));
vi.mock("@cinatra-ai/agents/auth-policy", () => ({ requireResourceAccess, buildSkillResourceRef }));

const { enqueueInlineForSkill } = vi.hoisted(() => ({ enqueueInlineForSkill: vi.fn(async () => undefined) }));
vi.mock("./llm-matching/event-hooks", () => ({ enqueueInlineForSkill }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { rollbackCustomSkill } from "./rollback";

const ACTOR = { principalId: "u1", principalType: "user" } as never;
const CUSTOM_SKILL = {
  id: "s1",
  name: "My Skill",
  packageId: "custom:personal-skills",
  packageName: "Custom Skills",
  packageSlug: "custom-skills",
  level: "personal",
  scope: "u1",
  isCustomSkill: true,
  ownerUserId: "u1",
  content: "current body",
  // no sourcePath → disk re-projection is skipped (best-effort; not under test)
};

beforeEach(() => {
  vi.clearAllMocks();
  db.readSkillCatalogFromDatabase.mockReturnValue({ skills: [CUSTOM_SKILL], skillPackages: [] });
  db.readSkillActiveRevisionFromDatabase.mockReturnValue({ activeRevisionId: "head0", contentDigest: "shaHead", content: "current body" });
  db.readSkillRevisionContentForRollback.mockReturnValue({ revisionId: "revPrior", contentDigest: "shaPrior", content: "prior body" });
  db.applySkillRollbackInDatabase.mockReturnValue({ changed: true });
  requireResourceAccess.mockReturnValue(undefined); // allow by default
});

describe("rollbackCustomSkill — authorization (trusted, fail-closed)", () => {
  it("denies without touching the write path when requireResourceAccess throws", async () => {
    requireResourceAccess.mockImplementation(() => { throw new Error("AuthzError: forbidden"); });
    await expect(rollbackCustomSkill({ skillId: "s1", targetRevisionId: "revPrior", actor: ACTOR })).rejects.toThrow(/forbidden/);
    expect(db.applySkillRollbackInDatabase).not.toHaveBeenCalled();
  });

  it("authorizes 'manage' derived from the PERSISTED skill (level/scope), not a caller flag", async () => {
    await rollbackCustomSkill({ skillId: "s1", targetRevisionId: "revPrior", actor: ACTOR });
    expect(buildSkillResourceRef).toHaveBeenCalledWith(expect.objectContaining({ id: "s1", level: "personal", scope: "u1" }));
    expect(requireResourceAccess).toHaveBeenCalledWith(ACTOR, expect.anything(), "manage");
  });

  it("rejects a skill that is not custom/personal before authz or any write", async () => {
    db.readSkillCatalogFromDatabase.mockReturnValue({ skills: [{ id: "s1", packageId: "github:acme/x", content: "x" }], skillPackages: [] });
    await expect(rollbackCustomSkill({ skillId: "s1", targetRevisionId: "r", actor: ACTOR })).rejects.toThrow(/not a custom\/personal skill/);
    expect(db.applySkillRollbackInDatabase).not.toHaveBeenCalled();
  });
});

describe("rollbackCustomSkill — content authority (fail-closed)", () => {
  it("rejects a target revision that does not belong to the skill", async () => {
    db.readSkillRevisionContentForRollback.mockReturnValue(null);
    await expect(rollbackCustomSkill({ skillId: "s1", targetRevisionId: "foreign", actor: ACTOR })).rejects.toThrow(/does not belong/);
    expect(db.applySkillRollbackInDatabase).not.toHaveBeenCalled();
  });

  it("rejects a target with no durable content blob (never restores unverifiable content)", async () => {
    db.readSkillRevisionContentForRollback.mockReturnValue({ revisionId: "revPrior", contentDigest: "shaPrior", content: null });
    await expect(rollbackCustomSkill({ skillId: "s1", targetRevisionId: "revPrior", actor: ACTOR })).rejects.toThrow(/no durable content/);
    expect(db.applySkillRollbackInDatabase).not.toHaveBeenCalled();
  });

  it("rejects when the skill has no established active head", async () => {
    db.readSkillActiveRevisionFromDatabase.mockReturnValue({ activeRevisionId: null, contentDigest: null, content: null });
    await expect(rollbackCustomSkill({ skillId: "s1", targetRevisionId: "revPrior", actor: ACTOR })).rejects.toThrow(/no established active revision/);
    expect(db.applySkillRollbackInDatabase).not.toHaveBeenCalled();
  });
});

describe("rollbackCustomSkill — concurrency (compare-and-swap)", () => {
  it("passes the observed head as the CAS guard and records a 'rollback' revision restoring the target", async () => {
    const res = await rollbackCustomSkill({ skillId: "s1", targetRevisionId: "revPrior", actor: ACTOR });
    expect(db.applySkillRollbackInDatabase).toHaveBeenCalledTimes(1);
    const arg = db.applySkillRollbackInDatabase.mock.calls[0][0];
    expect(arg.expectedActiveRevisionId).toBe("head0"); // CAS guard = observed head
    expect(arg.targetRevisionId).toBe("revPrior");
    expect(arg.restoredContent).toBe("prior body");
    expect(arg.restoredContentDigest).toBe("shaPrior");
    // the restored payload carries the restored content (exact prior content)
    expect(JSON.parse(arg.restoredPayloadJson).content).toBe("prior body");
    expect(res.restoredFromRevisionId).toBe("revPrior");
    expect(res.contentDigest).toBe("shaPrior");
  });

  it("FAILS LOUDLY (never silently reverts) when the active head moved under it (changed=false)", async () => {
    db.applySkillRollbackInDatabase.mockReturnValue({ changed: false });
    await expect(rollbackCustomSkill({ skillId: "s1", targetRevisionId: "revPrior", actor: ACTOR })).rejects.toThrow(/moved concurrently/);
  });
});

describe("rollbackCustomSkill — re-match hook", () => {
  it("fires the standard enqueueInlineForSkill hook after a successful rollback", async () => {
    await rollbackCustomSkill({ skillId: "s1", targetRevisionId: "revPrior", actor: ACTOR });
    expect(enqueueInlineForSkill).toHaveBeenCalledWith("s1");
  });

  it("does NOT fire the re-match hook when the CAS failed", async () => {
    db.applySkillRollbackInDatabase.mockReturnValue({ changed: false });
    await expect(rollbackCustomSkill({ skillId: "s1", targetRevisionId: "revPrior", actor: ACTOR })).rejects.toThrow();
    expect(enqueueInlineForSkill).not.toHaveBeenCalled();
  });
});
