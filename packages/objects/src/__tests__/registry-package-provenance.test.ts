// Object type registry — package provenance + removeByPackage teardown.
//
// The runtime extension teardown hook (archive / uninstall) deregisters an
// extension's object types from the process-global registry by package. This
// test pins the pure registry mechanics: provenance recording, getTypesForPackage,
// and removeByPackage (which must NEVER touch built-in/host types registered
// without a package).

import { describe, it, expect, beforeEach } from "vitest";

import {
  objectTypeRegistry,
  ObjectTypeDefinitionConflictError,
} from "../registry";
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

  it("definerOf returns the defining package, null for host built-ins and unknown ids", () => {
    objectTypeRegistry.register(def("@scope/a:one"), "@scope/a");
    objectTypeRegistry.register(def("@cinatra-ai/objects:builtin")); // host, no provenance

    // A package-defined type resolves to its owning package.
    expect(objectTypeRegistry.definerOf("@scope/a:one")).toBe("@scope/a");
    // A host/built-in registration is provenance-less → null (never the type id).
    expect(objectTypeRegistry.definerOf("@cinatra-ai/objects:builtin")).toBeNull();
    // An unregistered id → null.
    expect(objectTypeRegistry.definerOf("@scope/never:type")).toBeNull();

    // Follows the provenance through teardown: once removed, the definer is gone.
    objectTypeRegistry.removeByPackage("@scope/a");
    expect(objectTypeRegistry.definerOf("@scope/a:one")).toBeNull();
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

  it("a host takeover of a PACKAGE-owned type is a conflict (epic #1785 — never a silent replace)", () => {
    objectTypeRegistry.register(def("@scope/a:one"), "@scope/a");
    // A host (provenance-less) registration of a type a package already defines
    // is a DIFFERENT definer — the ratified model rejects it as an install-time
    // conflict rather than silently taking the type over.
    expect(() => objectTypeRegistry.register(def("@scope/a:one"))).toThrow(
      ObjectTypeDefinitionConflictError,
    );
    // The package's original definition + provenance are untouched.
    expect(objectTypeRegistry.getTypesForPackage("@scope/a")).toEqual(["@scope/a:one"]);
    expect(objectTypeRegistry.resolve("@scope/a:one")).not.toBeNull();
  });

  it("a DIFFERENT package redefining another package's type is a structured conflict", () => {
    objectTypeRegistry.register(def("@scope/a:one"), "@scope/a");
    let caught: unknown;
    try {
      objectTypeRegistry.register(def("@scope/a:one"), "@scope/b");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ObjectTypeDefinitionConflictError);
    const err = caught as ObjectTypeDefinitionConflictError;
    expect(err.code).toBe("OBJECT_TYPE_DEFINITION_CONFLICT");
    expect(err.typeId).toBe("@scope/a:one");
    expect(err.existingDefiner).toBe("@scope/a");
    expect(err.attemptedDefiner).toBe("@scope/b");
    // The original definer keeps ownership.
    expect(objectTypeRegistry.getTypesForPackage("@scope/a")).toEqual(["@scope/a:one"]);
    expect(objectTypeRegistry.getTypesForPackage("@scope/b")).toEqual([]);
  });

  it("a package clobbering a HOST built-in type is a conflict (the email:body / :sent-email empiric)", () => {
    // Host defines the type WITHOUT provenance (register-types.ts model).
    objectTypeRegistry.register(def("@cinatra-ai/email:body"));
    expect(() =>
      objectTypeRegistry.register(def("@cinatra-ai/email:body"), "@cinatra-ai/email-artifacts"),
    ).toThrow(ObjectTypeDefinitionConflictError);
    // The host definition stays; no package now owns it.
    expect(objectTypeRegistry.resolve("@cinatra-ai/email:body")).not.toBeNull();
    expect(objectTypeRegistry.getTypesForPackage("@cinatra-ai/email-artifacts")).toEqual([]);
  });

  it("SAME-definer re-registration is idempotent — no conflict (reboot / re-install / dev-watcher rescan)", () => {
    // Same package re-registers its own type: idempotent replace, ownership kept.
    objectTypeRegistry.register(def("@scope/a:one"), "@scope/a");
    expect(() => objectTypeRegistry.register(def("@scope/a:one"), "@scope/a")).not.toThrow();
    expect(objectTypeRegistry.getTypesForPackage("@scope/a")).toEqual(["@scope/a:one"]);
    expect(objectTypeRegistry.list().filter((d) => d.type === "@scope/a:one")).toHaveLength(1);

    // Host re-registers its own (provenance-less) built-in: also idempotent.
    objectTypeRegistry.register(def("@cinatra-ai/objects:builtin"));
    expect(() => objectTypeRegistry.register(def("@cinatra-ai/objects:builtin"))).not.toThrow();
    expect(objectTypeRegistry.getTypesForPackage("@cinatra-ai/objects:builtin")).toEqual([]);
    expect(
      objectTypeRegistry.list().filter((d) => d.type === "@cinatra-ai/objects:builtin"),
    ).toHaveLength(1);
  });

  it("re-registration after removeByPackage is a clean re-register, not a conflict (dev-watcher reconcile)", () => {
    objectTypeRegistry.register(def("@scope/a:one"), "@scope/a");
    objectTypeRegistry.removeByPackage("@scope/a");
    // A different package may now claim the freed id (the prior definer released it).
    expect(() => objectTypeRegistry.register(def("@scope/a:one"), "@scope/b")).not.toThrow();
    expect(objectTypeRegistry.getTypesForPackage("@scope/b")).toEqual(["@scope/a:one"]);
  });

  it("permanent tombstone backstop (cinatra#1789): a retired dynamic-namespace type is NEVER registered (skip + warn)", () => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => {
      warns.push(a.map(String).join(" "));
    };
    try {
      // The universal choke point under EVERY registration path — the artifact
      // bridge AND the SDK `ctx.objects.registerType` provider AND direct callers.
      objectTypeRegistry.register(def("@dynamic/types:invoice"), "@some/pack");
      objectTypeRegistry.register(def("@cinatra-ai/dynamic:legacy-thing"));
    } finally {
      console.warn = orig;
    }
    expect(objectTypeRegistry.resolve("@dynamic/types:invoice")).toBeNull();
    expect(objectTypeRegistry.resolve("@cinatra-ai/dynamic:legacy-thing")).toBeNull();
    // Never entered the provenance index either.
    expect(objectTypeRegistry.getTypesForPackage("@some/pack")).toEqual([]);
    expect(
      warns.filter((w) => w.includes("permanently-retired dynamic namespace")),
    ).toHaveLength(2);
  });

  it("a near-miss look-alike scope registers normally (prefix-exact backstop, no false positive)", () => {
    objectTypeRegistry.register(def("@dynamics/types:invoice"), "@dynamics/types");
    expect(objectTypeRegistry.resolve("@dynamics/types:invoice")).not.toBeNull();
  });
});
