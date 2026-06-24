import { describe, it, expect, vi } from "vitest";

// stream-registry resolveStream own-property guard (cinatra#344).
//
// The generated map (GENERATED_STREAM_DECLARATIONS) is a plain object literal,
// so a slug that names an Object.prototype member (`__proto__`, `constructor`,
// `toString`, …) must NOT resolve a truthy prototype value — it would crash
// buildStreamHandler (a 500) instead of the documented clean 404. With the
// empty INERT day-one registry, resolveStream must be a clean miss for EVERY
// slug, prototype names included.

vi.mock("server-only", () => ({}));
vi.mock("@/lib/generated/streams.server", () => ({
  // Empty INERT day-one registry — exactly the shipped generated file.
  GENERATED_STREAM_DECLARATIONS: {},
}));

import { resolveStream } from "@/lib/stream-registry.server";

describe("resolveStream (empty INERT registry)", () => {
  it("returns null for an ordinary undeclared slug", () => {
    expect(resolveStream("nope")).toBeNull();
  });

  it.each(["__proto__", "constructor", "toString", "valueOf", "hasOwnProperty"])(
    "returns null (not a truthy prototype value) for the prototype-name slug %s",
    (slug) => {
      expect(resolveStream(slug)).toBeNull();
    },
  );
});
