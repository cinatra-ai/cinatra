import { describe, expect, it } from "vitest";

import { scanFile } from "../analytics-routes-banned.mjs";

// Build the banned literals from fragments so a repo-wide grep for the route
// strings finds ONLY the gate script + .planning history.
const ANALYTICS = "/analytics/";
const COST_API = "metric-cost-api";
const USAGE_API = "metric-usage-api";
const TRACES = "traces";

describe("analytics-routes-banned scanFile", () => {
  it("flags the old cost route", () => {
    expect(scanFile(`<Link href="${ANALYTICS}${COST_API}">`)).toEqual([1]);
  });

  it("flags the old usage route", () => {
    expect(scanFile(`href="${ANALYTICS}${USAGE_API}"`)).toEqual([1]);
  });

  it("flags the old traces route with a query string", () => {
    expect(scanFile(`href="${ANALYTICS}${TRACES}?runId=abc"`)).toEqual([1]);
  });

  it("flags the old pricing sub-route", () => {
    expect(scanFile(`revalidatePath("${ANALYTICS}${COST_API}/pricing")`)).toEqual([1]);
  });

  it("does not match the @cinatra-ai package specifier", () => {
    expect(scanFile(`import { x } from "@cinatra-ai/${COST_API}"`)).toEqual([]);
  });

  it("does not match the @cinatra-ai usage package specifier", () => {
    expect(scanFile(`import { x } from "@cinatra-ai/${USAGE_API}/screens"`)).toEqual([]);
  });

  it("does not match the MCP primitive names", () => {
    expect(scanFile('await mcp.call("metric_cost_summary", {})')).toEqual([]);
    expect(scanFile('await mcp.call("metric_usage_events", {})')).toEqual([]);
  });

  it("does not match the new analytics routes", () => {
    expect(scanFile(`<Link href="${ANALYTICS}llm">`)).toEqual([]);
    expect(scanFile(`<Link href="${ANALYTICS}llm-usage">`)).toEqual([]);
    expect(scanFile(`<Link href="${ANALYTICS}api">`)).toEqual([]);
  });

  it("does not match a longer segment that shares the prefix", () => {
    expect(scanFile(`href="${ANALYTICS}${COST_API}-archive"`)).toEqual([]);
    expect(scanFile(`href="${ANALYTICS}${TRACES}board"`)).toEqual([]);
  });
});
