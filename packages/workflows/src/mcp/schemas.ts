import { z } from "zod";

// MCP tool metadata for the release-workflow primitives (mirrors the
// packages/agents ToolMeta pattern). Spec inputs are intentionally LOOSE
// objects so the handler runs the shared materializeSpec (validation + limits +
// trigger lint) and returns STRUCTURED, fail-closed errors the assistant can act
// on — rather than a raw Zod throw at the transport.

export type ToolMeta = { description: string; inputSchema: z.ZodTypeAny };

const specInput = z.record(z.string(), z.unknown());

export const WORKFLOW_TOOL_META: Record<string, ToolMeta> = {
  workflow_template_list: {
    description:
      "List reusable workflow templates visible in your organization. Read-only. Use this FIRST to find a template before drafting from scratch.",
    inputSchema: z.object({}).loose(),
  },
  workflow_template_get: {
    description:
      "Fetch one workflow template's placeholders + metadata (e.g. typed launcher picker hints) by templateId. Read-only. Use after workflow_template_list to render a launcher.",
    inputSchema: z.object({ templateId: z.string() }),
  },
  workflow_template_instantiate: {
    description:
      "Instantiate a template into a new DRAFT workflow: fills typed placeholders from `inputs`, sets the target date/timezone, snapshots the template version, and re-authorizes referenced agents/approvers. Returns the draft id + a workflow deep link. Proposal-only.",
    inputSchema: z.object({
      templateId: z.string(),
      name: z.string().optional(),
      inputs: z.record(z.string(), z.unknown()).optional(),
      targetAt: z.string().optional(),
      targetTz: z.string().optional(),
      // Optional Cinatra project to scope the new workflow row
      // (workflow.project_id). Requires the actor's write grant on the project.
      projectId: z.string().optional(),
    }),
  },
  workflow_draft_create: {
    description:
      "Create a new DRAFT workflow from a spec (name, release {at,tz}, tasks[]). Validates + enforces resource limits + rejects trigger-bundling; fails closed with structured errors. Returns the draft id + workflow deep link. Proposal-only — cannot start/approve.",
    inputSchema: z.object({ spec: specInput }),
  },
  workflow_draft_update: {
    description:
      "Replace a DRAFT workflow's spec. Requires the current lockVersion (optimistic concurrency). Only works on drafts — never edits an active/paused/completed workflow. Proposal-only.",
    inputSchema: z.object({
      workflowId: z.string(),
      spec: specInput,
      expectedLockVersion: z.number().int().nonnegative(),
      name: z.string().optional(),
    }),
  },
  workflow_draft_get: {
    description: "Read a draft workflow with its resolved timeline (planned start/end + due dates). Read-only.",
    inputSchema: z.object({ workflowId: z.string() }),
  },
  workflow_draft_list: {
    description: "List workflows visible to you (optionally filter by status). Read-only.",
    inputSchema: z.object({ status: z.string().optional() }),
  },
  workflow_validate: {
    description:
      "Validate a spec at template / draft / start tiers and return structured errors (no persistence). Use to check a draft before previewing.",
    inputSchema: z.object({ spec: specInput }),
  },
  workflow_preview: {
    description:
      "Preview a spec (or an existing workflow by id): returns validation + the resolved timeline + a workflow deep link. Read-only — the handoff point to the workflow management surface.",
    inputSchema: z.object({ spec: specInput.optional(), workflowId: z.string().optional() }),
  },
  workflow_status_get: {
    description:
      "Operational status of a workflow: per-task status, planned/actual dates, and any gate blockers (answers 'what's blocked / due / why did X fail'). Read-only.",
    inputSchema: z.object({ workflowId: z.string() }),
  },
  workflow_status_list: {
    description: "Status summary across visible workflows (optionally filter by status and/or projectId). Read-only.",
    inputSchema: z.object({ status: z.string().optional(), projectId: z.string().optional() }),
  },
  workflow_artifacts_list: {
    description:
      "List the artifact representations produced by a workflow (optionally scoped to one task). Used by the task-detail sheet to render produced drafts/images inline. Read-only.",
    inputSchema: z.object({ workflowId: z.string(), taskId: z.string().optional() }),
  },
  workflow_cascade_preview: {
    description:
      "Preview the cascade of moving a workflow's target date: returns the per-task due-date changes for UNPINNED relative tasks (pinned/absolute tasks excluded). Read-only — the target-date control uses this before committing a target-date change.",
    inputSchema: z.object({ workflowId: z.string(), targetAt: z.string() }),
  },
  workflow_copy: {
    description:
      "Copy a previous workflow into a new DRAFT (optionally re-anchored to a new target date). Proposal-only.",
    inputSchema: z.object({
      sourceWorkflowId: z.string(),
      name: z.string().optional(),
      targetAt: z.string().optional(),
    }),
  },
  workflow_save_as_template: {
    description:
      "Save a draft as a reusable template (scope derived from the source/your org). Proposal-only.",
    inputSchema: z.object({
      workflowId: z.string(),
      key: z.string(),
      name: z.string().optional(),
      version: z.number().int().positive().optional(),
    }),
  },
};

export const WORKFLOW_TOOL_NAMES = Object.keys(WORKFLOW_TOOL_META);
