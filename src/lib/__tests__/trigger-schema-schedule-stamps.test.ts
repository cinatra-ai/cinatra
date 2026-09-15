/**
 * THE SCHEDULE STAMPS REACH BOTH KINDS OF DATABASE (cinatra#2972).
 *
 * Two nullable columns join `agent_run_triggers`: `last_fired_at` (a recurring
 * schedule has produced at least one run) and `stopped_at` (**Cancel schedule**
 * was pressed).
 *
 * The trigger lifecycle's DDL leaf is spread into
 * `buildCreateStoreSchemaQueries`, so every statement it returns is executed
 * core-store DDL. A new column therefore has to be written TWICE or it reaches
 * only half the estate:
 *
 *   · in the `CREATE TABLE IF NOT EXISTS` — the fresh database;
 *   · in an `ALTER TABLE … ADD COLUMN IF NOT EXISTS` — every DEPLOYED database,
 *     where the CREATE is a no-op and would silently skip the column.
 *
 * Missing the second one is invisible in local development (a fresh DB has the
 * column) and fatal in production (`SELECT last_fired_at` on a table that never
 * got it), so it is pinned rather than reviewed.
 *
 * The column carries plan (A) §7.2's amended reading — "**Cancel schedule**,
 * shown only for a recurring schedule that has fired once" — and it is
 * deliberately NOT `released_at`: that stamp opens the schedule-defining run's
 * own side-effect gate, which a recurring tick must never do.
 */
import { describe, expect, it } from "vitest";

import { triggerSchemaQueries } from "../trigger-schema";

const statements = triggerSchemaQueries("cinatra").map((q) => q.text);
const triggerTable = statements.filter((t) => t.includes("agent_run_triggers"));

describe("agent_run_triggers carries last_fired_at on both paths", () => {
  it("the CREATE TABLE declares it — the fresh-database path", () => {
    const create = triggerTable.find((t) => t.includes("CREATE TABLE IF NOT EXISTS"));
    expect(create).toBeDefined();
    expect(create).toContain("last_fired_at timestamptz");
  });

  it("an ALTER TABLE adds it — the DEPLOYED-database path", () => {
    const alter = triggerTable.find(
      (t) => t.includes("ALTER TABLE") && t.includes("last_fired_at"),
    );
    expect(alter).toBeDefined();
    // Additive and re-runnable: the bootstrap DDL runs on every boot.
    expect(alter).toContain("ADD COLUMN IF NOT EXISTS");
    // NULLABLE. A NOT NULL on an existing table is the destructive shape the
    // schema-migration gate refuses without a migration artifact, and there is
    // no honest default for "when did this schedule last fire".
    expect(alter).not.toContain("NOT NULL");
  });

  it("it is executed against the SAME schema as the table itself", () => {
    const alter = triggerTable.find(
      (t) => t.includes("ALTER TABLE") && t.includes("last_fired_at"),
    )!;
    expect(alter).toContain('"cinatra"."agent_run_triggers"');
  });

  it("stopped_at reaches both paths too — the Cancel-schedule stamp", () => {
    const create = triggerTable.find((t) => t.includes("CREATE TABLE IF NOT EXISTS"))!;
    expect(create).toContain("stopped_at timestamptz");
    const alter = triggerTable.find(
      (t) => t.includes("ALTER TABLE") && t.includes("stopped_at"),
    );
    expect(alter).toBeDefined();
    expect(alter).toContain("ADD COLUMN IF NOT EXISTS");
    expect(alter).not.toContain("NOT NULL");
  });

  it("released_at is untouched — the stamps stay three and separate", () => {
    const create = triggerTable.find((t) => t.includes("CREATE TABLE IF NOT EXISTS"))!;
    expect(create).toContain("released_at timestamptz");
    expect(
      statements.some(
        (t) => t.includes("DROP COLUMN") || /released_at\s+timestamptz\s+NOT NULL/.test(t),
      ),
    ).toBe(false);
  });
});
