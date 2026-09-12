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
import { WORKSPACE_SCOPE_SENTINEL } from "@/lib/assignment-scope";

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

/**
 * A second declared table whose rows belong to ONE RUN (cinatra#3249): it names
 * its run column beside its organisation column, and the host binds the one
 * exactly as it binds the other.
 */
const RUN_BOUND_TABLES = parseDeclaredTables(
  [
    {
      name: "run_reservations",
      organizationColumn: "org_id",
      runColumn: "run_id",
      columns: [
        { name: "id", type: "text", notNull: true, primaryKey: true },
        { name: "org_id", type: "text", notNull: true },
        { name: "run_id", type: "text", notNull: true },
        { name: "state", type: "text", notNull: true },
      ],
    },
  ],
  PACKAGE,
);
const RUN_BOUND_PHYSICAL = "ext_cinatra_ai_w7_fixture_run_reservations";
const RUN = "run-3249";

const buildRunBound = (request: Parameters<typeof buildExtensionDataStatement>[0]["request"]) =>
  buildExtensionDataStatement({
    packageName: PACKAGE,
    schemaName: SCHEMA,
    tables: RUN_BOUND_TABLES,
    orgId: "org-w7",
    runId: RUN,
    request,
  });

/**
 * A THIRD declared table, bound to the run AND to the SCOPE that run belongs
 * to (cinatra#3249, decision A per scope): the kind of scope and the id inside
 * it, in the host's own per-scope vocabulary — the workspace, an organisation,
 * a team, a project, a person's own scope.
 */
const SCOPE_BOUND_TABLES = parseDeclaredTables(
  [
    {
      name: "scope_reservations",
      organizationColumn: "org_id",
      runColumn: "run_id",
      scopeKindColumn: "scope_kind",
      scopeIdColumn: "scope_id",
      columns: [
        { name: "id", type: "text", notNull: true, primaryKey: true },
        { name: "org_id", type: "text", notNull: true },
        { name: "run_id", type: "text", notNull: true },
        { name: "scope_kind", type: "text", notNull: true },
        { name: "scope_id", type: "text", notNull: true },
        { name: "state", type: "text", notNull: true },
      ],
    },
  ],
  PACKAGE,
);
const SCOPE_BOUND_PHYSICAL = "ext_cinatra_ai_w7_fixture_scope_reservations";
/** The scope THIS run belongs to — the host's value, read off the run. */
const SCOPE = { kind: "project", id: "project-77" } as const;

const buildScopeBound = (
  request: Parameters<typeof buildExtensionDataStatement>[0]["request"],
  // `null` is this helper's "the call carries NO scope": an explicit
  // `undefined` would re-apply the default and prove nothing.
  scope: { kind: "workspace" | "organization" | "team" | "project" | "user"; id: string } | null = SCOPE,
) =>
  buildExtensionDataStatement({
    packageName: PACKAGE,
    schemaName: SCHEMA,
    tables: SCOPE_BOUND_TABLES,
    orgId: "org-w7",
    runId: RUN,
    scope: scope ?? undefined,
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

describe("the run a run-bound table's rows belong to (cinatra#3249)", () => {
  const refusal = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return e as ExtensionDataRefusal;
    }
    throw new Error("expected a refusal");
  };

  it("fills the run column from the BOUND run on insertIfAbsent, unnamed by the caller", () => {
    const c = buildRunBound({
      operation: "insertIfAbsent",
      table: "run_reservations",
      row: { id: "r1", state: "reserved" },
      conflictKeys: ["id"],
    });
    expect(c.text).toContain('("org_id", "run_id", "id", "state") VALUES ($1, $2, $3, $4)');
    // The conflict lookup stays inside the bound run as it stays inside the org.
    expect(c.text).toContain('WHERE "org_id" = $5 AND "run_id" = $6 AND "id" = $7');
    expect(c.values).toEqual(["org-w7", RUN, "r1", "reserved", "org-w7", RUN, "r1"]);
    expect(c.physicalTable).toBe(RUN_BOUND_PHYSICAL);
    // The audit's row keys name what the CALLER wrote, as they do today.
    expect(c.rowKeys).toEqual({ id: "r1", state: "reserved" });
  });

  it("fills the run column on the plain insert the same way", () => {
    const c = buildRunBound({
      operation: "insert",
      table: "run_reservations",
      values: { id: "r1", state: "reserved" },
    });
    expect(c.text).toContain('("org_id", "run_id", "id", "state") VALUES ($1, $2, $3, $4)');
    expect(c.values.slice(0, 2)).toEqual(["org-w7", RUN]);
  });

  it("substitutes the bound run on a select asking for THIS RUN'S rows", () => {
    const c = buildRunBound({
      operation: "select",
      table: "run_reservations",
      where: { state: "reserved", run_id: { boundRun: true } },
    });
    expect(c.text).toBe(
      'SELECT "id", "org_id", "run_id", "state" FROM ' +
        `"cinatra"."${RUN_BOUND_PHYSICAL}" ` +
        'WHERE "org_id" = $1 AND "state" = $2 AND "run_id" = $3 LIMIT 100',
    );
    expect(c.values).toEqual(["org-w7", "reserved", RUN]);
    // The marker is the host's own value, never a row key the caller chose.
    expect(c.rowKeys).toEqual({ state: "reserved" });
  });

  it("substitutes the bound run on a conditional update asking for THIS RUN'S rows", () => {
    const c = buildRunBound({
      operation: "updateWhere",
      table: "run_reservations",
      set: { state: "drafted" },
      where: { run_id: { boundRun: true }, id: "r1" },
      expect: { state: "reserved" },
    });
    expect(c.text).toBe(
      `UPDATE "cinatra"."${RUN_BOUND_PHYSICAL}" SET "state" = $1 ` +
        'WHERE "org_id" = $2 AND "run_id" = $3 AND "id" = $4 AND "state" = $5',
    );
    expect(c.values).toEqual(["drafted", "org-w7", RUN, "r1", "reserved"]);
  });

  it("refuses a LITERAL run value in a where clause", () => {
    const e = refusal(() =>
      buildRunBound({
        operation: "select",
        table: "run_reservations",
        where: { run_id: "another-run" },
      }),
    );
    expect(e.reason).toBe("run-is-the-hosts");
    expect(e.message).toContain('the run column "run_id" is bound by the host');
  });

  it("refuses a caller that names the run column in the row it writes", () => {
    const e = refusal(() =>
      buildRunBound({
        operation: "insertIfAbsent",
        table: "run_reservations",
        row: { id: "r1", run_id: "another-run" },
        conflictKeys: ["id"],
      }),
    );
    expect(e.reason).toBe("run-is-the-hosts");
  });

  it("refuses the run column in a conditional update's `set` and in its `expect`", () => {
    expect(
      refusal(() =>
        buildRunBound({
          operation: "updateWhere",
          table: "run_reservations",
          set: { run_id: "another-run" },
        }),
      ).reason,
    ).toBe("run-is-the-hosts");
    expect(
      refusal(() =>
        buildRunBound({
          operation: "updateWhere",
          table: "run_reservations",
          set: { state: "drafted" },
          expect: { run_id: "another-run" },
        }),
      ).reason,
    ).toBe("run-is-the-hosts");
  });

  it("refuses the marker on a column that is not the declared run column", () => {
    const e = refusal(() =>
      buildRunBound({
        operation: "select",
        table: "run_reservations",
        where: { state: { boundRun: true } },
      }),
    );
    expect(e.reason).toBe("bound-run-marker-not-the-run-column");
  });

  it("refuses a run-bound table when the call carries no run at all", () => {
    const e = refusal(() =>
      buildExtensionDataStatement({
        packageName: PACKAGE,
        schemaName: SCHEMA,
        tables: RUN_BOUND_TABLES,
        orgId: "org-w7",
        request: { operation: "insert", table: "run_reservations", values: { id: "r1", state: "s" } },
      }),
    );
    expect(e.reason).toBe("no-run");
  });

  it("leaves a table that declares NO run column exactly as it was", () => {
    const c = build({
      operation: "insertIfAbsent",
      table: "idea_reservations",
      row: { id: "r1", idea_artifact_id: "a1", state: "reserved" },
      conflictKeys: ["idea_artifact_id"],
    });
    expect(c.text).toContain('("org_id", "id", "idea_artifact_id", "state") VALUES ($1, $2, $3, $4)');
    expect(c.text).toContain('WHERE "org_id" = $5 AND "idea_artifact_id" = $6');
    expect(c.values).toEqual(["org-w7", "r1", "a1", "reserved", "org-w7", "a1"]);
    // And the marker means nothing there: the table binds its rows to no run.
    expect(
      refusal(() =>
        build({
          operation: "select",
          table: "idea_reservations",
          where: { state: { boundRun: true } },
        }),
      ).reason,
    ).toBe("bound-run-marker-not-the-run-column");
  });
});

describe("the scope a scope-bound table's rows belong to (cinatra#3249, per scope)", () => {
  const refusal = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return e as ExtensionDataRefusal;
    }
    throw new Error("expected a refusal");
  };

  it("fills the run AND the scope columns from the BOUND run on insertIfAbsent", () => {
    const c = buildScopeBound({
      operation: "insertIfAbsent",
      table: "scope_reservations",
      row: { id: "r1", state: "reserved" },
      conflictKeys: ["id"],
    });
    expect(c.text).toContain(
      '("org_id", "run_id", "scope_kind", "scope_id", "id", "state") ' +
        "VALUES ($1, $2, $3, $4, $5, $6)",
    );
    // The row the conflict keys stand under is looked for inside the bound run
    // and the bound scope, as it is looked for inside the organisation.
    expect(c.text).toContain(
      'WHERE "org_id" = $7 AND "run_id" = $8 AND "scope_kind" = $9 AND "scope_id" = $10 ' +
        'AND "id" = $11',
    );
    expect(c.values).toEqual([
      "org-w7",
      RUN,
      "project",
      "project-77",
      "r1",
      "reserved",
      "org-w7",
      RUN,
      "project",
      "project-77",
      "r1",
    ]);
    expect(c.physicalTable).toBe(SCOPE_BOUND_PHYSICAL);
    // The audit's row keys still name only what the CALLER wrote.
    expect(c.rowKeys).toEqual({ id: "r1", state: "reserved" });
  });

  it("fills the scope columns on the plain insert the same way", () => {
    const c = buildScopeBound({
      operation: "insert",
      table: "scope_reservations",
      values: { id: "r1", state: "reserved" },
    });
    expect(c.text).toContain(
      '("org_id", "run_id", "scope_kind", "scope_id", "id", "state") ' +
        "VALUES ($1, $2, $3, $4, $5, $6)",
    );
    expect(c.values.slice(0, 4)).toEqual(["org-w7", RUN, "project", "project-77"]);
  });

  it("substitutes the bound scope on a select asking for THIS SCOPE'S rows", () => {
    const c = buildScopeBound({
      operation: "select",
      table: "scope_reservations",
      where: {
        state: "reserved",
        scope_kind: { boundScope: true },
        scope_id: { boundScope: true },
      },
    });
    expect(c.text).toBe(
      'SELECT "id", "org_id", "run_id", "scope_kind", "scope_id", "state" FROM ' +
        `"cinatra"."${SCOPE_BOUND_PHYSICAL}" ` +
        // The scope stands with the organisation, ahead of the caller's own
        // predicates: it is the floor every statement on this table carries,
        // and naming the marker asks for the predicate the host adds anyway.
        'WHERE "org_id" = $1 AND "scope_kind" = $2 AND "scope_id" = $3 AND "state" = $4 LIMIT 100',
    );
    expect(c.values).toEqual(["org-w7", "project", "project-77", "reserved"]);
    // The marker is the host's own value, never a row key the caller chose.
    expect(c.rowKeys).toEqual({ state: "reserved" });
  });

  it("asks for this SCOPE'S rows across runs, and for this RUN'S rows, with the two markers", () => {
    const c = buildScopeBound({
      operation: "select",
      table: "scope_reservations",
      where: {
        run_id: { boundRun: true },
        scope_kind: { boundScope: true },
        scope_id: { boundScope: true },
      },
    });
    expect(c.text).toContain(
      'WHERE "org_id" = $1 AND "scope_kind" = $2 AND "scope_id" = $3 AND "run_id" = $4',
    );
    expect(c.values).toEqual(["org-w7", "project", "project-77", RUN]);
  });

  it("substitutes the bound scope on a conditional update", () => {
    const c = buildScopeBound({
      operation: "updateWhere",
      table: "scope_reservations",
      set: { state: "drafted" },
      where: { scope_kind: { boundScope: true }, scope_id: { boundScope: true }, id: "r1" },
      expect: { state: "reserved" },
    });
    expect(c.text).toBe(
      `UPDATE "cinatra"."${SCOPE_BOUND_PHYSICAL}" SET "state" = $1 ` +
        'WHERE "org_id" = $2 AND "scope_kind" = $3 AND "scope_id" = $4 AND "id" = $5 ' +
        'AND "state" = $6',
    );
    expect(c.values).toEqual(["drafted", "org-w7", "project", "project-77", "r1", "reserved"]);
  });

  it("refuses a LITERAL scope value in a where clause", () => {
    expect(
      refusal(() =>
        buildScopeBound({
          operation: "select",
          table: "scope_reservations",
          where: { scope_id: "another-project" },
        }),
      ).reason,
    ).toBe("scope-is-the-hosts");
    const e = refusal(() =>
      buildScopeBound({
        operation: "select",
        table: "scope_reservations",
        where: { scope_kind: "organization" },
      }),
    );
    expect(e.reason).toBe("scope-is-the-hosts");
    expect(e.message).toContain("is bound by the host");
  });

  it("refuses a caller that names a scope column in the row it writes, or sets or expects one", () => {
    expect(
      refusal(() =>
        buildScopeBound({
          operation: "insertIfAbsent",
          table: "scope_reservations",
          row: { id: "r1", scope_id: "another-project" },
          conflictKeys: ["id"],
        }),
      ).reason,
    ).toBe("scope-is-the-hosts");
    expect(
      refusal(() =>
        buildScopeBound({
          operation: "updateWhere",
          table: "scope_reservations",
          set: { scope_kind: "team" },
        }),
      ).reason,
    ).toBe("scope-is-the-hosts");
    expect(
      refusal(() =>
        buildScopeBound({
          operation: "updateWhere",
          table: "scope_reservations",
          set: { state: "drafted" },
          expect: { scope_id: "another-project" },
        }),
      ).reason,
    ).toBe("scope-is-the-hosts");
  });

  it("refuses the scope marker on a column that is not a declared scope column", () => {
    expect(
      refusal(() =>
        buildScopeBound({
          operation: "select",
          table: "scope_reservations",
          where: { state: { boundScope: true } },
        }),
      ).reason,
    ).toBe("bound-scope-marker-not-a-scope-column");
    // And the two markers do not stand in for each other.
    expect(
      refusal(() =>
        buildScopeBound({
          operation: "select",
          table: "scope_reservations",
          where: { run_id: { boundScope: true } },
        }),
      ).reason,
    ).toBe("bound-scope-marker-not-a-scope-column");
    expect(
      refusal(() =>
        buildScopeBound({
          operation: "select",
          table: "scope_reservations",
          where: { scope_id: { boundRun: true } },
        }),
      ).reason,
    ).toBe("bound-run-marker-not-the-run-column");
  });

  it("refuses a scope-bound table when the call carries no scope at all", () => {
    const e = refusal(() =>
      buildScopeBound(
        { operation: "insert", table: "scope_reservations", values: { id: "r1", state: "s" } },
        null,
      ),
    );
    expect(e.reason).toBe("no-scope");
  });

  it("carries the WORKSPACE arm, whose id is the storage sentinel the host already uses", () => {
    const c = buildScopeBound(
      {
        operation: "select",
        table: "scope_reservations",
        where: { scope_kind: { boundScope: true }, scope_id: { boundScope: true } },
      },
      { kind: "workspace", id: WORKSPACE_SCOPE_SENTINEL },
    );
    expect(c.values).toEqual(["org-w7", "workspace", WORKSPACE_SCOPE_SENTINEL]);
  });

  it("leaves a run-bound table that declares NO scope columns exactly as it was", () => {
    const c = buildRunBound({
      operation: "insertIfAbsent",
      table: "run_reservations",
      row: { id: "r1", state: "reserved" },
      conflictKeys: ["id"],
    });
    expect(c.text).toContain('("org_id", "run_id", "id", "state") VALUES ($1, $2, $3, $4)');
    expect(c.values).toEqual(["org-w7", RUN, "r1", "reserved", "org-w7", RUN, "r1"]);
    // And the scope marker means nothing there: the table binds its rows to no scope.
    expect(
      refusal(() =>
        buildRunBound({
          operation: "select",
          table: "run_reservations",
          where: { state: { boundScope: true } },
        }),
      ).reason,
    ).toBe("bound-scope-marker-not-a-scope-column");
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

  it("threads the run the operation is bound to into the statement it runs", async () => {
    const client = fakeClient({ rows: [], rowCount: 1 });
    const audited: Record<string, unknown>[] = [];
    await runExtensionDataOperation({
      client: client as never,
      schemaName: SCHEMA,
      packageName: PACKAGE,
      tables: RUN_BOUND_TABLES,
      orgId: "org-w7",
      runId: RUN,
      request: {
        operation: "updateWhere",
        table: "run_reservations",
        set: { state: "drafted" },
        where: { run_id: { boundRun: true } },
      },
      audit: async (e) => {
        audited.push(e);
      },
    });
    const statement = client.statements.find((s) => s.startsWith("UPDATE"));
    expect(statement).toContain('"run_id" = $3');
    // The audit line names the run as it does today.
    expect(audited.map((e) => e.runId)).toEqual([RUN]);
  });

  it("threads the SCOPE the operation's run belongs to into the statement it runs", async () => {
    const client = fakeClient({ rows: [], rowCount: 1 });
    const audited: Record<string, unknown>[] = [];
    await runExtensionDataOperation({
      client: client as never,
      schemaName: SCHEMA,
      packageName: PACKAGE,
      tables: SCOPE_BOUND_TABLES,
      orgId: "org-w7",
      runId: RUN,
      scope: SCOPE,
      request: {
        operation: "updateWhere",
        table: "scope_reservations",
        set: { state: "drafted" },
        where: { scope_kind: { boundScope: true }, scope_id: { boundScope: true } },
      },
      audit: async (e) => {
        audited.push(e);
      },
    });
    const statement = client.statements.find((s) => s.startsWith("UPDATE"));
    expect(statement).toContain('"scope_kind" = $3 AND "scope_id" = $4');
    // The audit line names the RUN as it does today, and nothing more.
    expect(audited.map((e) => e.runId)).toEqual([RUN]);
    expect(audited.every((e) => !("scope" in e))).toBe(true);
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

/**
 * WHERE THE SCOPE COMES FROM ON THE REAL CALL (cinatra#3249, decided per scope).
 *
 * A caller on the passthrough hands this port the RUN and nothing else, so a
 * contract that only works when a caller also hands a scope is a contract the
 * host does not honour. These read the scope the way production reaches it: off
 * the bound run's own immutable launch anchor, with no `scope` in the call.
 */
describe("the scope the bound run belongs to, read off the run", () => {
  const anchorClient = (
    anchor: unknown,
    payload: { rows: unknown[]; rowCount: number } = { rows: [], rowCount: 1 },
  ) => {
    const statements: { text: string; values?: unknown[] }[] = [];
    return {
      statements,
      query: async (text: string, values?: unknown[]) => {
        statements.push({ text, values });
        if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL ROLE)/.test(text)) return { rows: [], rowCount: 0 };
        if (/launch_scope_anchor/.test(text)) {
          return anchor === undefined
            ? { rows: [], rowCount: 0 }
            : { rows: [{ launch_scope_anchor: anchor }], rowCount: 1 };
        }
        return payload;
      },
    };
  };

  /** The call as the passthrough makes it: a run, and NO scope. */
  const runWithoutScope = async (
    anchor: unknown,
    request: Parameters<typeof buildExtensionDataStatement>[0]["request"],
    tables = SCOPE_BOUND_TABLES,
  ) => {
    const client = anchorClient(anchor);
    await runExtensionDataOperation({
      client: client as never,
      schemaName: SCHEMA,
      packageName: PACKAGE,
      tables,
      orgId: "org-w7",
      runId: RUN,
      request,
      audit: async () => {},
    });
    return client;
  };

  const INSERT: Parameters<typeof buildExtensionDataStatement>[0]["request"] = {
    operation: "insertIfAbsent",
    table: "scope_reservations",
    row: { id: "r1", state: "reserved" },
    conflictKeys: ["id"],
  };

  it("stamps the run's own scope on an insert the caller never named it in", async () => {
    const client = await runWithoutScope({ v: 1, kind: "project", id: "project-77" }, INSERT);
    const read = client.statements.find((s) => /launch_scope_anchor/.test(s.text));
    expect(read?.values).toEqual([RUN, "org-w7"]);
    const insert = client.statements.find((s) => s.text.includes("INSERT INTO"));
    expect(insert?.text).toContain('("org_id", "run_id", "scope_kind", "scope_id", "id", "state")');
    expect(insert?.values).toEqual([
      "org-w7",
      RUN,
      "project",
      "project-77",
      "r1",
      "reserved",
      "org-w7",
      RUN,
      "project",
      "project-77",
      "r1",
    ]);
  });

  it("reads the id-less workspace vantage as the sentinel the per-scope model stores", async () => {
    const client = await runWithoutScope({ v: 1, kind: "workspace" }, INSERT);
    const insert = client.statements.find((s) => s.text.includes("INSERT INTO"));
    expect(insert?.values).toContain(WORKSPACE_SCOPE_SENTINEL);
    expect(insert?.values?.[2]).toBe("workspace");
    expect(insert?.values?.[3]).toBe(WORKSPACE_SCOPE_SENTINEL);
  });

  it("substitutes that scope where the caller asks for this scope's rows", async () => {
    const client = await runWithoutScope({ v: 1, kind: "team", id: "team-9" }, {
      operation: "select",
      table: "scope_reservations",
      where: { scope_kind: { boundScope: true }, scope_id: { boundScope: true } },
    });
    const select = client.statements.find((s) => s.text.startsWith("SELECT ") && !/launch_scope_anchor/.test(s.text));
    expect(select?.text).toContain('"scope_kind" = $2 AND "scope_id" = $3');
    expect(select?.values).toEqual(["org-w7", "team", "team-9"]);
  });

  it("refuses rather than stamping a scope the run never recorded", async () => {
    for (const anchor of [undefined, null, { v: 1, kind: "project" }, { v: 9, kind: "team", id: "t" }]) {
      const error = await runWithoutScope(anchor, INSERT).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ExtensionDataRefusal);
      expect((error as ExtensionDataRefusal).reason).toBe("no-scope");
    }
  });

  it("costs no read at all for a table that binds its rows to no scope", async () => {
    const client = await runWithoutScope(
      { v: 1, kind: "project", id: "project-77" },
      {
        operation: "insertIfAbsent",
        table: "run_reservations",
        row: { id: "r1", state: "reserved" },
        conflictKeys: ["id"],
      },
      RUN_BOUND_TABLES,
    );
    expect(client.statements.some((s) => /launch_scope_anchor/.test(s.text))).toBe(false);
  });
});

/**
 * THE SCOPE FLOOR AND THE TENANT-CONSTRAINED ANCHOR READ (cinatra#3249, adopted
 * from the convergence round).
 *
 * The binding is worth what a request CANNOT do with it. A scope-bound table's
 * every statement must stand inside the bound scope whether or not the caller
 * remembered to say so: before this floor a request that omitted the marker, or
 * named only its kind half, reached every OTHER scope's rows of the same
 * organisation on a select, an update and a delete alike.
 */
describe("the bound scope is a floor, not an option", () => {
  const SCOPE_FLOOR = '"scope_kind" = $2 AND "scope_id" = $3';

  it("stands inside the bound scope on a select that names no scope at all", () => {
    const c = buildScopeBound({
      operation: "select",
      table: "scope_reservations",
      where: { state: "reserved" },
    });
    expect(c.text).toBe(
      `SELECT "id", "org_id", "run_id", "scope_kind", "scope_id", "state" FROM ` +
        `"cinatra"."${SCOPE_BOUND_PHYSICAL}" WHERE "org_id" = $1 AND ${SCOPE_FLOOR} ` +
        `AND "state" = $4 LIMIT 100`,
    );
    expect(c.values).toEqual(["org-w7", "project", "project-77", "reserved"]);
    // The caller never named a scope, so no scope value entered the audit's row keys.
    expect(c.rowKeys).toEqual({ state: "reserved" });
  });

  it("cannot read every other scope's rows with the KIND half of the marker alone", () => {
    const c = buildScopeBound({
      operation: "select",
      table: "scope_reservations",
      where: { scope_kind: { boundScope: true } },
    });
    // The id half is present even though the caller named only the kind, and
    // neither half is written twice.
    expect(c.text).toContain(SCOPE_FLOOR);
    expect(c.text.match(/"scope_kind" =/g)).toHaveLength(1);
    expect(c.text.match(/"scope_id" =/g)).toHaveLength(1);
    expect(c.values).toEqual(["org-w7", "project", "project-77"]);
  });

  it("narrows to this run on top of the floor, never instead of it", () => {
    const c = buildScopeBound({
      operation: "select",
      table: "scope_reservations",
      where: { run_id: { boundRun: true } },
    });
    expect(c.text).toContain(`"org_id" = $1 AND ${SCOPE_FLOOR} AND "run_id" = $4`);
    expect(c.values).toEqual(["org-w7", "project", "project-77", RUN]);
  });

  it("stands inside the bound scope on an updateWhere that carries no where", () => {
    const c = buildScopeBound({
      operation: "updateWhere",
      table: "scope_reservations",
      set: { state: "taken" },
      expect: { state: "reserved" },
    });
    expect(c.text).toBe(
      `UPDATE "cinatra"."${SCOPE_BOUND_PHYSICAL}" SET "state" = $1 WHERE "org_id" = $2 ` +
        `AND "scope_kind" = $3 AND "scope_id" = $4 AND "state" = $5`,
    );
    expect(c.values).toEqual(["taken", "org-w7", "project", "project-77", "reserved"]);
  });

  it("stands inside the bound scope on an update and on a delete", () => {
    const upd = buildScopeBound({
      operation: "update",
      table: "scope_reservations",
      values: { state: "taken" },
    });
    expect(upd.text).toContain(`WHERE "org_id" = $2 AND "scope_kind" = $3 AND "scope_id" = $4`);
    const del = buildScopeBound({ operation: "delete", table: "scope_reservations" });
    expect(del.text).toContain(`WHERE "org_id" = $1 AND ${SCOPE_FLOOR}`);
    expect(del.values).toEqual(["org-w7", "project", "project-77"]);
  });

  it("refuses a scope-bound select when the call carries no scope — not only a write", () => {
    const error = (() => {
      try {
        buildScopeBound(
          { operation: "select", table: "scope_reservations", where: { run_id: { boundRun: true } } },
          null,
        );
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(ExtensionDataRefusal);
    expect((error as ExtensionDataRefusal).reason).toBe("no-scope");
  });

  it("leaves a table that binds its rows to no scope compiling exactly as before", () => {
    const c = buildRunBound({
      operation: "select",
      table: "run_reservations",
      where: { state: "reserved" },
    });
    expect(c.text).toBe(
      `SELECT "id", "org_id", "run_id", "state" FROM "cinatra"."${RUN_BOUND_PHYSICAL}" ` +
        `WHERE "org_id" = $1 AND "state" = $2 LIMIT 100`,
    );
    expect(c.text).not.toContain("scope_");
  });
});

/**
 * The anchor read is the one privileged read this port makes under the HOST'S
 * role, so it carries its own tenant predicate: a run id that did not belong to
 * the bound organisation would otherwise hand back another tenant's scope, and
 * that scope would be stamped into this tenant's rows.
 */
describe("the anchor read is tenant-constrained", () => {
  const tenantClient = (rows: (values: unknown[]) => unknown[]) => {
    const statements: { text: string; values?: unknown[] }[] = [];
    return {
      statements,
      query: async (text: string, values?: unknown[]) => {
        statements.push({ text, values });
        if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL ROLE)/.test(text)) return { rows: [], rowCount: 0 };
        if (/launch_scope_anchor/.test(text)) {
          const r = rows(values ?? []);
          return { rows: r, rowCount: r.length };
        }
        return { rows: [], rowCount: 1 };
      },
    };
  };
  const SELECT_THIS_RUN: Parameters<typeof buildExtensionDataStatement>[0]["request"] = {
    operation: "select",
    table: "scope_reservations",
    where: { run_id: { boundRun: true } },
  };
  const run = async (client: { query: unknown }) =>
    runExtensionDataOperation({
      client: client as never,
      schemaName: SCHEMA,
      packageName: PACKAGE,
      tables: SCOPE_BOUND_TABLES,
      orgId: "org-w7",
      runId: RUN,
      request: SELECT_THIS_RUN,
      audit: async () => {},
    });

  it("names the organisation beside the run in the read's own predicate", async () => {
    const client = tenantClient(() => [{ launch_scope_anchor: { v: 1, kind: "team", id: "team-9" } }]);
    await run(client);
    const read = client.statements.find((s) => /launch_scope_anchor/.test(s.text));
    expect(read?.text).toContain('WHERE id = $1 AND org_id = $2');
    expect(read?.values).toEqual([RUN, "org-w7"]);
  });

  it("refuses the call when the run does not belong to the bound organisation", async () => {
    // The stub answers the way the database would: a run of ANOTHER tenant is
    // simply not there under this organisation's predicate.
    const client = tenantClient((values) => (values[1] === "org-w7" ? [] : [{ launch_scope_anchor: {} }]));
    const error = await run(client).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ExtensionDataRefusal);
    expect((error as ExtensionDataRefusal).reason).toBe("no-scope");
    // And nothing was executed under the extension's role.
    expect(client.statements.some((s) => /^BEGIN/.test(s.text))).toBe(false);
  });
});
