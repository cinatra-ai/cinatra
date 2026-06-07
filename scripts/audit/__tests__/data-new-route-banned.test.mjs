import { describe, expect, it } from "vitest";

import { scanFile } from "../data-new-route-banned.mjs";

// Build the banned literal from fragments so the repo-wide route-string
// acceptance (SDC-04) finds ONLY the gate script + .planning history.
const ROUTE = "/data/" + "new";

describe("data-new-route-banned scanFile", () => {
  it("flags an href to the retired route", () => {
    expect(scanFile(`{ title: "New data item", url: "${ROUTE}" }`)).toEqual([1]);
  });

  it("reports the correct 1-indexed line numbers across a multi-line file", () => {
    const content = ["clean line", `<Link href="${ROUTE}">`, "tail"].join("\n");
    expect(scanFile(content)).toEqual([2]);
  });

  it("does not match a longer segment that shares the prefix", () => {
    expect(scanFile(`href="${ROUTE}sletter"`)).toEqual([]);
  });

  it("does not match the surviving /data/types route", () => {
    expect(scanFile('<Link href="/data/types">')).toEqual([]);
  });
});
