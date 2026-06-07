// changeSetListSchema backward-compat + new optional fields. Pure zod test
// (no DB / no @/ imports).

import { describe, expect, it } from "vitest";
import { changeSetListSchema } from "../schemas";

describe("changeSetListSchema", () => {
  it("backward-compat: a legacy call ({ runId }) still parses + defaults limit", () => {
    const parsed = changeSetListSchema.parse({ runId: "run_1" });
    expect(parsed.runId).toBe("run_1");
    expect(parsed.limit).toBe(50);
  });

  it("an empty call parses (all filters optional)", () => {
    expect(changeSetListSchema.parse({})).toMatchObject({ limit: 50 });
  });

  it("accepts every new optional filter", () => {
    const parsed = changeSetListSchema.parse({
      objectId: "obj_1",
      actorId: "user_1",
      effectRollup: "irreversible-logged",
      restorable: true,
      createdAfter: "2026-05-01T00:00:00Z",
      createdBefore: "2026-05-31T00:00:00Z",
      closedAtAfter: "2026-05-23T20:00:00Z",
    });
    expect(parsed.objectId).toBe("obj_1");
    expect(parsed.effectRollup).toBe("irreversible-logged");
    expect(parsed.restorable).toBe(true);
  });

  it("rejects an invalid effectRollup enum", () => {
    expect(() =>
      changeSetListSchema.parse({ effectRollup: "bogus" }),
    ).toThrow();
  });

  it("rejects a non-datetime createdAfter", () => {
    expect(() => changeSetListSchema.parse({ createdAfter: "not-a-date" })).toThrow();
  });

  it("stays strict — rejects unknown keys", () => {
    expect(() => changeSetListSchema.parse({ bogusField: 1 })).toThrow();
  });
});
