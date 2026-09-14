// The larger-runner trial measurement (cinatra#3316, item 4): the before/after
// table, pinned against the same fixture of recorded reclaims the weekly count
// reads. The fixture carries records under two runner labels either side of a
// week boundary.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parsePhase, trialReport } from "../reclaim-trial-report.mjs";

const FIXTURES = path.resolve(
  fileURLToPath(import.meta.url),
  "..",
  "__fixtures__",
  "hosted-reclaim",
);

const ARTIFACTS = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, "ledger-sample.json"), "utf8"),
);

const BEFORE = {
  runner: "ubuntu-latest",
  start: "2026-08-31T00:00:00Z",
  end: "2026-09-07T00:00:00Z",
};
const AFTER = {
  runner: "ubuntu-latest-8-cores",
  start: "2026-09-07T00:00:00Z",
  end: "2026-09-14T00:00:00Z",
};

describe("trialReport: the before/after reclaim count for a named window and runner size", () => {
  const report = trialReport({ artifacts: ARTIFACTS, before: BEFORE, after: AFTER });

  it("counts each phase against its own window AND its own runner label", () => {
    expect(report.rows.map((r) => [r.phase, r.runner, r.total])).toEqual([
      ["before", "ubuntu-latest", 5],
      ["after", "ubuntu-latest-8-cores", 2],
    ]);
  });

  it("prints the table the trial is recorded with", () => {
    expect(report.text).toBe(
      [
        "| phase | week (UTC) | runner size | reclaimed jobs |",
        "| --- | --- | --- | --- |",
        "| before | 2026-08-31 to 2026-09-07 | ubuntu-latest | 5 |",
        "| after | 2026-09-07 to 2026-09-14 | ubuntu-latest-8-cores | 2 |",
        "",
        "- before (ubuntu-latest): design-visual-verify 3, Build and publish image 1, dashboard-live-verify 1",
        "- after (ubuntu-latest-8-cores): Build and publish image 1, dashboard-live-verify 1",
        "",
        "One entry per job id; a second attempt is counted separately. Counted from the re-run watcher's own records, not from run logs.",
      ].join("\n"),
    );
  });

  it("says so plainly when a phase's window holds no reclaim at all", () => {
    const empty = trialReport({
      artifacts: ARTIFACTS,
      before: BEFORE,
      after: { runner: "ubuntu-latest-8-cores", start: "2026-07-06T00:00:00Z", end: "2026-07-13T00:00:00Z" },
    });
    expect(empty.rows[1].total).toBe(0);
    expect(empty.text).toContain("- after (ubuntu-latest-8-cores): no reclaimed jobs");
  });
});

describe("trialReport: it measures, it does not switch anything", () => {
  it("touches no repository variable and no workflow file", () => {
    const source = fs.readFileSync(
      path.resolve(fileURLToPath(import.meta.url), "..", "..", "reclaim-trial-report.mjs"),
      "utf8",
    );
    expect(source).not.toMatch(/actions\/variables/);
    expect(source).not.toMatch(/method: "(PATCH|PUT|POST)"/);
  });
});

describe("parsePhase", () => {
  it("reads <start>:<end>:<runner label>", () => {
    expect(parsePhase("2026-08-31:2026-09-07:ubuntu-latest", "--before")).toEqual({
      start: "2026-08-31",
      end: "2026-09-07",
      runner: "ubuntu-latest",
    });
  });

  it("refuses an unreadable bound rather than measuring a window nobody named", () => {
    expect(() => parsePhase("not-a-day:2026-09-07:ubuntu-latest", "--before")).toThrow(
      /not a readable instant/,
    );
    expect(() => parsePhase("2026-08-31:2026-09-07", "--after")).toThrow(
      /expects <start>:<end>:<runner label>/,
    );
  });
});
