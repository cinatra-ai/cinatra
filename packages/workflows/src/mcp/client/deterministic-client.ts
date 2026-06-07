import "server-only";

// In-process deterministic client for the workflows primitives, mirroring the
// agents/skills/blog clients. It wraps the SAME
// `createWorkflowPrimitiveHandlers(deps)` the MCP server registers, so the
// workflow-launcher portlet's instantiate path shares the host-injected
// `assertProjectWriteAccess` gate (no authz drift). The caller supplies the
// session-derived actor + the host deps; scope is NEVER caller-overridable here.
import {
  createInProcessPrimitiveTransport,
  invokePrimitive,
  type PrimitiveActorContext,
  type PrimitiveTransport,
} from "@cinatra-ai/mcp-client";
import { createWorkflowPrimitiveHandlers, type WorkflowHandlerDeps } from "../handlers";

export type { WorkflowHandlerDeps };

export type WorkflowTemplateSummary = { id: string; key: string; version: string; name: string };
export type WorkflowTemplateDetail = {
  id: string;
  key: string;
  version: string;
  name: string;
  placeholders: Record<string, unknown>;
  metadata: Record<string, unknown>;
};
export type WorkflowInstantiateResult =
  | { workflowId: string; deepLink?: string; renderHint?: string }
  | { error: string; code?: string };

export type DeterministicWorkflowsClient = ReturnType<typeof createDeterministicWorkflowsClient>;

export function createDeterministicWorkflowsClient(input: {
  actor: PrimitiveActorContext;
  deps?: WorkflowHandlerDeps;
  transport?: PrimitiveTransport;
}) {
  const transport =
    input.transport ??
    // The workflow handlers type their request `input` as Record<string,unknown>
    // (stricter than the transport's `unknown`); the in-process transport passes
    // input straight through, so bridge the contravariant param type here.
    createInProcessPrimitiveTransport(
      createWorkflowPrimitiveHandlers(input.deps ?? {}) as unknown as Parameters<
        typeof createInProcessPrimitiveTransport
      >[0],
    );

  function invoke<TOutput>(primitiveName: string, primitiveInput: unknown) {
    return invokePrimitive<unknown, TOutput>(transport, {
      primitiveName,
      input: primitiveInput,
      actor: input.actor,
      mode: "deterministic",
    });
  }

  return {
    template: {
      list: () => invoke<{ templates: WorkflowTemplateSummary[] } | { error: string }>("workflow_template_list", {}),
      get: (templateId: string) =>
        invoke<WorkflowTemplateDetail | { error: string; code?: string }>("workflow_template_get", { templateId }),
      instantiate: (args: {
        templateId: string;
        name?: string;
        inputs?: Record<string, unknown>;
        targetAt?: string;
        targetTz?: string;
        projectId?: string;
      }) => invoke<WorkflowInstantiateResult>("workflow_template_instantiate", args),
    },
  };
}
