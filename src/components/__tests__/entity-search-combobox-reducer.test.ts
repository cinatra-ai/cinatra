// Pure reducers backing EntitySearchCombobox (cinatra#1509 §4.0-b): the
// debounce delay, the pagination merge, and the client-side exclusion filter.
// Unlike the source-text contract test (entity-search-combobox.test.tsx), these
// exercise the REAL functions — the logic is pure (no DOM / React), mirroring
// the access-selection.test.ts precedent.

import { describe, it, expect } from "vitest";
import {
  entitySearchDebounceMs,
  mergeEntityPages,
  visibleEntityResults,
} from "@/components/entity-search-combobox";

describe("entitySearchDebounceMs", () => {
  it("is 0 ms on an empty query (immediate on open) and 300 ms while typing", () => {
    expect(entitySearchDebounceMs("")).toBe(0);
    expect(entitySearchDebounceMs("a")).toBe(300);
    expect(entitySearchDebounceMs("marcus")).toBe(300);
  });
});

describe("mergeEntityPages", () => {
  const a = { id: "a", name: "Ada" };
  const b = { id: "b", name: "Ben" };
  const c = { id: "c", name: "Cid" };

  it("appends genuinely-new rows after the existing ones (stable order)", () => {
    expect(mergeEntityPages([a, b], [c])).toEqual([a, b, c]);
  });

  it("de-dupes by id — a repeated row from an overlapping page is dropped", () => {
    expect(mergeEntityPages([a, b], [b, c])).toEqual([a, b, c]);
  });

  it("returns a copy of prev when the next page adds nothing new", () => {
    const prev = [a, b];
    const merged = mergeEntityPages(prev, [a, b]);
    expect(merged).toEqual([a, b]);
    expect(merged).not.toBe(prev); // a fresh array, never a mutation of prev
  });

  it("handles an empty existing set and an empty next page", () => {
    expect(mergeEntityPages([], [a])).toEqual([a]);
    expect(mergeEntityPages([a], [])).toEqual([a]);
    expect(mergeEntityPages([], [])).toEqual([]);
  });
});

describe("visibleEntityResults", () => {
  const rows = [
    { id: "a", name: "Ada" },
    { id: "b", name: "Ben" },
    { id: "c", name: "Cid" },
  ];

  it("drops excluded ids (already-granted / already-selected)", () => {
    expect(visibleEntityResults(rows, ["b"]).map((r) => r.id)).toEqual(["a", "c"]);
    expect(visibleEntityResults(rows, ["a", "c"]).map((r) => r.id)).toEqual(["b"]);
  });

  it("returns all rows when nothing is excluded", () => {
    expect(visibleEntityResults(rows, []).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
});
