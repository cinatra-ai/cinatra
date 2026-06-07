// stripOpenRestoreParam coverage.

import { describe, expect, it } from "vitest";

import { stripOpenRestoreParam } from "../url-params";

describe("stripOpenRestoreParam", () => {
  it("removes openRestore when it is the only param (→ bare pathname)", () => {
    expect(
      stripOpenRestoreParam("/data-safety/change-sets/cs_1", "openRestore=1"),
    ).toBe("/data-safety/change-sets/cs_1");
  });

  it("removes openRestore but preserves other params", () => {
    expect(
      stripOpenRestoreParam(
        "/data-safety/change-sets/cs_1",
        "openRestore=1&tab=events",
      ),
    ).toBe("/data-safety/change-sets/cs_1?tab=events");
  });

  it("handles a leading '?' in the search string", () => {
    expect(
      stripOpenRestoreParam("/p", "?openRestore=1&keep=2"),
    ).toBe("/p?keep=2");
  });

  it("returns the path with surviving params unchanged when openRestore is absent", () => {
    expect(stripOpenRestoreParam("/p", "keep=2")).toBe("/p?keep=2");
  });

  it("returns the bare pathname when there is no search at all", () => {
    expect(stripOpenRestoreParam("/p", "")).toBe("/p");
  });
});
