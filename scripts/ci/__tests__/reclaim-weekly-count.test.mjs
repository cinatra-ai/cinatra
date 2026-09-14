// The weekly reclaim count (cinatra#3316, item 3): the window, the
// deduplication rule, and the two comment bodies — pinned against a fixture of
// RECORDED reclaims (the watcher's own ledger artifact names).
//
// The fixture is deliberately awkward: it carries a record one second before
// the window opens, one exactly at the closing instant, records after the
// window, a duplicate of one record, a second attempt of a job that is already
// counted on attempt 1, and a foreign artifact that is not a record at all.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  EMPTY_WEEK_LINE,
  TRACKING_ISSUE,
  countReclaims,
  lastCompleteWeek,
  renderWeeklyComment,
} from "../reclaim-weekly-count.mjs";

const FIXTURES = path.resolve(
  fileURLToPath(import.meta.url),
  "..",
  "__fixtures__",
  "hosted-reclaim",
);

const ARTIFACTS = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, "ledger-sample.json"), "utf8"),
);

// Monday 2026-08-31 00:00:00Z through Sunday 2026-09-06 24:00:00Z.
const START = "2026-08-31T00:00:00Z";
const END = "2026-09-07T00:00:00Z";

describe("lastCompleteWeek: a fixed Monday 00:00 - Sunday 24:00 UTC window", () => {
  it("takes the whole previous week when the schedule fires on a Monday", () => {
    const { start, end } = lastCompleteWeek("2026-09-07T06:17:00Z");
    expect(start.toISOString()).toBe("2026-08-31T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-09-07T00:00:00.000Z");
  });

  it("never includes the current, incomplete week", () => {
    const { start, end } = lastCompleteWeek("2026-09-09T23:59:59Z");
    expect(start.toISOString()).toBe("2026-08-31T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-09-07T00:00:00.000Z");
  });

  it("treats Sunday as the last day of the week it closes, not the first of the next", () => {
    const { start, end } = lastCompleteWeek("2026-09-13T12:00:00Z");
    expect(start.toISOString()).toBe("2026-08-31T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-09-07T00:00:00.000Z");
  });
});

describe("countReclaims: the fixture's expected count", () => {
  const counted = countReclaims({ artifacts: ARTIFACTS, start: START, end: END });

  it("counts exactly the five records inside the window", () => {
    expect(counted.total).toBe(5);
  });

  it("groups them per workflow, under the workflows' real names", () => {
    expect(counted.perWorkflow).toEqual([
      { workflow: "design-visual-verify", count: 3 },
      { workflow: "Build and publish image", count: 1 },
      { workflow: "dashboard-live-verify", count: 1 },
    ]);
  });

  it("keeps one entry per job id and counts a second attempt separately", () => {
    const ofJob = counted.entries.filter((e) => e.jobId === "8800000010");
    expect(ofJob.map((e) => e.attempt).sort()).toEqual([1, 2]);
  });

  it("excludes the record one second before the window and the one at the closing instant", () => {
    const ids = counted.entries.map((e) => e.jobId);
    expect(ids).not.toContain("8800000002");
    expect(ids).not.toContain("8800000040");
  });

  it("ignores artifacts that are not the watcher's records", () => {
    expect(counted.entries.every((e) => e.workflow.length > 0)).toBe(true);
    expect(counted.total).toBeLessThan(ARTIFACTS.length);
  });

  it("can restrict the count to one runner label", () => {
    expect(
      countReclaims({
        artifacts: ARTIFACTS,
        start: START,
        end: END,
        runner: "ubuntu-latest-8-cores",
      }).total,
    ).toBe(0);
    expect(
      countReclaims({
        artifacts: ARTIFACTS,
        start: START,
        end: END,
        runner: "ubuntu-latest",
      }).total,
    ).toBe(5);
  });
});

describe("renderWeeklyComment", () => {
  it("posts the per-workflow table with the window in UTC", () => {
    const counted = countReclaims({ artifacts: ARTIFACTS, start: START, end: END });
    const body = renderWeeklyComment({ start: START, end: END, counted });
    expect(body).toContain(
      "**Hosted-runner reclaims, 2026-08-31 Monday 00:00 UTC through 2026-09-06 Sunday 24:00 UTC:** 5",
    );
    expect(body).toContain("| design-visual-verify | 3 |");
    expect(body).toContain("| dashboard-live-verify | 1 |");
    expect(body).toContain("| Build and publish image | 1 |");
    expect(body).toContain(
      "One entry per job id; a second attempt is counted separately.",
    );
  });

  it("posts nothing but one line when the window holds no reclaim", () => {
    const counted = countReclaims({
      artifacts: ARTIFACTS,
      start: "2026-07-06T00:00:00Z",
      end: "2026-07-13T00:00:00Z",
    });
    expect(counted.total).toBe(0);
    expect(renderWeeklyComment({ start: "2026-07-06T00:00:00Z", end: "2026-07-13T00:00:00Z", counted })).toBe(
      EMPTY_WEEK_LINE,
    );
    expect(EMPTY_WEEK_LINE).toBe("no reclaimed jobs this week");
  });
});

describe("where the count is posted", () => {
  it("appends to the tracking issue and to no other", () => {
    expect(TRACKING_ISSUE).toBe(3267);
  });
});
