import { describe, it, expect } from "vitest";
import {
  digestKey,
  selectGcEligibleDigests,
  type OnDiskDigest,
} from "@/lib/extension-store-gc";

const PKG = "@cinatra-ai/foo-connector";
const BAR = "@cinatra-ai/bar-connector";

function onDisk(...entries: [string, string][]): OnDiskDigest[] {
  return entries.map(([packageName, digest]) => ({ packageName, digest }));
}

describe("digestKey", () => {
  it("joins package + digest with @", () => {
    expect(digestKey(PKG, "abc")).toBe(`${PKG}@abc`);
  });
});

describe("selectGcEligibleDigests", () => {
  it("returns [] for empty input (pure + total)", () => {
    expect(
      selectGcEligibleDigests({
        onDisk: [],
        activeDigests: new Set(),
        leasedDigests: new Set(),
      }),
    ).toEqual([]);
  });

  it("deletes orphans (neither active nor leased)", () => {
    const eligible = selectGcEligibleDigests({
      onDisk: onDisk([PKG, "old"], [PKG, "older"]),
      activeDigests: new Set(),
      leasedDigests: new Set(),
    });
    expect(eligible).toEqual(onDisk([PKG, "old"], [PKG, "older"]));
  });

  it("protects the active digest", () => {
    const eligible = selectGcEligibleDigests({
      onDisk: onDisk([PKG, "new"], [PKG, "old"]),
      activeDigests: new Set([digestKey(PKG, "new")]),
      leasedDigests: new Set(),
    });
    expect(eligible).toEqual(onDisk([PKG, "old"]));
  });

  it("protects a leased digest (in-flight run)", () => {
    const eligible = selectGcEligibleDigests({
      onDisk: onDisk([PKG, "new"], [PKG, "old"]),
      activeDigests: new Set([digestKey(PKG, "new")]),
      leasedDigests: new Set([digestKey(PKG, "old")]),
    });
    expect(eligible).toEqual([]);
  });

  it("excludes a digest that is both active AND leased", () => {
    const eligible = selectGcEligibleDigests({
      onDisk: onDisk([PKG, "x"]),
      activeDigests: new Set([digestKey(PKG, "x")]),
      leasedDigests: new Set([digestKey(PKG, "x")]),
    });
    expect(eligible).toEqual([]);
  });

  it("keys by pkg@digest so a shared digest across packages does not alias", () => {
    // BAR's "shared" is active; PKG's "shared" is an orphan and must be deletable.
    const eligible = selectGcEligibleDigests({
      onDisk: onDisk([PKG, "shared"], [BAR, "shared"]),
      activeDigests: new Set([digestKey(BAR, "shared")]),
      leasedDigests: new Set(),
    });
    expect(eligible).toEqual(onDisk([PKG, "shared"]));
  });

  it("preserves onDisk order in the result", () => {
    const eligible = selectGcEligibleDigests({
      onDisk: onDisk([PKG, "a"], [PKG, "b"], [PKG, "c"]),
      activeDigests: new Set([digestKey(PKG, "b")]),
      leasedDigests: new Set(),
    });
    expect(eligible).toEqual(onDisk([PKG, "a"], [PKG, "c"]));
  });

  it("does not mutate the input onDisk array", () => {
    const input = onDisk([PKG, "a"], [PKG, "b"]);
    const snapshot = JSON.parse(JSON.stringify(input));
    selectGcEligibleDigests({
      onDisk: input,
      activeDigests: new Set([digestKey(PKG, "a")]),
      leasedDigests: new Set(),
    });
    expect(input).toEqual(snapshot);
  });
});
