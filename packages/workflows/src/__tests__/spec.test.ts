import { describe, it, expect } from "vitest";
import {
  validateTemplate,
  validateDraft,
  validateStart,
  checkLimits,
  iso8601DurationToApproxDays,
  jsonDepth,
  SPEC_LIMITS,
  workflowSpecSchema,
  type WorkflowSpec,
} from "../spec";

function baseDraft(): WorkflowSpec {
  return {
    name: "Major Product Release",
    product: "Acme 2.0",
    target: { at: "2026-06-01T00:00:00Z", tz: "America/New_York" },
    tasks: [
      { key: "kickoff", type: "checkpoint", title: "Kickoff" },
      {
        key: "blog",
        type: "agent_task",
        title: "Draft launch blog",
        agentRef: { package: "@cinatra-ai/asset-blog" },
        input: { topic: "launch" },
        schedule: {
          mode: "relative",
          anchor: "target",
          offsetIso8601: "P7D",
          direction: "before",
          localTime: "09:00",
          tz: "America/New_York",
        },
        dependsOn: [{ taskKey: "kickoff" }],
      },
      {
        key: "notify",
        type: "notification",
        title: "Notify team",
        message: "Launch is near",
        schedule: { mode: "relative", anchor: "blog", offsetIso8601: "PT1H", direction: "after" },
        dependsOn: [{ taskKey: "blog", outcome: "success" }],
      },
    ],
  } as WorkflowSpec;
}

const codes = (r: { errors: { code: string }[] }) => r.errors.map((e) => e.code);

describe("spec validation — happy paths", () => {
  it("a complete draft is template-, draft-, and start-valid", () => {
    const spec = baseDraft();
    expect(validateTemplate(spec).ok).toBe(true);
    expect(validateDraft(spec).ok).toBe(true);
    const start = validateStart(spec);
    expect(start.ok).toBe(true);
    expect(start.tier).toBe("start");
  });

  it("a template with placeholders + no release date is template-valid but not draft-valid", () => {
    const tmpl: unknown = {
      name: "Generic Release Template",
      placeholders: { product: { type: "string", required: true } },
      tasks: [
        { key: "kickoff", type: "checkpoint", title: "Kickoff for {{product}}" },
        {
          key: "blog",
          type: "agent_task",
          title: "Draft blog",
          agentRef: { package: "@cinatra-ai/asset-blog" },
          schedule: { mode: "relative", anchor: "target", offsetIso8601: "P7D", direction: "before" },
        },
      ],
    };
    expect(validateTemplate(tmpl).ok).toBe(true);
    const draft = validateDraft(tmpl);
    expect(draft.ok).toBe(false);
    expect(codes(draft)).toContain("UNRESOLVED_PLACEHOLDER");
    expect(codes(draft)).toContain("MISSING_TARGET_DATE");
  });
});

describe("spec validation — schema + structural errors", () => {
  it("rejects an unknown task type at the schema tier", () => {
    const r = validateTemplate({ name: "x", tasks: [{ key: "a", type: "frobnicate", title: "X" }] });
    expect(r.ok).toBe(false);
  });

  it("flags an empty spec", () => {
    const r = validateTemplate({ name: "x", tasks: [] });
    expect(codes(r)).toContain("EMPTY_SPEC");
  });

  it("flags duplicate task keys", () => {
    const spec = baseDraft();
    spec.tasks[1].key = "kickoff";
    expect(codes(validateTemplate(spec))).toContain("DUPLICATE_TASK_KEY");
  });

  it("flags an unknown dependency", () => {
    const spec = baseDraft();
    spec.tasks[0].dependsOn = [{ taskKey: "ghost" }];
    expect(codes(validateTemplate(spec))).toContain("UNKNOWN_DEPENDENCY");
  });

  it("flags a self dependency", () => {
    const spec = baseDraft();
    spec.tasks[0].dependsOn = [{ taskKey: "kickoff" }];
    expect(codes(validateTemplate(spec))).toContain("SELF_DEPENDENCY");
  });

  it("flags a dependency cycle", () => {
    const spec = baseDraft();
    // kickoff -> blog -> notify already; add notify -> kickoff to close a cycle
    spec.tasks[0].dependsOn = [{ taskKey: "notify" }];
    expect(codes(validateTemplate(spec))).toContain("DEPENDENCY_CYCLE");
  });

  it("accepts a valid hierarchy parent", () => {
    const spec = baseDraft();
    spec.tasks[1].parent = "kickoff"; // blog is a child of kickoff
    expect(validateTemplate(spec).ok).toBe(true);
  });

  it("flags an unknown parent", () => {
    const spec = baseDraft();
    spec.tasks[0].parent = "ghost";
    expect(codes(validateTemplate(spec))).toContain("UNKNOWN_PARENT");
  });

  it("flags a self parent", () => {
    const spec = baseDraft();
    spec.tasks[0].parent = "kickoff"; // kickoff parents itself
    expect(codes(validateTemplate(spec))).toContain("SELF_PARENT");
  });

  it("flags a parent cycle", () => {
    const spec = baseDraft();
    // kickoff.parent = blog, blog.parent = kickoff → 2-node cycle
    spec.tasks[0].parent = "blog";
    spec.tasks[1].parent = "kickoff";
    expect(codes(validateTemplate(spec))).toContain("PARENT_CYCLE");
  });

  it("rejects a schedule on a task that IS a parent (window must derive from children)", () => {
    const spec = baseDraft();
    // make `kickoff` the parent of `blog`, then try to schedule kickoff
    spec.tasks[1].parent = "kickoff";
    spec.tasks[0].schedule = { mode: "relative", anchor: "target", offsetIso8601: "P1D", direction: "before" };
    expect(codes(validateTemplate(spec))).toContain("PARENT_HAS_SCHEDULE");
  });

  it("rejects pinning a task that IS a parent", () => {
    const spec = baseDraft();
    spec.tasks[1].parent = "kickoff";
    spec.tasks[0].pinned = true;
    expect(codes(validateTemplate(spec))).toContain("PINNED_PARENT_INVALID");
  });

  it("flags a hierarchy/schedule cross-cycle — a child anchored to its own ancestor", () => {
    const spec = baseDraft();
    // Make `kickoff` parent of `blog`; blog's schedule already anchors to "target".
    // Re-point blog's anchor at `kickoff` (its ancestor) — that's the cross-cycle.
    spec.tasks[1].parent = "kickoff";
    spec.tasks[1].schedule = { mode: "relative", anchor: "kickoff", offsetIso8601: "P1D", direction: "after" };
    expect(codes(validateTemplate(spec))).toContain("HIERARCHY_SCHEDULE_CYCLE");
  });

  it("validateStart rejects a hierarchical spec with HIERARCHY_NOT_RUNNABLE (render-only)", () => {
    const spec = baseDraft();
    spec.tasks[1].parent = "kickoff";
    // start tier rolls up template+draft errors too; ensure HIERARCHY_NOT_RUNNABLE is present.
    expect(codes(validateStart(spec))).toContain("HIERARCHY_NOT_RUNNABLE");
  });

  it("flags an unknown schedule anchor", () => {
    const spec = baseDraft();
    spec.tasks[1].schedule = {
      mode: "relative",
      anchor: "ghost",
      offsetIso8601: "P1D",
      direction: "before",
    };
    expect(codes(validateTemplate(spec))).toContain("UNKNOWN_ANCHOR");
  });

  it("flags a self anchor", () => {
    const spec = baseDraft();
    spec.tasks[1].schedule = {
      mode: "relative",
      anchor: "blog",
      offsetIso8601: "P1D",
      direction: "before",
    };
    expect(codes(validateTemplate(spec))).toContain("SELF_ANCHOR");
  });

  it("flags an anchor cycle", () => {
    const spec = baseDraft();
    // blog anchors to notify, notify anchors to blog
    spec.tasks[1].schedule = { mode: "relative", anchor: "notify", offsetIso8601: "P1D", direction: "before" };
    spec.tasks[2].schedule = { mode: "relative", anchor: "blog", offsetIso8601: "P1D", direction: "after" };
    expect(codes(validateTemplate(spec))).toContain("ANCHOR_CYCLE");
  });

  it("flags an unresolvable relative chain in a draft (anchor never reaches release)", () => {
    const spec = baseDraft();
    // blog now anchors to kickoff, but kickoff has no schedule → not resolvable
    spec.tasks[1].schedule = { mode: "relative", anchor: "kickoff", offsetIso8601: "P1D", direction: "before" };
    const r = validateDraft(spec);
    expect(codes(r)).toContain("UNRESOLVABLE_SCHEDULE");
  });
});

describe("spec validation — start tier", () => {
  it("allows an approval-gated workflow to start with the gated task pending", () => {
    const spec = baseDraft();
    spec.tasks.push({
      key: "legal",
      type: "approval",
      title: "Legal sign-off",
      requiredScope: { level: "organization" },
    } as WorkflowSpec["tasks"][number]);
    const r = validateStart(spec);
    expect(r.ok).toBe(true);
    expect(codes(r)).not.toContain("NOT_STARTABLE_APPROVALS_PENDING");
  });

  it("uses the injected agentExists check when provided", () => {
    const spec = baseDraft();
    const r = validateStart(spec, { agentExists: () => false });
    expect(codes(r)).toContain("AGENT_NOT_FOUND");
  });
});

describe("resource limits", () => {
  it("flags too many tasks", () => {
    const spec = baseDraft();
    spec.tasks = Array.from({ length: SPEC_LIMITS.maxTasks + 1 }, (_, i) => ({
      key: `t${i}`,
      type: "checkpoint" as const,
      title: `Task ${i}`,
    }));
    expect(checkLimits(spec).map((e) => e.code)).toContain("TOO_MANY_TASKS");
  });

  it("flags an over-long title", () => {
    const spec = baseDraft();
    spec.tasks[0].title = "x".repeat(SPEC_LIMITS.maxTitleLength + 1);
    expect(checkLimits(spec).map((e) => e.code)).toContain("TITLE_TOO_LONG");
  });

  it("flags an over-large agent input", () => {
    const spec = baseDraft();
    (spec.tasks[1] as { input?: Record<string, unknown> }).input = {
      blob: "x".repeat(SPEC_LIMITS.maxInputBytes + 10),
    };
    expect(checkLimits(spec).map((e) => e.code)).toContain("INPUT_TOO_LARGE");
  });

  it("flags an over-large offset", () => {
    const spec = baseDraft();
    spec.tasks[1].schedule = {
      mode: "relative",
      anchor: "target",
      offsetIso8601: "P400D",
      direction: "before",
    };
    expect(checkLimits(spec).map((e) => e.code)).toContain("OFFSET_TOO_LARGE");
  });

  it("computes ISO duration days and JSON depth", () => {
    expect(iso8601DurationToApproxDays("P7D")).toBe(7);
    expect(iso8601DurationToApproxDays("PT24H")).toBe(1);
    expect(iso8601DurationToApproxDays("garbage")).toBeNull();
    expect(jsonDepth({ a: { b: { c: 1 } } })).toBe(4);
    expect(jsonDepth(1)).toBe(1);
  });
});

describe("additional validation coverage", () => {
  it("flags duplicate dependency edges", () => {
    const spec = baseDraft();
    spec.tasks[1].dependsOn = [{ taskKey: "kickoff" }, { taskKey: "kickoff" }];
    expect(codes(validateTemplate(spec))).toContain("DUPLICATE_DEPENDENCY");
  });

  it("flags an invalid IANA timezone", () => {
    const spec = baseDraft();
    spec.target!.tz = "Not/AZone";
    expect(codes(validateTemplate(spec))).toContain("INVALID_TIMEZONE");
  });

  it("flags a task beyond the schedule horizon", () => {
    const spec = baseDraft();
    spec.tasks.push({
      key: "farfuture",
      type: "checkpoint",
      title: "Far",
      schedule: { mode: "absolute", at: "2031-01-01T00:00:00Z" },
    } as WorkflowSpec["tasks"][number]);
    expect(codes(validateDraft(spec))).toContain("SCHEDULE_HORIZON_EXCEEDED");
  });

  it("flags an over-long bar duration", () => {
    const spec = baseDraft();
    spec.tasks[1].schedule = {
      mode: "relative",
      anchor: "target",
      offsetIso8601: "P7D",
      direction: "before",
      durationIso8601: "P400D",
    };
    expect(checkLimits(spec).map((e) => e.code)).toContain("DURATION_TOO_LARGE");
  });
});

describe("schema parsing", () => {
  it("parses a valid spec", () => {
    expect(workflowSpecSchema.safeParse(baseDraft()).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// placeholder scan with foreach scope
// ---------------------------------------------------------------------------
describe("placeholder scan respects foreach scope", () => {
  function foreachSpec(template: Record<string, unknown>): unknown {
    return {
      name: "Foreach scoping test",
      target: { at: "2026-12-01T00:00:00Z", tz: "America/New_York" },
      tasks: [
        {
          key: "ideas",
          type: "agent_task",
          title: "Generate ideas",
          agentRef: { package: "@cinatra-ai/blog-idea-generator-agent" },
        },
        {
          key: "drafts",
          type: "agent_task",
          title: "Write draft for {{idea.title}}",
          agentRef: { package: "@cinatra-ai/blog-draft-writer-agent" },
          dependsOn: [{ taskKey: "ideas" }],
          foreach: {
            source: "ideas",
            as: "idea",
            template,
          },
        },
      ],
    };
  }

  it("{{idea.title}} inside foreach.template does NOT trip UNRESOLVED_PLACEHOLDER (foreach-scoped)", () => {
    const spec = foreachSpec({
      type: "agent_task",
      key: "draft_template",
      title: "Write draft for {{idea.title}}",
      agentRef: { package: "@cinatra-ai/blog-draft-writer-agent" },
      input: { idea: "{{idea}}", title: "{{idea.title}}", position: "{{$position}}" },
    });
    const r = validateDraft(spec);
    expect(codes(r)).not.toContain("UNRESOLVED_PLACEHOLDER");
  });

  it("$index/$position/$total inside foreach.template do NOT trip UNRESOLVED_PLACEHOLDER (reserved)", () => {
    const spec = foreachSpec({
      type: "agent_task",
      key: "draft_template",
      title: "Draft #{{$position}} of {{$total}}",
      agentRef: { package: "@cinatra-ai/blog-draft-writer-agent" },
      input: { i: "{{$index}}" },
    });
    const r = validateDraft(spec);
    expect(codes(r)).not.toContain("UNRESOLVED_PLACEHOLDER");
  });

  it("{{undeclared}} inside foreach.template is caught by foreach variable-binding validation (stronger than placeholder check)", () => {
    const spec = foreachSpec({
      type: "agent_task",
      key: "draft_template",
      title: "Draft for {{idea.title}} (env: {{undeclared}})",
      agentRef: { package: "@cinatra-ai/blog-draft-writer-agent" },
    });
    // FOREACH_INVALID_VARIABLE_BINDING catches the unresolved token at the
    // template tier — strictly stronger than UNRESOLVED_PLACEHOLDER. A
    // genuinely-unresolved token inside a foreach.template fails fast at
    // template validation, before the engine ever sees the spec.
    const r = validateTemplate(spec);
    expect(codes(r)).toContain("FOREACH_INVALID_VARIABLE_BINDING");
  });
});
