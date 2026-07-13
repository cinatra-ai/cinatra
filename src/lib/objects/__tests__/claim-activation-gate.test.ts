// Unit tests for the per-claim activation gate + NEW-write enforcement
// (cinatra#1429). Live-DB audit/quarantine behavior is proven by
// binding-write-path.integration.test.ts (AC-4).

import { beforeEach, describe, expect, it, vi } from "vitest";

const runPostgresQueriesSync = vi.fn();
vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: (...a: unknown[]) => runPostgresQueriesSync(...a),
}));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: vi.fn() }));
vi.mock("@/lib/postgres-config", () => ({
  postgresSchema: "cinatra",
  getPostgresConnectionString: () => "postgres://test",
}));

import {
  ClaimNotActivatableError,
  InvalidActivatedTypePayloadError,
  assertActivatedTypePayloadValid,
  assertClaimActivatable,
  quarantineObject,
} from "@/lib/objects/claim-activation-gate";

beforeEach(() => runPostgresQueriesSync.mockReset());

describe("assertActivatedTypePayloadValid (NEW-write enforcement)", () => {
  const validate = (d: unknown) => typeof (d as { title?: unknown })?.title === "string";

  it("rejects an invalid payload for an activated (claimed + validated) type", () => {
    expect(() =>
      assertActivatedTypePayloadValid({ objectTypeId: "@v/p:t", data: { title: 1 }, hasActiveClaim: true, validate }),
    ).toThrow(InvalidActivatedTypePayloadError);
  });

  it("passes a valid payload", () => {
    expect(() =>
      assertActivatedTypePayloadValid({ objectTypeId: "@v/p:t", data: { title: "ok" }, hasActiveClaim: true, validate }),
    ).not.toThrow();
  });

  it("does not gate a type with no active claim, or with no registered validator", () => {
    expect(() =>
      assertActivatedTypePayloadValid({ objectTypeId: "@v/p:t", data: { title: 1 }, hasActiveClaim: false, validate }),
    ).not.toThrow();
    expect(() =>
      assertActivatedTypePayloadValid({ objectTypeId: "@v/p:t", data: { title: 1 }, hasActiveClaim: true, validate: null }),
    ).not.toThrow();
  });

  it("fail-closed: a validator that throws is treated as invalid", () => {
    expect(() =>
      assertActivatedTypePayloadValid({
        objectTypeId: "@v/p:t",
        data: {},
        hasActiveClaim: true,
        validate: () => {
          throw new Error("boom");
        },
      }),
    ).toThrow(InvalidActivatedTypePayloadError);
  });
});

describe("assertClaimActivatable (pre-activation gate)", () => {
  it("fail-closed: no registered validator ⇒ ClaimNotActivatableError, no DB touched", () => {
    expect(() =>
      assertClaimActivatable({ scope: "org:o1", objectTypeId: "@v/p:t", validate: null }),
    ).toThrow(ClaimNotActivatableError);
    expect(runPostgresQueriesSync).not.toHaveBeenCalled();
  });

  it("audits the type's rows and quarantines the invalid ones", () => {
    // One page: a valid row + an invalid row, then an empty page ends the sweep.
    runPostgresQueriesSync
      .mockReturnValueOnce([{ rows: [{ id: "g", org_id: "o1", data: { title: "ok" } }, { id: "b", org_id: "o1", data: { title: 9 } }], rowCount: 2 }]) // page 1
      .mockReturnValueOnce([{ rows: [], rowCount: 0 }]); // quarantine insert for b
    const validate = (d: unknown) => typeof (d as { title?: unknown })?.title === "string";
    const res = assertClaimActivatable({ scope: "org:o1", objectTypeId: "@v/p:t", validate, batchSize: 10 });
    expect(res).toEqual({ audited: 2, quarantined: 1 });
    // The quarantine INSERT is the second call (after the page read).
    const insert = runPostgresQueriesSync.mock.calls[1][0].queries[0];
    expect(insert.text).toMatch(/INSERT INTO "cinatra"\."object_binding_quarantine"/);
    expect(insert.text).toMatch(/ON CONFLICT \(org_id, object_id\) DO NOTHING/);
    expect(insert.values[1]).toBe("b");
  });
});

describe("quarantineObject", () => {
  it("is an idempotent ON CONFLICT DO NOTHING insert", () => {
    runPostgresQueriesSync.mockReturnValue([{ rows: [], rowCount: 0 }]);
    quarantineObject({ orgId: "o1", objectId: "x", objectTypeId: "@v/p:t", reason: "r" });
    const qy = runPostgresQueriesSync.mock.calls[0][0].queries[0];
    expect(qy.text).toMatch(/ON CONFLICT \(org_id, object_id\) DO NOTHING/);
    expect(qy.values.slice(0, 3)).toEqual(["o1", "x", "@v/p:t"]);
  });
});
