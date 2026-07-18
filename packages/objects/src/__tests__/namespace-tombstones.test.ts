// PERMANENT namespace tombstones (cinatra#1789, epic #1785).
//
// The canonical tombstone predicate + its two pinned mirrors. This test pins
// the claims-leaf mirror byte-equal to the single source of truth in
// ./namespace, so the two exported predicates can never silently diverge (the
// edge-serving host-lib mirror is pinned separately in
// src/lib/__tests__/extension-edge-bound-serving.test.ts — that lib cannot be
// imported from a packages/objects test without pulling server-only deps).
import { describe, it, expect } from "vitest";

import {
  TOMBSTONED_OBJECT_TYPE_ID_PREFIXES,
  isTombstonedObjectTypeId,
  isDynamicObjectTypeId,
  DYNAMIC_TYPE_ID_PREFIX,
  LEGACY_DYNAMIC_TYPE_ID_PREFIX,
} from "../namespace";
import { TOMBSTONED_CLAIMED_TYPE_PREFIXES, isTombstonedClaimedTypeId } from "../claims";

// Ids UNDER a tombstoned namespace — including malformed/derived variants a
// strict well-formed-slug check would miss.
const TOMBSTONED = [
  "@dynamic/types:invoice",
  "@dynamic/types:competitor-profile",
  "@cinatra-ai/dynamic:invoice",
  "@cinatra-ai/dynamic:email-drafts-bundle",
  "@dynamic/types:artifact", // the derived `<pkg>:artifact` umbrella id
  "@dynamic/types:Foo", // uppercase slug — NOT a well-formed dynamic id, still tombstoned
  "@dynamic/types:", // empty slug — malformed but still in the reserved scope
  "@cinatra-ai/dynamic:", // empty legacy slug
];

// NEAR-MISS ids that must NOT be tombstoned — prefix-exact matching, no false
// positive on a look-alike scope/package.
const NOT_TOMBSTONED = [
  "@dynamics/types:invoice", // scope is `@dynamics`, not `@dynamic`
  "@dynamic/typesx:invoice", // package is `typesx`, not `types`
  "@cinatra-ai/dynamics:invoice", // package is `dynamics`, not `dynamic`
  "@cinatra-ai/dynamic-legacy:invoice", // package is `dynamic-legacy`, not `dynamic`
  "@vendor/pkg:thing", // a normal vendor type
  "@cinatra-ai/campaigns:email", // a normal first-party type
  "@cinatra-ai/artifact:object", // the permanent floor claim — never matched
  "plain-type",
  "",
];

describe("isTombstonedObjectTypeId (canonical source of truth)", () => {
  it("is true for every id under a tombstoned dynamic namespace", () => {
    for (const id of TOMBSTONED) expect(isTombstonedObjectTypeId(id), id).toBe(true);
  });

  it("is false for near-miss look-alike ids and normal types (prefix-exact)", () => {
    for (const id of NOT_TOMBSTONED) expect(isTombstonedObjectTypeId(id), id).toBe(false);
  });

  it("is false for a non-string input (never throws)", () => {
    expect(isTombstonedObjectTypeId(undefined as never)).toBe(false);
    expect(isTombstonedObjectTypeId(null as never)).toBe(false);
    expect(isTombstonedObjectTypeId(42 as never)).toBe(false);
  });

  it("is BROADER than isDynamicObjectTypeId (catches ids the strict slug check misses)", () => {
    // Every well-formed dynamic id is also tombstoned.
    expect(isDynamicObjectTypeId("@dynamic/types:invoice")).toBe(true);
    expect(isTombstonedObjectTypeId("@dynamic/types:invoice")).toBe(true);
    // ...but a malformed-slug reserved-scope id is NOT a well-formed dynamic id,
    // yet MUST still be tombstoned so it can never sneak a row into the scope.
    expect(isDynamicObjectTypeId("@dynamic/types:Foo")).toBe(false);
    expect(isTombstonedObjectTypeId("@dynamic/types:Foo")).toBe(true);
    expect(isDynamicObjectTypeId("@dynamic/types:")).toBe(false);
    expect(isTombstonedObjectTypeId("@dynamic/types:")).toBe(true);
  });
});

describe("tombstone prefix set — single source of truth pins", () => {
  it("is exactly the reserved dynamic scope + the legacy dynamic prefix", () => {
    expect([...TOMBSTONED_OBJECT_TYPE_ID_PREFIXES]).toEqual([
      DYNAMIC_TYPE_ID_PREFIX,
      LEGACY_DYNAMIC_TYPE_ID_PREFIX,
    ]);
    expect([...TOMBSTONED_OBJECT_TYPE_ID_PREFIXES]).toEqual([
      "@dynamic/types:",
      "@cinatra-ai/dynamic:",
    ]);
  });

  it("the claims-leaf mirror is byte-equal to the canonical declaration", () => {
    expect([...TOMBSTONED_CLAIMED_TYPE_PREFIXES]).toEqual([...TOMBSTONED_OBJECT_TYPE_ID_PREFIXES]);
  });

  it("the claims-leaf predicate agrees with the canonical predicate on every id", () => {
    for (const id of [...TOMBSTONED, ...NOT_TOMBSTONED]) {
      expect(isTombstonedClaimedTypeId(id), id).toBe(isTombstonedObjectTypeId(id));
    }
  });
});
