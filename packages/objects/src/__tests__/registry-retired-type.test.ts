// The registry's RETIRED marker (cinatra#4366): a host type whose definer moved
// stays registered so its stored rows resolve and fail closed, and is marked
// retired so the write paths and the classifier can refuse it.

import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";

import {
  isDispositionGovernedType,
  objectTypeRegistry,
  resolveTypeProjectionDisposition,
} from "../registry";
import type { ObjectTypeDefinition } from "../types";

function def(type: string, projection: "none" | "artifact-safe" = "none"): ObjectTypeDefinition<unknown> {
  return {
    type,
    category: "content",
    schema: z.record(z.string(), z.unknown()),
    lifecycle: { sources: ["agent"], mutableBy: ["agent"] },
    renderers: { listRow: null, card: null, detail: null },
    dispositions: { projection },
  } as unknown as ObjectTypeDefinition<unknown>;
}

beforeEach(() => {
  objectTypeRegistry._clearForTests();
});

describe("objectTypeRegistry retired marker", () => {
  it("registerRetired keeps the type resolvable, host-owned, governed and marked retired", () => {
    objectTypeRegistry.registerRetired(def("@acme/old:thing"));
    expect(objectTypeRegistry.resolve("@acme/old:thing")).not.toBeNull();
    expect(objectTypeRegistry.definerOf("@acme/old:thing")).toBeNull();
    expect(objectTypeRegistry.isRetired("@acme/old:thing")).toBe(true);
    expect(isDispositionGovernedType("@acme/old:thing")).toBe(true);
    expect(resolveTypeProjectionDisposition("@acme/old:thing")).toBe("none");
  });

  it("refuses a retired registration that would project (a tombstone must fail closed)", () => {
    expect(() => objectTypeRegistry.registerRetired(def("@acme/old:leaky", "artifact-safe"))).toThrow(
      /projection "none"/,
    );
    expect(objectTypeRegistry.resolve("@acme/old:leaky")).toBeNull();
    expect(objectTypeRegistry.isRetired("@acme/old:leaky")).toBe(false);
  });

  it("an ordinary registration is not retired, and a later host re-register clears the marker", () => {
    objectTypeRegistry.register(def("@acme/live:thing", "artifact-safe"));
    expect(objectTypeRegistry.isRetired("@acme/live:thing")).toBe(false);
    objectTypeRegistry.registerRetired(def("@acme/live:thing"));
    expect(objectTypeRegistry.isRetired("@acme/live:thing")).toBe(true);
    objectTypeRegistry.register(def("@acme/live:thing", "artifact-safe"));
    expect(objectTypeRegistry.isRetired("@acme/live:thing")).toBe(false);
  });

  it("a package cannot take over a retired host id (definer conflict)", () => {
    objectTypeRegistry.registerRetired(def("@acme/old:thing"));
    expect(() => objectTypeRegistry.register(def("@acme/old:thing", "artifact-safe"), "@acme/pack")).toThrow();
    expect(objectTypeRegistry.isRetired("@acme/old:thing")).toBe(true);
  });

  it("an unregistered id is not retired, and the test reset clears the marker", () => {
    expect(objectTypeRegistry.isRetired("@acme/never:registered")).toBe(false);
    objectTypeRegistry.registerRetired(def("@acme/old:thing"));
    objectTypeRegistry._clearForTests();
    expect(objectTypeRegistry.isRetired("@acme/old:thing")).toBe(false);
    expect(objectTypeRegistry.resolve("@acme/old:thing")).toBeNull();
  });
});
