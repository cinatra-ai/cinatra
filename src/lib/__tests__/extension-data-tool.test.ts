/**
 * What the extension-data tool will compile, and what it refuses
 * (cinatra#3031, epic #3023 W7; plan (C) enabler 0.25).
 *
 * "operating only on the calling extension's declared tables and declared
 * columns — select, insert, update and delete on the caller's own rows — with
 * the caller derived from the run's extension identity, the organisation column
 * injected by the host, parameters only, no raw statement".
 *
 * Every one of those clauses is a property of ONE pure function, so it is read
 * here as text rather than inferred from a database's behaviour: the statement
 * this builder emits IS the whole surface an extension can reach.
 */
import { describe, expect, it } from "vitest";

import {
  buildExtensionDataStatement,
  EXTENSION_DATA_MAX_LIMIT,
  ExtensionDataRefusal,
  runExtensionDataOperation,
} from "@/lib/extension-data-tool";
import { parseDeclaredTables } from "@cinatra-ai/sdk-extensions/manifest";

const PACKAGE = "@cinatra-ai/w7-fixture";
const SCHEMA = "cinatra";
const TABLES = parseDeclaredTables(
  [
    {
      name: "idea_reservations",
      organizationColumn: "org_id",
      columns: [
        { name: "id", type: "text", notNull: true, primaryKey: true },
        { name: "org_id", type: "text", notNull: true },
        { name: "idea_artifact_id", type: "text", notNull: true },
        { name: "state", type: "text", notNull: true },
      ],
    },
  ],
  PACKAGE,
);

const build = (request: Parameters<typeof buildExtensionDataStatement>[0]["request"]) =>
  buildExtensionDataStatement({
    packageName: PACKAGE,
    schemaName: SCHEMA,
    tables: TABLES,
    orgId: "org-w7",
    request,
  });

describe("the statement the tool compiles", () => {
  it("selects from the prefixed physical table, with the organisation injected first", () => {
    const c = build({ operation: "select", table: "idea_reservations", where: { state: "reserved" } });
    expect(c.text).toBe(
      'SELECT "id", "org_id", "idea_artifact_id", "state" FROM ' +
        '"cinatra"."ext_cinatra_ai_w7_fixture_idea_reservations" ' +
        'WHERE "org_id" = $1 AND "state" = $2 LIMIT 100',
    );
    expect(c.values).toEqual(["org-w7", "reserved"]);
    expect(c.physicalTable).toBe("ext_cinatra_ai_w7_fixture_idea_reservations");
  });

  it("inserts with the organisation the HOST supplies", () => {
    const c = build({
      operation: "insert",
      table: "idea_reservations",
      values: { id: "r1", idea_artifact_id: "a1", state: "reserved" },
    });
    expect(c.text).toContain('INSERT INTO "cinatra"."ext_cinatra_ai_w7_fixture_idea_reservations"');
    expect(c.text).toContain('("org_id", "id", "idea_artifact_id", "state") VALUES ($1, $2, $3, $4)');
    expect(c.values[0]).toBe("org-w7");
    expect(c.rowKeys).toEqual({ id: "r1", idea_artifact_id: "a1", state: "reserved" });
  });

  it("updates and deletes only inside the run's organisation", () => {
    const u = build({
      operation: "update",
      table: "idea_reservations",
      values: { state: "drafted" },
      where: { id: "r1" },
    });
    expect(u.text).toBe(
      'UPDATE "cinatra"."ext_cinatra_ai_w7_fixture_idea_reservations" SET "state" = $1 ' +
        'WHERE "org_id" = $2 AND "id" = $3 ' +
        'RETURNING "id", "org_id", "idea_artifact_id", "state"',
    );
    const d = build({ operation: "delete", table: "idea_reservations", where: { id: "r1" } });
    expect(d.text).toContain('WHERE "org_id" = $1 AND "id" = $2');
  });

  it("passes every caller value as a PARAMETER, never as text in the statement", () => {
    const c = build({
      operation: "select",
      table: "idea_reservations",
      where: { id: "'; DROP TABLE objects; --" },
    });
    expect(c.text).not.toContain("DROP TABLE");
    expect(c.values).toContain("'; DROP TABLE objects; --");
  });

  it("caps the page a select may ask for", () => {
    const c = build({ operation: "select", table: "idea_reservations", limit: 10_000 });
    expect(c.text).toContain(`LIMIT ${EXTENSION_DATA_MAX_LIMIT}`);
  });
});

describe("what the tool refuses", () => {
  const refusal = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return e as ExtensionDataRefusal;
    }
    throw new Error("expected a refusal");
  };

  it("a table the calling extension does not declare", () => {
    const e = refusal(() => build({ operation: "select", table: "objects" }));
    expect(e.reason).toBe("table-not-declared");
    expect(e.message).toBe(
      "extension_data: `table` must name one of the calling extension's own declared tables",
    );
  });

  it("a column the table does not declare, in a filter or in a value", () => {
    expect(refusal(() => build({ operation: "select", table: "idea_reservations", where: { nope: 1 } })).reason).toBe(
      "column-not-declared",
    );
    expect(
      refusal(() =>
        build({ operation: "insert", table: "idea_reservations", values: { nope: 1 } }),
      ).reason,
    ).toBe("column-not-declared");
    expect(
      refusal(() =>
        build({ operation: "select", table: "idea_reservations", columns: ["nope"] }),
      ).reason,
    ).toBe("column-not-declared");
  });

  it("a request that tries to name the organisation itself", () => {
    expect(
      refusal(() =>
        build({ operation: "select", table: "idea_reservations", where: { org_id: "other-org" } }),
      ).reason,
    ).toBe("organisation-is-the-hosts");
    expect(
      refusal(() =>
        build({ operation: "insert", table: "idea_reservations", values: { org_id: "other-org" } }),
      ).reason,
    ).toBe("organisation-is-the-hosts");
  });

  it("a run with no organisation — rather than reading across tenants", () => {
    const e = refusal(() =>
      buildExtensionDataStatement({
        packageName: PACKAGE,
        schemaName: SCHEMA,
        tables: TABLES,
        orgId: "",
        request: { operation: "select", table: "idea_reservations" },
      }),
    );
    expect(e.reason).toBe("no-organisation");
  });

  it("an operation outside select / insert / update / delete", () => {
    const e = refusal(() =>
      build({ operation: "truncate" as never, table: "idea_reservations" }),
    );
    expect(e.reason).toBe("unknown-operation");
  });
});

// ---------------------------------------------------------------------------
// THE TWO CONDITIONAL OPERATIONS (cinatra#3249, epic #3023).
//
// Acceptance item 2 in the issue's own words: "the passthrough instead admits a
// type- and table-agnostic `extension_data` operation — a conditional insert
// whose conflict is reported as a conflict — scoped to the caller's own declared
// table". The contract recorded on the issue states the shapes asserted below.
// ---------------------------------------------------------------------------

const ROW = { id: "r1", idea_artifact_id: "a1", state: "reserved" };

/** The same reader the refusal cases above use, at this file's own scope. */
const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e as ExtensionDataRefusal;
  }
  throw new Error("expected a refusal");
};

describe("the conditional insert the tool compiles", () => {
  it("is ONE statement: it inserts, or it hands back the row that won", () => {
    const c = build({
      operation: "insertIfAbsent",
      table: "idea_reservations",
      row: ROW,
      conflictKeys: ["idea_artifact_id"],
    });
    expect(c.resultShape).toBe("insertIfAbsent");
    // One round trip: one statement, no separator, no second read.
    expect(c.text.split(";")).toHaveLength(1);
    expect(c.text).toContain(
      'INSERT INTO "cinatra"."ext_cinatra_ai_w7_fixture_idea_reservations" ' +
        '("org_id", "id", "idea_artifact_id", "state") VALUES ($1, $2, $3, $4)',
    );
    expect(c.text).toContain("ON CONFLICT DO NOTHING");
    expect(c.text).toContain("UNION ALL");
    // The fallback read is the caller's own row, inside the run's organisation.
    expect(c.text).toContain('WHERE "org_id" = $5 AND "idea_artifact_id" = $6');
    // The projection is named three times and each naming is the same list.
    expect(c.text.split('"id", "org_id", "idea_artifact_id", "state"')).toHaveLength(4);
    expect(c.values).toEqual(["org-w7", "r1", "a1", "reserved", "org-w7", "a1"]);
    expect(c.physicalTable).toBe("ext_cinatra_ai_w7_fixture_idea_reservations");
    expect(c.rowKeys).toEqual(ROW);
  });

  it("refuses a conflict key the row does not carry", () => {
    const e = refusal(() =>
      build({
        operation: "insertIfAbsent",
        table: "idea_reservations",
        row: ROW,
        conflictKeys: ["id", "state", "missing_here"],
      }),
    );
    expect(e.reason).toBe("column-not-declared");
  });

  it("refuses a conflict key that names the organisation the host injects", () => {
    const e = refusal(() =>
      build({
        operation: "insertIfAbsent",
        table: "idea_reservations",
        row: ROW,
        conflictKeys: ["org_id"],
      }),
    );
    expect(e.reason).toBe("organisation-is-the-hosts");
  });

  it("refuses a conditional insert that names no conflict at all", () => {
    const e = refusal(() =>
      build({ operation: "insertIfAbsent", table: "idea_reservations", row: ROW }),
    );
    expect(e.reason).toBe("no-conflict-keys");
  });

  it("refuses a conflict key the row leaves out", () => {
    const e = refusal(() =>
      build({
        operation: "insertIfAbsent",
        table: "idea_reservations",
        row: { idea_artifact_id: "a1" },
        conflictKeys: ["id"],
      }),
    );
    expect(e.reason).toBe("conflict-key-not-in-row");
  });

  it("names a repeated projection column once, so the common table stays unambiguous", () => {
    const c = build({
      operation: "insertIfAbsent",
      table: "idea_reservations",
      columns: ["id", "state", "id"],
      row: ROW,
      conflictKeys: ["idea_artifact_id"],
    });
    expect(c.text).toContain('RETURNING "id", "state")');
    expect(c.text).not.toContain('"id", "state", "id"');
    // The plain operations keep the projection the caller wrote.
    expect(
      build({
        operation: "select",
        table: "idea_reservations",
        columns: ["id", "state", "id"],
      }).text,
    ).toContain('SELECT "id", "state", "id" FROM');
  });

  it("matches a null conflict key with IS NOT DISTINCT FROM, since = NULL never matches", () => {
    const c = build({
      operation: "insertIfAbsent",
      table: "idea_reservations",
      row: { id: "r1", idea_artifact_id: null, state: "reserved" },
      conflictKeys: ["idea_artifact_id"],
    });
    expect(c.text).toContain('"idea_artifact_id" IS NOT DISTINCT FROM $6');
    expect(c.values[5]).toBeNull();
  });

  it("refuses a conditional insert with no row to write", () => {
    const e = refusal(() =>
      build({ operation: "insertIfAbsent", table: "idea_reservations", conflictKeys: ["id"] }),
    );
    expect(e.reason).toBe("no-values");
  });
});

describe("the conditional update the tool compiles", () => {
  it("moves the rows the caller names only while its columns still hold what it expects", () => {
    const c = build({
      operation: "updateWhere",
      table: "idea_reservations",
      set: { state: "drafted" },
      where: { id: "r1" },
      expect: { state: "reserved" },
    });
    expect(c.text).toBe(
      'UPDATE "cinatra"."ext_cinatra_ai_w7_fixture_idea_reservations" SET "state" = $1 ' +
        'WHERE "org_id" = $2 AND "id" = $3 AND "state" = $4',
    );
    expect(c.values).toEqual(["drafted", "org-w7", "r1", "reserved"]);
    expect(c.resultShape).toBe("updated");
  });

  it("is an ordinary scoped update when the caller expects nothing in particular", () => {
    const c = build({
      operation: "updateWhere",
      table: "idea_reservations",
      set: { state: "drafted" },
      where: { id: "r1" },
    });
    expect(c.values).toEqual(["drafted", "org-w7", "r1"]);
  });

  it("refuses a set, a filter or an expectation the table does not declare", () => {
    expect(
      refusal(() =>
        build({ operation: "updateWhere", table: "idea_reservations", set: { nope: 1 } }),
      ).reason,
    ).toBe("column-not-declared");
    expect(
      refusal(() =>
        build({
          operation: "updateWhere",
          table: "idea_reservations",
          set: { state: "drafted" },
          expect: { nope: 1 },
        }),
      ).reason,
    ).toBe("column-not-declared");
  });

  it("matches a null expectation and a null filter with IS NOT DISTINCT FROM", () => {
    const c = build({
      operation: "updateWhere",
      table: "idea_reservations",
      set: { state: "drafted" },
      where: { idea_artifact_id: null },
      expect: { state: null },
    });
    expect(c.text).toBe(
      'UPDATE "cinatra"."ext_cinatra_ai_w7_fixture_idea_reservations" SET "state" = $1 ' +
        'WHERE "org_id" = $2 AND "idea_artifact_id" IS NOT DISTINCT FROM $3 ' +
        'AND "state" IS NOT DISTINCT FROM $4',
    );
    expect(c.values).toEqual(["drafted", "org-w7", null, null]);
  });

  it("refuses a conditional update that sets nothing", () => {
    const e = refusal(() => build({ operation: "updateWhere", table: "idea_reservations" }));
    expect(e.reason).toBe("no-values");
  });
});

describe("the refusal a table the caller has not declared gets (acceptance item 3)", () => {
  const MESSAGE =
    "extension_data: `table` must name one of the calling extension's own declared tables";

  it("carries the refusal shape over verbatim, with the tool's own name on it", () => {
    const e = refusal(() => build({ operation: "select", table: "objects" }));
    expect(e.reason).toBe("table-not-declared");
    expect(e.message).toBe(MESSAGE);
  });

  it("says the same thing on every operation, the conditional ones included", () => {
    for (const request of [
      { operation: "insert" as const, table: "objects", values: { id: "x" } },
      { operation: "update" as const, table: "objects", values: { id: "x" } },
      { operation: "delete" as const, table: "objects" },
      {
        operation: "insertIfAbsent" as const,
        table: "objects",
        row: { id: "x" },
        conflictKeys: ["id"],
      },
      { operation: "updateWhere" as const, table: "objects", set: { id: "x" } },
    ]) {
      const e = refusal(() => build(request));
      expect(e.reason).toBe("table-not-declared");
      expect(e.message).toBe(MESSAGE);
    }
  });
});

describe("what the tool hands the calling pack back", () => {
  const fakeClient = (payload: { rows: unknown[]; rowCount: number }) => {
    const statements: string[] = [];
    return {
      statements,
      query: async (text: string) => {
        statements.push(text);
        if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL ROLE)/.test(text)) return { rows: [], rowCount: 0 };
        return payload;
      },
    };
  };

  const run = async (
    request: Parameters<typeof buildExtensionDataStatement>[0]["request"],
    payload: { rows: unknown[]; rowCount: number },
  ) => {
    const client = fakeClient(payload);
    const result = await runExtensionDataOperation({
      client: client as never,
      schemaName: SCHEMA,
      packageName: PACKAGE,
      tables: TABLES,
      orgId: "org-w7",
      runId: "run-3249",
      request,
      audit: async () => {},
    });
    return { result, client };
  };

  const STORED = { id: "r1", org_id: "org-w7", idea_artifact_id: "a1", state: "reserved" };

  it("reports a write that landed as inserted, in one round trip", async () => {
    const { result, client } = await run(
      {
        operation: "insertIfAbsent",
        table: "idea_reservations",
        row: ROW,
        conflictKeys: ["idea_artifact_id"],
      },
      { rows: [{ __inserted: true, ...STORED }], rowCount: 1 },
    );
    expect(result).toEqual({ inserted: true, row: STORED });
    expect(client.statements.filter((s) => !/^(BEGIN|COMMIT|SET LOCAL ROLE)/.test(s))).toHaveLength(
      1,
    );
  });

  it("reports the losing write as a conflict, with the row that won", async () => {
    const { result } = await run(
      {
        operation: "insertIfAbsent",
        table: "idea_reservations",
        row: ROW,
        conflictKeys: ["idea_artifact_id"],
      },
      { rows: [{ __inserted: false, ...STORED }], rowCount: 1 },
    );
    expect(result).toEqual({ inserted: false, conflict: true, existing: STORED });
  });

  it("reports a conflict with no row under the caller's key as existing null", async () => {
    const { result } = await run(
      {
        operation: "insertIfAbsent",
        table: "idea_reservations",
        row: ROW,
        conflictKeys: ["idea_artifact_id"],
      },
      { rows: [], rowCount: 0 },
    );
    expect(result).toEqual({ inserted: false, conflict: true, existing: null });
  });

  it("counts the rows a conditional update actually moved", async () => {
    const { result } = await run(
      {
        operation: "updateWhere",
        table: "idea_reservations",
        set: { state: "drafted" },
        where: { id: "r1" },
        expect: { state: "reserved" },
      },
      { rows: [], rowCount: 2 },
    );
    expect(result).toEqual({ updated: 2 });
  });

  it("leaves the rows the older operations hand back exactly as they were", async () => {
    const { result } = await run(
      { operation: "select", table: "idea_reservations" },
      { rows: [STORED], rowCount: 1 },
    );
    expect(result).toEqual({
      rows: [STORED],
      rowCount: 1,
      table: "ext_cinatra_ai_w7_fixture_idea_reservations",
    });
  });
});
