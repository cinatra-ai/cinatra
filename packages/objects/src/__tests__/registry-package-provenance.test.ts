// Object type registry — package provenance + removeByPackage teardown.
//
// The runtime extension teardown hook (archive / uninstall) deregisters an
// extension's object types from the process-global registry by package. This
// test pins the pure registry mechanics: provenance recording, getTypesForPackage,
// and removeByPackage (which must NEVER touch built-in/host types registered
// without a package).

import { describe, it, expect, beforeEach } from "vitest";

import { objectTypeRegistry } from "../registry";
import type { ObjectTypeDefinition } from "../types";

// Minimal fixture — only `type`/`category` are exercised by these tests; the
// rest of ObjectTypeDefinition is irrelevant to provenance bookkeeping.
function def(type: string): ObjectTypeDefinition<unknown> {
  return { type, category: "report" } as unknown as ObjectTypeDefinition<unknown>;
}

describe("objectTypeRegistry — package provenance + removeByPackage", () => {
  beforeEach(() => {
    objectTypeRegistry._clearForTests();
  });

  it("records provenance and lists a package's types", () => {
    objectTypeRegistry.register(def("@scope/a:one"), "@scope/a");
    objectTypeRegistry.register(def("@scope/a:two"), "@scope/a");
    objectTypeRegistry.register(def("@scope/b:one"), "@scope/b");

    expect(new Set(objectTypeRegistry.getTypesForPackage("@scope/a"))).toEqual(
      new Set(["@scope/a:one", "@scope/a:two"]),
    );
    expect(objectTypeRegistry.getTypesForPackage("@scope/b")).toEqual(["@scope/b:one"]);
    expect(objectTypeRegistry.getTypesForPackage("@scope/none")).toEqual([]);
  });

  it("removeByPackage deregisters ONLY the named package's types and returns them", () => {
    objectTypeRegistry.register(def("@scope/a:one"), "@scope/a");
    objectTypeRegistry.register(def("@scope/a:two"), "@scope/a");
    objectTypeRegistry.register(def("@scope/b:one"), "@scope/b");

    const removed = objectTypeRegistry.removeByPackage("@scope/a");

    expect(new Set(removed)).toEqual(new Set(["@scope/a:one", "@scope/a:two"]));
    // a's types are gone from the registry...
    expect(objectTypeRegistry.resolve("@scope/a:one")).toBeNull();
    expect(objectTypeRegistry.resolve("@scope/a:two")).toBeNull();
    // ...b's type survives.
    expect(objectTypeRegistry.resolve("@scope/b:one")).not.toBeNull();
    // provenance index cleared too.
    expect(objectTypeRegistry.getTypesForPackage("@scope/a")).toEqual([]);
  });

  it("never removes built-in/host types registered without a package", () => {
    objectTypeRegistry.register(def("@cinatra-ai/objects:builtin")); // no provenance
    objectTypeRegistry.register(def("@scope/a:one"), "@scope/a");

    // Removing by the built-in's own type-string-as-package is a no-op...
    expect(objectTypeRegistry.removeByPackage("@cinatra-ai/objects:builtin")).toEqual([]);
    // ...and the built-in stays registered after any package teardown.
    objectTypeRegistry.removeByPackage("@scope/a");
    expect(objectTypeRegistry.resolve("@cinatra-ai/objects:builtin")).not.toBeNull();
  });

  it("removeByPackage is a safe no-op for an unknown package", () => {
    objectTypeRegistry.register(def("@scope/a:one"), "@scope/a");
    expect(objectTypeRegistry.removeByPackage("@scope/never-registered")).toEqual([]);
    expect(objectTypeRegistry.resolve("@scope/a:one")).not.toBeNull();
  });

  it("a host re-register WITHOUT a package clears stale provenance (no longer removable by the old package)", () => {
    objectTypeRegistry.register(def("@scope/a:one"), "@scope/a");
    // Host re-registers the same type id with no provenance (e.g. a built-in
    // takeover). It must no longer be attributed to @scope/a.
    objectTypeRegistry.register(def("@scope/a:one"));

    expect(objectTypeRegistry.getTypesForPackage("@scope/a")).toEqual([]);
    expect(objectTypeRegistry.removeByPackage("@scope/a")).toEqual([]);
    expect(objectTypeRegistry.resolve("@scope/a:one")).not.toBeNull();
  });
});
