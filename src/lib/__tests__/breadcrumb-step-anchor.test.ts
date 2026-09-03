/**
 * THE YOU-ARE-HERE ANCHOR NAMES THE STEP (cinatra#3068, fix leg 2).
 *
 * The run's schedule step is named in the page header because it answers at its
 * own sub-route (`/.../<run>/trigger`, labelled "Schedule"). The run's FIRST
 * step — the agent's own input form — answers on the run's own path, so the
 * trail stopped at the run's name and the reader was told the run but never the
 * step. The graded pictures read exactly one you-are-here anchor on the page,
 * the rail row, and a breadcrumb that named no step.
 *
 * A step is not a route, so the anchor arrives the way every other
 * route-published label arrives: through the ONE crumb channel, as a crumb
 * APPENDED after the run's own crumb — the mirror of the ancestry insertion the
 * channel already carries.
 *
 * Run:
 *   npx vitest run src/lib/__tests__/breadcrumb-step-anchor.test.ts
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  clearCrumbContributions,
  publishCrumbContributions,
  selectCrumbContributions,
} from "../breadcrumb-contributions";
import { buildBreadcrumbTrail } from "../breadcrumb-trail";

const RUN_PATH = "/agents/cinatra-ai/blog-draft-writer-agent/run-3068";
const EPOCH = "user-1:org-1";

beforeEach(() => {
  clearCrumbContributions();
});

describe("a step crumb is appended after the run's own crumb", () => {
  it("names the step the run detail is showing", () => {
    const crumbs = buildBreadcrumbTrail(RUN_PATH, {
      contributions: [
        { prefix: RUN_PATH, label: "Blog Draft Writer Agent (1)" },
        {
          prefix: `${RUN_PATH}#step`,
          label: "idea",
          appendAfter: RUN_PATH,
          nonNavigable: true,
        },
      ],
    });

    expect(crumbs.map((c) => c.label)).toEqual([
      "Agents",
      "Blog Draft Writer Agent (1)",
      "idea",
    ]);
    expect(crumbs[2].nonNavigable).toBe(true);
  });

  it("leaves the trail exactly as it was when no step is named", () => {
    const crumbs = buildBreadcrumbTrail(RUN_PATH, {
      contributions: [{ prefix: RUN_PATH, label: "Blog Draft Writer Agent (1)" }],
    });
    expect(crumbs.map((c) => c.label)).toEqual([
      "Agents",
      "Blog Draft Writer Agent (1)",
    ]);
  });

  it("keeps naming the schedule step exactly as it did", () => {
    const crumbs = buildBreadcrumbTrail(`${RUN_PATH}/trigger`, {
      contributions: [{ prefix: RUN_PATH, label: "Blog Draft Writer Agent (1)" }],
    });
    expect(crumbs.map((c) => c.label)).toEqual([
      "Agents",
      "Blog Draft Writer Agent (1)",
      "Schedule",
    ]);
  });

  it("skips an append whose target crumb is not on this trail", () => {
    const crumbs = buildBreadcrumbTrail(RUN_PATH, {
      contributions: [
        { prefix: "/elsewhere#step", label: "idea", appendAfter: "/elsewhere" },
      ],
    });
    expect(crumbs.some((c) => c.label === "idea")).toBe(false);
    expect(crumbs[0].label).toBe("Agents");
  });

  it("appends after the crumb it targets on a general trail too", () => {
    const crumbs = buildBreadcrumbTrail("/projects/p-1", {
      contributions: [
        { prefix: "/projects/p-1", label: "Migration road" },
        { prefix: "/projects/p-1#step", label: "Draft", appendAfter: "/projects/p-1" },
      ],
    });
    expect(crumbs.map((c) => c.label)).toEqual([
      "Projects",
      "Migration road",
      "Draft",
    ]);
  });
});

describe("the step crumb is route-scoped, like every synthesized crumb", () => {
  it("applies only while the publishing route is the current route", () => {
    publishCrumbContributions(RUN_PATH, EPOCH, [
      { prefix: RUN_PATH, label: "Blog Draft Writer Agent (1)" },
      { prefix: `${RUN_PATH}#step`, label: "idea", appendAfter: RUN_PATH },
    ]);

    expect(
      selectCrumbContributions(RUN_PATH, EPOCH).map((c) => c.label),
    ).toEqual(["Blog Draft Writer Agent (1)", "idea"]);
    // A soft navigation into a sub-route keeps the run's own label and drops
    // the step the other route was standing on.
    expect(
      selectCrumbContributions(`${RUN_PATH}/trigger`, EPOCH).map((c) => c.label),
    ).toEqual(["Blog Draft Writer Agent (1)"]);
  });

  it("is exempt from the per-prefix dedupe, as an insertion is", () => {
    publishCrumbContributions(RUN_PATH, EPOCH, [
      { prefix: `${RUN_PATH}#step`, label: "idea", appendAfter: RUN_PATH },
      { prefix: `${RUN_PATH}#step`, label: "audience", appendAfter: RUN_PATH },
    ]);
    expect(
      selectCrumbContributions(RUN_PATH, EPOCH).map((c) => c.label),
    ).toEqual(["idea", "audience"]);
  });
});

// ---------------------------------------------------------------------------
// CONVERGENCE, fix leg 2. The append is the MIRROR of the insertion, and two
// places it was not: the order two appends land in, and whether a
// position-targeted entry may also be read as a replacement.
// ---------------------------------------------------------------------------

describe("appends after one crumb land in publisher declaration order", () => {
  it("draws two appended steps in the order they were published, not in reverse", () => {
    // The insertion below it stays ordered for free — each insert pushes its
    // TARGET right, so the next lands after it. An append lands one past the
    // target every time, which is the SAME slot: a second append would push the
    // first one down and the trail would read backwards.
    const crumbs = buildBreadcrumbTrail(RUN_PATH, {
      contributions: [
        { prefix: RUN_PATH, label: "Blog Draft Writer Agent (1)" },
        { prefix: `${RUN_PATH}#a`, label: "idea", appendAfter: RUN_PATH },
        { prefix: `${RUN_PATH}#b`, label: "audience", appendAfter: RUN_PATH },
      ],
    });
    expect(crumbs.map((c) => c.label)).toEqual([
      "Agents",
      "Blog Draft Writer Agent (1)",
      "idea",
      "audience",
    ]);
  });

  it("keeps that order on the general trail too", () => {
    const crumbs = buildBreadcrumbTrail("/projects/migration-road", {
      contributions: [
        { prefix: "/projects/migration-road#a", label: "One", appendAfter: "/projects" },
        { prefix: "/projects/migration-road#b", label: "Two", appendAfter: "/projects" },
      ],
    });
    expect(crumbs.map((c) => c.label)).toEqual([
      "Projects",
      "One",
      "Two",
      "Migration Road",
    ]);
  });
});

describe("a position-targeted entry is never read as a replacement", () => {
  it("does not relabel the crumb whose path its own prefix happens to equal", () => {
    // An append carries a prefix so the trail has a path to key the new crumb
    // by; that prefix is not a claim on an existing crumb. Reading it as one
    // would draw a single contribution twice — once in place, once beside it.
    const crumbs = buildBreadcrumbTrail("/projects/migration-road", {
      contributions: [
        { prefix: "/projects/migration-road", label: "Draft", appendAfter: "/projects" },
      ],
    });
    expect(crumbs.map((c) => c.label)).toEqual([
      "Projects",
      "Draft",
      "Migration Road",
    ]);
  });

  it("does not relabel the run's own crumb on the agent-instance trail", () => {
    const crumbs = buildBreadcrumbTrail(RUN_PATH, {
      contributions: [
        { prefix: RUN_PATH, label: "Blog Draft Writer Agent (1)" },
        { prefix: RUN_PATH, label: "idea", appendAfter: RUN_PATH },
      ],
    });
    expect(crumbs.map((c) => c.label)).toEqual([
      "Agents",
      "Blog Draft Writer Agent (1)",
      "idea",
    ]);
  });
});

