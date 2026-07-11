import { describe, it, expect } from "vitest";
import {
  CONFIG_HYDRATION_SCHEMA_KEY,
  sanitizeConfigHydrationValues,
  type ConfigHydrationKeySets,
} from "../config-hydration-contract";

// The opt-in hydration read-action contract (cinatra#1082 item 3;
// owner-ratified). The sanitizer is the SDK-owned NON-SECRET / fail-closed
// boundary: PURE, never-throwing, and independent of any host parser
// invariant (hostile results are assumed — the contract is public).

const keys = (hydratable: string[], secret: string[] = []): ConfigHydrationKeySets => ({
  hydratableKeys: new Set(hydratable),
  secretKeys: new Set(secret),
});

describe("CONFIG_HYDRATION_SCHEMA_KEY", () => {
  it("is the stable configSchema root key", () => {
    expect(CONFIG_HYDRATION_SCHEMA_KEY).toBe("hydrateAction");
  });
});

describe("sanitizeConfigHydrationValues — happy path encodings", () => {
  it("normalizes every supported value type to the form's string encoding", () => {
    const out = sanitizeConfigHydrationValues(
      {
        model: "claude-x",
        enabled: true,
        disabled: false,
        maxTokens: 4096,
        zero: 0,
        hosts: ["a.example", "b.example"],
        emptyList: [],
        emptyString: "",
      },
      keys(["model", "enabled", "disabled", "maxTokens", "zero", "hosts", "emptyList", "emptyString"]),
    );
    expect(out).toEqual({
      model: "claude-x",
      enabled: "true",
      disabled: "false",
      maxTokens: "4096",
      zero: "0",
      hosts: JSON.stringify(["a.example", "b.example"]),
      emptyList: "[]",
      emptyString: "",
    });
  });
});

describe("sanitizeConfigHydrationValues — secret refusal", () => {
  it("drops a secret field's key regardless of the returned value", () => {
    const out = sanitizeConfigHydrationValues(
      { apiKey: "sk-LEAKED", model: "m1" },
      keys(["model"], ["apiKey"]),
    );
    expect(out).toEqual({ model: "m1" });
  });

  it("secret WINS over hydratable on collision (defense in depth)", () => {
    const out = sanitizeConfigHydrationValues(
      { token: "sk-LEAKED" },
      // Caller mistake: the same key listed in BOTH sets — refusal must win.
      keys(["token"], ["token"]),
    );
    expect(out).toEqual({});
  });
});

describe("sanitizeConfigHydrationValues — fail-closed top level", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "nope"],
    ["a number", 42],
    ["an array", [{ model: "m" }]],
    ["a Date", new Date(0)],
    ["a Map", new Map([["model", "m"]])],
  ])("returns {} for %s", (_name, raw) => {
    expect(sanitizeConfigHydrationValues(raw, keys(["model"]))).toEqual({});
  });

  it("returns {} for a class instance (not exactly a plain object)", () => {
    class Sneaky {
      model = "m";
    }
    expect(sanitizeConfigHydrationValues(new Sneaky(), keys(["model"]))).toEqual({});
  });

  it("accepts a null-prototype object (still a plain data object)", () => {
    const raw = Object.create(null) as Record<string, unknown>;
    raw.model = "m";
    expect(sanitizeConfigHydrationValues(raw, keys(["model"]))).toEqual({ model: "m" });
  });
});

describe("sanitizeConfigHydrationValues — per-entry filtering", () => {
  it("drops unknown keys (not declared hydratable)", () => {
    const out = sanitizeConfigHydrationValues(
      { model: "m", stray: "x" },
      keys(["model"]),
    );
    expect(out).toEqual({ model: "m" });
  });

  it("keeps valid entries when invalid ones coexist (drop, don't discard)", () => {
    const out = sanitizeConfigHydrationValues(
      {
        model: "m",
        nan: Number.NaN,
        inf: Number.POSITIVE_INFINITY,
        nested: { a: 1 },
        mixed: ["ok", 1],
        fn: () => "x",
        big: BigInt(10) as unknown,
        nul: null,
        undef: undefined,
      },
      keys(["model", "nan", "inf", "nested", "mixed", "fn", "big", "nul", "undef"]),
    );
    expect(out).toEqual({ model: "m" });
  });

  it("refuses prototype-pollution carrier keys even when listed hydratable", () => {
    const raw = JSON.parse('{"__proto__": "x", "constructor": "y", "prototype": "z", "model": "m"}');
    const out = sanitizeConfigHydrationValues(
      raw,
      keys(["__proto__", "constructor", "prototype", "model"]),
    );
    expect(out).toEqual({ model: "m" });
    expect(Object.prototype).not.toHaveProperty("x");
  });

  it("rejects an object with a custom prototype outright (inherited props unreachable)", () => {
    // Not exactly a plain object → {} at the top level, so an inherited
    // enumerable property can never smuggle a value in.
    const proto = { inherited: "nope" };
    const raw = Object.create(proto) as Record<string, unknown>;
    raw.model = "m";
    expect(sanitizeConfigHydrationValues(raw, keys(["model", "inherited"]))).toEqual({});
  });

  it("ignores symbol keys on a plain object", () => {
    const raw: Record<string | symbol, unknown> = { model: "m" };
    raw[Symbol("sym")] = "nope";
    const out = sanitizeConfigHydrationValues(raw, keys(["model"]));
    expect(out).toEqual({ model: "m" });
  });
});

describe("sanitizeConfigHydrationValues — hostile reflection never throws", () => {
  it("returns {} for a proxy with a throwing ownKeys trap", () => {
    const raw = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("hostile ownKeys");
        },
      },
    );
    expect(sanitizeConfigHydrationValues(raw, keys(["model"]))).toEqual({});
  });

  it("returns {} (never a partial result) for a throwing getter", () => {
    const raw: Record<string, unknown> = { model: "m" };
    Object.defineProperty(raw, "boom", {
      enumerable: true,
      get() {
        throw new Error("hostile getter");
      },
    });
    expect(sanitizeConfigHydrationValues(raw, keys(["model", "boom"]))).toEqual({});
  });

  it("returns {} for a proxy with a throwing getPrototypeOf trap", () => {
    const raw = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("hostile getPrototypeOf");
        },
      },
    );
    expect(sanitizeConfigHydrationValues(raw, keys(["model"]))).toEqual({});
  });
});
