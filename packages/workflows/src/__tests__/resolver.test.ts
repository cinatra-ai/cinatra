import { describe, it, expect } from "vitest";
import { TZDate } from "@date-fns/tz";
import {
  resolveSchedule,
  computeCascadeDiff,
  parseIsoDuration,
  parseInstantMs,
} from "../schedule/resolver";
import type { WorkflowSpec } from "../spec/schema";

const NY = "America/New_York";

function wallClockHour(iso: string, tz: string): number {
  return new TZDate(Date.parse(iso), tz).getHours();
}

describe("resolver — basics", () => {
  it("parses ISO durations and instants", () => {
    expect(parseIsoDuration("P7D")).toMatchObject({ days: 7 });
    expect(parseIsoDuration("PT4H30M")).toMatchObject({ hours: 4, minutes: 30 });
    expect(parseIsoDuration("nope")).toBeNull();
    // bare local datetime interpreted in tz; 00:00 EDT (UTC-4) on Jun 1 = 04:00Z
    expect(parseInstantMs("2026-06-01T00:00:00", NY)).toBe(Date.parse("2026-06-01T04:00:00Z"));
    // offset datetime is absolute
    expect(parseInstantMs("2026-06-01T00:00:00Z", NY)).toBe(Date.parse("2026-06-01T00:00:00Z"));
  });

  it("resolves a relative 'before release' offset", () => {
    const spec: WorkflowSpec = {
      name: "R",
      target: { at: "2026-06-15T12:00:00Z", tz: "UTC" },
      tasks: [
        {
          key: "a",
          type: "checkpoint",
          title: "A",
          schedule: { mode: "relative", anchor: "target", offsetIso8601: "P7D", direction: "before" },
        },
      ],
    } as WorkflowSpec;
    const { tasks } = resolveSchedule(spec);
    expect(tasks.a.dueAtUtc).toBe("2026-06-08T12:00:00.000Z");
  });

  it("chains anchors (task -> task -> release)", () => {
    const spec: WorkflowSpec = {
      name: "R",
      target: { at: "2026-06-15T00:00:00Z", tz: "UTC" },
      tasks: [
        { key: "a", type: "checkpoint", title: "A", schedule: { mode: "relative", anchor: "target", offsetIso8601: "P10D", direction: "before" } },
        { key: "b", type: "checkpoint", title: "B", schedule: { mode: "relative", anchor: "a", offsetIso8601: "P2D", direction: "after" } },
      ],
    } as WorkflowSpec;
    const { tasks } = resolveSchedule(spec);
    expect(tasks.a.dueAtUtc).toBe("2026-06-05T00:00:00.000Z");
    expect(tasks.b.dueAtUtc).toBe("2026-06-07T00:00:00.000Z");
  });

  it("defaults an unscheduled task to the release instant with a warning", () => {
    const spec: WorkflowSpec = {
      name: "R",
      target: { at: "2026-06-15T00:00:00Z", tz: "UTC" },
      tasks: [{ key: "a", type: "checkpoint", title: "A" }],
    } as WorkflowSpec;
    const res = resolveSchedule(spec);
    expect(res.tasks.a.dueAtUtc).toBe("2026-06-15T00:00:00.000Z");
    expect(res.warnings.map((w) => w.code)).toContain("UNSCHEDULED_DEFAULTED_TO_RELEASE");
  });

  it("applies anchorPoint=start + duration to derive the planned bar", () => {
    const spec: WorkflowSpec = {
      name: "R",
      target: { at: "2026-06-15T00:00:00Z", tz: "UTC" },
      tasks: [
        {
          key: "a",
          type: "agent_task",
          title: "A",
          agentRef: { package: "p" },
          schedule: {
            mode: "relative",
            anchor: "target",
            offsetIso8601: "P5D",
            direction: "before",
            anchorPoint: "start",
            durationIso8601: "P2D",
          },
        },
      ],
    } as WorkflowSpec;
    const { tasks } = resolveSchedule(spec);
    expect(tasks.a.plannedStartUtc).toBe("2026-06-10T00:00:00.000Z");
    expect(tasks.a.plannedEndUtc).toBe("2026-06-12T00:00:00.000Z");
    expect(tasks.a.dueAtUtc).toBe("2026-06-12T00:00:00.000Z");
  });

  it("anchors a descendant to the anchor task's DUE (end), not its start", () => {
    const spec: WorkflowSpec = {
      name: "R",
      target: { at: "2026-06-15T00:00:00Z", tz: "UTC" },
      tasks: [
        // A starts 5d before release with a 2d duration → due = release-3d = 2026-06-12
        {
          key: "a",
          type: "agent_task",
          title: "A",
          agentRef: { package: "p" },
          schedule: { mode: "relative", anchor: "target", offsetIso8601: "P5D", direction: "before", anchorPoint: "start", durationIso8601: "P2D" },
        },
        // B is 1d after A → must anchor to A's DUE (06-12)+1d = 06-13, NOT A.start+1d (06-11)
        { key: "b", type: "checkpoint", title: "B", schedule: { mode: "relative", anchor: "a", offsetIso8601: "P1D", direction: "after" } },
      ],
    } as WorkflowSpec;
    const { tasks } = resolveSchedule(spec);
    expect(tasks.a.dueAtUtc).toBe("2026-06-12T00:00:00.000Z");
    expect(tasks.b.dueAtUtc).toBe("2026-06-13T00:00:00.000Z");
  });
});

describe("resolver — DST correctness (America/New_York, 2026)", () => {
  // Spring forward: 2026-03-08 02:00 -> 03:00 (EST UTC-5 -> EDT UTC-4).
  it("preserves wall-clock local time across a DST boundary between anchor and task date", () => {
    const spec: WorkflowSpec = {
      name: "R",
      target: { at: "2026-03-15T12:00:00", tz: NY }, // after spring-forward (EDT)
      tasks: [
        // resolves to 2026-03-05 09:00 NY — BEFORE spring-forward (EST, UTC-5)
        { key: "early", type: "checkpoint", title: "Early", schedule: { mode: "relative", anchor: "target", offsetIso8601: "P10D", direction: "before", localTime: "09:00", tz: NY } },
        // resolves to 2026-03-12 09:00 NY — AFTER spring-forward (EDT, UTC-4)
        { key: "late", type: "checkpoint", title: "Late", schedule: { mode: "relative", anchor: "target", offsetIso8601: "P3D", direction: "before", localTime: "09:00", tz: NY } },
      ],
    } as WorkflowSpec;
    const { tasks } = resolveSchedule(spec);
    // Both keep 09:00 NY wall-clock...
    expect(wallClockHour(tasks.early.dueAtUtc, NY)).toBe(9);
    expect(wallClockHour(tasks.late.dueAtUtc, NY)).toBe(9);
    // ...but their UTC instants differ by the DST offset (14:00Z EST vs 13:00Z EDT).
    expect(tasks.early.dueAtUtc).toBe("2026-03-05T14:00:00.000Z");
    expect(tasks.late.dueAtUtc).toBe("2026-03-12T13:00:00.000Z");
  });

  it("rolls a spring-forward gap local time forward and warns (DST_GAP)", () => {
    const spec: WorkflowSpec = {
      name: "R",
      target: { at: "2026-03-08T20:00:00", tz: NY },
      tasks: [
        // 02:30 on 2026-03-08 does not exist (02:00 -> 03:00 gap)
        { key: "gap", type: "checkpoint", title: "Gap", schedule: { mode: "relative", anchor: "target", offsetIso8601: "P0D", direction: "before", localTime: "02:30", tz: NY } },
      ],
    } as WorkflowSpec;
    const res = resolveSchedule(spec);
    expect(res.warnings.map((w) => w.code)).toContain("DST_GAP");
    // rolled forward into 03:xx EDT
    expect(wallClockHour(res.tasks.gap.dueAtUtc, NY)).toBe(3);
  });
});

describe("resolver — cascade diff", () => {
  it("moves unpinned relative tasks but not pinned ones when the release date changes", () => {
    const spec: WorkflowSpec = {
      name: "R",
      target: { at: "2026-06-15T00:00:00Z", tz: "UTC" },
      tasks: [
        { key: "movable", type: "checkpoint", title: "Movable", schedule: { mode: "relative", anchor: "target", offsetIso8601: "P7D", direction: "before" } },
        { key: "pinned", type: "checkpoint", title: "Pinned", pinned: true, schedule: { mode: "relative", anchor: "target", offsetIso8601: "P3D", direction: "before" } },
        { key: "fixed", type: "checkpoint", title: "Fixed", schedule: { mode: "absolute", at: "2026-06-01T00:00:00Z" } },
      ],
    } as WorkflowSpec;
    // push the release one week later
    const diff = computeCascadeDiff(spec, { targetAtUtc: "2026-06-22T00:00:00Z" });
    const keys = diff.map((d) => d.taskKey);
    expect(keys).toContain("movable");
    expect(keys).not.toContain("pinned"); // pinned excluded
    expect(keys).not.toContain("fixed"); // absolute date unaffected by release move
    const movable = diff.find((d) => d.taskKey === "movable")!;
    expect(movable.oldDueAtUtc).toBe("2026-06-08T00:00:00.000Z");
    expect(movable.newDueAtUtc).toBe("2026-06-15T00:00:00.000Z");
  });

  it("freezes pinned tasks as cascade anchors so descendants do not move", () => {
    const spec: WorkflowSpec = {
      name: "R",
      target: { at: "2026-06-15T00:00:00Z", tz: "UTC" },
      tasks: [
        // pinned 5d before release → frozen at 2026-06-10 regardless of release move
        { key: "pin", type: "checkpoint", title: "Pin", pinned: true, schedule: { mode: "relative", anchor: "target", offsetIso8601: "P5D", direction: "before" } },
        // child is 1d after the PINNED task → 2026-06-11; must NOT cascade
        { key: "child", type: "checkpoint", title: "Child", schedule: { mode: "relative", anchor: "pin", offsetIso8601: "P1D", direction: "after" } },
      ],
    } as WorkflowSpec;
    const diff = computeCascadeDiff(spec, { targetAtUtc: "2026-06-22T00:00:00Z" });
    const keys = diff.map((d) => d.taskKey);
    expect(keys).not.toContain("pin"); // pinned excluded
    expect(keys).not.toContain("child"); // anchored to the frozen pin → no movement
  });

  // Mirrors the `wf-seed-v65-major-release-draft-cascade` seed fixture:
  // every task is target-anchored with a distinct offset, and the span tasks
  // anchor on `end` + carry a `durationIso8601` so both bar ends move together.
  // Guards the seed-realism contract — a target move must FAN OUT (each task
  // shifts by its own offset, retaining distinct dates) rather than COLLAPSE
  // every task onto the new target (the unscheduled-defaults-to-release bug
  // this fixture exists to avoid).
  it("fans out a target move across milestone + span tasks (seed-realism contract)", () => {
    const spec: WorkflowSpec = {
      name: "Mixed Gantt",
      target: { at: "2026-07-01T00:00:00Z", tz: "UTC" },
      tasks: [
        { key: "kickoff", type: "checkpoint", title: "Kickoff", schedule: { mode: "relative", anchor: "target", offsetIso8601: "P29D", direction: "before" } },
        { key: "design", type: "agent_task", title: "Design", schedule: { mode: "relative", anchor: "target", offsetIso8601: "P23D", direction: "before", anchorPoint: "end", durationIso8601: "P5D" } },
        { key: "build", type: "manual", title: "Build", schedule: { mode: "relative", anchor: "target", offsetIso8601: "P12D", direction: "before", anchorPoint: "end", durationIso8601: "P10D" } },
        { key: "beta-notice", type: "notification", title: "Beta", schedule: { mode: "relative", anchor: "target", offsetIso8601: "P8D", direction: "before", anchorPoint: "end", durationIso8601: "P3D" } },
        { key: "exec-sign", type: "approval", title: "Exec", schedule: { mode: "relative", anchor: "target", offsetIso8601: "P6D", direction: "before" } },
        { key: "soak", type: "wait", title: "Soak", schedule: { mode: "relative", anchor: "target", offsetIso8601: "P1D", direction: "before", anchorPoint: "end", durationIso8601: "P4D" } },
        { key: "launch", type: "checkpoint", title: "Launch", schedule: { mode: "relative", anchor: "target", offsetIso8601: "P0D", direction: "before" } },
      ],
    } as WorkflowSpec;

    // Initial render: each task lands at target − its offset, and span bars keep
    // their duration (end − start === durationIso8601).
    const { tasks } = resolveSchedule(spec);
    expect(tasks.kickoff.dueAtUtc).toBe("2026-06-02T00:00:00.000Z");
    expect(tasks["exec-sign"].dueAtUtc).toBe("2026-06-25T00:00:00.000Z");
    expect(tasks.launch.dueAtUtc).toBe("2026-07-01T00:00:00.000Z");
    // design span: end = target − 23d (2026-06-08), start = end − 5d (2026-06-03)
    expect(tasks.design.plannedEndUtc).toBe("2026-06-08T00:00:00.000Z");
    expect(tasks.design.plannedStartUtc).toBe("2026-06-03T00:00:00.000Z");

    // Move the target +20 days.
    const newTarget = "2026-07-21T00:00:00Z";
    const diff = computeCascadeDiff(spec, { targetAtUtc: newTarget });

    // Every task moves (none are pinned/absolute) — full fan-out, not a subset.
    expect(diff.map((d) => d.taskKey).sort()).toEqual(
      ["beta-notice", "build", "design", "exec-sign", "kickoff", "launch", "soak"],
    );
    // Each task shifts by exactly +20 days …
    const DAY = 86_400_000;
    for (const d of diff) {
      const delta = Date.parse(d.newDueAtUtc) - Date.parse(d.oldDueAtUtc);
      expect(delta).toBe(20 * DAY);
    }
    // … and the new due dates stay DISTINCT (the anti-collapse guard): seven
    // tasks → seven unique new due-at instants, none equal to the new target
    // except the P0D `launch`.
    const newDues = diff.map((d) => d.newDueAtUtc);
    expect(new Set(newDues).size).toBe(7);
    const collapsedToTarget = newDues.filter((iso) => iso === "2026-07-21T00:00:00.000Z");
    expect(collapsedToTarget).toHaveLength(1); // only launch (P0D)
  });
});

describe("resolver — hierarchy", () => {
  it("derives a parent's window from its children — min(start)/max(end)/max(due)", () => {
    const spec: WorkflowSpec = {
      name: "H",
      target: { at: "2026-07-01T00:00:00Z", tz: "UTC" },
      tasks: [
        { key: "phase", type: "checkpoint", title: "Phase" },
        { key: "design", type: "agent_task", title: "Design", parent: "phase",
          agentRef: { package: "x" },
          schedule: { mode: "relative", anchor: "target", offsetIso8601: "P23D", direction: "before", anchorPoint: "end", durationIso8601: "P5D" } },
        { key: "ship", type: "checkpoint", title: "Ship", parent: "phase",
          schedule: { mode: "relative", anchor: "target", offsetIso8601: "P0D", direction: "before" } },
      ],
    } as WorkflowSpec;
    const { tasks } = resolveSchedule(spec);
    // design end = target - 23d = 2026-06-08, start = end - 5d = 2026-06-03
    expect(tasks.design.plannedStartUtc).toBe("2026-06-03T00:00:00.000Z");
    expect(tasks.design.plannedEndUtc).toBe("2026-06-08T00:00:00.000Z");
    expect(tasks.ship.dueAtUtc).toBe("2026-07-01T00:00:00.000Z");
    // phase window: start = min(design.start, ship.start) = design.start;
    //               end = max(design.end, ship.end) = ship.end = 2026-07-01;
    //               due = max(design.due, ship.due) = ship.due.
    expect(tasks.phase.plannedStartUtc).toBe("2026-06-03T00:00:00.000Z");
    expect(tasks.phase.plannedEndUtc).toBe("2026-07-01T00:00:00.000Z");
    expect(tasks.phase.dueAtUtc).toBe("2026-07-01T00:00:00.000Z");
  });

  it("nests 2 levels — a parent-of-parents derives from its descendants' leaves", () => {
    const spec: WorkflowSpec = {
      name: "H2",
      target: { at: "2026-07-01T00:00:00Z", tz: "UTC" },
      tasks: [
        { key: "epic", type: "checkpoint", title: "Epic" },
        { key: "phase", type: "checkpoint", title: "Phase", parent: "epic" },
        { key: "leaf-a", type: "checkpoint", title: "A", parent: "phase",
          schedule: { mode: "relative", anchor: "target", offsetIso8601: "P10D", direction: "before" } },
        { key: "leaf-b", type: "checkpoint", title: "B", parent: "phase",
          schedule: { mode: "relative", anchor: "target", offsetIso8601: "P2D", direction: "before" } },
      ],
    } as WorkflowSpec;
    const { tasks } = resolveSchedule(spec);
    // phase derives from leaf-a/leaf-b; epic derives from phase.
    expect(tasks.phase.dueAtUtc).toBe(tasks["leaf-b"].dueAtUtc); // max(child.due)
    expect(tasks.epic.dueAtUtc).toBe(tasks.phase.dueAtUtc);
    expect(tasks.epic.plannedStartUtc).toBe(tasks["leaf-a"].plannedStartUtc); // earliest leaf
  });

  it("cascade skips parent entries — they are derived, not user-actionable", () => {
    const spec: WorkflowSpec = {
      name: "H",
      target: { at: "2026-07-01T00:00:00Z", tz: "UTC" },
      tasks: [
        { key: "phase", type: "checkpoint", title: "Phase" },
        { key: "child", type: "checkpoint", title: "Child", parent: "phase",
          schedule: { mode: "relative", anchor: "target", offsetIso8601: "P5D", direction: "before" } },
      ],
    } as WorkflowSpec;
    const diff = computeCascadeDiff(spec, { targetAtUtc: "2026-07-21T00:00:00Z" });
    expect(diff.map((d) => d.taskKey)).toEqual(["child"]); // phase NOT in the diff
  });

  it("suppresses the UNSCHEDULED_DEFAULTED_TO_RELEASE warning for parent tasks", () => {
    const spec: WorkflowSpec = {
      name: "H",
      target: { at: "2026-07-01T00:00:00Z", tz: "UTC" },
      tasks: [
        { key: "phase", type: "checkpoint", title: "Phase" },
        { key: "child", type: "checkpoint", title: "Child", parent: "phase",
          schedule: { mode: "relative", anchor: "target", offsetIso8601: "P5D", direction: "before" } },
      ],
    } as WorkflowSpec;
    const { warnings } = resolveSchedule(spec);
    expect(warnings.find((w) => w.taskKey === "phase")).toBeUndefined();
  });
});
