import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// Capture the values() argument and the update().set() argument across calls.
const insertValuesSpy = vi.fn();
const insertOnConflictSpy = vi.fn();
const updateSetSpy = vi.fn();
const updateWhereSpy = vi.fn();

vi.mock("../db", () => ({
  db: {
    insert: vi.fn(() => ({
      values: (v: unknown) => {
        insertValuesSpy(v);
        return {
          onConflictDoNothing: (target: unknown) => {
            insertOnConflictSpy(target);
          },
        };
      },
    })),
    update: vi.fn(() => ({
      set: (v: unknown) => {
        updateSetSpy(v);
        return {
          where: (w: unknown) => {
            updateWhereSpy(w);
          },
        };
      },
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        orderBy: vi.fn(async () => []),
      })),
    })),
  },
}));

describe("ensureDynamicObjectType fields", () => {
  beforeEach(() => {
    insertValuesSpy.mockClear();
    insertOnConflictSpy.mockClear();
    updateSetSpy.mockClear();
    updateWhereSpy.mockClear();
  });

  it("writes source, confidence, slug, jsonSchema.canonicalKeys, originContext, and status", async () => {
    const { ensureDynamicObjectType } = await import("../auto-registrar");
    await ensureDynamicObjectType({
      type: "@cinatra-ai/dynamic:competitor-profile",
      inferredName: "Competitor Profile",
      inferredCategory: "report",
      source: "classifier",
      confidence: "high",
      canonicalKeys: ["name", "domain"],
      originContext: { agentId: "@cinatra/test", runId: "run-1" },
      status: "proposed",
    });
    expect(insertValuesSpy).toHaveBeenCalledTimes(1);
    const args = insertValuesSpy.mock.calls[0][0];
    expect(args).toMatchObject({
      type: "@cinatra-ai/dynamic:competitor-profile",
      displayName: "Competitor Profile",
      inferredCategory: "report",
      source: "classifier",
      confidence: "high",
      slug: "competitor-profile",
      jsonSchema: { canonicalKeys: ["name", "domain"] },
      originContext: { agentId: "@cinatra/test", runId: "run-1" },
      status: "proposed",
    });
    expect(insertOnConflictSpy).toHaveBeenCalledTimes(1);
    // INSERT-ONLY semantics: ensureDynamicObjectType never invokes
    // db.update(); status transitions live exclusively in
    // approveDynamicObjectType / archiveDynamicObjectType.
    expect(updateSetSpy).not.toHaveBeenCalled();
  });

  it("writes null jsonSchema when canonicalKeys is empty/missing", async () => {
    const { ensureDynamicObjectType } = await import("../auto-registrar");
    await ensureDynamicObjectType({
      type: "@cinatra-ai/dynamic:noKeys",
      inferredName: "No Keys",
      inferredCategory: "report",
    });
    const args = insertValuesSpy.mock.calls[0][0];
    expect(args.jsonSchema).toBeNull();
    expect(args.originContext).toBeNull();
    expect(args.source).toBeNull();
    expect(args.confidence).toBeNull();
    expect(args.slug).toBe("noKeys");
  });

  it("idempotent insert calls onConflictDoNothing", async () => {
    const { ensureDynamicObjectType } = await import("../auto-registrar");
    await ensureDynamicObjectType({
      type: "@cinatra-ai/dynamic:a",
      inferredName: "A",
      inferredCategory: "report",
    });
    await ensureDynamicObjectType({
      type: "@cinatra-ai/dynamic:a",
      inferredName: "A",
      inferredCategory: "report",
    });
    expect(insertOnConflictSpy).toHaveBeenCalledTimes(2);
    // Re-registering an existing row never calls db.update(); the existing row
    // stays untouched at the DB level.
    expect(updateSetSpy).not.toHaveBeenCalled();
  });
});

describe("approveDynamicObjectType / archiveDynamicObjectType", () => {
  beforeEach(() => {
    insertValuesSpy.mockClear();
    updateSetSpy.mockClear();
    updateWhereSpy.mockClear();
  });

  it("approveDynamicObjectType calls update().set({ status: 'active' })", async () => {
    const { approveDynamicObjectType } = await import("../auto-registrar");
    await approveDynamicObjectType("@cinatra-ai/dynamic:foo");
    expect(updateSetSpy).toHaveBeenCalledWith({ status: "active" });
    expect(updateWhereSpy).toHaveBeenCalledTimes(1);
  });

  it("archiveDynamicObjectType calls update().set({ status: 'archived' })", async () => {
    const { archiveDynamicObjectType } = await import("../auto-registrar");
    await archiveDynamicObjectType("@cinatra-ai/dynamic:foo");
    expect(updateSetSpy).toHaveBeenCalledWith({ status: "archived" });
    expect(updateWhereSpy).toHaveBeenCalledTimes(1);
  });
});

// Note: readAllDynamicObjectTypes canonicalKeys-extraction test is omitted here
// because db.select chain mocking is complex; the extractCanonicalKeys helper is
// a pure function and is implicitly verified by integration runs against a live PG.
