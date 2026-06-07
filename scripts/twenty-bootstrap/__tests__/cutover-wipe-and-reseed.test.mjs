import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

import { assertDevDatabase } from "../cutover-wipe-and-reseed.mjs";

const SCRIPT_SRC = readFileSync(
  path.resolve(import.meta.dirname, "../cutover-wipe-and-reseed.mjs"),
  "utf8",
);

// The destructive cutover script's dev-DB assertion is the load-bearing
// safety check that keeps the wipe from ever firing against a non-dev
// database. The cases below pin the contract.

describe("assertDevDatabase", () => {
  it("accepts localhost + cinatra schema", () => {
    const out = assertDevDatabase(
      "postgres://postgres:cinatra@localhost:5432/postgres",
      "cinatra",
    );
    expect(out.ok).toBe(true);
    expect(out.host).toBe("localhost");
    expect(out.schema).toBe("cinatra");
    expect(out.override).toBeUndefined();
  });

  it("accepts 127.0.0.1 + cinatra_<slug> schema (worktree pattern)", () => {
    const out = assertDevDatabase(
      "postgres://postgres:cinatra@127.0.0.1:5432/postgres",
      "cinatra_worktree_twenty",
    );
    expect(out.ok).toBe(true);
    expect(out.host).toBe("127.0.0.1");
  });

  it("rejects remote host without override", () => {
    expect(() =>
      assertDevDatabase(
        "postgres://postgres:cinatra@db.production.example.com:5432/postgres",
        "cinatra",
      ),
    ).toThrow(/target appears non-dev/);
  });

  it("rejects non-cinatra schema without override", () => {
    expect(() =>
      assertDevDatabase(
        "postgres://postgres:cinatra@localhost:5432/postgres",
        "public",
      ),
    ).toThrow(/target appears non-dev/);
  });

  it("rejects remote host even on a cinatra schema without override", () => {
    expect(() =>
      assertDevDatabase(
        "postgres://postgres:cinatra@db.production.example.com:5432/postgres",
        "cinatra",
      ),
    ).toThrow(/target appears non-dev/);
  });

  it("accepts remote host with --i-know-this-is-dev override (records override:true)", () => {
    const out = assertDevDatabase(
      "postgres://postgres:cinatra@db.production.example.com:5432/postgres",
      "cinatra",
      { knowDev: true },
    );
    expect(out.ok).toBe(true);
    expect(out.override).toBe(true);
  });

  it("rejects empty connection string", () => {
    expect(() => assertDevDatabase("", "cinatra")).toThrow(/SUPABASE_DB_URL/);
  });

  it("rejects malformed connection string", () => {
    expect(() => assertDevDatabase("not-a-url", "cinatra")).toThrow(/not a valid URL/);
  });
});

// Regression guard: the legacy CRM surfaces are retired, so the destructive
// path is unlocked — `--yes` is the only flag the wipe requires. The
// `--unlock-destructive` gate must NOT be re-introduced (re-adding it would
// silently re-lock the operator's cutover step).
describe("destructive path is unlocked (--unlock-destructive removed)", () => {
  it("the script no longer references the --unlock-destructive flag anywhere", () => {
    expect(SCRIPT_SRC).not.toMatch(/--unlock-destructive/);
    expect(SCRIPT_SRC).not.toMatch(/unlockDestructive/);
  });

  it("`--unlock-destructive` is not in the KNOWN_FLAGS set", () => {
    const knownFlagsBlock = SCRIPT_SRC.slice(
      SCRIPT_SRC.indexOf("const KNOWN_FLAGS"),
      SCRIPT_SRC.indexOf("const RAW_ARGS"),
    );
    expect(knownFlagsBlock).toContain('"--yes"');
    expect(knownFlagsBlock).toContain('"--dry-run"');
    expect(knownFlagsBlock).not.toContain("--unlock-destructive");
  });

  it("the destructive run requires only --yes (no second unlock gate)", () => {
    // The single invocation guard for the destructive path is the --yes
    // check; there must be no remaining "destructive path is gated" die().
    expect(SCRIPT_SRC).toMatch(/destructive run requires --yes/);
    expect(SCRIPT_SRC).not.toMatch(/destructive path is gated/);
  });

  it("the dev-DB safety guard is still present (assertDevDatabase + --i-know-this-is-dev)", () => {
    // Removing the unlock gate must NOT weaken the dev-DB guard — that is the
    // load-bearing safety check against a non-dev wipe.
    expect(SCRIPT_SRC).toMatch(/assertDevDatabase/);
    expect(SCRIPT_SRC).toMatch(/--i-know-this-is-dev/);
  });
});

// Regression guard: the active-CRM-runs check originally SELECTed an
// `agent_slug` column off `agent_runs` — but no such column exists, so the
// query crashed at runtime with `column "agent_slug" does not exist` the
// first time an operator tried the dry-run end-to-end. The fix LEFT JOINs
// `agent_templates` for the human-readable `name` and falls back to the
// run id in the abort message. Pin both the corrected shape and the
// absence of any `agent_slug` reference so the bug can't reappear.
describe("active-CRM-runs query JOINs agent_templates (no `agent_slug` column on agent_runs)", () => {
  it("SELECTs id + agent_templates.name via LEFT JOIN on template_id", () => {
    expect(SCRIPT_SRC).toContain(
      'LEFT JOIN ${quoteIdent(schema)}."agent_templates" t ON t.id = r.template_id',
    );
    expect(SCRIPT_SRC).toContain("SELECT r.id, t.name AS agent_name, r.status");
  });

  it("the abort-message loop reads `agent_name` (with run-id fallback)", () => {
    expect(SCRIPT_SRC).toContain("agent=${row.agent_name ?? row.id}");
  });

  it("the script does NOT reference `agent_slug` at runtime (SQL SELECT or JS field access)", () => {
    // The two real crash sites: a SQL SELECT naming the column, or a JS
    // field access on the result row. Comments may still mention the
    // column name for documentation (why the query was changed).
    expect(SCRIPT_SRC).not.toMatch(/\brow\.agent_slug\b/);
    expect(SCRIPT_SRC).not.toMatch(/SELECT[^;]*\bagent_slug\b/);
  });
});
