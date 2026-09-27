// cinatra#3700 — a typed promotion's retype must queue the binding reconcile.
//
// `canonicalRetype` (src/lib/artifacts/typed-promotion-store.ts) retypes an
// artifact through `historyAwareUpsert`. Its UPDATE used to change
// objects.type without queueing the per-artifact 'binding-reconcile-write'
// row the objects store queues on every type change, so the stale binding
// (still naming the OLD type) survived and the context road dropped the
// artifact. These tests drive the REAL `historyAwareUpsert` with the database
// seams stubbed (the shape of canonical-writer-guard-refusal.test.ts), record
// the statements it hands the REAL guarded-batch builder (the spy pattern of
// co-commit-statements.test.ts) and read the write statement — the batch's
// LAST entry. Whether the queue, once drained, writes the binding to the new type
// is the real-database tier's (binding-write-path.integration.test.ts).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const ARTIFACT_ID = "obj_3700";
const ORG_ID = "org_3700";
const FROM_TYPE = "@cinatra-ai/markdown-artifact:markdown";
const TO_TYPE = "@cinatra-ai/blog-idea-artifact:blog-idea";

const mocks = vi.hoisted(() => ({
  batches: [] as Array<Array<{ text: string; values?: unknown[] }>>,
  runGuardedOrgWriteBatchSync: vi.fn(),
  // Pre-write reads: the snapshot read answers the markdown-typed row at
  // version 7, the event-sequence read answers an empty change set.
  runPostgresQueriesSync: vi.fn(
    (input: { queries: Array<{ text: string }> }) => {
      const text = input.queries[0]?.text ?? "";
      if (/FROM\s+"[^"]+"\."objects"/.test(text)) {
        return [
          {
            rows: [
              {
                id: "obj_3700",
                type: "@cinatra-ai/markdown-artifact:markdown",
                data: { body: "# idea" },
                org_id: "org_3700",
                version: 7,
                deleted_at: null,
              },
            ],
            rowCount: 1,
          },
        ];
      }
      return [{ rows: [{ max_seq: 0 }], rowCount: 1 }];
    },
  ),
}));

vi.mock("@cinatra-ai/org-write-kernel", async (importOriginal) => {
  const actual = (await importOriginal()) as {
    buildGuardedOrgWriteBatch: (request: unknown, queries: unknown) => unknown;
  };
  return {
    ...actual,
    // The real builder runs (its authority checks included); the spy only
    // records the statements the writer hands it, in order.
    buildGuardedOrgWriteBatch: (request: unknown, queries: Array<{ text: string; values?: unknown[] }>) => {
      mocks.batches.push([...queries]);
      return actual.buildGuardedOrgWriteBatch(request, queries);
    },
  };
});

vi.mock("@/lib/org-write/batch-wrapper", () => ({
  runGuardedOrgWriteBatchSync: mocks.runGuardedOrgWriteBatchSync,
}));

vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: mocks.runPostgresQueriesSync,
}));

vi.mock("@/lib/database", () => ({
  ensurePostgresSchema: () => {},
  getPostgresConnectionString: () => "postgres://stub",
  postgresSchema: "cinatra_test",
}));

vi.mock("@/lib/mcp-request-context", () => ({
  mcpRequestContextStorage: { getStore: () => undefined },
}));

vi.mock("@/lib/project-writable", () => ({
  assertProjectWritableSync: () => {},
}));

vi.mock("@/lib/project-inheritance", () => ({
  resolveProjectInheritanceForType: () => null,
}));

vi.mock("../change-set", () => ({
  openChangeSet: () => ({ changeSetId: "cs_3700" }),
  closeChangeSet: () => {},
}));

import type { OrgWriteAuthority } from "@cinatra-ai/org-write-kernel";
import { historyAwareUpsert } from "../canonical-writer";

const authority: OrgWriteAuthority = { orgId: ORG_ID, can: () => true };

type Captured = { text: string; values?: unknown[] };

function answerWithOneRow(type: string, version: number) {
  mocks.runGuardedOrgWriteBatchSync.mockImplementation(() => {
    const row = {
      id: ARTIFACT_ID,
      type,
      data: { body: "# idea" },
      org_id: ORG_ID,
      version,
      deleted_at: null,
      row_json: { id: ARTIFACT_ID, type, org_id: ORG_ID, version },
      cas_ok: 1,
    };
    return [{ rows: [row], rowCount: 1 }];
  });
}

function lastWriteStatement(): Captured {
  expect(mocks.batches).toHaveLength(1);
  expect(mocks.runGuardedOrgWriteBatchSync).toHaveBeenCalledTimes(1);
  const write = mocks.batches[0]?.at(-1);
  expect(write).toBeDefined();
  return write as Captured;
}

/** The typed promotion's retype, with exactly the arguments `canonicalRetype`
 *  passes to the canonical writer. */
function retypeAsTheTypedPromotionDoes(): Captured {
  answerWithOneRow(TO_TYPE, 8);
  historyAwareUpsert(
    { id: ARTIFACT_ID, type: TO_TYPE, data: { body: "# idea" }, orgId: ORG_ID },
    {
      actor: { actorId: "user_3700", actorKind: "user", orgId: ORG_ID },
      historyEffect: "reversible-internal",
      expectedBaseVersion: 7,
      authority,
    },
  );
  return lastWriteStatement();
}

function squash(sql: string): string {
  return sql.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").trim();
}

/** The body of one named CTE (`name AS ( ... )`), balanced on parentheses. */
function cteBody(sql: string, name: string): string | null {
  const start = sql.indexOf(`${name} AS (`);
  if (start < 0) return null;
  let depth = 0;
  const open = start + `${name} AS `.length;
  for (let i = open; i < sql.length; i += 1) {
    if (sql[i] === "(") depth += 1;
    else if (sql[i] === ")") {
      depth -= 1;
      if (depth === 0) return sql.slice(open + 1, i).trim();
    }
  }
  return null;
}

afterEach(() => {
  mocks.batches.length = 0;
  mocks.runGuardedOrgWriteBatchSync.mockReset();
  mocks.runPostgresQueriesSync.mockClear();
});

afterAll(() => {
  vi.doUnmock("@cinatra-ai/org-write-kernel");
  vi.doUnmock("@/lib/org-write/batch-wrapper");
  vi.doUnmock("@/lib/postgres-sync");
  vi.doUnmock("@/lib/database");
  vi.doUnmock("@/lib/mcp-request-context");
  vi.doUnmock("@/lib/project-writable");
  vi.doUnmock("@/lib/project-inheritance");
  vi.doUnmock("../change-set");
  vi.resetModules();
});

describe("canonical writer × typed promotion retype queues the binding reconcile (cinatra#3700)", () => {
  it("T1: the retype's write statement enqueues a 'binding-reconcile-write' row for the object", () => {
    const write = retypeAsTheTypedPromotionDoes();
    const sql = squash(write.text);
    const arm = cteBody(sql, "binding_reconcile_enqueue");
    expect(arm, "the UPDATE carries a binding_reconcile_enqueue CTE").not.toBeNull();
    expect(arm).toContain(
      'INSERT INTO "cinatra_test"."artifact_binding_reconcile_queue" (scope, object_type_id, object_id, org_id, kind, status)',
    );
    expect(arm).toContain(
      "SELECT 'org:' || updated.org_id, updated.type, updated.id, updated.org_id, 'binding-reconcile-write', 'pending' FROM updated",
    );
    // The updated row is the object named by $1 in the caller's org ($7).
    expect(sql).toMatch(/WHERE id = \$1 AND version = \$32 AND \(org_id = \$7 OR \$7 IS NULL OR org_id IS NULL\)/);
    expect(write.values?.[0]).toBe(ARTIFACT_ID);
    expect(write.values?.[1]).toBe(TO_TYPE);
    expect(write.values?.[6]).toBe(ORG_ID);
    expect(write.values?.[31]).toBe(7);
    // The row moves AWAY from the markdown type the snapshot read found.
    expect(JSON.parse(String(write.values?.[32])).type).toBe(FROM_TYPE);
  });

  it("T2: the enqueue is gated on a real type change read inside the statement and on a non-null org", () => {
    const sql = squash(retypeAsTheTypedPromotionDoes().text);
    // The prior type is read INSIDE the same statement (the pre-statement
    // snapshot), never from a value read before the transaction.
    const base = cteBody(sql, "base_row");
    expect(base, "the UPDATE reads the prior type in a base_row CTE").not.toBeNull();
    expect(base).toBe('SELECT type AS prev_type FROM "cinatra_test"."objects" WHERE id = $1');
    const arm = cteBody(sql, "binding_reconcile_enqueue") ?? "";
    expect(arm).toContain("WHERE updated.org_id IS NOT NULL");
    expect(arm).toContain("AND (SELECT prev_type FROM base_row) IS DISTINCT FROM updated.type");
  });

  it("T3: its claim and binding arms match the objects store's arm term for term", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const storeSource = readFileSync(join(here, "..", "..", "objects-store.ts"), "utf8");
    const storeArm = cteBody(squash(storeSource), "binding_reconcile_enqueue");
    expect(storeArm, "objects-store.ts still carries its binding_reconcile_enqueue arm").not.toBeNull();
    const predicate = /AND \( (EXISTS \( SELECT 1 FROM "\$\{schema\}"\."artifact_type_claims" c [^]*? OR EXISTS \( SELECT 1 FROM "\$\{schema\}"\."semantic_assertion" sa [^]*?sa\.eligibility <> 'archived'\)) \)$/.exec(
      storeArm ?? "",
    );
    expect(predicate, "the objects store's claim-or-binding predicate").not.toBeNull();
    const expected = (predicate?.[1] ?? "")
      .replaceAll("${schema}", "cinatra_test")
      .replaceAll("upserted.", "updated.");
    expect(expected).toContain("c.status IN ('active','retiring')");
    expect(expected).toContain("(c.scope = 'platform' OR c.scope = 'org:' || updated.org_id)");
    expect(expected).toContain("sa.assertion_basis = 'binding' AND sa.eligibility <> 'archived'");
    const arm = cteBody(squash(retypeAsTheTypedPromotionDoes().text), "binding_reconcile_enqueue") ?? "";
    expect(arm).toContain(`AND ( ${expected} )`);
  });

  it("T4: the create statement stays without an enqueue arm (this change's boundary)", () => {
    answerWithOneRow(TO_TYPE, 1);
    historyAwareUpsert(
      { id: ARTIFACT_ID, type: TO_TYPE, data: { body: "# idea" }, orgId: ORG_ID },
      {
        actor: { actorId: "user_3700", actorKind: "user", orgId: ORG_ID },
        historyEffect: "reversible-internal",
        expectedBaseVersion: null,
        authority,
      },
    );
    const sql = squash(lastWriteStatement().text);
    expect(sql).toMatch(/^WITH inserted AS \( INSERT INTO "cinatra_test"\."objects"/);
    expect(sql).not.toContain("binding_reconcile_enqueue");
    expect(sql).not.toContain("artifact_binding_reconcile_queue");
  });
});
