import { describe, expect, it } from "vitest";
import { buildObjectRowLiveAtVersionGuardQuery } from "@/lib/objects-store";

// The objects store's spliceable row guard. DB-FREE contract tests, in the shape
// of objects-outbox-cte.test.ts: the statement's conditions, its bound values,
// the schema escaping and the input checks. The guard's effect inside a real
// transaction (a changed or deleted row aborts the caller's whole write) rides
// the database tier.

const sample = { id: "obj-1", orgId: "org-1", expectedVersion: 3 };

describe("objects row guard — the statement (Q-a)", () => {
  it("locks the schema-qualified row by id, organization, liveness and version", () => {
    const { text } = buildObjectRowLiveAtVersionGuardQuery("cinatra", sample);
    expect(text).toContain('FROM "cinatra"."objects"');
    expect(text).toContain("id = $1");
    expect(text).toContain("org_id = $2");
    expect(text).toContain("deleted_at IS NULL");
    expect(text).toContain("COALESCE(version, 1) = $3");
    expect(text).toContain("FOR UPDATE");
  });

  it("projects 1 / COUNT(*) as the statement's output, so the division is always evaluated", () => {
    const { text } = buildObjectRowLiveAtVersionGuardQuery("cinatra", sample);
    expect(text).toMatch(/^SELECT 1 \/ COUNT\(\*\)::int AS [a-z_]+\s/);
  });
});

describe("objects row guard — the values (Q-b)", () => {
  it("binds exactly id, organization and expected version, in that order", () => {
    const { values } = buildObjectRowLiveAtVersionGuardQuery("cinatra", sample);
    expect(values).toEqual(["obj-1", "org-1", 3]);
  });

  it("binds a version of 1 as given", () => {
    const { values } = buildObjectRowLiveAtVersionGuardQuery("cinatra", {
      id: "obj-2",
      orgId: "org-2",
      expectedVersion: 1,
    });
    expect(values).toEqual(["obj-2", "org-2", 1]);
  });
});

describe("objects row guard — schema escaping (Q-c)", () => {
  it("escapes an embedded quote in the schema name as the outbox builder does", () => {
    const { text } = buildObjectRowLiveAtVersionGuardQuery('cin"atra', sample);
    expect(text).toContain('"cin""atra"."objects"');
  });
});

describe("objects row guard — input checks and read-only shape (Q-d)", () => {
  it("throws on an empty organization", () => {
    expect(() => buildObjectRowLiveAtVersionGuardQuery("cinatra", { ...sample, orgId: "" })).toThrow(
      /objects row guard: orgId/,
    );
  });

  it("throws on a non-string organization", () => {
    expect(() =>
      buildObjectRowLiveAtVersionGuardQuery("cinatra", {
        ...sample,
        orgId: null as unknown as string,
      }),
    ).toThrow(/objects row guard: orgId/);
  });

  it("throws on a non-integer expected version", () => {
    expect(() => buildObjectRowLiveAtVersionGuardQuery("cinatra", { ...sample, expectedVersion: 1.5 })).toThrow(
      /objects row guard: expectedVersion/,
    );
    expect(() =>
      buildObjectRowLiveAtVersionGuardQuery("cinatra", {
        ...sample,
        expectedVersion: Number.NaN,
      }),
    ).toThrow(/objects row guard: expectedVersion/);
  });

  it("carries no INSERT, no UPDATE of a table and no DELETE: the row lock stays a read", () => {
    const { text } = buildObjectRowLiveAtVersionGuardQuery("cinatra", sample);
    expect(text).not.toMatch(/\bINSERT\b/i);
    expect(text).not.toMatch(/\bDELETE\b/i);
    expect(text.replaceAll("FOR UPDATE", "")).not.toMatch(/\bUPDATE\b/i);
    expect(text).not.toMatch(/\bSET\b/i);
  });
});
