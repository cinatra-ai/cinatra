// Demo workflow seed fixtures (cinatra#151 Stage 6): the release-workflow
// template + instance data extracted from scripts/seed.mjs into a PURE
// builder module (no DB, no I/O) so the presence-conditional filter and the
// seed-determinism test consume the SAME fixture source the seed writes.
// All free variables (org ids + date derivation) are parameters.
//
// NOTE: several templates/instances reference OPTIONAL agent extensions
// (blog-pipeline, blog-linkedin-writer, email-outreach). The seed NEVER
// writes those rows when the referenced agent package is absent from the
// materialized extension universe — see scripts/seed-lib/extension-presence.mjs
// (filterWorkflowSeedByPresence) and the skip notices in scripts/seed.mjs.

export function buildWorkflowSeedTemplates({ orgGroup, orgRobotics, orgCloud }) {
  return [
    {
      id: "wftpl-seed-v65-major-product-release",
      key: "major-product-release",
      name: "Major Product Release",
      orgId: orgGroup,
      description: "8-step DAG: kickoff → eng-readiness → docs → legal-sign-off → comms-blog → comms-linkedin → launch-day → post-launch-retro.",
      definition: {
        schemaVersion: 1,
        placeholders: [{ key: "product", type: "string", required: true }],
        tasks: [
          { key: "kickoff", type: "checkpoint", title: "Release kickoff" },
          { key: "eng-readiness", type: "agent_task", title: "Engineering readiness check", agentRef: { package: "@cinatra-ai/code-reviewer-agent" }, dependsOn: [{ taskKey: "kickoff" }] },
          { key: "docs", type: "agent_task", title: "Documentation update", agentRef: { package: "@cinatra-ai/author-agent" }, dependsOn: [{ taskKey: "eng-readiness" }] },
          { key: "legal-sign-off", type: "approval", title: "Legal sign-off", requiredScope: { level: "organization" }, dependsOn: [{ taskKey: "docs" }] },
          { key: "comms-blog", type: "agent_task", title: "Launch blog draft", agentRef: { package: "@cinatra-ai/blog-pipeline-agent" }, dependsOn: [{ taskKey: "legal-sign-off" }] },
          { key: "comms-linkedin", type: "agent_task", title: "LinkedIn announcement", agentRef: { package: "@cinatra-ai/blog-linkedin-writer-agent" }, dependsOn: [{ taskKey: "comms-blog" }] },
          { key: "launch-day", type: "checkpoint", title: "Launch day", dependsOn: [{ taskKey: "comms-linkedin" }] },
          { key: "post-launch-retro", type: "manual", title: "Post-launch retro", dependsOn: [{ taskKey: "launch-day" }] },
        ],
      },
    },
    {
      id: "wftpl-seed-v65-hotfix-release",
      key: "hotfix-release",
      name: "Hotfix Release",
      orgId: orgCloud,
      description: "Fast-iteration hotfix DAG: triage → fix → patch-release → comms-update.",
      definition: {
        schemaVersion: 1,
        tasks: [
          { key: "triage", type: "checkpoint", title: "Incident triage" },
          { key: "fix", type: "agent_task", title: "Patch implementation", agentRef: { package: "@cinatra-ai/code-reviewer-agent" }, dependsOn: [{ taskKey: "triage" }] },
          { key: "patch-release", type: "checkpoint", title: "Patch release", dependsOn: [{ taskKey: "fix" }] },
          { key: "comms-update", type: "agent_task", title: "Customer update", agentRef: { package: "@cinatra-ai/author-agent" }, dependsOn: [{ taskKey: "patch-release" }] },
        ],
      },
    },
    {
      id: "wftpl-seed-v65-security-patch-release",
      key: "security-patch-release",
      name: "Security Patch Release",
      orgId: orgCloud,
      description: "CVE intake → patch → security-review → coordinated disclosure → release.",
      definition: {
        schemaVersion: 1,
        tasks: [
          { key: "cve-intake", type: "checkpoint", title: "CVE intake" },
          { key: "patch", type: "agent_task", title: "Patch", agentRef: { package: "@cinatra-ai/security-reviewer-agent" }, dependsOn: [{ taskKey: "cve-intake" }] },
          { key: "security-review", type: "approval", title: "Security review sign-off", requiredScope: { level: "organization" }, dependsOn: [{ taskKey: "patch" }] },
          { key: "disclosure", type: "manual", title: "Coordinated disclosure", dependsOn: [{ taskKey: "security-review" }] },
          { key: "release", type: "checkpoint", title: "Patch release", dependsOn: [{ taskKey: "disclosure" }] },
        ],
      },
    },
    {
      id: "wftpl-seed-v65-beta-release",
      key: "beta-release",
      name: "Beta Release",
      orgId: orgRobotics,
      description: "Beta cohort lifecycle: kickoff → beta-blog → cohort-invites → feedback-windows → GA decision.",
      definition: {
        schemaVersion: 1,
        tasks: [
          { key: "kickoff", type: "checkpoint", title: "Beta kickoff" },
          { key: "beta-blog", type: "agent_task", title: "Beta announcement", agentRef: { package: "@cinatra-ai/blog-pipeline-agent" }, dependsOn: [{ taskKey: "kickoff" }] },
          { key: "cohort-invites", type: "agent_task", title: "Invite beta cohort", agentRef: { package: "@cinatra-ai/email-outreach-agent" }, dependsOn: [{ taskKey: "beta-blog" }] },
          { key: "feedback-windows", type: "manual", title: "Collect feedback (2-week window)", dependsOn: [{ taskKey: "cohort-invites" }] },
          { key: "ga-decision", type: "manual", title: "GA / extend decision", dependsOn: [{ taskKey: "feedback-windows" }] },
        ],
      },
    },
    {
      id: "wftpl-seed-v65-marketing-campaign-approval",
      key: "marketing-campaign-approval",
      name: "Marketing Campaign Approval",
      orgId: orgGroup,
      description: "Marketing creative → legal-sign-off → exec-sign-off → publish.",
      definition: {
        schemaVersion: 1,
        tasks: [
          { key: "brief", type: "checkpoint", title: "Campaign brief" },
          { key: "creative-draft", type: "agent_task", title: "Creative draft", agentRef: { package: "@cinatra-ai/blog-linkedin-writer-agent" }, dependsOn: [{ taskKey: "brief" }] },
          { key: "legal-sign-off", type: "approval", title: "Legal sign-off", requiredScope: { level: "organization" }, dependsOn: [{ taskKey: "creative-draft" }] },
          { key: "exec-sign-off", type: "approval", title: "Exec sign-off", requiredScope: { level: "organization" }, dependsOn: [{ taskKey: "legal-sign-off" }] },
          { key: "publish", type: "checkpoint", title: "Publish", dependsOn: [{ taskKey: "exec-sign-off" }] },
        ],
      },
    },
    {
      id: "wftpl-seed-v65-compliance-review",
      key: "compliance-review",
      name: "Quarterly Compliance Review",
      orgId: orgGroup,
      description: "Scope → controls audit → remediation → exec-sign-off → file.",
      definition: {
        schemaVersion: 1,
        tasks: [
          { key: "scope", type: "checkpoint", title: "Scope definition" },
          { key: "controls-audit", type: "agent_task", title: "Controls audit", agentRef: { package: "@cinatra-ai/security-reviewer-agent" }, dependsOn: [{ taskKey: "scope" }] },
          { key: "remediation", type: "manual", title: "Remediation tasks", dependsOn: [{ taskKey: "controls-audit" }] },
          { key: "exec-sign-off", type: "approval", title: "Exec sign-off", requiredScope: { level: "organization" }, dependsOn: [{ taskKey: "remediation" }] },
          { key: "file", type: "checkpoint", title: "File compliance report", dependsOn: [{ taskKey: "exec-sign-off" }] },
        ],
      },
    },
  ];
}

export function buildWorkflowSeedInstances({ orgGroup, orgRobotics, orgCloud, daysFromNow, cascadeDay }) {
  return [
    // ── Major Product Release (group) ───────────────────────────────────
    { id: "wf-seed-v65-major-release-draft-q1", name: "Q1 Platform Launch (planning)", product: "ACME Cloud", status: "draft",
      targetAt: daysFromNow(75), orgId: orgGroup, sourceTemplateId: "wftpl-seed-v65-major-product-release",
      tasks: [
        // Mix: 2 milestones (kickoff, launch) bookend 3 span bars so the Gantt
        // shows real-shape variety on the user's primary repro workflow.
        { key: "kickoff", type: "checkpoint", title: "Release kickoff", status: "idle", due: daysFromNow(60) },
        { key: "eng-readiness", type: "agent_task", title: "Engineering readiness check", status: "idle",
          start: daysFromNow(60), end: daysFromNow(63), due: daysFromNow(63),
          agentPackage: "@cinatra-ai/code-reviewer-agent", agentRef: { package: "@cinatra-ai/code-reviewer-agent" } },
        { key: "docs", type: "agent_task", title: "Documentation update", status: "idle",
          start: daysFromNow(63), end: daysFromNow(68), due: daysFromNow(68),
          agentPackage: "@cinatra-ai/author-agent", agentRef: { package: "@cinatra-ai/author-agent" } },
        { key: "legal-sign-off", type: "approval", title: "Legal sign-off", status: "idle",
          start: daysFromNow(68), end: daysFromNow(70), due: daysFromNow(70) },
        { key: "launch-day", type: "checkpoint", title: "Launch day", status: "idle", due: daysFromNow(75) },
      ],
      dependencies: [
        { from: "kickoff", to: "eng-readiness" }, { from: "eng-readiness", to: "docs" },
        { from: "docs", to: "legal-sign-off" }, { from: "legal-sign-off", to: "launch-day" },
      ],
      gates: [{ taskKey: "kickoff", kind: "dependency", state: "pending" }],
      events: [{ kind: "workflow_created", source: "ui", at: daysFromNow(-1) }],
    },
    // Dedicated mixed-shapes demo: 3 point milestones + 4 span bars covering
    // all 6 task types (checkpoint, agent_task, manual, notification, approval,
    // wait). Draft so the user can drag-test span bars and milestones side by
    // side. Linear dep chain.
    { id: "wf-seed-v65-major-release-draft-mixed-gantt", name: "Demo: Mixed Gantt Shapes",
      product: "ACME Platform", status: "draft",
      targetAt: daysFromNow(30), orgId: orgGroup,
      sourceTemplateId: "wftpl-seed-v65-major-product-release",
      tasks: [
        { key: "kickoff", type: "checkpoint", title: "Kickoff (milestone)", status: "idle",
          due: daysFromNow(1) },
        { key: "design", type: "agent_task", title: "Design review (5d span)", status: "idle",
          start: daysFromNow(2), end: daysFromNow(7), due: daysFromNow(7),
          agentPackage: "@cinatra-ai/code-reviewer-agent",
          agentRef: { package: "@cinatra-ai/code-reviewer-agent" } },
        { key: "build", type: "manual", title: "Build implementation (10d span)", status: "idle",
          start: daysFromNow(8), end: daysFromNow(18), due: daysFromNow(18) },
        { key: "beta-notice", type: "notification", title: "Beta notice window (3d span)", status: "idle",
          start: daysFromNow(19), end: daysFromNow(22), due: daysFromNow(22) },
        { key: "exec-sign", type: "approval", title: "Exec sign-off (milestone)", status: "idle",
          due: daysFromNow(24) },
        { key: "soak", type: "wait", title: "Soak period (4d span)", status: "idle",
          start: daysFromNow(25), end: daysFromNow(29), due: daysFromNow(29) },
        { key: "launch", type: "checkpoint", title: "Launch day (milestone)", status: "idle",
          due: daysFromNow(30) },
      ],
      dependencies: [
        { from: "kickoff", to: "design" },
        { from: "design", to: "build" },
        { from: "build", to: "beta-notice" },
        { from: "beta-notice", to: "exec-sign" },
        { from: "exec-sign", to: "soak" },
        { from: "soak", to: "launch" },
      ],
      gates: [{ taskKey: "kickoff", kind: "dependency", state: "pending" }],
      events: [{ kind: "workflow_created", source: "ui", at: daysFromNow(-1) }],
    },
    // Dedicated target-date CASCADE demo: every task is RELATIVE-scheduled to the
    // target so moving the release date in the Gantt fans the whole plan out
    // (each task shifts by its own offset) instead of collapsing onto the target
    // — the behavior an unscheduled task would (wrongly) show. Milestones use the
    // default `due` anchor (no duration) so they stay directly drag-editable AND
    // cascade. The 4 span bars carry `anchorPoint:"end"`+`durationIso8601`, which
    // the drag path rejects (`unsupported_in_slice`): here they move via the
    // target-date cascade or chat, NOT direct drag — drag-test span bars on the
    // "Mixed Gantt Shapes" fixture above. Dates derive from one `cascadeBase`
    // instant so the static planned columns match the resolver output exactly.
    { id: "wf-seed-v65-major-release-draft-cascade", name: "Demo: Release Cascade",
      product: "ACME Platform", status: "draft",
      targetAt: cascadeDay(30), orgId: orgGroup,
      sourceTemplateId: "wftpl-seed-v65-major-product-release",
      tasks: [
        { key: "kickoff", type: "checkpoint", title: "Kickoff (milestone)", status: "idle",
          due: cascadeDay(1),
          schedule: { mode: "relative", anchor: "target", offsetIso8601: "P29D", direction: "before" } },
        { key: "design", type: "agent_task", title: "Design review (5d span)", status: "idle",
          start: cascadeDay(2), end: cascadeDay(7), due: cascadeDay(7),
          agentPackage: "@cinatra-ai/code-reviewer-agent",
          agentRef: { package: "@cinatra-ai/code-reviewer-agent" },
          schedule: { mode: "relative", anchor: "target", offsetIso8601: "P23D", direction: "before", anchorPoint: "end", durationIso8601: "P5D" } },
        { key: "build", type: "manual", title: "Build implementation (10d span)", status: "idle",
          start: cascadeDay(8), end: cascadeDay(18), due: cascadeDay(18),
          schedule: { mode: "relative", anchor: "target", offsetIso8601: "P12D", direction: "before", anchorPoint: "end", durationIso8601: "P10D" } },
        { key: "beta-notice", type: "notification", title: "Beta notice window (3d span)", status: "idle",
          start: cascadeDay(19), end: cascadeDay(22), due: cascadeDay(22),
          schedule: { mode: "relative", anchor: "target", offsetIso8601: "P8D", direction: "before", anchorPoint: "end", durationIso8601: "P3D" } },
        { key: "exec-sign", type: "approval", title: "Exec sign-off (milestone)", status: "idle",
          due: cascadeDay(24),
          schedule: { mode: "relative", anchor: "target", offsetIso8601: "P6D", direction: "before" } },
        { key: "soak", type: "wait", title: "Soak period (4d span)", status: "idle",
          start: cascadeDay(25), end: cascadeDay(29), due: cascadeDay(29),
          schedule: { mode: "relative", anchor: "target", offsetIso8601: "P1D", direction: "before", anchorPoint: "end", durationIso8601: "P4D" } },
        { key: "launch", type: "checkpoint", title: "Launch day (milestone)", status: "idle",
          due: cascadeDay(30),
          schedule: { mode: "relative", anchor: "target", offsetIso8601: "P0D", direction: "before" } },
      ],
      dependencies: [
        { from: "kickoff", to: "design" },
        { from: "design", to: "build" },
        { from: "build", to: "beta-notice" },
        { from: "beta-notice", to: "exec-sign" },
        { from: "exec-sign", to: "soak" },
        { from: "soak", to: "launch" },
      ],
      gates: [{ taskKey: "kickoff", kind: "dependency", state: "pending" }],
      events: [{ kind: "workflow_created", source: "ui", at: cascadeDay(-1) }],
    },
    // Hierarchical demo — one summary parent ("summary") rolling up 3 leaf
    // children (design, build, ship). Reviewers see SVAR's rollup bar +
    // collapse/expand. DRAFT-only — `validateStart` rejects hierarchical
    // specs with HIERARCHY_NOT_RUNNABLE (executing summary parents is
    // future scope). The leaf children carry relative schedules
    // anchored to target so a target move ALSO demonstrates hierarchy + cascade
    // together; the parent's window auto-derives from min(child.start) /
    // max(child.end) / max(child.due). The parent task carries no schedule —
    // validation now rejects own-schedule/pinned on parents.
    { id: "wf-seed-v65-major-release-draft-hierarchy", name: "Demo: Hierarchical Release",
      product: "ACME Platform", status: "draft",
      targetAt: daysFromNow(30), orgId: orgGroup,
      sourceTemplateId: "wftpl-seed-v65-major-product-release",
      tasks: [
        // Parent window is min(child.start) / max(child.end) / max(child.due)
        // = (design.start=day 2, ship.due=day 30, ship.due=day 30). The seed
        // path bypasses resolveSchedule, so write the derived dates directly
        // (the live spec/writer path computes this from the children via the
        // resolver's parent-pass — see resolveSchedule in
        // packages/workflows/src/schedule/resolver.ts).
        { key: "summary", type: "checkpoint", title: "Summary", status: "idle",
          start: daysFromNow(2), end: daysFromNow(30), due: daysFromNow(30) },
        { key: "design", type: "agent_task", title: "Design", status: "idle",
          parent: "summary",
          start: daysFromNow(2), end: daysFromNow(7), due: daysFromNow(7),
          agentPackage: "@cinatra-ai/code-reviewer-agent",
          agentRef: { package: "@cinatra-ai/code-reviewer-agent" },
          schedule: { mode: "relative", anchor: "target", offsetIso8601: "P23D", direction: "before", anchorPoint: "end", durationIso8601: "P5D" } },
        { key: "build", type: "manual", title: "Build", status: "idle",
          parent: "summary",
          start: daysFromNow(8), end: daysFromNow(18), due: daysFromNow(18),
          schedule: { mode: "relative", anchor: "target", offsetIso8601: "P12D", direction: "before", anchorPoint: "end", durationIso8601: "P10D" } },
        { key: "ship", type: "checkpoint", title: "Ship", status: "idle",
          parent: "summary",
          due: daysFromNow(30),
          schedule: { mode: "relative", anchor: "target", offsetIso8601: "P0D", direction: "before" } },
      ],
      dependencies: [
        { from: "design", to: "build" },
        { from: "build", to: "ship" },
      ],
      gates: [{ taskKey: "design", kind: "dependency", state: "pending" }],
      events: [{ kind: "workflow_created", source: "ui", at: daysFromNow(-1) }],
    },
    { id: "wf-seed-v65-major-release-active-q4", name: "ACME 2.0 Q4 Launch", product: "ACME Platform", status: "active",
      targetAt: daysFromNow(21), orgId: orgGroup, sourceTemplateId: "wftpl-seed-v65-major-product-release",
      tasks: [
        { key: "kickoff", type: "checkpoint", title: "Release kickoff", status: "succeeded", due: daysFromNow(-7), actualStart: daysFromNow(-7), actualEnd: daysFromNow(-7) },
        { key: "eng-readiness", type: "agent_task", title: "Engineering readiness check", status: "succeeded", due: daysFromNow(-4), actualStart: daysFromNow(-5), actualEnd: daysFromNow(-4), agentPackage: "@cinatra-ai/code-reviewer-agent", agentRef: { package: "@cinatra-ai/code-reviewer-agent" } },
        { key: "docs", type: "agent_task", title: "Documentation update", status: "running", due: daysFromNow(7), actualStart: daysFromNow(-1), agentPackage: "@cinatra-ai/author-agent", agentRef: { package: "@cinatra-ai/author-agent" } },
        { key: "legal-sign-off", type: "approval", title: "Legal sign-off", status: "pending_approval", due: daysFromNow(14) },
        { key: "launch-day", type: "checkpoint", title: "Launch day", status: "idle", due: daysFromNow(21) },
      ],
      dependencies: [
        { from: "kickoff", to: "eng-readiness" }, { from: "eng-readiness", to: "docs" },
        { from: "docs", to: "legal-sign-off" }, { from: "legal-sign-off", to: "launch-day" },
      ],
      attempts: [
        { taskKey: "kickoff", attemptNo: 1, status: "succeeded", startedAt: daysFromNow(-7), completedAt: daysFromNow(-7) },
        { taskKey: "eng-readiness", attemptNo: 1, status: "succeeded", startedAt: daysFromNow(-5), completedAt: daysFromNow(-4) },
        { taskKey: "docs", attemptNo: 1, status: "running", startedAt: daysFromNow(-1) },
      ],
      approvals: [{ taskKey: "legal-sign-off", requiredScope: { level: "organization" }, status: "pending" }],
      gates: [
        { taskKey: "legal-sign-off", kind: "dependency", state: "blocked", reason: "Waiting on docs completion" },
        { taskKey: "legal-sign-off", kind: "approval", state: "pending", reason: "Awaiting org-scope approver" },
        { taskKey: "launch-day", kind: "dependency", state: "pending" },
      ],
      events: [
        { kind: "workflow_started", source: "lifecycle", at: daysFromNow(-7) },
        { kind: "task_succeeded", source: "reconciler", taskKey: "kickoff", at: daysFromNow(-7) },
        { kind: "task_succeeded", source: "reconciler", taskKey: "eng-readiness", at: daysFromNow(-4) },
        { kind: "task_dispatched", source: "reconciler", taskKey: "docs", at: daysFromNow(-1) },
      ],
    },
    { id: "wf-seed-v65-major-release-paused-mvp", name: "Q3 Platform Cutover", product: "ACME Platform", status: "paused",
      targetAt: daysFromNow(14), orgId: orgGroup, sourceTemplateId: "wftpl-seed-v65-major-product-release",
      tasks: [
        { key: "kickoff", type: "checkpoint", title: "Release kickoff", status: "succeeded", due: daysFromNow(-3), actualStart: daysFromNow(-3), actualEnd: daysFromNow(-3) },
        { key: "eng-readiness", type: "agent_task", title: "Engineering readiness check", status: "scheduled", due: daysFromNow(2), agentPackage: "@cinatra-ai/code-reviewer-agent", agentRef: { package: "@cinatra-ai/code-reviewer-agent" } },
        { key: "launch-day", type: "checkpoint", title: "Launch day", status: "idle", due: daysFromNow(14) },
      ],
      dependencies: [{ from: "kickoff", to: "eng-readiness" }, { from: "eng-readiness", to: "launch-day" }],
      attempts: [{ taskKey: "kickoff", attemptNo: 1, status: "succeeded", startedAt: daysFromNow(-3), completedAt: daysFromNow(-3) }],
      gates: [{ taskKey: "eng-readiness", kind: "dependency", state: "blocked", reason: "Workflow paused — operator-initiated" }],
      events: [
        { kind: "workflow_started", source: "lifecycle", at: daysFromNow(-3) },
        { kind: "task_succeeded", source: "reconciler", taskKey: "kickoff", at: daysFromNow(-3) },
        { kind: "workflow_paused", source: "lifecycle", at: daysFromNow(-1) },
      ],
    },
    { id: "wf-seed-v65-major-release-completed-h2", name: "H2 Platform Release", product: "ACME Platform", status: "completed",
      targetAt: daysFromNow(-14), orgId: orgGroup, sourceTemplateId: "wftpl-seed-v65-major-product-release",
      tasks: [
        { key: "kickoff", type: "checkpoint", title: "Release kickoff", status: "succeeded", due: daysFromNow(-60), actualStart: daysFromNow(-60), actualEnd: daysFromNow(-60) },
        { key: "eng-readiness", type: "agent_task", title: "Engineering readiness check", status: "succeeded", due: daysFromNow(-50), actualStart: daysFromNow(-51), actualEnd: daysFromNow(-50), agentPackage: "@cinatra-ai/code-reviewer-agent", agentRef: { package: "@cinatra-ai/code-reviewer-agent" } },
        { key: "legal-sign-off", type: "approval", title: "Legal sign-off", status: "succeeded", due: daysFromNow(-30), actualStart: daysFromNow(-32), actualEnd: daysFromNow(-30) },
        { key: "launch-day", type: "checkpoint", title: "Launch day", status: "succeeded", due: daysFromNow(-14), actualStart: daysFromNow(-14), actualEnd: daysFromNow(-14) },
        { key: "post-launch-retro", type: "manual", title: "Post-launch retro", status: "succeeded", due: daysFromNow(-7), actualStart: daysFromNow(-7), actualEnd: daysFromNow(-7) },
      ],
      dependencies: [
        { from: "kickoff", to: "eng-readiness" }, { from: "eng-readiness", to: "legal-sign-off" },
        { from: "legal-sign-off", to: "launch-day" }, { from: "launch-day", to: "post-launch-retro" },
      ],
      attempts: [
        { taskKey: "kickoff", attemptNo: 1, status: "succeeded", startedAt: daysFromNow(-60), completedAt: daysFromNow(-60) },
        { taskKey: "eng-readiness", attemptNo: 1, status: "succeeded", startedAt: daysFromNow(-51), completedAt: daysFromNow(-50) },
      ],
      approvals: [{ taskKey: "legal-sign-off", requiredScope: { level: "organization" }, status: "granted", decidedBy: "usr-alice-cooper", decidedAt: daysFromNow(-30), reason: "Approved without redline." }],
      artifacts: [
        { taskKey: "launch-day", kind: "url", ref: "https://acme-cloud.example/blog/h2-release-notes" },
        { taskKey: "post-launch-retro", kind: "document", ref: "doc://retro/h2-2026" },
      ],
      gates: [{ taskKey: "post-launch-retro", kind: "dependency", state: "passed" }],
      events: [
        { kind: "workflow_started", source: "lifecycle", at: daysFromNow(-60) },
        { kind: "workflow_completed", source: "lifecycle", at: daysFromNow(-7) },
      ],
    },
    { id: "wf-seed-v65-major-release-failed-q2", name: "Q2 Rollback Release", product: "ACME Cloud", status: "failed",
      targetAt: daysFromNow(-30), orgId: orgGroup, sourceTemplateId: "wftpl-seed-v65-major-product-release",
      tasks: [
        { key: "kickoff", type: "checkpoint", title: "Release kickoff", status: "succeeded", due: daysFromNow(-45), actualStart: daysFromNow(-45), actualEnd: daysFromNow(-45) },
        { key: "eng-readiness", type: "agent_task", title: "Engineering readiness check", status: "failed", due: daysFromNow(-40), actualStart: daysFromNow(-42), actualEnd: daysFromNow(-40), agentPackage: "@cinatra-ai/code-reviewer-agent", agentRef: { package: "@cinatra-ai/code-reviewer-agent" } },
        { key: "launch-day", type: "checkpoint", title: "Launch day", status: "cancelled", due: daysFromNow(-30) },
      ],
      dependencies: [{ from: "kickoff", to: "eng-readiness" }, { from: "eng-readiness", to: "launch-day" }],
      attempts: [
        { taskKey: "kickoff", attemptNo: 1, status: "succeeded", startedAt: daysFromNow(-45), completedAt: daysFromNow(-45) },
        { taskKey: "eng-readiness", attemptNo: 1, status: "failed", startedAt: daysFromNow(-42), completedAt: daysFromNow(-40), error: { code: "readiness_check_failed", message: "3 P1 issues outstanding" } },
        { taskKey: "eng-readiness", attemptNo: 2, status: "failed", startedAt: daysFromNow(-41), completedAt: daysFromNow(-40), error: { code: "readiness_check_failed", message: "Retry: still 2 P1 issues outstanding" } },
      ],
      gates: [{ taskKey: "launch-day", kind: "dependency", state: "blocked", reason: "Upstream task failed" }],
      events: [
        { kind: "workflow_started", source: "lifecycle", at: daysFromNow(-45) },
        { kind: "task_failed", source: "reconciler", taskKey: "eng-readiness", at: daysFromNow(-40) },
        { kind: "workflow_failed", source: "lifecycle", at: daysFromNow(-40) },
      ],
    },
    { id: "wf-seed-v65-major-release-cancelled-shift", name: "Roadmap-shift Cancelled Release", product: "ACME Platform", status: "cancelled",
      targetAt: daysFromNow(45), orgId: orgGroup, sourceTemplateId: "wftpl-seed-v65-major-product-release",
      tasks: [
        { key: "kickoff", type: "checkpoint", title: "Release kickoff", status: "succeeded", due: daysFromNow(-2), actualStart: daysFromNow(-2), actualEnd: daysFromNow(-2) },
        { key: "eng-readiness", type: "agent_task", title: "Engineering readiness check", status: "cancelled", due: daysFromNow(15), agentPackage: "@cinatra-ai/code-reviewer-agent", agentRef: { package: "@cinatra-ai/code-reviewer-agent" } },
        { key: "launch-day", type: "checkpoint", title: "Launch day", status: "cancelled", due: daysFromNow(45) },
      ],
      dependencies: [{ from: "kickoff", to: "eng-readiness" }, { from: "eng-readiness", to: "launch-day" }],
      events: [
        { kind: "workflow_started", source: "lifecycle", at: daysFromNow(-2) },
        { kind: "workflow_cancelled", source: "lifecycle", at: daysFromNow(-1) },
      ],
    },
    // ── Hotfix Release (cloud) ──────────────────────────────────────────
    { id: "wf-seed-v65-hotfix-active-7-3-2", name: "Hotfix 7.3.2 — cache eviction", product: "ACME Cloud", status: "active",
      targetAt: daysFromNow(2), orgId: orgCloud, sourceTemplateId: "wftpl-seed-v65-hotfix-release",
      tasks: [
        { key: "triage", type: "checkpoint", title: "Incident triage", status: "succeeded", due: daysFromNow(-1), actualStart: daysFromNow(-1), actualEnd: daysFromNow(-1) },
        { key: "fix", type: "agent_task", title: "Patch implementation", status: "running", due: daysFromNow(1), actualStart: daysFromNow(0), agentPackage: "@cinatra-ai/code-reviewer-agent", agentRef: { package: "@cinatra-ai/code-reviewer-agent" } },
        { key: "patch-release", type: "checkpoint", title: "Patch release", status: "idle", due: daysFromNow(2) },
        { key: "comms-update", type: "agent_task", title: "Customer update", status: "idle", due: daysFromNow(2), agentPackage: "@cinatra-ai/author-agent", agentRef: { package: "@cinatra-ai/author-agent" } },
      ],
      dependencies: [
        { from: "triage", to: "fix" }, { from: "fix", to: "patch-release" }, { from: "patch-release", to: "comms-update" },
      ],
      attempts: [
        { taskKey: "triage", attemptNo: 1, status: "succeeded", startedAt: daysFromNow(-1), completedAt: daysFromNow(-1) },
        { taskKey: "fix", attemptNo: 1, status: "running", startedAt: daysFromNow(0) },
      ],
      gates: [{ taskKey: "patch-release", kind: "dependency", state: "pending" }],
      events: [
        { kind: "workflow_started", source: "lifecycle", at: daysFromNow(-1) },
        { kind: "task_dispatched", source: "reconciler", taskKey: "fix", at: daysFromNow(0) },
      ],
    },
    { id: "wf-seed-v65-hotfix-completed-7-3-1", name: "Hotfix 7.3.1 — bucket auth", product: "ACME Cloud", status: "completed",
      targetAt: daysFromNow(-3), orgId: orgCloud, sourceTemplateId: "wftpl-seed-v65-hotfix-release",
      tasks: [
        { key: "triage", type: "checkpoint", title: "Incident triage", status: "succeeded", due: daysFromNow(-5), actualStart: daysFromNow(-5), actualEnd: daysFromNow(-5) },
        { key: "fix", type: "agent_task", title: "Patch implementation", status: "succeeded", due: daysFromNow(-4), actualStart: daysFromNow(-5), actualEnd: daysFromNow(-4), agentPackage: "@cinatra-ai/code-reviewer-agent", agentRef: { package: "@cinatra-ai/code-reviewer-agent" } },
        { key: "patch-release", type: "checkpoint", title: "Patch release", status: "succeeded", due: daysFromNow(-3), actualStart: daysFromNow(-3), actualEnd: daysFromNow(-3) },
        { key: "comms-update", type: "agent_task", title: "Customer update", status: "succeeded", due: daysFromNow(-3), actualStart: daysFromNow(-3), actualEnd: daysFromNow(-3), agentPackage: "@cinatra-ai/author-agent", agentRef: { package: "@cinatra-ai/author-agent" } },
      ],
      dependencies: [{ from: "triage", to: "fix" }, { from: "fix", to: "patch-release" }, { from: "patch-release", to: "comms-update" }],
      artifacts: [{ taskKey: "comms-update", kind: "url", ref: "https://acme-cloud.example/incident/7-3-1-postmortem" }],
      events: [
        { kind: "workflow_started", source: "lifecycle", at: daysFromNow(-5) },
        { kind: "workflow_completed", source: "lifecycle", at: daysFromNow(-3) },
      ],
    },
    // ── Security Patch Release (cloud) ──────────────────────────────────
    { id: "wf-seed-v65-security-active-cve-2026-1117", name: "CVE-2026-1117 patch", product: "ACME Cloud", status: "active",
      targetAt: daysFromNow(5), orgId: orgCloud, sourceTemplateId: "wftpl-seed-v65-security-patch-release",
      tasks: [
        { key: "cve-intake", type: "checkpoint", title: "CVE intake", status: "succeeded", due: daysFromNow(-3), actualStart: daysFromNow(-3), actualEnd: daysFromNow(-3) },
        { key: "patch", type: "agent_task", title: "Patch", status: "succeeded", due: daysFromNow(-1), actualStart: daysFromNow(-2), actualEnd: daysFromNow(-1), agentPackage: "@cinatra-ai/security-reviewer-agent", agentRef: { package: "@cinatra-ai/security-reviewer-agent" } },
        { key: "security-review", type: "approval", title: "Security review sign-off", status: "succeeded", due: daysFromNow(0), actualStart: daysFromNow(0), actualEnd: daysFromNow(0) },
        { key: "disclosure", type: "manual", title: "Coordinated disclosure", status: "running", due: daysFromNow(3), actualStart: daysFromNow(0) },
        { key: "release", type: "checkpoint", title: "Patch release", status: "idle", due: daysFromNow(5) },
      ],
      dependencies: [
        { from: "cve-intake", to: "patch" }, { from: "patch", to: "security-review" },
        { from: "security-review", to: "disclosure" }, { from: "disclosure", to: "release" },
      ],
      approvals: [{ taskKey: "security-review", requiredScope: { level: "organization" }, status: "granted", decidedBy: "usr-elena-rossi", decidedAt: daysFromNow(0), reason: "Patch validated; coordinated disclosure approved." }],
      gates: [{ taskKey: "release", kind: "dependency", state: "pending" }],
      events: [{ kind: "workflow_started", source: "lifecycle", at: daysFromNow(-3) }],
    },
    { id: "wf-seed-v65-security-pending-cve-2026-1240", name: "CVE-2026-1240 patch", product: "ACME Cloud", status: "active",
      targetAt: daysFromNow(7), orgId: orgCloud, sourceTemplateId: "wftpl-seed-v65-security-patch-release",
      tasks: [
        { key: "cve-intake", type: "checkpoint", title: "CVE intake", status: "succeeded", due: daysFromNow(-2), actualStart: daysFromNow(-2), actualEnd: daysFromNow(-2) },
        { key: "patch", type: "agent_task", title: "Patch", status: "succeeded", due: daysFromNow(0), actualStart: daysFromNow(-1), actualEnd: daysFromNow(0), agentPackage: "@cinatra-ai/security-reviewer-agent", agentRef: { package: "@cinatra-ai/security-reviewer-agent" } },
        { key: "security-review", type: "approval", title: "Security review sign-off", status: "pending_approval", due: daysFromNow(2) },
        { key: "release", type: "checkpoint", title: "Patch release", status: "idle", due: daysFromNow(7) },
      ],
      dependencies: [{ from: "cve-intake", to: "patch" }, { from: "patch", to: "security-review" }, { from: "security-review", to: "release" }],
      // Deliberately-open pending approval: upstream `patch` is `succeeded`
      // and the approver list has been notified. solicitedAt=true makes
      // this approval visible + decidable in the approvals UI.
      approvals: [{ taskKey: "security-review", requiredScope: { level: "organization" }, status: "pending", solicitedAt: true }],
      gates: [{ taskKey: "security-review", kind: "approval", state: "pending", reason: "Awaiting approver decision" }],
      events: [{ kind: "workflow_started", source: "lifecycle", at: daysFromNow(-2) }],
    },
    { id: "wf-seed-v65-security-rejected-cve-2026-0901", name: "CVE-2026-0901 patch (rejected)", product: "ACME Cloud", status: "failed",
      targetAt: daysFromNow(-7), orgId: orgCloud, sourceTemplateId: "wftpl-seed-v65-security-patch-release",
      tasks: [
        { key: "cve-intake", type: "checkpoint", title: "CVE intake", status: "succeeded", due: daysFromNow(-14), actualStart: daysFromNow(-14), actualEnd: daysFromNow(-14) },
        { key: "patch", type: "agent_task", title: "Patch", status: "succeeded", due: daysFromNow(-10), actualStart: daysFromNow(-12), actualEnd: daysFromNow(-10), agentPackage: "@cinatra-ai/security-reviewer-agent", agentRef: { package: "@cinatra-ai/security-reviewer-agent" } },
        { key: "security-review", type: "approval", title: "Security review sign-off", status: "failed", due: daysFromNow(-8), actualStart: daysFromNow(-9), actualEnd: daysFromNow(-8) },
        { key: "release", type: "checkpoint", title: "Patch release", status: "cancelled", due: daysFromNow(-7) },
      ],
      dependencies: [{ from: "cve-intake", to: "patch" }, { from: "patch", to: "security-review" }, { from: "security-review", to: "release" }],
      approvals: [{ taskKey: "security-review", requiredScope: { level: "organization" }, status: "rejected", decidedBy: "usr-elena-rossi", decidedAt: daysFromNow(-8), reason: "Disclosure timing unacceptable for OEM partners. Patch refactor required before re-review." }],
      events: [{ kind: "workflow_started", source: "lifecycle", at: daysFromNow(-14) }, { kind: "workflow_failed", source: "lifecycle", at: daysFromNow(-8) }],
    },
    // ── Beta Release (robotics) ─────────────────────────────────────────
    { id: "wf-seed-v65-beta-active-rover-v3", name: "Rover v3 beta", product: "ACME Robotics", status: "active",
      targetAt: daysFromNow(30), orgId: orgRobotics, sourceTemplateId: "wftpl-seed-v65-beta-release",
      tasks: [
        { key: "kickoff", type: "checkpoint", title: "Beta kickoff", status: "succeeded", due: daysFromNow(-10), actualStart: daysFromNow(-10), actualEnd: daysFromNow(-10) },
        { key: "beta-blog", type: "agent_task", title: "Beta announcement", status: "succeeded", due: daysFromNow(-7), actualStart: daysFromNow(-8), actualEnd: daysFromNow(-7), agentPackage: "@cinatra-ai/blog-pipeline-agent", agentRef: { package: "@cinatra-ai/blog-pipeline-agent" } },
        { key: "cohort-invites", type: "agent_task", title: "Invite beta cohort", status: "succeeded", due: daysFromNow(-5), actualStart: daysFromNow(-6), actualEnd: daysFromNow(-5), agentPackage: "@cinatra-ai/email-outreach-agent", agentRef: { package: "@cinatra-ai/email-outreach-agent" } },
        { key: "feedback-windows", type: "manual", title: "Collect feedback (2-week window)", status: "running", due: daysFromNow(9), actualStart: daysFromNow(-5) },
        { key: "ga-decision", type: "manual", title: "GA / extend decision", status: "idle", due: daysFromNow(30) },
      ],
      dependencies: [
        { from: "kickoff", to: "beta-blog" }, { from: "beta-blog", to: "cohort-invites" },
        { from: "cohort-invites", to: "feedback-windows" }, { from: "feedback-windows", to: "ga-decision" },
      ],
      artifacts: [{ taskKey: "beta-blog", kind: "url", ref: "https://acme-robotics.example/blog/rover-v3-beta" }],
      gates: [{ taskKey: "ga-decision", kind: "dependency", state: "blocked", reason: "Awaiting feedback window close" }],
      events: [{ kind: "workflow_started", source: "lifecycle", at: daysFromNow(-10) }],
    },
    { id: "wf-seed-v65-beta-completed-rover-v2", name: "Rover v2 beta (shipped to GA)", product: "ACME Robotics", status: "completed",
      targetAt: daysFromNow(-21), orgId: orgRobotics, sourceTemplateId: "wftpl-seed-v65-beta-release",
      tasks: [
        { key: "kickoff", type: "checkpoint", title: "Beta kickoff", status: "succeeded", due: daysFromNow(-90), actualStart: daysFromNow(-90), actualEnd: daysFromNow(-90) },
        { key: "beta-blog", type: "agent_task", title: "Beta announcement", status: "succeeded", due: daysFromNow(-85), actualStart: daysFromNow(-86), actualEnd: daysFromNow(-85), agentPackage: "@cinatra-ai/blog-pipeline-agent", agentRef: { package: "@cinatra-ai/blog-pipeline-agent" } },
        { key: "cohort-invites", type: "agent_task", title: "Invite beta cohort", status: "succeeded", due: daysFromNow(-80), actualStart: daysFromNow(-82), actualEnd: daysFromNow(-80), agentPackage: "@cinatra-ai/email-outreach-agent", agentRef: { package: "@cinatra-ai/email-outreach-agent" } },
        { key: "feedback-windows", type: "manual", title: "Collect feedback (2-week window)", status: "succeeded", due: daysFromNow(-60), actualStart: daysFromNow(-80), actualEnd: daysFromNow(-60) },
        { key: "ga-decision", type: "manual", title: "GA / extend decision", status: "succeeded", due: daysFromNow(-21), actualStart: daysFromNow(-21), actualEnd: daysFromNow(-21) },
      ],
      dependencies: [
        { from: "kickoff", to: "beta-blog" }, { from: "beta-blog", to: "cohort-invites" },
        { from: "cohort-invites", to: "feedback-windows" }, { from: "feedback-windows", to: "ga-decision" },
      ],
      artifacts: [
        { taskKey: "beta-blog", kind: "url", ref: "https://acme-robotics.example/blog/rover-v2-beta" },
        { taskKey: "ga-decision", kind: "document", ref: "doc://ga-decisions/rover-v2" },
      ],
      events: [{ kind: "workflow_completed", source: "lifecycle", at: daysFromNow(-21) }],
    },
    // ── Marketing Campaign Approval (group) ─────────────────────────────
    { id: "wf-seed-v65-marketing-needs-revision-q4", name: "Q4 brand campaign — Holiday", product: "ACME Group", status: "active",
      targetAt: daysFromNow(28), orgId: orgGroup, sourceTemplateId: "wftpl-seed-v65-marketing-campaign-approval",
      tasks: [
        { key: "brief", type: "checkpoint", title: "Campaign brief", status: "succeeded", due: daysFromNow(-7), actualStart: daysFromNow(-7), actualEnd: daysFromNow(-7) },
        { key: "creative-draft", type: "agent_task", title: "Creative draft", status: "succeeded", due: daysFromNow(-3), actualStart: daysFromNow(-5), actualEnd: daysFromNow(-3), agentPackage: "@cinatra-ai/blog-linkedin-writer-agent", agentRef: { package: "@cinatra-ai/blog-linkedin-writer-agent" } },
        { key: "legal-sign-off", type: "approval", title: "Legal sign-off", status: "running", due: daysFromNow(2) },
        { key: "exec-sign-off", type: "approval", title: "Exec sign-off", status: "idle", due: daysFromNow(7) },
        { key: "publish", type: "checkpoint", title: "Publish", status: "idle", due: daysFromNow(28) },
      ],
      dependencies: [
        { from: "brief", to: "creative-draft" }, { from: "creative-draft", to: "legal-sign-off" },
        { from: "legal-sign-off", to: "exec-sign-off" }, { from: "exec-sign-off", to: "publish" },
      ],
      approvals: [
        { taskKey: "legal-sign-off", requiredScope: { level: "organization" }, status: "needs_revision", decidedBy: "usr-carla-mendes", decidedAt: daysFromNow(-1), reason: "Trademark phrasing — line 3 needs a rework before re-submission." },
        { taskKey: "exec-sign-off", requiredScope: { level: "organization" }, status: "pending" },
      ],
      gates: [{ taskKey: "legal-sign-off", kind: "approval", state: "blocked", reason: "Decision: needs_revision" }],
      events: [{ kind: "workflow_started", source: "lifecycle", at: daysFromNow(-7) }],
    },
    // ── Compliance Review (group) ────────────────────────────────────────
    { id: "wf-seed-v65-compliance-active-q4-soc2", name: "Q4 SOC2 review", product: "ACME Group", status: "active",
      targetAt: daysFromNow(30), orgId: orgGroup, sourceTemplateId: "wftpl-seed-v65-compliance-review",
      tasks: [
        { key: "scope", type: "checkpoint", title: "Scope definition", status: "succeeded", due: daysFromNow(-14), actualStart: daysFromNow(-14), actualEnd: daysFromNow(-14) },
        { key: "controls-audit", type: "agent_task", title: "Controls audit", status: "succeeded", due: daysFromNow(-7), actualStart: daysFromNow(-10), actualEnd: daysFromNow(-7), agentPackage: "@cinatra-ai/security-reviewer-agent", agentRef: { package: "@cinatra-ai/security-reviewer-agent" } },
        { key: "remediation", type: "manual", title: "Remediation tasks", status: "running", due: daysFromNow(14), actualStart: daysFromNow(-7) },
        { key: "exec-sign-off", type: "approval", title: "Exec sign-off", status: "idle", due: daysFromNow(21) },
        { key: "file", type: "checkpoint", title: "File compliance report", status: "idle", due: daysFromNow(30) },
      ],
      dependencies: [
        { from: "scope", to: "controls-audit" }, { from: "controls-audit", to: "remediation" },
        { from: "remediation", to: "exec-sign-off" }, { from: "exec-sign-off", to: "file" },
      ],
      gates: [{ taskKey: "exec-sign-off", kind: "dependency", state: "blocked", reason: "Remediation in progress" }],
      events: [{ kind: "workflow_started", source: "lifecycle", at: daysFromNow(-14) }],
    },
  ];
}
