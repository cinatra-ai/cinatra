// Behavior pin for the objects-provider DI slot (migrated onto createHostDepsSlot).
// This slot is the one with BOTH a fail-closed `require` (runtime call paths) and a
// non-throwing `getOrNull` (boot-time registration that also runs during
// `next build`, when the host binder has not executed). The migration must preserve
// that split exactly.

import { describe, it, expect, beforeEach } from "vitest";
import {
  setObjectsProvider,
  requireObjectsProvider,
  getObjectsProviderOrNull,
  _resetObjectsProviderForTests,
} from "../objects-provider-contract";
import type { ObjectsProvider } from "../objects-provider-contract";

function stubProvider(): ObjectsProvider {
  return {
    registerObjectType: () => {},
    registerSyncAdapter: () => {},
    addGraphitiEpisodeForObject: async () => ({ episodeUuid: "ep-1" }),
    saveObject: async () => ({
      objectId: "obj-1",
      type: "contact",
      isNew: true,
      wasMerged: false,
      confidence: 1,
    }),
  } as unknown as ObjectsProvider;
}

describe("objects-provider-contract — host-injected DI slot", () => {
  beforeEach(() => {
    _resetObjectsProviderForTests();
  });

  it("getObjectsProviderOrNull is a non-throwing probe: null when unwired", () => {
    expect(getObjectsProviderOrNull()).toBeNull();
  });

  it("requireObjectsProvider fails CLOSED (throws) when unwired", () => {
    expect(() => requireObjectsProvider()).toThrowError(/wired the objects/);
  });

  it("after setObjectsProvider, both require and getOrNull resolve the wired impl", () => {
    const impl = stubProvider();
    setObjectsProvider(impl);
    expect(getObjectsProviderOrNull()).toBe(impl);
    expect(requireObjectsProvider()).toBe(impl);
  });

  it("_resetObjectsProviderForTests clears it back to unwired", () => {
    setObjectsProvider(stubProvider());
    _resetObjectsProviderForTests();
    expect(getObjectsProviderOrNull()).toBeNull();
    expect(() => requireObjectsProvider()).toThrowError(/wired the objects/);
  });
});
