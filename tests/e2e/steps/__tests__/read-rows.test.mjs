// readRows: rows of one table read by named columns, every name checked against
// the database's own catalog first, every value a bound parameter.
//
// The defect these cases stand for: a row was selected by `user_id` where the
// table's column is `userId`, and the run died at the database, far from the
// line that wrote the query. The step refuses the name at once, names the column
// the table has, and never sends a query built from a name it did not check.
import { describe, expect, it } from "vitest";

import { labelOf, refusal, theSteps } from "./backends.mjs";
import { COLUMNS_QUERY, DATABASES, DatabaseDouble, DatabaseError, TABLES_QUERY, rowsScene } from "./databases.mjs";

for (const database of DATABASES) {
  describe.skipIf(Boolean(database.skip))(`readRows [${labelOf(database)}]`, () => {
    it("reads rows by named columns, each value a bound parameter, and writes no value", async () => {
      await rowsScene(database, async ({ db, record, lines }) => {
        const { readRows } = theSteps("readRows");
        const [alpha, member] = [db.schema("alpha"), db.table("step_member")];
        const result = await readRows(db.client, { table: member, columns: ["id", "role"], where: { userId: "user-ada", organizationId: "org-north" }, record });
        expect(result).toEqual({ schema: alpha, table: member, columns: ["id", "role"], rows: [{ id: "member-one", role: "owner" }] });
        expect(lines).toEqual([`readRows: 1 row of ${alpha}.${member} (id, role) where userId, organizationId`]);
        // The catalog first, then the one query: names quoted as identifiers, the values apart from it.
        expect(db.queries).toEqual([
          { text: COLUMNS_QUERY, values: [member] },
          {
            text: `SELECT "id", "role" FROM "${alpha}"."${member}" WHERE "userId" = $1 AND "organizationId" = $2 LIMIT $3`,
            values: ["user-ada", "org-north", 101],
          },
        ]);
        for (const value of ["user-ada", "org-north"]) {
          expect(lines[0].includes(value), "a line the step wrote carries a value").toBe(false);
          expect(db.queries[1].text.includes(value), "a value was written into the query").toBe(false);
        }
      });
    });

    it("refuses user_id at once, naming the table's userId, and reads no row", async () => {
      await rowsScene(database, async ({ db, record, lines }) => {
        const { readRows } = theSteps("readRows");
        const [alpha, member] = [db.schema("alpha"), db.table("step_member")];
        const error = await refusal(readRows(db.client, { table: member, columns: ["id"], where: { user_id: "user-ada" }, record }));
        expect(error.name).toBe("StepRefusal");
        expect(error.step).toBe("readRows");
        expect(error.kind).toBe("unknown-column");
        expect(error.message).toBe(`readRows refused (unknown-column): ${alpha}.${member} has no column user_id (the closest is userId); nothing was read`);
        expect(lines).toEqual([error.message]);
        expect(db.queries.map((query) => query.text), "a query was built from a name the catalog did not list").toEqual([COLUMNS_QUERY]);
      });
    });

    it("names every unknown column with its closest, whether it is read or matched", async () => {
      await rowsScene(database, async ({ db, record }) => {
        const { readRows } = theSteps("readRows");
        const [alpha, member] = [db.schema("alpha"), db.table("step_member")];
        const error = await refusal(readRows(db.client, { table: member, columns: ["ID", "role_name"], where: { org_id: "org-north" }, record }));
        expect(error.message).toBe(
          `readRows refused (unknown-column): ${alpha}.${member} has no column ID (the closest is id), ` +
            "no column role_name (the closest is role), no column org_id (the closest is organizationId); nothing was read",
        );
      });
    });

    it("refuses a table no schema holds, naming the closest there is", async () => {
      await rowsScene(database, async ({ db, record }) => {
        const { readRows } = theSteps("readRows");
        const [alpha, member, typo] = [db.schema("alpha"), db.table("step_member"), db.table("step_membr")];
        const error = await refusal(readRows(db.client, { table: typo, columns: ["id"], record }));
        expect(error.kind).toBe("unknown-table");
        expect(error.message).toBe(`readRows refused (unknown-table): there is no table ${typo} in any schema — the closest is ${alpha}.${member}; nothing was read`);
        expect(db.queries.map((query) => query.text)).toEqual([COLUMNS_QUERY, TABLES_QUERY]);
      });
    });

    it("names the schema that holds a table when the schema named does not", async () => {
      await rowsScene(database, async ({ db, record }) => {
        const { readRows } = theSteps("readRows");
        const [alpha, beta, run] = [db.schema("alpha"), db.schema("beta"), db.table("step_run")];
        const error = await refusal(readRows(db.client, { table: run, columns: ["id"], schema: beta, record }));
        expect(error.kind).toBe("unknown-table");
        expect(error.message).toBe(`readRows refused (unknown-table): there is no table ${beta}.${run}; a table ${run} is in ${alpha}; nothing was read`);
      });
    });

    it("refuses a table two schemas hold until the schema is named, then reads that one", async () => {
      await rowsScene(database, async ({ db, record, lines }) => {
        const { readRows } = theSteps("readRows");
        const [alpha, beta, shared] = [db.schema("alpha"), db.schema("beta"), db.table("step_shared")];
        const error = await refusal(readRows(db.client, { table: shared, columns: ["id"], record }));
        expect(error.kind).toBe("ambiguous");
        expect(error.message).toBe(`readRows refused (ambiguous): a table ${shared} is in 2 schemas, ${alpha} and ${beta} — name the schema; nothing was read`);
        const result = await readRows(db.client, { table: shared, columns: ["id", "label"], schema: beta, record });
        expect(result).toEqual({ schema: beta, table: shared, columns: ["id", "label"], rows: [{ id: "shared-beta", label: "the beta one" }] });
        expect(lines.at(-1)).toBe(`readRows: 1 row of ${beta}.${shared} (id, label)`);
      });
    });

    it("matches an empty column with null, and a number or a boolean as a parameter", async () => {
      await rowsScene(database, async ({ db, record, lines }) => {
        const { readRows } = theSteps("readRows");
        const [alpha, run] = [db.schema("alpha"), db.table("step_run")];
        const empty = await readRows(db.client, { table: run, columns: ["id"], where: { note: null, archived: false }, record });
        expect(empty.rows).toEqual([{ id: "run-one" }]);
        expect(db.queries.at(-1)).toEqual({ text: `SELECT "id" FROM "${alpha}"."${run}" WHERE "note" IS NULL AND "archived" = $1 LIMIT $2`, values: [false, 101] });
        const twice = await readRows(db.client, { table: run, columns: ["id", "attempts"], where: { attempts: 2 }, record });
        expect([...twice.rows].sort((a, b) => a.id.localeCompare(b.id))).toEqual([
          { id: "run-three", attempts: 2 },
          { id: "run-two", attempts: 2 },
        ]);
        const none = await readRows(db.client, { table: run, columns: ["id"], where: { status: "queued" }, record });
        expect(none.rows).toEqual([]);
        expect(lines.at(-1)).toBe(`readRows: 0 rows of ${alpha}.${run} (id) where status`);
      });
    });

    it("refuses more matching rows than its limit, and returns none of them", async () => {
      await rowsScene(database, async ({ db, record }) => {
        const { readRows } = theSteps("readRows");
        const [alpha, member] = [db.schema("alpha"), db.table("step_member")];
        const error = await refusal(readRows(db.client, { table: member, columns: ["id"], limit: 2, record }));
        expect(error.kind).toBe("too-many-rows");
        expect(error.message).toBe(
          `readRows refused (too-many-rows): more than 2 rows of ${alpha}.${member} match — narrow the where, or raise the limit; no rows were returned`,
        );
        expect(db.queries.at(-1).values).toEqual([3]);
        const two = await readRows(db.client, { table: member, columns: ["id"], where: { organizationId: "org-north" }, limit: 2, record });
        expect(two.rows).toHaveLength(2);
      });
    });

    it("keeps only the class and the code of a reading the database refused, never the value", async () => {
      await rowsScene(database, async ({ db, record }) => {
        const { readRows } = theSteps("readRows");
        const [alpha, run] = [db.schema("alpha"), db.table("step_run")];
        const value = ["not", "a", "number"].join("-");
        const error = await refusal(readRows(db.client, { table: run, columns: ["id"], where: { attempts: value }, record }));
        expect(error.kind).toBe("unreadable");
        expect(error.message).toBe(`readRows refused (unreadable): the database could not read the rows of ${alpha}.${run} (DatabaseError, code 22P02)`);
        expect(error.message).not.toContain(value);
      });
    });

    it("reads nothing when it refuses its arguments", async () => {
      await rowsScene(database, async ({ db, record, lines }) => {
        const { readRows } = theSteps("readRows");
        const table = db.table("step_member");
        const nothing = "nothing was read";
        const cases = [
          [null, { table, columns: ["id"], record }, `hand the step a database client with a query(text, values) method, such as a connected pg client — ${nothing}`],
          [db.client, { columns: ["id"], record }, `name the table, such as member — ${nothing}`],
          [db.client, { table, columns: [], record }, `name one or more columns to read — ${nothing}`],
          [db.client, { table, columns: ["id", "id"], record }, `name each column to read once — ${nothing}`],
          [db.client, { table, columns: ["id"], where: [], record }, `where must be an object of column names and values — ${nothing}`],
          [db.client, { table, columns: ["id"], where: { userId: { raw: "x" } }, record }, `the value for userId must be a string, a number, a boolean or null — ${nothing}`],
          [db.client, { table, columns: ["id"], where: { userId: undefined }, record }, `the value for userId must be a string, a number, a boolean or null — ${nothing}`],
          [db.client, { table, columns: ["id"], schema: " ", record }, `schema must be a non-empty name — ${nothing}`],
          [db.client, { table, columns: ["id"], limit: 0, record }, `limit must be a whole number of rows, at least 1 — ${nothing}`],
          [db.client, { table, columns: ["id"], bounds: { readingMs: 0 }, record }, `readingMs must be a positive number of milliseconds — ${nothing}`],
          [db.client, { table, columns: ["id"], bounds: { queryMs: 5 }, record }, `there is no bound named queryMs — ${nothing}`],
        ];
        for (const [client, options, reason] of cases) {
          const error = await refusal(readRows(client, options));
          expect(error.kind).toBe("input");
          expect(error.message).toBe(`readRows refused (input): ${reason}`);
          expect(lines.at(-1)).toBe(error.message);
        }
        const unrecorded = await refusal(readRows(db.client, { table, columns: ["id"] }));
        expect(unrecorded.message).toBe("readRows refused (input): hand the step a record callback — nothing was done");
        expect(db.queries, "a refused call sent a query").toEqual([]);
      });
    });
  });
}

describe("readRows [database double: a database that fails or does not answer]", () => {
  it("names its bound and its limit", () => {
    const steps = theSteps("readRows");
    expect(steps.READ_ROWS_BOUND_MS).toBe(10_000);
    expect(steps.READ_ROWS_BOUNDS).toEqual({ readingMs: steps.READ_ROWS_BOUND_MS });
    expect(steps.READ_ROWS_LIMIT).toBe(100);
  });

  it("refuses by name a database that does not answer within the bound", async () => {
    const { readRows } = theSteps("readRows");
    const lines = [];
    const slow = new DatabaseDouble({ answerAfterMs: 1_500 });
    const error = await refusal(readRows(slow.client, { table: "step_member", columns: ["id"], record: (line) => lines.push(line), bounds: { readingMs: 300 } }));
    expect(error.kind).toBe("no-answer");
    expect(error.message).toBe("readRows refused (no-answer): the database gave no answer to the reading of the columns of step_member within 300 ms");
    expect(lines).toEqual([error.message]);
  });

  it("keeps only the class and the code of a failed catalog reading", async () => {
    const { readRows } = theSteps("readRows");
    const secret = ["fixture", "secret", "value"].join("-");
    const failing = new DatabaseDouble({ failWith: new DatabaseError(`permission denied near "${secret}"`, "42501") });
    const error = await refusal(readRows(failing.client, { table: "step_member", columns: ["id"], record: () => {} }));
    expect(error.kind).toBe("unreadable");
    expect(error.message).toBe("readRows refused (unreadable): the database could not read the columns of step_member (DatabaseError, code 42501)");
    expect(error.message).not.toContain(secret);
  });

  it("refuses an answer without rows", async () => {
    const { readRows } = theSteps("readRows");
    const error = await refusal(readRows({ query: async () => ({}) }, { table: "step_member", columns: ["id"], record: () => {} }));
    expect(error.kind).toBe("unreadable");
    expect(error.message).toBe("readRows refused (unreadable): the database answered the reading of the columns of step_member without rows");
  });
});
