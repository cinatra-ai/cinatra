import type { WorkflowSpec } from "../../spec/schema";

// Canonical fixture pack: non-agent / agent / approval / DST.
// All are draft-valid (concrete release date, no placeholders). Reused across
// unit + integration tests and as the seed shape for the "Major Product
// Release" template.

/** Non-agent workflow: checkpoint + manual + notification + wait, relative schedules. */
export const nonAgentFixture: WorkflowSpec = {
  name: "Minor Release — coordination only",
  product: "Acme Widgets",
  target: { at: "2026-09-01T00:00:00Z", tz: "America/New_York" },
  tasks: [
    { key: "kickoff", type: "checkpoint", title: "Release kickoff" },
    {
      key: "freeze",
      type: "manual",
      title: "Code freeze",
      instructions: "Lock the release branch.",
      dependsOn: [{ taskKey: "kickoff" }],
      schedule: { mode: "relative", anchor: "target", offsetIso8601: "P5D", direction: "before", localTime: "17:00", tz: "America/New_York" },
    },
    {
      key: "hold",
      type: "wait",
      title: "Soak period",
      dependsOn: [{ taskKey: "freeze" }],
      schedule: { mode: "relative", anchor: "freeze", offsetIso8601: "P2D", direction: "after" },
    },
    {
      key: "announce",
      type: "notification",
      title: "Notify the team",
      message: "Release is live.",
      dependsOn: [{ taskKey: "hold", outcome: "success" }],
      schedule: { mode: "relative", anchor: "target", offsetIso8601: "PT1H", direction: "after" },
    },
  ],
} as WorkflowSpec;

/** Agent workflow: an agent_task drafts launch content. */
export const agentFixture: WorkflowSpec = {
  name: "Content-driven Release",
  product: "Acme Cloud",
  target: { at: "2026-09-15T00:00:00Z", tz: "UTC" },
  tasks: [
    { key: "kickoff", type: "checkpoint", title: "Kickoff" },
    {
      key: "blog",
      type: "agent_task",
      title: "Draft launch blog",
      agentRef: { package: "@cinatra-ai/asset-blog", name: "blog-draft" },
      input: { topic: "Acme Cloud GA", tone: "announcement" },
      dependsOn: [{ taskKey: "kickoff" }],
      schedule: { mode: "relative", anchor: "target", offsetIso8601: "P7D", direction: "before" },
      maxAttempts: 3,
      failurePolicy: "block",
    },
  ],
} as WorkflowSpec;

/** Approval workflow: a human approval gate; draft-valid, not start-valid. */
export const approvalFixture: WorkflowSpec = {
  name: "Governed Release",
  product: "Acme Enterprise",
  target: { at: "2026-10-01T00:00:00Z", tz: "Europe/London" },
  tasks: [
    {
      key: "blog",
      type: "agent_task",
      title: "Draft press release",
      agentRef: { package: "@cinatra-ai/asset-blog" },
      schedule: { mode: "relative", anchor: "target", offsetIso8601: "P10D", direction: "before" },
    },
    {
      key: "legal",
      type: "approval",
      title: "Legal sign-off",
      requiredScope: { level: "organization" },
      rejectionPolicy: "needs_revision",
      deadlineIso8601: "2026-09-28T17:00:00Z",
      dependsOn: [{ taskKey: "blog", outcome: "success" }],
      schedule: { mode: "relative", anchor: "target", offsetIso8601: "P3D", direction: "before" },
    },
  ],
} as WorkflowSpec;

/** DST workflow: tasks straddling the 2026-03-08 America/New_York spring-forward. */
export const dstFixture: WorkflowSpec = {
  name: "DST-straddling Release",
  product: "Acme Time",
  target: { at: "2026-03-15T12:00:00", tz: "America/New_York" },
  tasks: [
    {
      key: "early",
      type: "checkpoint",
      title: "Pre-DST checkpoint (09:00 EST)",
      schedule: { mode: "relative", anchor: "target", offsetIso8601: "P10D", direction: "before", localTime: "09:00", tz: "America/New_York" },
    },
    {
      key: "late",
      type: "checkpoint",
      title: "Post-DST checkpoint (09:00 EDT)",
      schedule: { mode: "relative", anchor: "target", offsetIso8601: "P3D", direction: "before", localTime: "09:00", tz: "America/New_York" },
    },
  ],
} as WorkflowSpec;

export const allFixtures = {
  nonAgent: nonAgentFixture,
  agent: agentFixture,
  approval: approvalFixture,
  dst: dstFixture,
};
