import { describe, expect, it } from "vitest";

import { scanFile } from "../agents-status-route-banned.mjs";

// Build the banned literal from fragments so the repo-wide route-string
// acceptance (ASR-03) finds ONLY the gate script + .planning history —
// never this test fixture.
const ROUTE = "/agents/" + "status";

describe("agents-status-route-banned scanFile", () => {
  it("flags an href to the retired route", () => {
    expect(scanFile(`<Link href="${ROUTE}">`)).toEqual([1]);
  });

  it("flags a run-page reference with a trailing /<runId>", () => {
    expect(scanFile(`open the run page at \`${ROUTE}/<runId>\``)).toEqual([1]);
  });

  it("reports the correct 1-indexed line numbers across a multi-line file", () => {
    const content = ["clean line", `redirect("${ROUTE}")`, "another clean line"].join("\n");
    expect(scanFile(content)).toEqual([2]);
  });

  it("does not match an unrelated path that merely shares the prefix", () => {
    expect(scanFile(`href="${ROUTE}board"`)).toEqual([]);
  });

  it("does not match the live /agents surface", () => {
    expect(scanFile('<Link href="/agents">')).toEqual([]);
  });
});
