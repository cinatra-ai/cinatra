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
    expect(e.message).toContain("does not declare a table named");
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
