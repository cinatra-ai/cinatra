import { describe, it, expect } from "vitest";
import type { ExtensionDependency, VersionConstraint } from "../dependencies";
import {
  PROJECT_TEMPLATE_FORMAT_VERSION,
  validateProjectTemplate,
  versionConstraintsEqual,
  checkTemplateWorkerRefsAgainstDependencies,
  templateWorkerAllowlist,
  composeWorkItemNaturalKey,
  computeAbsoluteDate,
  materializeProjectTemplate,
  itemNotReadyReason,
  isItemReady,
  indexItemStatusByKey,
  readyItems,
  type ProjectTemplate,
  type ReadyItemView,
} from "../project-template-contract";

// A minimal well-formed template: two worker tasks (B depends on A) + a human
// approval gate C depending on B.
function validTemplate(): ProjectTemplate {
  return {
    formatVersion: PROJECT_TEMPLATE_FORMAT_VERSION,
    id: "release-announcement",
    name: "Release Announcement",
    anchor: { id: "launch", label: "Launch date" },
    tasks: [
      {
        id: "draft",
        title: "Draft the post",
        schedule: { startOffsetDays: -3, dueOffsetDays: -2 },
        worker: {
          role: "writer",
          packageName: "@cinatra-ai/blog-draft-writer-agent",
          versionConstraint: { kind: "semver-range", range: "^0.1.0" },
        },
        acceptance: [{ id: "has-title", description: "post has a title" }],
      },
      {
        id: "image",
        title: "Generate the image",
        dependsOn: ["draft"],
        schedule: { dueOffsetDays: -1 },
        worker: {
          role: "imager",
          packageName: "@cinatra-ai/blog-image-prompt-agent",
          versionConstraint: { kind: "exact", version: "0.2.3" },
        },
      },
      {
        id: "approve",
        title: "Human sign-off",
        dependsOn: ["image"],
        schedule: { dueOffsetDays: 0 },
        approval: { id: "final-approval", assigneeRole: "editor" },
      },
    ],
  };
}

function deps(): ExtensionDependency[] {
  return [
    {
      packageName: "@cinatra-ai/blog-draft-writer-agent",
      kind: "agent",
      edgeType: "runtime",
      versionConstraint: { kind: "semver-range", range: "^0.1.0" },
      requirement: "required",
    },
    {
      packageName: "@cinatra-ai/blog-image-prompt-agent",
      kind: "agent",
      edgeType: "runtime",
      versionConstraint: { kind: "exact", version: "0.2.3" },
      requirement: "required",
    },
  ];
}

describe("validateProjectTemplate", () => {
  it("accepts a well-formed template", () => {
    const res = validateProjectTemplate(validTemplate());
    expect(res.valid).toBe(true);
    if (res.valid) expect(res.template.id).toBe("release-announcement");
  });

  it("rejects a non-object", () => {
    const res = validateProjectTemplate(null);
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.violations[0].code).toBe("not_object");
  });

  it("rejects a wrong format version", () => {
    const t = { ...validTemplate(), formatVersion: "nope" };
    const res = validateProjectTemplate(t);
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.violations.map((v) => v.code)).toContain("bad_format_version");
  });

  it("rejects bad template id / name / anchor", () => {
    const res = validateProjectTemplate({
      ...validTemplate(),
      id: "bad/id",
      name: "  ",
      anchor: { id: "" },
    });
    expect(res.valid).toBe(false);
    if (!res.valid) {
      const codes = res.violations.map((v) => v.code);
      expect(codes).toContain("bad_template_id");
      expect(codes).toContain("bad_template_name");
      expect(codes).toContain("bad_anchor");
    }
  });

  it("rejects empty tasks", () => {
    const res = validateProjectTemplate({ ...validTemplate(), tasks: [] });
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.violations[0].code).toBe("no_tasks");
  });

  it("rejects a task id carrying the natural-key separator", () => {
    const t = validTemplate();
    t.tasks[0].id = "a/b";
    const res = validateProjectTemplate(t);
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.violations.map((v) => v.code)).toContain("bad_task_id");
  });

  it("rejects duplicate task ids", () => {
    const t = validTemplate();
    t.tasks[1].id = "draft";
    const res = validateProjectTemplate(t);
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.violations.map((v) => v.code)).toContain("duplicate_task_id");
  });

  it("rejects unknown, self, and duplicate dependencies", () => {
    const t = validTemplate();
    t.tasks[1].dependsOn = ["nope", "image", "draft", "draft"];
    const res = validateProjectTemplate(t);
    expect(res.valid).toBe(false);
    if (!res.valid) {
      const codes = res.violations.map((v) => v.code);
      expect(codes).toContain("unknown_dependency");
      expect(codes).toContain("self_dependency");
      expect(codes).toContain("duplicate_dependency");
    }
  });

  it("rejects non-integer offsets and due-before-start", () => {
    const t = validTemplate();
    t.tasks[0].schedule = { startOffsetDays: 1.5, dueOffsetDays: 0 };
    const res = validateProjectTemplate(t);
    expect(res.valid).toBe(false);
    if (!res.valid) {
      const codes = res.violations.map((v) => v.code);
      expect(codes).toContain("bad_offset");
      expect(codes).toContain("due_before_start");
    }
  });

  it("rejects a malformed worker and inconsistent role binding", () => {
    const t = validTemplate();
    // task[1] reuses role "writer" but a different package -> inconsistent.
    t.tasks[1].worker = {
      role: "writer",
      packageName: "@cinatra-ai/other-agent",
      versionConstraint: { kind: "semver-range", range: "^1.0.0" },
    };
    const res = validateProjectTemplate(t);
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.violations.map((v) => v.code)).toContain("inconsistent_worker_role");
  });

  it("rejects duplicate acceptance ids and empty descriptions", () => {
    const t = validTemplate();
    t.tasks[0].acceptance = [
      { id: "x", description: "ok" },
      { id: "x", description: "  " },
    ];
    const res = validateProjectTemplate(t);
    expect(res.valid).toBe(false);
    if (!res.valid) {
      const codes = res.violations.map((v) => v.code);
      expect(codes).toContain("duplicate_acceptance_id");
      expect(codes).toContain("bad_acceptance_desc");
    }
  });

  it("detects a dependency cycle", () => {
    const t = validTemplate();
    t.tasks[0].dependsOn = ["approve"]; // draft <- approve <- image <- draft
    const res = validateProjectTemplate(t);
    expect(res.valid).toBe(false);
    if (!res.valid) expect(res.violations.map((v) => v.code)).toContain("cyclic_dependencies");
  });
});

describe("versionConstraintsEqual", () => {
  it("is true for structurally identical constraints", () => {
    expect(
      versionConstraintsEqual({ kind: "exact", version: "1.0.0" }, { kind: "exact", version: "1.0.0" }),
    ).toBe(true);
  });
  it("is false across kinds or values", () => {
    const a: VersionConstraint = { kind: "semver-range", range: "^1.0.0" };
    expect(versionConstraintsEqual(a, { kind: "exact", version: "1.0.0" })).toBe(false);
    expect(versionConstraintsEqual(a, { kind: "semver-range", range: "^2.0.0" })).toBe(false);
  });
});

describe("checkTemplateWorkerRefsAgainstDependencies (one truth source)", () => {
  it("passes when every worker exact-matches a dependency edge", () => {
    expect(checkTemplateWorkerRefsAgainstDependencies(validTemplate(), deps())).toEqual([]);
  });

  it("rejects a worker absent from the dependency edges", () => {
    const missing = deps().filter((d) => !d.packageName.includes("image-prompt"));
    const out = checkTemplateWorkerRefsAgainstDependencies(validTemplate(), missing);
    expect(out.map((v) => v.code)).toContain("worker_not_in_dependencies");
  });

  it("rejects a worker whose version does not exact-match its edge", () => {
    const drifted = deps().map((d) =>
      d.packageName.includes("image-prompt")
        ? { ...d, versionConstraint: { kind: "exact", version: "9.9.9" } as VersionConstraint }
        : d,
    );
    const out = checkTemplateWorkerRefsAgainstDependencies(validTemplate(), drifted);
    expect(out.map((v) => v.code)).toContain("worker_version_mismatch");
  });
});

describe("templateWorkerAllowlist", () => {
  it("returns distinct worker bindings sorted by role (approval task excluded)", () => {
    const allow = templateWorkerAllowlist(validTemplate());
    expect(allow.map((w) => w.role)).toEqual(["imager", "writer"]);
  });
});

describe("date helpers", () => {
  it("composes the natural key", () => {
    expect(composeWorkItemNaturalKey("proj-42", "draft")).toBe("proj-42/draft");
  });
  it("adds days in UTC across month/negative boundaries", () => {
    expect(computeAbsoluteDate("2026-03-01", -1)).toBe("2026-02-28");
    expect(computeAbsoluteDate("2026-01-31", 1)).toBe("2026-02-01");
    expect(computeAbsoluteDate("2026-07-08", 0)).toBe("2026-07-08");
  });
  it("throws on a malformed anchor date", () => {
    expect(() => computeAbsoluteDate("07/08/2026", 0)).toThrow();
    expect(() => computeAbsoluteDate("2026-13-40", 0)).toThrow();
  });
});

describe("materializeProjectTemplate", () => {
  const opts = { projectRef: "proj-42", anchorDate: "2026-07-10" };

  it("is deterministic (identical output on repeat)", () => {
    const a = materializeProjectTemplate(validTemplate(), opts);
    const b = materializeProjectTemplate(validTemplate(), opts);
    expect(a).toEqual(b);
  });

  it("computes keys, dates, dependsOn, status, and provenance", () => {
    const items = materializeProjectTemplate(validTemplate(), opts);
    const draft = items[0];
    expect(draft.taskId).toBe("draft");
    expect(draft.draft.naturalKey).toBe("proj-42/draft");
    expect(draft.draft.status).toBe("backlog");
    expect(draft.draft.startDate).toBe("2026-07-07"); // -3
    expect(draft.draft.dueDate).toBe("2026-07-08"); // -2
    expect(draft.worker?.role).toBe("writer");
    expect(draft.requiresApproval).toBe(false);

    const image = items[1];
    expect(image.draft.dependsOn).toEqual(["proj-42/draft"]);
    expect(image.draft.startDate).toBeNull(); // no start offset

    const approve = items[2];
    expect(approve.worker).toBeNull();
    expect(approve.requiresApproval).toBe(true);
    expect(approve.draft.dependsOn).toEqual(["proj-42/image"]);
  });

  it("repair rule: an anchor-date change recomputes dates but preserves identity", () => {
    const before = materializeProjectTemplate(validTemplate(), opts);
    const after = materializeProjectTemplate(validTemplate(), { ...opts, anchorDate: "2026-08-10" });
    // natural keys (identity) are anchor-independent...
    expect(after.map((i) => i.draft.naturalKey)).toEqual(before.map((i) => i.draft.naturalKey));
    // ...while due dates shift by the same 31-day anchor delta.
    expect(before[0].draft.dueDate).toBe("2026-07-08");
    expect(after[0].draft.dueDate).toBe("2026-08-08");
  });
});

describe("ready-item validator", () => {
  // A small board: A (no deps, started) -> B depends on A -> C depends on B.
  function board(overrides: Partial<Record<"a" | "b" | "c", Partial<ReadyItemView>>> = {}): ReadyItemView[] {
    return [
      { naturalKey: "p/a", status: "backlog", startDate: "2026-07-01", ...overrides.a },
      { naturalKey: "p/b", status: "backlog", dependsOn: ["p/a"], ...overrides.b },
      { naturalKey: "p/c", status: "backlog", dependsOn: ["p/b"], ...overrides.c },
    ];
  }
  const asOf = "2026-07-10";
  const ctxOf = (items: ReadyItemView[]) => ({ asOf, statusByKey: indexItemStatusByKey(items) });

  it("only the started, dep-free, unclaimed item is ready initially", () => {
    const items = board();
    expect(readyItems(items, asOf).map((i) => i.naturalKey)).toEqual(["p/a"]);
    const ctx = ctxOf(items);
    expect(itemNotReadyReason(items[0], ctx)).toBeNull();
    expect(itemNotReadyReason(items[1], ctx)).toBe("deps_unmet"); // A not done
    expect(itemNotReadyReason(items[2], ctx)).toBe("deps_unmet"); // B not done
  });

  it("a completed dependency unblocks the next item", () => {
    const items = board({ a: { status: "done" } });
    expect(readyItems(items, asOf).map((i) => i.naturalKey)).toEqual(["p/b"]); // A done+terminal, B ready
  });

  it("a cancelled or missing blocker does NOT satisfy the edge", () => {
    const cancelled = board({ a: { status: "cancelled" } });
    expect(itemNotReadyReason(cancelled[1], ctxOf(cancelled))).toBe("deps_unmet");
    // B references p/a; drop A from the index entirely -> missing blocker is unmet.
    const orphan: ReadyItemView[] = [{ naturalKey: "p/b", status: "backlog", dependsOn: ["p/a"] }];
    expect(itemNotReadyReason(orphan[0], ctxOf(orphan))).toBe("deps_unmet");
  });

  it("a claim (assignee) makes an otherwise-ready item not ready", () => {
    const items = board({ a: { assigneeIds: ["u1"] } });
    expect(itemNotReadyReason(items[0], ctxOf(items))).toBe("claimed");
  });

  it("non-pickable statuses are never ready", () => {
    for (const status of ["in_progress", "blocked", "done", "cancelled"] as const) {
      const items = board({ a: { status } });
      expect(itemNotReadyReason(items[0], ctxOf(items))).toBe("not_pickable_status");
    }
  });

  it("START-gates readiness; a future start date is not-yet-started, null start is eligible", () => {
    const future = board({ a: { startDate: "2026-07-11" } }); // after asOf 07-10
    expect(itemNotReadyReason(future[0], ctxOf(future))).toBe("not_yet_started");
    const onDay = board({ a: { startDate: asOf } }); // start == asOf -> eligible
    expect(isItemReady(onDay[0], ctxOf(onDay))).toBe(true);
    const noStart = board({ a: { startDate: null } });
    expect(isItemReady(noStart[0], ctxOf(noStart))).toBe(true);
  });

  it("dueDate does NOT gate readiness (a live item's due is ignored)", () => {
    // A fuller live item carrying a far-future dueDate. Assigned through a
    // variable so the extra `dueDate` is accepted structurally; the predicate
    // reads only naturalKey/status/assigneeIds/dependsOn/startDate, so due never
    // affects pickability (it drives urgency, a follow-on concern).
    const live = { naturalKey: "p/x", status: "todo" as const, startDate: "2026-01-01", dueDate: "2999-12-31" };
    const item: ReadyItemView = live;
    expect(isItemReady(item, { asOf, statusByKey: indexItemStatusByKey([item]) })).toBe(true);
  });

  it("checks gates in a fixed priority: status > claimed > deps > start", () => {
    // done + claimed + unmet-dep + future-start -> status wins (checked first).
    const items = board({
      a: { status: "done", assigneeIds: ["u1"], dependsOn: ["p/z"], startDate: "2999-01-01" },
    });
    expect(itemNotReadyReason(items[0], ctxOf(items))).toBe("not_pickable_status");
    // backlog + claimed + unmet-dep -> claimed wins over deps.
    const claimed = board({ a: { assigneeIds: ["u1"], dependsOn: ["p/z"] } });
    expect(itemNotReadyReason(claimed[0], ctxOf(claimed))).toBe("claimed");
  });

  it("readyItems preserves input order and is a pure filter", () => {
    const items = board({ a: { status: "done" }, b: { status: "todo" }, c: { status: "todo", dependsOn: ["p/b"] } });
    // A done (terminal), B ready (dep A done), C blocked (dep B not done).
    expect(readyItems(items, asOf).map((i) => i.naturalKey)).toEqual(["p/b"]);
    expect(readyItems(items, asOf)).not.toBe(items); // new array
  });

  it("throws on a malformed asOf", () => {
    const items = board();
    expect(() => itemNotReadyReason(items[0], { asOf: "07/10/2026", statusByKey: indexItemStatusByKey(items) })).toThrow();
  });
});
