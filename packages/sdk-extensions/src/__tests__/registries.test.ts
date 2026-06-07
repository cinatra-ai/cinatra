import { describe, it, expect, beforeEach } from "vitest";
import { createExtensionRegistry } from "../registries";

describe("createExtensionRegistry", () => {
  beforeEach(() => {
    // Each test uses a uniquely-named registry so the globalThis slots don't leak.
  });

  it("registers and looks up a capability by id", () => {
    const r = createExtensionRegistry<{ v: number }>(`test-basic-${Math.random()}`);
    expect(r.has("a")).toBe(false);
    expect(r.get("a")).toBeUndefined();
    r.register("a", { v: 1 });
    expect(r.has("a")).toBe(true);
    expect(r.get("a")).toEqual({ v: 1 });
  });

  it("replaces on re-register (last write wins)", () => {
    const r = createExtensionRegistry<number>(`test-replace-${Math.random()}`);
    r.register("k", 1);
    r.register("k", 2);
    expect(r.get("k")).toBe(2);
  });

  it("lists all registered entries", () => {
    const r = createExtensionRegistry<string>(`test-list-${Math.random()}`);
    r.register("x", "X");
    r.register("y", "Y");
    expect(r.list().sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: "x", value: "X" },
      { id: "y", value: "Y" },
    ]);
  });

  it("shares the backing slot across factory calls with the SAME name (cross-bundle invariant)", () => {
    const name = `test-shared-${Math.random()}`;
    const a = createExtensionRegistry<number>(name);
    const b = createExtensionRegistry<number>(name);
    a.register("shared", 42);
    // A second handle for the same name (simulating a second compiled module
    // instance) sees the registration — this is the globalThis-Symbol guarantee
    // the whole IoC inversion depends on.
    expect(b.get("shared")).toBe(42);
  });

  it("isolates registries with DIFFERENT names", () => {
    const a = createExtensionRegistry<number>(`test-iso-a-${Math.random()}`);
    const b = createExtensionRegistry<number>(`test-iso-b-${Math.random()}`);
    a.register("k", 1);
    expect(b.has("k")).toBe(false);
  });

  it("remove() deletes a registration live (uninstall semantics) and reports presence", () => {
    const r = createExtensionRegistry<number>(`test-remove-${Math.random()}`);
    r.register("k", 1);
    expect(r.remove("k")).toBe(true);
    expect(r.has("k")).toBe(false);
    expect(r.get("k")).toBeUndefined();
    expect(r.remove("k")).toBe(false); // already gone
  });

  it("_resetForTests clears registrations", () => {
    const r = createExtensionRegistry<number>(`test-reset-${Math.random()}`);
    r.register("k", 1);
    r._resetForTests();
    expect(r.has("k")).toBe(false);
  });
});
