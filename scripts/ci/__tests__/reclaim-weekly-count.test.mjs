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
  listArtifacts,
  main,
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

describe("the artifact ledger must be complete before a count is published", () => {
  const artifact = (id, ledger = false) => ({
    id,
    name: ledger ? `reclaim-record.dashboard-live-verify.${id}.1.ubuntu-latest` : `other-${id}`,
    created_at: "2026-09-03T12:00:00Z",
  });
  const response = (artifacts, total_count) => ({
    ok: true,
    status: 200,
    json: async () => ({ artifacts, total_count }),
  });

  it("finds a reclaimed job beyond the former 2,000-artifact cutoff", async () => {
    const requests = [];
    const records = await listArtifacts("fixture-only", async (url) => {
      requests.push(url);
      const page = Number(new URL(url).searchParams.get("page"));
      if (page <= 20) return response(Array.from({ length: 100 }, (_, i) => artifact((page - 1) * 100 + i + 1)), 2001);
      return response([artifact(2001, true)], 2001);
    });
    expect(requests).toHaveLength(22); // complete listing plus first-page drift check
    expect(countReclaims({ artifacts: records, start: START, end: END }).total).toBe(1);
  });

  it("accepts an explicitly empty repository", async () => {
    expect(await listArtifacts("fixture-only", async () => response([], 0))).toEqual([]);
  });

  it("bounds concurrent pages and preserves ordering when responses arrive out of order", async () => {
    let active = 0;
    let maximum = 0;
    const records = await listArtifacts("fixture-only", async (url) => {
      const page = Number(new URL(url).searchParams.get("page"));
      active += 1; maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, page === 2 ? 10 : 1));
      active -= 1;
      const size = page === 6 ? 1 : 100;
      return response(Array.from({length:size}, (_, i) => artifact((page-1)*100+i+1, i===0)), 501);
    });
    expect(maximum).toBe(4);
    expect(records).toHaveLength(6);
  });

  it("aborts other in-flight requests when one page fails", async () => {
    let aborted = 0;
    const running = listArtifacts("fixture-only", async (url, options) => {
      const page = Number(new URL(url).searchParams.get("page"));
      if (page === 1) return response(Array.from({length:100}, (_, i) => artifact(i+1)), 501);
      if (page === 2) return {ok:false,status:503};
      return new Promise((resolve, reject) => options.signal.addEventListener("abort", () => {
        aborted += 1; reject(new Error("aborted"));
      }, {once:true}));
    });
    await expect(running).rejects.toThrow(/503/);
    expect(aborted).toBe(3);
  });

  it("continues past an initially full tail and refuses visible listing drift", async () => {
    let firstReads = 0;
    const pages = [];
    await expect(listArtifacts("fixture-only", async (url) => {
      const page = Number(new URL(url).searchParams.get("page")); pages.push(page);
      if (page === 1) firstReads += 1;
      const total = firstReads > 1 || page > 2 ? 201 : 200;
      return response(Array.from({length:page === 3 ? 1 : 100}, (_, i) => artifact((page-1)*100+i+1)), total);
    })).rejects.toThrow(/changed during collection/);
    expect(pages).toEqual([1,2,3,1]);
  });

  it("refuses first-page identity drift even when the total is unchanged", async () => {
    let calls = 0;
    await expect(listArtifacts("fixture-only", async () => response([artifact(++calls, true)], 1)))
      .rejects.toThrow(/changed during collection/);
  });

  it("refuses conflicting duplicate metadata across concurrent pages", async () => {
    await expect(listArtifacts("fixture-only", async (url) => {
      const page = Number(new URL(url).searchParams.get("page"));
      const batch = Array.from({length:100}, (_, i) => artifact((page-1)*100+i+1));
      if (page === 3) batch[0] = {...artifact(101), created_at:"2026-09-04T12:00:00Z"};
      return response(batch, 501);
    })).rejects.toThrow(/conflicting artifact/i);
  });

  it("refuses a short listing that cannot cover the initial total", async () => {
    await expect(listArtifacts("fixture-only", async () => response([], 2001))).rejects.toThrow(/incomplete/i);
  });

  it("refuses an unreadable collection instead of counting it as empty", async () => {
    for (const body of [{}, { artifacts: null, total_count: 0 }, { artifacts: [], total_count: -1 }]) {
      await expect(listArtifacts("fixture-only", async () => ({ ok: true, json: async () => body }))).rejects.toThrow(/invalid/i);
    }
  });

  it("detects a server repeating a full page without progress", async () => {
    const page = Array.from({ length: 100 }, (_, i) => artifact(i + 1));
    await expect(listArtifacts("fixture-only", async () => response(page, 200))).rejects.toThrow(/progress/i);
  });

  it("refuses malformed ledger records instead of silently dropping them", async () => {
    for (const row of [
      { ...artifact(1, true), created_at: "unreadable" },
      { ...artifact(1, true), name: "reclaim-record.malformed" },
    ]) {
      await expect(listArtifacts("fixture-only", async () => response([row], 1))).rejects.toThrow(/invalid.*record/i);
    }
  });

  it("refuses conflicting metadata for a duplicated artifact", async () => {
    await expect(listArtifacts("fixture-only", async () => response([
      artifact(1, true), { ...artifact(1, true), created_at: "2026-09-04T12:00:00Z" },
    ], 1))).rejects.toThrow(/conflicting artifact/i);
  });

  it("refuses when the complete listing exceeds the workflow read budget", async () => {
    let instant = 0;
    await expect(listArtifacts("fixture-only", async () => {
      instant = 210_000;
      return response([artifact(1, true)], 1);
    }, () => instant)).rejects.toThrow(/210-second read budget/i);
  });

  it("refuses the page safety limit instead of returning a partial ledger", async () => {
    let calls = 0;
    await expect(listArtifacts("fixture-only", async () => {
      const first = calls++ * 100;
      return response(Array.from({ length: 100 }, (_, index) => artifact(first + index + 1)), 100_001);
    }, () => 0)).rejects.toThrow(/1,000-page safety budget/i);
    expect(calls).toBe(1000);
  });

  it("never posts a weekly zero after a truncated collection", async () => {
    const previous = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "fixture-only";
    const writes = [];
    try {
      await expect(main({
        now: "2026-09-07T06:17:00Z",
        doFetch: async (url, options) => {
          if (options?.method === "POST") writes.push(url);
          return response([], 2001);
        },
      })).rejects.toThrow(/incomplete/i);
      expect(writes).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previous;
    }
  });
});
