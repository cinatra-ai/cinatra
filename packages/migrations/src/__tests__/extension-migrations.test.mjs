// The credential split of plan (C) 8.3, as a table (cinatra#3031, epic #3023 W7).
//
// "the host keeps the lock and the ledger under its own credential and switches
// to the extension's role around the extension's statements only" — so every
// statement the runner issues has to land on exactly one side of that line.
// This is the classifier's contract, plus the proxy's two rewrites: the host
// writes the ledger row itself, and a REFUSED row never reads as "already run".

import { describe, expect, it } from "vitest";

import {
  assertExtensionStatementKeepsItsRole,
  EXTENSION_MIGRATION_STATE_APPLIED,
  EXTENSION_MIGRATION_STATE_REFUSED,
  classifyExtensionMigrationStatement,
  createExtensionRoleClient,
  ledgerStatementSet,
} from "../core-migrations.mjs";

const SCHEMA = "cinatra";
const ledger = ledgerStatementSet(SCHEMA);
// A FRESH set per use: the proxy spends a name once the host has written its
// ledger row, so a shared set would leak that between cases.
const newPending = () => new Set(["ext_acme_note__0001_seed", "ext_acme_note__0002_backfill"]);

const classify = (sql, pending = newPending()) =>
  classifyExtensionMigrationStatement(sql, { ledger, pendingNames: pending }).kind;

describe("which side of the credential line a statement lands on", () => {
  it("keeps the library's own ledger statements on the host", () => {
    expect(classify(ledger.existsProbe)).toBe("host");
    expect(classify(ledger.primaryKeyProbe)).toBe("host");
    expect(classify(ledger.createTable)).toBe("host");
    expect(classify(ledger.addPrimaryKey)).toBe("host");
  });

  it("keeps transaction and session control on the host — matched WHOLE, never by prefix", () => {
    for (const s of [
      "BEGIN;",
      "COMMIT;",
      "ROLLBACK",
      'SET search_path TO "cinatra"',
      'CREATE SCHEMA IF NOT EXISTS "cinatra"',
    ]) {
      expect(classify(s)).toBe("host");
    }
  });

  it("a statement that CARRIES a second statement is the extension's, whatever it starts with", () => {
    // The hole a prefix match left open: PostgreSQL's simple query protocol
    // runs both halves, so `RESET ROLE; <anything>` would have executed under
    // the HOST credential and undone the whole perimeter.
    expect(classify('RESET ROLE; DELETE FROM "cinatra"."objects"')).toBe("extension");
    expect(classify('BEGIN; DROP TABLE "cinatra"."objects";')).toBe("extension");
    expect(classify('SET search_path TO "cinatra"; DROP TABLE "cinatra"."objects"')).toBe(
      "extension",
    );
  });

  it("never lets a migration change the role it runs as", () => {
    for (const s of ["SET ROLE postgres", "RESET ROLE", "SET SESSION AUTHORIZATION postgres"]) {
      expect(classify(s)).toBe("extension");
    }
  });

  it("recognises the run-names SELECT so refused rows can be filtered out", () => {
    expect(classify(ledger.runNamesSelect)).toBe("run-names-select");
  });

  it("recognises the mark-as-run INSERT for a name in this run's pending set", () => {
    expect(classify(ledger.markAsRun("ext_acme_note__0001_seed"))).toBe("mark-as-run");
  });

  it("sends the extension's own statements to the extension role", () => {
    expect(classify("CREATE TABLE ext_acme_note_thing (id text)")).toBe("extension");
    expect(classify("INSERT INTO ext_acme_note_thing (id) VALUES ('a')")).toBe("extension");
    expect(classify('UPDATE "cinatra"."objects" SET data = data')).toBe("extension");
  });

  it("sends a HAND-SPELLED ledger write to the extension role, where the database refuses it", () => {
    // Not the library's statement: a migration forging a ledger row must not
    // borrow the host credential by mentioning the table.
    expect(classify(`INSERT INTO "cinatra"."pgmigrations" (name) VALUES ('forged')`)).toBe(
      "extension",
    );
    expect(classify(`DELETE FROM "cinatra"."pgmigrations" WHERE name='x'`)).toBe("extension");
    // The library's exact spelling for a name this run is NOT applying.
    expect(classify(ledger.markAsRun("ext_other_pkg__0001_x"))).toBe("extension");
  });

  it("marks as run ONLY the NEXT pending module, never one further down the chain", () => {
    // node-pg-migrate applies the chain in order and marks each module right
    // after it. Accepting any pending name let 0001 write 0002's ledger row: a
    // process that stopped between the two would then read 0002 as applied and
    // never run it.
    const pending = newPending();
    expect(classify(ledger.markAsRun("ext_acme_note__0002_backfill"), pending)).toBe("extension");
    expect(classify(ledger.markAsRun("ext_acme_note__0001_seed"), pending)).toBe("mark-as-run");
  });
});

function recordingClient() {
  const calls = [];
  return {
    calls,
    async query(text, values) {
      const sql = typeof text === "string" ? text : String(text?.text ?? "");
      calls.push({ sql, values });
      if (/^SELECT name FROM/i.test(sql.trim())) return { rows: [{ name: "prior" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
}

describe("the proxy's two rewrites and the role switch", () => {
  it("wraps every extension statement in SET ROLE / RESET ROLE", async () => {
    const raw = recordingClient();
    const proxy = createExtensionRoleClient({
      raw,
      roleName: "ext_acme_note",
      ledger,
      pendingNames: newPending(),
      markedAsRun: [],
    });
    await proxy.query("INSERT INTO ext_acme_note_thing (id) VALUES ('a')");
    expect(raw.calls.map((c) => c.sql)).toEqual([
      'SET ROLE "ext_acme_note"',
      "INSERT INTO ext_acme_note_thing (id) VALUES ('a')",
      "RESET ROLE",
    ]);
  });

  it("resets the role even when the extension's statement raises", async () => {
    const raw = recordingClient();
    const inner = raw.query.bind(raw);
    raw.query = async (text, values) => {
      const sql = typeof text === "string" ? text : String(text?.text ?? "");
      await inner(text, values);
      if (sql.startsWith("INSERT INTO ext_")) throw new Error("permission denied for table objects");
      return { rows: [], rowCount: 0 };
    };
    const proxy = createExtensionRoleClient({
      raw,
      roleName: "ext_acme_note",
      ledger,
      pendingNames: newPending(),
      markedAsRun: [],
    });
    await expect(proxy.query("INSERT INTO ext_x (id) VALUES ('a')")).rejects.toThrow(
      /permission denied/,
    );
    expect(raw.calls.map((c) => c.sql)).toContain("RESET ROLE");
  });

  it("replaces the library's mark-as-run with the HOST's own parameterized insert", async () => {
    const raw = recordingClient();
    const markedAsRun = [];
    const proxy = createExtensionRoleClient({
      raw,
      roleName: "ext_acme_note",
      ledger,
      pendingNames: newPending(),
      markedAsRun,
    });
    await proxy.query(ledger.markAsRun("ext_acme_note__0001_seed"));
    expect(raw.calls).toHaveLength(1);
    expect(raw.calls[0].sql).toMatch(/INSERT INTO "cinatra"\."pgmigrations" \(name, run_on, state\)/);
    expect(raw.calls[0].values).toEqual([
      "ext_acme_note__0001_seed",
      EXTENSION_MIGRATION_STATE_APPLIED,
    ]);
    expect(raw.calls[0].sql).not.toContain("SET ROLE");
    expect(markedAsRun).toEqual(["ext_acme_note__0001_seed"]);
  });

  it("REFUSES a statement that would step out of the role, and never runs it", async () => {
    // `SET ROLE` is a SESSION switch and the extension's statement runs in that
    // same session, so `RESET ROLE; <anything>` would run under the host
    // credential. The host refuses the statement instead; the chain stops and
    // the refusal lands on the ledger like any other.
    const raw = recordingClient();
    const proxy = createExtensionRoleClient({
      raw,
      roleName: "ext_acme_note",
      ledger,
      pendingNames: newPending(),
      markedAsRun: [],
    });
    await expect(
      proxy.query('RESET ROLE; DELETE FROM "cinatra"."objects"'),
    ).rejects.toThrow(/may not change the role it runs as/);
    expect(raw.calls).toEqual([]);
  });

  it("does not mistake a role-change WORD inside a literal for a role change", () => {
    expect(() =>
      assertExtensionStatementKeepsItsRole("INSERT INTO ext_t (note) VALUES ('set role postgres')"),
    ).not.toThrow();
    expect(() =>
      assertExtensionStatementKeepsItsRole("INSERT INTO ext_t (id) VALUES ('a') -- reset role"),
    ).not.toThrow();
    expect(() => assertExtensionStatementKeepsItsRole("SET SESSION AUTHORIZATION postgres")).toThrow(
      /may not change the role/,
    );
  });

  it("spends a name once its row is written, so the NEXT module becomes the markable one", async () => {
    const raw = recordingClient();
    const pending = newPending();
    const proxy = createExtensionRoleClient({
      raw,
      roleName: "ext_acme_note",
      ledger,
      pendingNames: pending,
      markedAsRun: [],
    });
    await proxy.query(ledger.markAsRun("ext_acme_note__0001_seed"));
    expect(
      classifyExtensionMigrationStatement(ledger.markAsRun("ext_acme_note__0002_backfill"), {
        ledger,
        pendingNames: pending,
      }).kind,
    ).toBe("mark-as-run");
    // And the spent one can never be written twice.
    expect(
      classifyExtensionMigrationStatement(ledger.markAsRun("ext_acme_note__0001_seed"), {
        ledger,
        pendingNames: pending,
      }).kind,
    ).toBe("extension");
  });

  it("filters REFUSED rows out of the run-names read, so a refusal never reads as applied", async () => {
    const raw = recordingClient();
    const proxy = createExtensionRoleClient({
      raw,
      roleName: "ext_acme_note",
      ledger,
      pendingNames: newPending(),
      markedAsRun: [],
    });
    const res = await proxy.query(ledger.runNamesSelect);
    expect(raw.calls[0].sql).toContain("WHERE state IS DISTINCT FROM $1");
    expect(raw.calls[0].values).toEqual([EXTENSION_MIGRATION_STATE_REFUSED]);
    expect(res.rows).toEqual([{ name: "prior" }]);
  });
});
