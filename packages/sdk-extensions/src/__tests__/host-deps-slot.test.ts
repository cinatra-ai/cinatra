// Unit tests for `createHostDepsSlot` — the single host-dependency-slot primitive
// the per-contract DI slots (action-guard, connector-config, objects-provider,
// crm-request-actor, a2a-connection, google-oauth-connection, mcp-oauth-clients,
// crm external-resolver) are migrated onto (host-deps DI slots).
//
// The two load-bearing guarantees: (1) the slot is anchored on `globalThis` under
// the GLOBAL `Symbol.for(key)` registry, so any two compiled instances of the SDK
// resolve the SAME backing slot; (2) `require` fails CLOSED with the caller's
// message, while `get` is a non-throwing probe.

import { describe, it, expect, beforeEach } from "vitest";
import { createHostDepsSlot } from "../dependencies";

type Impl = { tag: string };

const KEY = "@cinatra-ai/sdk-extensions:__test-host-deps-slot/v1";

function clearGlobal(key: string): void {
  const holder = globalThis as unknown as { [k: symbol]: unknown };
  delete holder[Symbol.for(key)];
}

describe("createHostDepsSlot", () => {
  beforeEach(() => {
    clearGlobal(KEY);
  });

  it("starts unset: get() is null", () => {
    const slot = createHostDepsSlot<Impl>(KEY);
    expect(slot.get()).toBeNull();
  });

  it("require() fails CLOSED with the caller-supplied message when unset", () => {
    const slot = createHostDepsSlot<Impl>(KEY);
    expect(() => slot.require("custom unwired message")).toThrowError("custom unwired message");
  });

  it("set() then get()/require() return the wired value", () => {
    const slot = createHostDepsSlot<Impl>(KEY);
    const impl: Impl = { tag: "wired" };
    slot.set(impl);
    expect(slot.get()).toBe(impl);
    expect(slot.require("should not throw")).toBe(impl);
  });

  it("reset() clears the slot back to unset", () => {
    const slot = createHostDepsSlot<Impl>(KEY);
    slot.set({ tag: "wired" });
    slot.reset();
    expect(slot.get()).toBeNull();
    expect(() => slot.require("unwired again")).toThrowError("unwired again");
  });

  it("set(null) is equivalent to reset()", () => {
    const slot = createHostDepsSlot<Impl>(KEY);
    slot.set({ tag: "wired" });
    slot.set(null);
    expect(slot.get()).toBeNull();
  });

  it("two slot handles built from the SAME key share ONE backing slot (cross-instance)", () => {
    // Two `createHostDepsSlot(KEY)` calls model two compiled module instances of
    // the SDK: the host wires through one, an extension resolves through the other.
    const hostSlot = createHostDepsSlot<Impl>(KEY);
    const extensionSlot = createHostDepsSlot<Impl>(KEY);
    const impl: Impl = { tag: "shared" };
    hostSlot.set(impl);
    expect(extensionSlot.get()).toBe(impl);
    expect(extensionSlot.require("should not throw")).toBe(impl);
  });

  it("the slot is anchored at globalThis[Symbol.for(key)] (key-pin)", () => {
    const slot = createHostDepsSlot<Impl>(KEY);
    const impl: Impl = { tag: "anchored" };
    slot.set(impl);
    const holder = globalThis as unknown as { [k: symbol]: unknown };
    // The public API writes to EXACTLY the global-registry symbol for `key`.
    expect(holder[Symbol.for(KEY)]).toBe(impl);
    // ...and a value placed directly on that symbol is seen by the slot.
    const direct: Impl = { tag: "direct" };
    holder[Symbol.for(KEY)] = direct;
    expect(slot.get()).toBe(direct);
  });

  it("distinct keys do not collide", () => {
    const keyA = "@cinatra-ai/sdk-extensions:__test-host-deps-slot-A/v1";
    const keyB = "@cinatra-ai/sdk-extensions:__test-host-deps-slot-B/v1";
    clearGlobal(keyA);
    clearGlobal(keyB);
    const a = createHostDepsSlot<Impl>(keyA);
    const b = createHostDepsSlot<Impl>(keyB);
    a.set({ tag: "A" });
    expect(b.get()).toBeNull();
    expect(a.get()).toEqual({ tag: "A" });
  });
});
