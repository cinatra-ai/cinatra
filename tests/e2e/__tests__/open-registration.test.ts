/**
 * The end-to-end harnesses state the instance settings they depend on.
 *
 * Registration is closed on a fresh instance, and only the first account gets
 * in on the bootstrap exception. A harness that mints a second account has to
 * say so out loud, which is what `openRegistrationForFixtures` does; a harness
 * that wants to prove behaviour on a CLOSED instance says that with
 * `closeRegistrationForFixtures`. Both are one read-modify-write on one
 * settings row.
 *
 * These tests pin the two things that make the road safe to call from every
 * suite: it records the setting the caller asked for, and it leaves every
 * sibling setting on that row untouched. A whole-row write here would silently
 * delete a sibling, and a deleted `closedRegistration` key does not read as
 * "unchanged" — it reads as CLOSED, because only an explicit `false` opens the
 * door. That is the failure this file exists to keep out.
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

describe("closeRegistrationForFixtures", () => {
  it("records the closed choice explicitly rather than deleting the key", async () => {
    rows.set(KEY, JSON.stringify({ closedRegistration: false }));
    const { closeRegistrationForFixtures } = await import("../open-registration");
    await closeRegistrationForFixtures({ waitOutReadCache: false });
    expect(stored().closedRegistration).toBe(true);
  });

  it("keeps every sibling setting on the row", async () => {
    rows.set(KEY, JSON.stringify({ singleOrg: true, instanceNamespace: "uat" }));
    const { closeRegistrationForFixtures } = await import("../open-registration");
    await closeRegistrationForFixtures({ waitOutReadCache: false });
    const after = stored();
    expect(after.closedRegistration).toBe(true);
    expect(after.singleOrg).toBe(true);
    expect(after.instanceNamespace).toBe("uat");
  });
});

describe("patchInstanceSettingsForFixtures", () => {
  it("changes only the keys it was handed and never drops a neighbour", async () => {
    rows.set(KEY, JSON.stringify({ closedRegistration: false, instanceNamespace: "uat" }));
    const { patchInstanceSettingsForFixtures } = await import("../open-registration");
    await patchInstanceSettingsForFixtures({ singleOrg: true }, { waitOutReadCache: false });
    const after = stored();
    expect(after.singleOrg).toBe(true);
    // The registration choice a sibling suite recorded survives this write.
    // Losing it would leave the instance reading CLOSED, which is exactly how
    // a suite that opened registration ends up meeting a closed door later on.
    expect(after.closedRegistration).toBe(false);
    expect(after.instanceNamespace).toBe("uat");
  });

  it("writes nothing when every key it was handed already holds that value", async () => {
    rows.set(KEY, JSON.stringify({ singleOrg: false, closedRegistration: false }));
    const { patchInstanceSettingsForFixtures } = await import("../open-registration");
    await patchInstanceSettingsForFixtures({ singleOrg: false }, { waitOutReadCache: false });
    expect(queries.filter((q) => /INSERT/i.test(q.text))).toHaveLength(0);
  });

  it("writes when any one of the keys it was handed differs", async () => {
    rows.set(KEY, JSON.stringify({ singleOrg: false, closedRegistration: false }));
    const { patchInstanceSettingsForFixtures } = await import("../open-registration");
    await patchInstanceSettingsForFixtures(
      { singleOrg: false, closedRegistration: true },
      { waitOutReadCache: false },
    );
    expect(stored()).toEqual({ singleOrg: false, closedRegistration: true });
  });
});
