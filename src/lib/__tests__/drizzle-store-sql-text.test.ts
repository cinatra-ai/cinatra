// drizzle-store SQL-text builder smoke test (cinatra#104).
//
// drizzle-store builds queries with the DRIVERLESS `drizzle-orm/pg-proxy`
// driver (so `pg` stays out of its import graph — see the header note in
// drizzle-store.ts). The remote callback passed to pg-proxy throws; query
// BUILDING must therefore never invoke the driver, only `.toSQL()`. These
// assertions lock that contract and the parameterized output shape.
import { describe, expect, it } from "vitest";
import {
  buildReadMetadataQuery,
  buildUpsertJsonRowQuery,
  buildInsertExtensionLifecycleAuditQuery,
} from "@/lib/drizzle-store";

const SCHEMA = "cinatra_test_schema";

describe("drizzle-store SQL-text builders (pg-proxy, driverless)", () => {
  it("buildReadMetadataQuery produces parameterized SQL without executing", () => {
    const query = buildReadMetadataQuery(SCHEMA, "some-key");
    expect(query.text).toContain(`"${SCHEMA}"."metadata"`);
    expect(query.text).toContain("select");
    expect(query.values).toContain("some-key");
  });

  it("buildUpsertJsonRowQuery produces parameterized SQL without executing", () => {
    const query = buildUpsertJsonRowQuery(SCHEMA, "chat_threads", {
      id: "thread-1",
      payload: JSON.stringify({ hello: "world" }),
    });
    expect(query.text).toContain(`"${SCHEMA}"."chat_threads"`);
    expect(query.text.toLowerCase()).toContain("insert into");
    expect(query.text.toLowerCase()).toContain("on conflict");
    expect(query.values).toContain("thread-1");
  });

  it("buildInsertExtensionLifecycleAuditQuery produces parameterized SQL without executing", () => {
    const query = buildInsertExtensionLifecycleAuditQuery(SCHEMA, {
      id: "audit-1",
      actorId: "actor-1",
      actorType: "user",
      orgId: null,
      operation: "install",
      packageName: "@cinatra/example",
      packageVersion: "1.0.0",
      destroyedRowSnapshot: null,
      danglingReferences: null,
      reason: null,
    });
    expect(query.text).toContain(`"${SCHEMA}"."extension_lifecycle_audit"`);
    expect(query.text.toLowerCase()).toContain("insert into");
    expect(query.values).toContain("audit-1");
  });
});
