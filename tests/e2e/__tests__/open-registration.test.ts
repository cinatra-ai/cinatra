/**
 * The end-to-end harnesses open registration explicitly.
 *
 * Registration is closed on a fresh instance, and only the first account gets
 * in on the bootstrap exception. A harness that mints a second account has to
 * say so out loud, which is what `openRegistrationForFixtures` does. This test
 * pins the two things that make it safe to call from every suite: it opens the
 * instance, and it leaves every sibling setting on that row untouched.
 *
 * `pg` is replaced with a tiny in-memory table so the read-modify-write is
 * exercised without a real Postgres.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const rows = new Map<string, string>();
const queries: Array<{ text: string; values: unknown[] }> = [];
let connects = 0;
let ends = 0;

vi.mock("pg", () => ({
  Client: class {
    async connect() {
      connects += 1;
    }
    async end() {
      ends += 1;
    }
    async query(text: string, values: unknown[] = []) {
      queries.push({ text, values });
      if (/^\s*SELECT/i.test(text)) {
        const key = String(values[0]);
        return rows.has(key)
          ? { rowCount: 1, rows: [{ value: rows.get(key) }] }
          : { rowCount: 0, rows: [] };
      }
      rows.set(String(values[0]), String(values[1]));
      return { rowCount: 1, rows: [] };
    }
  },
}));

const KEY = "connector_config:instance_identity";

function stored(): Record<string, unknown> {
  return JSON.parse(rows.get(KEY) ?? "{}") as Record<string, unknown>;
}

beforeEach(() => {
  rows.clear();
  queries.length = 0;
  connects = 0;
  ends = 0;
});

describe("openRegistrationForFixtures", () => {
  it("opens registration on an instance that has never recorded a choice", async () => {
    const { openRegistrationForFixtures } = await import("../open-registration");
    await openRegistrationForFixtures({ waitOutReadCache: false });
    expect(stored().closedRegistration).toBe(false);
  });

  it("keeps every sibling setting on the row", async () => {
    rows.set(KEY, JSON.stringify({ singleOrg: true, instanceNamespace: "uat" }));
    const { openRegistrationForFixtures } = await import("../open-registration");
    await openRegistrationForFixtures({ waitOutReadCache: false });
    const after = stored();
    expect(after.closedRegistration).toBe(false);
    expect(after.singleOrg).toBe(true);
    expect(after.instanceNamespace).toBe("uat");
  });

  it("writes nothing when the instance is already open", async () => {
    rows.set(KEY, JSON.stringify({ closedRegistration: false }));
    const { openRegistrationForFixtures } = await import("../open-registration");
    await openRegistrationForFixtures({ waitOutReadCache: false });
    expect(queries.filter((q) => /INSERT/i.test(q.text))).toHaveLength(0);
  });

  it("survives an unreadable row rather than throwing the suite away", async () => {
    rows.set(KEY, "not json at all");
    const { openRegistrationForFixtures } = await import("../open-registration");
    await openRegistrationForFixtures({ waitOutReadCache: false });
    expect(stored().closedRegistration).toBe(false);
  });

  it("always hands the connection back", async () => {
    const { openRegistrationForFixtures } = await import("../open-registration");
    await openRegistrationForFixtures({ waitOutReadCache: false });
    expect(connects).toBe(1);
    expect(ends).toBe(1);
  });

  it("addresses the row by the schema it is given", async () => {
    const { openRegistrationForFixtures } = await import("../open-registration");
    await openRegistrationForFixtures({ schema: "other_schema", waitOutReadCache: false });
    expect(queries.every((q) => q.text.includes('"other_schema"."metadata"'))).toBe(true);
  });
});
