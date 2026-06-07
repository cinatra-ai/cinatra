import "server-only";

import type { WorkflowSpec } from "../spec/schema";
import { createWorkflowTemplate, listWorkflowTemplates } from "../store";

// The first real, reusable release-workflow template (roadmap 437.5).
// Authored in TEMPLATE mode: relative schedules anchored to the release, a typed
// `{{product}}` placeholder, default agents + a legal approval gate. No concrete
// release date — instantiate sets it (and fills the placeholder).
export const MAJOR_PRODUCT_RELEASE_TEMPLATE: WorkflowSpec = {
  name: "{{product}} — Major Product Release",
  product: "{{product}}",
  placeholders: {
    product: { type: "string", required: true, description: "Product / release name" },
  },
  tasks: [
    {
      key: "kickoff",
      type: "checkpoint",
      title: "Release kickoff",
      schedule: { mode: "relative", anchor: "target", offsetIso8601: "P21D", direction: "before" },
    },
    {
      key: "blog",
      type: "agent_task",
      title: "Draft launch blog for {{product}}",
      agentRef: { package: "@cinatra-ai/blog-pipeline-agent" },
      input: { brief: "{{product}} launch announcement" },
      dependsOn: [{ taskKey: "kickoff" }],
      maxAttempts: 3,
      failurePolicy: "block",
      schedule: { mode: "relative", anchor: "target", offsetIso8601: "P10D", direction: "before", localTime: "09:00" },
    },
    {
      key: "press",
      type: "agent_task",
      title: "Draft press release for {{product}}",
      agentRef: { package: "@cinatra-ai/blog-pipeline-agent" },
      input: { brief: "{{product}} press release" },
      dependsOn: [{ taskKey: "kickoff" }],
      schedule: { mode: "relative", anchor: "target", offsetIso8601: "P10D", direction: "before" },
    },
    {
      key: "legal",
      type: "approval",
      title: "Legal sign-off",
      requiredScope: { level: "organization" },
      rejectionPolicy: "needs_revision",
      dependsOn: [
        { taskKey: "blog", outcome: "success" },
        { taskKey: "press", outcome: "success" },
      ],
      schedule: { mode: "relative", anchor: "target", offsetIso8601: "P5D", direction: "before" },
    },
    {
      key: "final",
      type: "checkpoint",
      title: "Go / no-go review",
      dependsOn: [{ taskKey: "legal", outcome: "success" }],
      schedule: { mode: "relative", anchor: "target", offsetIso8601: "P1D", direction: "before" },
    },
    {
      key: "announce",
      type: "notification",
      title: "Announce {{product}} is live",
      message: "{{product}} has shipped.",
      dependsOn: [{ taskKey: "final" }],
      schedule: { mode: "relative", anchor: "target", offsetIso8601: "PT1H", direction: "after" },
    },
  ],
};

export const MAJOR_PRODUCT_RELEASE_KEY = "major-product-release";
export const MAJOR_PRODUCT_RELEASE_VERSION = 1;

/**
 * Idempotently seed the "Major Product Release" template into an org. Returns
 * whether it was created. Safe to call repeatedly (keyed on key+version+org).
 */
export async function seedMajorProductReleaseTemplate(input: {
  orgId: string;
  ownerLevel?: string;
  ownerId?: string;
  createdBy?: string | null;
}): Promise<{ created: boolean; templateId: string }> {
  const existing = (await listWorkflowTemplates({ orgId: input.orgId })).find(
    (t) => t.key === MAJOR_PRODUCT_RELEASE_KEY && t.version === MAJOR_PRODUCT_RELEASE_VERSION,
  );
  if (existing) return { created: false, templateId: existing.id };
  const tmpl = await createWorkflowTemplate({
    key: MAJOR_PRODUCT_RELEASE_KEY,
    version: MAJOR_PRODUCT_RELEASE_VERSION,
    name: "Major Product Release",
    description: "AI-assisted multi-week product launch: content drafts, legal sign-off, go/no-go, announce.",
    definition: MAJOR_PRODUCT_RELEASE_TEMPLATE,
    orgId: input.orgId,
    ownerLevel: input.ownerLevel ?? "organization",
    ownerId: input.ownerId ?? input.orgId,
    createdBy: input.createdBy ?? null,
  });
  return { created: true, templateId: tmpl.id };
}
