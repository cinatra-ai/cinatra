// The host `update` member of `@cinatra-ai/host:connector-config`: the atomic
// read-derive-persist loop, over an in-memory port that models the metadata
// row as RAW TEXT (byte compare-and-swap, an insert-if-absent that reports its
// result). Every interleaving is forced by a synchronous hook of the port,
// never by a sleep:
//   - beforePersist(n) runs right before the n-th persist statement (swap or
//     insert) of the call, i.e. inside the window between the attempt's read
//     and its persist;
//   - afterInsert() runs right after an insert landed.
// On success the cache entry is evicted after the landed write, never set.
// The ids S1-S14 are the update scenario table shared with the connectors'
// fake-store conformance tests; each case asserts the stored row FIRST.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CONNECTOR_CONFIG_UPDATE_ATTEMPTS,
  ConnectorConfigUpdateError,
  updateConnectorConfigVia,
  type ConnectorConfigUpdatePort,
} from "@/lib/connector-config-update";
import { hasSecretFields } from "@/lib/connector-config-secret-fields";

// The live Postgres binding is never reached here: every case runs over the
// in-memory port below (the binding has its own test).
vi.mock("@/lib/database-metadata", () => ({}));

const SENTINEL = "sentinel-7f3a-row-value";
const ID = "linkedin";
const KEY = `connector_config:${ID}`;
const ALLOWED_OWN_PROPERTIES = ["stack", "message", "name", "code", "key"];

type Fail = { readRaw?: unknown; compareAndSwap?: unknown; insertIfAbsent?: unknown };

function makePort(initial: Record<string, string> = {}) {
  const rows = new Map<string, string>(Object.entries(initial));
  const cache = new Map<string, unknown>();
  const logs: string[] = [];
  const calls = { readRaw: 0, compareAndSwap: 0, insertIfAbsent: 0, cacheEvict: 0, log: 0 };
  const hooks: { beforePersist?: (n: number) => void; afterInsert?: () => void } = {};
  const fail: Fail = {};
  const results: { readRaw?: () => unknown; compareAndSwap?: () => unknown; insertIfAbsent?: () => unknown } = {};
  let persists = 0;
  const port: ConnectorConfigUpdatePort = {
    readRaw(key) {
      calls.readRaw += 1;
      if (fail.readRaw) throw fail.readRaw;
      if (results.readRaw) return results.readRaw() as string | null;
      return rows.has(key) ? (rows.get(key) as string) : null;
    },
    compareAndSwap(key, nextRaw, expectedRaw) {
      calls.compareAndSwap += 1;
      persists += 1;
      hooks.beforePersist?.(persists);
      if (fail.compareAndSwap) throw fail.compareAndSwap;
      if (results.compareAndSwap) return results.compareAndSwap() as boolean;
      if (!rows.has(key) || rows.get(key) !== expectedRaw) return false;
      rows.set(key, nextRaw);
      return true;
    },
    insertIfAbsent(key, nextRaw) {
      calls.insertIfAbsent += 1;
      persists += 1;
      hooks.beforePersist?.(persists);
      if (fail.insertIfAbsent) throw fail.insertIfAbsent;
      if (results.insertIfAbsent) return results.insertIfAbsent() as boolean;
      if (rows.has(key)) return false;
      rows.set(key, nextRaw);
      hooks.afterInsert?.();
      return true;
    },
    cacheEvict(key) {
      calls.cacheEvict += 1;
      cache.delete(key);
    },
    log(line) {
      calls.log += 1;
      logs.push(line);
    },
  };
  return { port, rows, cache, logs, calls, hooks, fail, results };
}

/** A counting updater that merges `patch` into the current row. */
function merging(patch: Record<string, unknown>) {
  const seen: unknown[] = [];
  const fn = (current: unknown) => {
    seen.push(current === null ? null : structuredClone(current));
    return { ...((current as Record<string, unknown> | null) ?? {}), ...patch };
  };
  return { fn, seen };
}

function caught(run: () => void): ConnectorConfigUpdateError {
  try {
    run();
  } catch (error) {
    return error as ConnectorConfigUpdateError;
  }
  throw new Error("expected the update to throw");
}

const consoleSpies: Array<ReturnType<typeof vi.spyOn>> = [];
beforeEach(() => {
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    consoleSpies.push(vi.spyOn(console, method).mockImplementation(() => {}));
  }
});
afterEach(() => {
  for (const spy of consoleSpies.splice(0)) spy.mockRestore();
});

/** The sentinel check of the scenario table (S6, S8, S9, S13). */
function expectValueFree(error: unknown, logs: string[]) {
  const e = error as Record<string, unknown>;
  for (const text of [e.message, e.name, e.code, e.stack, String(error), JSON.stringify(error)]) {
    expect(String(text)).not.toContain(SENTINEL);
  }
  expect(e.cause).toBeUndefined();
  expect(Object.prototype.hasOwnProperty.call(error, "cause")).toBe(false);
  for (const name of Object.getOwnPropertyNames(error)) expect(ALLOWED_OWN_PROPERTIES).toContain(name);
  for (const line of logs) expect(line).not.toContain(SENTINEL);
  for (const spy of consoleSpies) {
    for (const args of spy.mock.calls) expect(JSON.stringify(args.map(String))).not.toContain(SENTINEL);
  }
}

const STORED = { clientId: "a", accounts: [{ id: "x" }], note: SENTINEL };
const STORED_RAW = JSON.stringify(STORED);

describe("connector-config update: the scenario table S1-S14", () => {
  it("S1 row present: the updater gets the parsed row, one swap, the cache entry is evicted", () => {
    const h = makePort({ [KEY]: STORED_RAW });
    h.cache.set(KEY, STORED);
    const u = merging({ clientSecret: "z" });
    updateConnectorConfigVia(h.port, ID, u.fn, hasSecretFields);
    expect(JSON.parse(h.rows.get(KEY) as string)).toEqual({ ...STORED, clientSecret: "z" });
    expect(u.seen).toEqual([STORED]);
    expect(h.calls.compareAndSwap).toBe(1);
    expect(h.calls.insertIfAbsent).toBe(0);
    expect(h.cache.has(KEY)).toBe(false);
    expect(h.calls.cacheEvict).toBe(1);
    expect(h.logs).toEqual([]);
  });

  it("S2 row absent: the updater gets null, the insert lands, exactly one readRaw", () => {
    const h = makePort();
    const u = merging({ clientId: "new" });
    updateConnectorConfigVia(h.port, ID, u.fn, hasSecretFields);
    expect(h.rows.get(KEY)).toBe(JSON.stringify({ clientId: "new" }));
    expect(u.seen).toEqual([null]);
    expect(h.calls.readRaw).toBe(1);
    expect(h.calls.insertIfAbsent).toBe(1);
    expect(h.calls.compareAndSwap).toBe(0);
    expect(h.cache.has(KEY)).toBe(false);
    expect(h.calls.cacheEvict).toBe(1);
  });

  it("S3 a change inside the window: swap 1 misses, attempt 2 merges the change", () => {
    const h = makePort({ [KEY]: STORED_RAW });
    h.hooks.beforePersist = (n) => {
      if (n === 1) h.rows.set(KEY, JSON.stringify({ ...STORED, accounts: [{ id: "x" }, { id: "y" }] }));
    };
    const u = merging({ clientSecret: "z" });
    updateConnectorConfigVia(h.port, ID, u.fn, hasSecretFields);
    expect(JSON.parse(h.rows.get(KEY) as string)).toEqual({
      ...STORED,
      accounts: [{ id: "x" }, { id: "y" }],
      clientSecret: "z",
    });
    expect(u.seen).toHaveLength(2);
    expect(h.calls.compareAndSwap).toBe(2);
  });

  it("S4a row absent, another writer creates it inside the window: the insert misses, attempt 2 swaps over the other row", () => {
    const h = makePort();
    h.hooks.beforePersist = (n) => {
      if (n === 1) h.rows.set(KEY, JSON.stringify({ accounts: [{ id: "other" }] }));
    };
    const u = merging({ clientId: "mine" });
    updateConnectorConfigVia(h.port, ID, u.fn, hasSecretFields);
    expect(JSON.parse(h.rows.get(KEY) as string)).toEqual({ accounts: [{ id: "other" }], clientId: "mine" });
    expect(u.seen).toEqual([null, { accounts: [{ id: "other" }] }]);
    expect(h.calls.insertIfAbsent).toBe(1);
    expect(h.calls.compareAndSwap).toBe(1);
  });

  it("S4b an insert that lands is done at once: another merge right after it is kept, and nothing throws", () => {
    const h = makePort();
    h.hooks.afterInsert = () => {
      // Another writer's merge over the row this call just inserted.
      const row = JSON.parse(h.rows.get(KEY) as string) as Record<string, unknown>;
      h.rows.set(KEY, JSON.stringify({ ...row, accounts: [{ id: "other" }] }));
    };
    const u = merging({ clientId: "mine" });
    expect(() => updateConnectorConfigVia(h.port, ID, u.fn, hasSecretFields)).not.toThrow();
    expect(JSON.parse(h.rows.get(KEY) as string)).toEqual({ clientId: "mine", accounts: [{ id: "other" }] });
    expect(u.seen).toHaveLength(1);
    expect(h.calls.readRaw).toBe(1);
    expect(h.calls.compareAndSwap).toBe(0);
    // The cache never holds this call's value: the next read gets the other writer's merge.
    expect(h.cache.has(KEY)).toBe(false);
    expect(h.logs).toEqual([]);
  });

  it("S4c another writer inserts bytes EQUAL to this call's next row: the missed insert is not success, attempt 2 runs", () => {
    const h = makePort();
    const nextRaw = JSON.stringify({ clientId: "mine" });
    h.hooks.beforePersist = (n) => {
      if (n === 1) h.rows.set(KEY, nextRaw);
    };
    const u = merging({ clientId: "mine" });
    updateConnectorConfigVia(h.port, ID, u.fn, hasSecretFields);
    expect(h.rows.get(KEY)).toBe(nextRaw);
    expect(u.seen).toEqual([null, { clientId: "mine" }]);
    expect(h.calls.readRaw).toBe(2);
    expect(h.calls.insertIfAbsent).toBe(1);
    expect(h.calls.compareAndSwap).toBe(1);
  });

  it("S5 a stale cache entry and a newer stored row: the updater sees the stored row", () => {
    const h = makePort({ [KEY]: JSON.stringify({ accounts: [{ id: "x" }, { id: "y" }] }) });
    h.cache.set(KEY, { accounts: [{ id: "x" }] });
    const u = merging({ loggingEnabled: false });
    updateConnectorConfigVia(h.port, ID, u.fn, hasSecretFields);
    expect(u.seen).toEqual([{ accounts: [{ id: "x" }, { id: "y" }] }]);
    expect(JSON.parse(h.rows.get(KEY) as string)).toEqual({
      accounts: [{ id: "x" }, { id: "y" }],
      loggingEnabled: false,
    });
    expect(h.cache.has(KEY)).toBe(false);
  });

  it("S6 a change before every persist: CONFLICT after 5 attempts, the competitor's last row stays, the cache is evicted", () => {
    const h = makePort({ [KEY]: STORED_RAW });
    h.cache.set(KEY, STORED);
    const competitor = (n: number) => JSON.stringify({ ...STORED, round: n, secret: SENTINEL });
    h.hooks.beforePersist = (n) => h.rows.set(KEY, competitor(n));
    const u = merging({ clientSecret: SENTINEL });
    const error = caught(() => updateConnectorConfigVia(h.port, ID, u.fn, hasSecretFields));
    expect(h.rows.get(KEY)).toBe(competitor(CONNECTOR_CONFIG_UPDATE_ATTEMPTS));
    expect(error).toBeInstanceOf(ConnectorConfigUpdateError);
    expect(error.code).toBe("CONNECTOR_CONFIG_CONFLICT");
    expect(error.name).toBe("ConnectorConfigConflictError");
    expect(error.key).toBe(KEY);
    expect(error.message).toBe(`Connector config ${KEY} changed under every update attempt; nothing was written.`);
    expect(u.seen).toHaveLength(5);
    expect(h.calls.readRaw).toBe(5);
    expect(h.calls.compareAndSwap).toBe(5);
    expect(h.cache.has(KEY)).toBe(false);
    expect(h.logs).toEqual([`[connector-config.update] key=${KEY} code=CONNECTOR_CONFIG_CONFLICT`]);
    expectValueFree(error, h.logs);
  });

  it.each([
    ["{not json", "S7 text that is not JSON"],
    ["", "S7 an empty text"],
  ])("%j (%s): ROW_UNPARSEABLE, the updater is never called, nothing is persisted", (raw) => {
    const h = makePort({ [KEY]: raw });
    const u = merging({ clientId: "z" });
    const error = caught(() => updateConnectorConfigVia(h.port, ID, u.fn, hasSecretFields));
    expect(h.rows.get(KEY)).toBe(raw);
    expect(error.code).toBe("CONNECTOR_CONFIG_ROW_UNPARSEABLE");
    expect(error.message).toBe(`Connector config ${KEY} holds text that is not JSON; nothing was written.`);
    expect(u.seen).toHaveLength(0);
    expect(h.calls.compareAndSwap + h.calls.insertIfAbsent).toBe(0);
    expect(h.logs).toEqual([`[connector-config.update] key=${KEY} code=CONNECTOR_CONFIG_ROW_UNPARSEABLE`]);
  });

  it("S8 the updater throws: UPDATER_FAILED, no persist, no further attempt, the thrown error is dropped", () => {
    const h = makePort({ [KEY]: STORED_RAW });
    let calls = 0;
    const error = caught(() =>
      updateConnectorConfigVia(
        h.port,
        ID,
        () => {
          calls += 1;
          throw Object.assign(new Error(SENTINEL), { code: SENTINEL, cause: SENTINEL });
        },
        hasSecretFields,
      ),
    );
    expect(h.rows.get(KEY)).toBe(STORED_RAW);
    expect(error.code).toBe("CONNECTOR_CONFIG_UPDATER_FAILED");
    expect(error.message).toBe(`Connector config ${KEY}: the updater failed; nothing was written.`);
    expect(calls).toBe(1);
    expect(h.calls.readRaw).toBe(1);
    expect(h.calls.compareAndSwap + h.calls.insertIfAbsent).toBe(0);
    expectValueFree(error, h.logs);
  });

  const cyclic: Record<string, unknown> = { note: SENTINEL };
  cyclic.self = cyclic;
  const throwingThen = {
    note: SENTINEL,
    get then() {
      throw new Error(SENTINEL);
    },
  };
  it.each([
    ["undefined", () => undefined],
    ["a function", () => () => SENTINEL],
    ["a thenable object", () => ({ note: SENTINEL, then: () => undefined })],
    ["a thenable promise", () => Promise.resolve(SENTINEL)],
    ["an object whose then getter throws", () => throwingThen],
    ["a cyclic object", () => cyclic],
    ["a bigint", () => BigInt(7)],
    ["a symbol", () => Symbol(SENTINEL)],
  ])("S9 the updater returns %s: UPDATE_INVALID, no persist", (_label, updater) => {
    const h = makePort({ [KEY]: STORED_RAW });
    const error = caught(() => updateConnectorConfigVia(h.port, ID, updater, hasSecretFields));
    expect(h.rows.get(KEY)).toBe(STORED_RAW);
    expect(error.code).toBe("CONNECTOR_CONFIG_UPDATE_INVALID");
    expect(error.message).toBe(`Connector config ${KEY}: the updater returned no storable value; nothing was written.`);
    expect(h.calls.compareAndSwap + h.calls.insertIfAbsent).toBe(0);
    expect(h.calls.readRaw).toBe(1);
    expectValueFree(error, h.logs);
  });

  it("S10 ABA: the row goes to B and back to A inside the window; swap 1 lands with f(A)", () => {
    const h = makePort({ [KEY]: STORED_RAW });
    h.hooks.beforePersist = (n) => {
      if (n !== 1) return;
      h.rows.set(KEY, JSON.stringify({ other: "B" }));
      h.rows.set(KEY, STORED_RAW);
    };
    const u = merging({ clientSecret: "z" });
    updateConnectorConfigVia(h.port, ID, u.fn, hasSecretFields);
    expect(JSON.parse(h.rows.get(KEY) as string)).toEqual({ ...STORED, clientSecret: "z" });
    expect(u.seen).toHaveLength(1);
    expect(h.calls.compareAndSwap).toBe(1);
  });

  it("S11 a delete inside the window: swap 1 misses, attempt 2 gets null and inserts", () => {
    const h = makePort({ [KEY]: STORED_RAW });
    h.hooks.beforePersist = (n) => {
      if (n === 1) h.rows.delete(KEY);
    };
    const u = merging({ clientSecret: "z" });
    updateConnectorConfigVia(h.port, ID, u.fn, hasSecretFields);
    expect(JSON.parse(h.rows.get(KEY) as string)).toEqual({ clientSecret: "z" });
    expect(u.seen).toEqual([STORED, null]);
    expect(h.calls.compareAndSwap).toBe(1);
    expect(h.calls.insertIfAbsent).toBe(1);
  });

  it("S12 a sealed id (nango): UNSUPPORTED before any store call; the cache entry is evicted and one line logged", () => {
    const h = makePort({ "connector_config:nango": JSON.stringify({ secretKey: SENTINEL }) });
    const u = merging({ serverUrl: "https://n" });
    const error = caught(() => updateConnectorConfigVia(h.port, "nango", u.fn, hasSecretFields));
    expect(h.rows.get("connector_config:nango")).toBe(JSON.stringify({ secretKey: SENTINEL }));
    expect(error.code).toBe("CONNECTOR_CONFIG_UPDATE_UNSUPPORTED");
    expect(error.message).toBe(
      "Connector config connector_config:nango has sealed fields; update is not supported for it; nothing was written.",
    );
    expect(u.seen).toHaveLength(0);
    expect(h.calls.readRaw + h.calls.compareAndSwap + h.calls.insertIfAbsent).toBe(0);
    expect(h.calls.cacheEvict).toBe(1);
    expect(h.logs).toEqual(["[connector-config.update] key=connector_config:nango code=CONNECTOR_CONFIG_UPDATE_UNSUPPORTED"]);
    expectValueFree(error, h.logs);
  });

  const storeError = () => Object.assign(new Error(SENTINEL), { code: "40001" });
  it.each([
    ["readRaw", { [KEY]: STORED_RAW }],
    ["readRaw", {}],
    ["compareAndSwap", { [KEY]: STORED_RAW }],
    ["insertIfAbsent", {}],
  ] as const)("S13 %s throws (initial rows %j): STORE_FAILED, no retry, one log line with the SQLSTATE", (step, initial) => {
    const h = makePort({ ...initial });
    h.cache.set(KEY, STORED);
    h.fail[step] = storeError();
    const u = merging({ clientSecret: "z" });
    const error = caught(() => updateConnectorConfigVia(h.port, ID, u.fn, hasSecretFields));
    expect(h.rows.get(KEY)).toBe((initial as Record<string, string>)[KEY]);
    expect(error.code).toBe("CONNECTOR_CONFIG_STORE_FAILED");
    expect(error.message).toBe(`Connector config ${KEY}: the store failed; the row may or may not have changed.`);
    expect(h.calls.readRaw).toBe(1);
    expect(h.calls.compareAndSwap + h.calls.insertIfAbsent).toBe(step === "readRaw" ? 0 : 1);
    expect(h.cache.has(KEY)).toBe(false);
    expect(h.logs).toEqual([
      `[connector-config.update] key=${KEY} code=CONNECTOR_CONFIG_STORE_FAILED sqlstate=40001`,
    ]);
    expectValueFree(error, h.logs);
  });

  it("S14 a key-reordered rewrite inside the window changes the bytes: swap 1 misses, attempt 2 lands", () => {
    const h = makePort({ [KEY]: JSON.stringify({ a: 1, b: 2 }) });
    h.hooks.beforePersist = (n) => {
      if (n === 1) h.rows.set(KEY, JSON.stringify({ b: 2, a: 1 }));
    };
    const u = merging({ c: 3 });
    updateConnectorConfigVia(h.port, ID, u.fn, hasSecretFields);
    expect(h.rows.get(KEY)).toBe(JSON.stringify({ b: 2, a: 1, c: 3 }));
    expect(u.seen).toHaveLength(2);
    expect(h.calls.compareAndSwap).toBe(2);
  });
});

describe("connector-config update: the storable value is an allow-list of JSON kinds", () => {
  class Settings {
    note = SENTINEL;
  }
  const nestedCycle = () => {
    const row: Record<string, unknown> = { note: SENTINEL, inner: {} };
    (row.inner as Record<string, unknown>).back = row;
    return row;
  };
  class Rows extends Array<unknown> {}
  const deepChain = () => {
    let row: unknown = SENTINEL;
    for (let i = 0; i < 100_000; i += 1) row = { row };
    return row;
  };
  it.each([
    ["NaN", () => ({ note: SENTINEL, n: NaN })],
    ["Infinity", () => ({ note: SENTINEL, n: Infinity })],
    ["-Infinity", () => [SENTINEL, -Infinity]],
    ["a top-level NaN", () => NaN],
    ["a Map", () => ({ m: new Map([["k", SENTINEL]]) })],
    ["a Set", () => new Set([SENTINEL])],
    ["a Date", () => ({ note: SENTINEL, at: new Date(0) })],
    ["a nested function", () => ({ note: SENTINEL, f: () => SENTINEL })],
    ["a nested symbol", () => ({ note: SENTINEL, s: Symbol(SENTINEL) })],
    ["a symbol key", () => ({ [Symbol("k")]: SENTINEL, note: SENTINEL })],
    ["a nested bigint", () => ({ note: SENTINEL, n: BigInt(7) })],
    ["a class instance", () => new Settings()],
    ["a boxed number", () => ({ note: SENTINEL, n: Object(1) as unknown })],
    ["an accessor property", () => ({ get note() { return SENTINEL; } })],
    ["an array hole", () => {
      const holey: unknown[] = new Array(3);
      holey[0] = SENTINEL;
      holey[2] = SENTINEL;
      return holey;
    }],
    ["undefined in an array", () => [SENTINEL, undefined]],
    ["a nested cycle", nestedCycle],
    ["an Array subclass instance", () => Rows.from([SENTINEL])],
    ["an array with an extra key", () => Object.assign([SENTINEL], { x: SENTINEL })],
    ["an array with a trailing hole", () => {
      const trailing: unknown[] = [SENTINEL];
      trailing.length = 2;
      return trailing;
    }],
    ["an array with a hole and an extra key", () => {
      const holey: unknown[] = new Array(3);
      holey[0] = SENTINEL;
      holey[2] = SENTINEL;
      return Object.assign(holey, { x: SENTINEL });
    }],
    ["a non-enumerable property", () => Object.defineProperty({ a: 1 }, "hidden", { value: SENTINEL, enumerable: false })],
    ["a proxy whose ownKeys trap throws", () => new Proxy({ note: SENTINEL }, {
      ownKeys() {
        throw new Error(SENTINEL);
      },
    })],
    ["a 100000-deep chain", deepChain],
    ["a thenable whose then throws", () => ({
      note: SENTINEL,
      then() {
        throw 0;
      },
    })],
    ["a proxy whose getPrototypeOf trap throws", () => new Proxy({ note: SENTINEL }, {
      getPrototypeOf() {
        throw new Error(SENTINEL);
      },
    })],
    ["a proxy whose own key has no descriptor", () => new Proxy({}, {
      ownKeys: () => ["note"],
      getOwnPropertyDescriptor: () => undefined,
      get: () => SENTINEL,
    })],
    ["a proxy whose then read throws", () => new Proxy({ note: SENTINEL }, {
      get(target, name) {
        if (name === "then") throw new Error(SENTINEL);
        return Reflect.get(target, name);
      },
    })],
  ])("C1 the updater returns a value with %s: UPDATE_INVALID before any store call", (_label, updater) => {
    const h = makePort({ [KEY]: STORED_RAW });
    const error = caught(() => updateConnectorConfigVia(h.port, ID, updater as () => unknown, hasSecretFields));
    expect(h.rows.get(KEY)).toBe(STORED_RAW);
    expect(error.code).toBe("CONNECTOR_CONFIG_UPDATE_INVALID");
    expect(h.calls.compareAndSwap + h.calls.insertIfAbsent).toBe(0);
    expect(h.calls.readRaw).toBe(1);
    expect(h.calls.cacheEvict).toBe(1);
    expectValueFree(error, h.logs);
  });

  it.each([
    ["nested objects and arrays", () => ({ b: 2, a: [1, { c: null }], s: "\u00e9", t: false, n: 1.5 })],
    ["a null-prototype object", () => Object.assign(Object.create(null), { a: 1 })],
    ["an own __proto__ key", () => JSON.parse('{"__proto__":{"x":1},"y":2}')],
    ["a shared (acyclic) reference", () => {
      const shared = { s: 1 };
      return { a: shared, b: shared };
    }],
    ["an object property that is undefined (dropped, as JSON drops it)", () => ({ a: 1, gone: undefined })],
    ["a plain object with a non-function then", () => ({ then: "later" })],
  ])("C1 an allowed value (%s) is stored byte-equal to its JSON text", (_label, make) => {
    const h = makePort({ [KEY]: STORED_RAW });
    updateConnectorConfigVia(h.port, ID, make, hasSecretFields);
    expect(h.rows.get(KEY)).toBe(JSON.stringify(make()));
    expect(h.calls.compareAndSwap).toBe(1);
  });

  it("C7 an async updater that rejects: UPDATE_INVALID, and its rejection is handled (no unhandled rejection)", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const h = makePort({ [KEY]: STORED_RAW });
      const error = caught(() =>
        updateConnectorConfigVia(
          h.port,
          ID,
          async () => {
            throw new Error(SENTINEL);
          },
          hasSecretFields,
        ),
      );
      expect(error.code).toBe("CONNECTOR_CONFIG_UPDATE_INVALID");
      expect(h.calls.compareAndSwap + h.calls.insertIfAbsent).toBe(0);
      // An unhandled rejection is reported after the microtask queue drains: wait two macrotasks.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
      expectValueFree(error, h.logs);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("C7 a thenable whose then returns a rejected promise: UPDATE_INVALID, and that rejection is handled", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const h = makePort({ [KEY]: STORED_RAW });
      const thenable = { note: SENTINEL, then: () => Promise.reject(new Error(SENTINEL)) };
      const error = caught(() => updateConnectorConfigVia(h.port, ID, () => thenable, hasSecretFields));
      expect(error.code).toBe("CONNECTOR_CONFIG_UPDATE_INVALID");
      expect(h.calls.compareAndSwap + h.calls.insertIfAbsent).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
      expectValueFree(error, h.logs);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("C7 a thenable whose then returns a function-typed thenable: UPDATE_INVALID, and that thenable's rejection is handled", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const h = makePort({ [KEY]: STORED_RAW });
      const thenable = {
        note: SENTINEL,
        then: () => {
          const inner = Promise.reject(new Error(SENTINEL));
          // A function with its own `then`: a thenable of typeof "function".
          return Object.assign(() => SENTINEL, {
            then: (onFulfilled?: () => unknown, onRejected?: (reason: unknown) => unknown) => inner.then(onFulfilled, onRejected),
          });
        },
      };
      const error = caught(() => updateConnectorConfigVia(h.port, ID, () => thenable, hasSecretFields));
      expect(error.code).toBe("CONNECTOR_CONFIG_UPDATE_INVALID");
      expect(h.calls.compareAndSwap + h.calls.insertIfAbsent).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
      expectValueFree(error, h.logs);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("C7 a thenable whose then returns a non-thenable object: UPDATE_INVALID, and that object's then is read exactly once", () => {
    const h = makePort({ [KEY]: STORED_RAW });
    let calls = 0;
    let reads = 0;
    const returned = {
      note: SENTINEL,
      get then() {
        reads += 1;
        return "later";
      },
    };
    const thenable = {
      note: SENTINEL,
      then: () => {
        calls += 1;
        return returned;
      },
    };
    const error = caught(() => updateConnectorConfigVia(h.port, ID, () => thenable, hasSecretFields));
    expect(error.code).toBe("CONNECTOR_CONFIG_UPDATE_INVALID");
    expect(h.calls.compareAndSwap + h.calls.insertIfAbsent).toBe(0);
    expect(calls).toBe(1);
    expect(reads).toBe(1);
    expectValueFree(error, h.logs);
  });

  it("C7 a thenable whose then returns a primitive: UPDATE_INVALID, and no then of that primitive is read", () => {
    const h = makePort({ [KEY]: STORED_RAW });
    let calls = 0;
    let reads = 0;
    const thenable = {
      note: SENTINEL,
      then: () => {
        calls += 1;
        return 7;
      },
    };
    // A read of `then` on the number 7 reaches Number.prototype: count it for this call only.
    const before = Object.getOwnPropertyDescriptor(Number.prototype, "then");
    Object.defineProperty(Number.prototype, "then", {
      configurable: true,
      get() {
        reads += 1;
        return undefined;
      },
    });
    const error = (() => {
      try {
        return caught(() => updateConnectorConfigVia(h.port, ID, () => thenable, hasSecretFields));
      } finally {
        if (before) Object.defineProperty(Number.prototype, "then", before);
        else Reflect.deleteProperty(Number.prototype, "then");
      }
    })();
    expect(Object.getOwnPropertyDescriptor(Number.prototype, "then")).toEqual(before);
    expect(error.code).toBe("CONNECTOR_CONFIG_UPDATE_INVALID");
    expect(h.calls.compareAndSwap + h.calls.insertIfAbsent).toBe(0);
    expect(calls).toBe(1);
    expect(reads).toBe(0);
    expectValueFree(error, h.logs);
  });
});

describe("connector-config update: the remaining branches", () => {
  it("a store error whose code is not a SQLSTATE logs no sqlstate", () => {
    const h = makePort({ [KEY]: STORED_RAW });
    h.fail.compareAndSwap = Object.assign(new Error(SENTINEL), { code: SENTINEL });
    const error = caught(() => updateConnectorConfigVia(h.port, ID, merging({}).fn, hasSecretFields));
    expect(error.code).toBe("CONNECTOR_CONFIG_STORE_FAILED");
    expect(h.logs).toEqual([`[connector-config.update] key=${KEY} code=CONNECTOR_CONFIG_STORE_FAILED`]);
    expectValueFree(error, h.logs);
  });

  it.each([
    ["an own code GETTER", () => Object.defineProperty(new Error(SENTINEL), "code", { get: () => "40001" })],
    ["an inherited code", () => Object.create(Object.assign(new Error(SENTINEL), { code: "40001" }))],
    ["a thrown string", () => SENTINEL],
    ["a thrown null", () => null],
    ["a lower-case code", () => Object.assign(new Error(SENTINEL), { code: "40p01" })],
    ["an own code of six characters", () => Object.assign(new Error(SENTINEL), { code: "400011" })],
    ["an own code of four characters", () => Object.assign(new Error(SENTINEL), { code: "4000" })],
    ["an own code with a SQLSTATE at its end", () => Object.assign(new Error(SENTINEL), { code: "XX40001" })],
    ["an own code with a SQLSTATE at its start", () =>
      Object.assign(new Error(SENTINEL), { code: `40001-${SENTINEL.toUpperCase()}` })],
    ["a proxy whose getOwnPropertyDescriptor trap throws", () =>
      new Proxy(Object.assign(new Error(SENTINEL), { code: "40001" }), {
        getOwnPropertyDescriptor() {
          throw new Error(SENTINEL);
        },
      })],
  ])("a store error with %s logs no sqlstate", (_label, make) => {
    const h = makePort({ [KEY]: STORED_RAW });
    h.port.readRaw = () => {
      throw make();
    };
    const error = caught(() => updateConnectorConfigVia(h.port, ID, merging({}).fn, hasSecretFields));
    expect(error.code).toBe("CONNECTOR_CONFIG_STORE_FAILED");
    expect(h.logs).toEqual([`[connector-config.update] key=${KEY} code=CONNECTOR_CONFIG_STORE_FAILED`]);
    expectValueFree(error, h.logs);
  });

  it("a store error that is a thrown function with an own code 40001 logs sqlstate=40001", () => {
    const h = makePort({ [KEY]: STORED_RAW });
    h.port.readRaw = () => {
      throw Object.assign(function storeFailure() {}, { code: "40001" });
    };
    const error = caught(() => updateConnectorConfigVia(h.port, ID, merging({}).fn, hasSecretFields));
    expect(error.code).toBe("CONNECTOR_CONFIG_STORE_FAILED");
    expect(h.logs).toEqual([`[connector-config.update] key=${KEY} code=CONNECTOR_CONFIG_STORE_FAILED sqlstate=40001`]);
    expectValueFree(error, h.logs);
  });

  it.each([
    ["readRaw returns undefined", "readRaw", () => undefined],
    ["readRaw returns a number", "readRaw", () => 7],
    ["compareAndSwap returns a truthy non-boolean", "compareAndSwap", () => 1],
    ["insertIfAbsent returns undefined", "insertIfAbsent", () => undefined],
  ] as const)("a port result outside its contract (%s) refuses with STORE_FAILED, never success or a retry", (_l, step, result) => {
    const h = makePort(step === "insertIfAbsent" ? {} : { [KEY]: STORED_RAW });
    h.results[step] = result;
    const u = merging({ clientSecret: "z" });
    const error = caught(() => updateConnectorConfigVia(h.port, ID, u.fn, hasSecretFields));
    expect(error.code).toBe("CONNECTOR_CONFIG_STORE_FAILED");
    expect(h.calls.readRaw).toBe(1);
    expect(h.calls.cacheEvict).toBe(1);
    expect(h.logs).toEqual([`[connector-config.update] key=${KEY} code=CONNECTOR_CONFIG_STORE_FAILED`]);
  });

  it("an updater that returns null stores the JSON text null", () => {
    const h = makePort({ [KEY]: STORED_RAW });
    updateConnectorConfigVia(h.port, ID, () => null, hasSecretFields);
    expect(h.rows.get(KEY)).toBe("null");
    expect(h.cache.has(KEY)).toBe(false);
  });

  it("a stored row that is valid JSON but not an object reaches the updater as parsed (the caller's rule decides)", () => {
    const h = makePort({ [KEY]: "true" });
    const seen: unknown[] = [];
    const error = caught(() =>
      updateConnectorConfigVia(
        h.port,
        ID,
        (current) => {
          seen.push(current);
          throw new Error("not a plain object");
        },
        hasSecretFields,
      ),
    );
    expect(error.code).toBe("CONNECTOR_CONFIG_UPDATER_FAILED");
    expect(seen).toEqual([true]);
    expect(h.rows.get(KEY)).toBe("true");
  });

  it.each([
    ["compareAndSwap", { [KEY]: STORED_RAW }],
    ["insertIfAbsent", {}],
  ] as const)("the eviction runs after the %s landed (initial rows %j), once, before success", (_step, initial) => {
    const h = makePort({ ...initial });
    h.cache.set(KEY, STORED);
    const atEvict: Array<string | undefined> = [];
    h.port.cacheEvict = (key) => {
      atEvict.push(h.rows.get(KEY));
      h.cache.delete(key);
    };
    updateConnectorConfigVia(h.port, ID, merging({ clientSecret: "z" }).fn, hasSecretFields);
    expect(atEvict).toEqual([h.rows.get(KEY)]);
    expect(JSON.parse(h.rows.get(KEY) as string)).toMatchObject({ clientSecret: "z" });
    expect(h.cache.has(KEY)).toBe(false);
  });

  it("an evict that throws after the persist landed: STORE_FAILED (the row changed), never success; one value-free line", () => {
    const h = makePort({ [KEY]: STORED_RAW });
    let evicts = 0;
    h.port.cacheEvict = () => {
      evicts += 1;
      throw new Error(SENTINEL);
    };
    const error = caught(() => updateConnectorConfigVia(h.port, ID, merging({ clientSecret: "z" }).fn, hasSecretFields));
    expect(JSON.parse(h.rows.get(KEY) as string)).toEqual({ ...STORED, clientSecret: "z" });
    expect(error.code).toBe("CONNECTOR_CONFIG_STORE_FAILED");
    expect(evicts).toBe(2);
    expect(h.calls.compareAndSwap).toBe(1);
    expect(h.logs).toEqual([`[connector-config.update] key=${KEY} code=CONNECTOR_CONFIG_STORE_FAILED`]);
    expectValueFree(error, h.logs);
  });

  it("an evict that throws on an error path does not replace the value-free error; the old entry may remain", () => {
    const h = makePort({ [KEY]: "{not json" });
    h.cache.set(KEY, STORED);
    h.port.cacheEvict = () => {
      throw new Error(SENTINEL);
    };
    const error = caught(() => updateConnectorConfigVia(h.port, ID, merging({}).fn, hasSecretFields));
    expect(error.code).toBe("CONNECTOR_CONFIG_ROW_UNPARSEABLE");
    expect(h.cache.get(KEY)).toEqual(STORED);
    expect(h.logs).toEqual([`[connector-config.update] key=${KEY} code=CONNECTOR_CONFIG_ROW_UNPARSEABLE`]);
    expectValueFree(error, h.logs);
  });

  it.each([
    ["compareAndSwap", { [KEY]: STORED_RAW }],
    ["insertIfAbsent", {}],
  ] as const)("a %s that commits and then throws (initial rows %j): STORE_FAILED, no retry, the row holds this call's value", (step, initial) => {
    const h = makePort({ ...initial });
    h.cache.set(KEY, STORED);
    const landed = h.port[step] as (...args: string[]) => boolean;
    Object.assign(h.port, {
      [step]: (...args: string[]) => {
        expect(landed(...args)).toBe(true);
        throw Object.assign(new Error(SENTINEL), { code: "08006" });
      },
    });
    const error = caught(() => updateConnectorConfigVia(h.port, ID, merging({ clientSecret: "z" }).fn, hasSecretFields));
    expect(JSON.parse(h.rows.get(KEY) as string)).toMatchObject({ clientSecret: "z" });
    expect(error.code).toBe("CONNECTOR_CONFIG_STORE_FAILED");
    expect(h.calls.readRaw).toBe(1);
    expect(h.calls.compareAndSwap + h.calls.insertIfAbsent).toBe(1);
    expect(h.cache.has(KEY)).toBe(false);
    expect(h.logs).toEqual([`[connector-config.update] key=${KEY} code=CONNECTOR_CONFIG_STORE_FAILED sqlstate=08006`]);
    expectValueFree(error, h.logs);
  });

  it("a log port that throws does not replace the value-free error", () => {
    const h = makePort({ [KEY]: "{not json" });
    h.port.log = () => {
      throw new Error(SENTINEL);
    };
    const error = caught(() => updateConnectorConfigVia(h.port, ID, merging({}).fn, hasSecretFields));
    expect(error.code).toBe("CONNECTOR_CONFIG_ROW_UNPARSEABLE");
    expectValueFree(error, []);
  });

  it("an unexpected internal throw (the sealed-id check) maps to STORE_FAILED and touches no store", () => {
    const h = makePort({ [KEY]: STORED_RAW });
    const error = caught(() =>
      updateConnectorConfigVia(h.port, ID, merging({}).fn, () => {
        throw new Error(SENTINEL);
      }),
    );
    expect(error.code).toBe("CONNECTOR_CONFIG_STORE_FAILED");
    expect(h.calls.readRaw + h.calls.compareAndSwap + h.calls.insertIfAbsent).toBe(0);
    expect(h.rows.get(KEY)).toBe(STORED_RAW);
    expectValueFree(error, h.logs);
  });

  it("the bound: never more than 5 reads, 5 updater calls and 5 persists per call", () => {
    const h = makePort();
    h.hooks.beforePersist = (n) => h.rows.set(KEY, JSON.stringify({ n }));
    h.rows.delete(KEY);
    const u = merging({});
    const error = caught(() => updateConnectorConfigVia(h.port, ID, u.fn, hasSecretFields));
    expect(error.code).toBe("CONNECTOR_CONFIG_CONFLICT");
    expect(h.rows.get(KEY)).toBe(JSON.stringify({ n: 5 }));
    expect(h.calls.readRaw).toBe(5);
    expect(u.seen).toHaveLength(5);
    expect(h.calls.compareAndSwap + h.calls.insertIfAbsent).toBe(5);
  });

  it("every error class carries code and key as own strings, readable without instanceof", () => {
    const h = makePort({ [KEY]: "{not json" });
    const error = caught(() => updateConnectorConfigVia(h.port, ID, merging({}).fn, hasSecretFields));
    expect(Object.getOwnPropertyDescriptor(error, "code")?.value).toBe("CONNECTOR_CONFIG_ROW_UNPARSEABLE");
    expect(Object.getOwnPropertyDescriptor(error, "key")?.value).toBe(KEY);
    expect(error.name).toBe("ConnectorConfigRowUnparseableError");
    expect(error).toBeInstanceOf(Error);
  });
});
