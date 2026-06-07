import { describe, expect, it } from "vitest";

import { scanFile } from "../configuration-jobs-dashboard-banned.mjs";

// Build literals from fragments so a repo-wide grep finds ONLY the gate
// script + .planning history.
const ROUTE = "/configuration/" + "environment/jobs-dashboard";
const TAB = "/configuration/" + "environment?tab=jobs";

describe("configuration-jobs-dashboard-banned scanFile", () => {
  it("flags the retired jobs-dashboard route literal", () => {
    expect(scanFile(`<Link href="${ROUTE}">`)).toEqual([
      { line: 1, label: expect.stringContaining("jobs-dashboard route literal") },
    ]);
  });

  it("flags the retired ?tab=jobs Environment link", () => {
    expect(scanFile(`<Link href="${TAB}">`)).toEqual([
      { line: 1, label: expect.stringContaining("?tab=jobs link") },
    ]);
  });

  it("flags the removed JobsDashboardFrame symbol", () => {
    expect(scanFile("import { JobsDashboardFrame } from './x'")).toEqual([
      { line: 1, label: expect.stringContaining("JobsDashboardFrame") },
    ]);
  });

  it("flags the removed JobsTabContent symbol", () => {
    expect(scanFile("async function JobsTabContent() {}")).toEqual([
      { line: 1, label: expect.stringContaining("JobsTabContent") },
    ]);
  });

  it("does not match the generic word 'jobs' in unrelated contexts", () => {
    expect(scanFile("const queueName = 'cinatra-background-jobs';")).toEqual([]);
    expect(scanFile("/api/jobs/foo")).toEqual([]);
  });

  it("does not match a longer route segment that shares the prefix", () => {
    expect(scanFile(`href="${ROUTE}-archived"`)).toEqual([]);
  });
});
