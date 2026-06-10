import { objectTypeRegistry } from "@cinatra-ai/objects";
import { z } from "zod";
import {
  AgentTemplateListRow,
  AgentTemplateCard,
  AgentTemplateDetail,
} from "./renderers";

export function registerAgentBuilderObjectTypes() {
  objectTypeRegistry.register({
    type: "@cinatra-ai/agent-builder:agent-template",
    category: "project",
    // Mirrors AgentTemplateRecord in store.ts. Keep these in lock-step when
    // new fields are added — consumers use this schema to validate
    // AgentTemplateRecord payloads, and a lag here rejects valid rows.
    schema: z.object({
      id: z.string(),
      orgId: z.string().nullable(),
      creatorId: z.string().nullable(),
      name: z.string(),
      description: z.string().nullable(),
      sourceNl: z.string(),
      compiledPlan: z.unknown(),
      inputSchema: z.unknown(),
      outputSchema: z.unknown().nullable(),
      approvalPolicy: z.unknown(),
      status: z.enum(["draft", "published", "archived"]),
      // OAS-aligned "flow"/"node" values must stay in lockstep with AgentTemplateRecord["type"].
      type: z.enum(["leaf", "proxy", "orchestrator", "parallel", "supervisor", "iterative", "flow", "node"]),
      // Execution-provider routing values include the WayFlow provider.
      executionProvider: z.enum(["openai", "anthropic", "gemini", "langgraph", "wayflow", "default"]),
      hitlRequired: z.boolean(),
      // LangGraph Python graph module + identifier. Nullable for templates
      // that do not use the LangGraph execution provider.
      lgGraphCode: z.string().nullable(),
      lgGraphId: z.string().nullable(),
      taskSpec: z.string().nullable(),
      packageName: z.string().nullable(),
      packageVersion: z.string().nullable(),
      currentVersionId: z.string().nullable(),
      hitlScreens: z.unknown().nullable(),
      agentDependencies: z.record(z.string(), z.string()).optional(),
      createdAt: z.string(),
      updatedAt: z.string(),
    }),
    lifecycle: {
      sources: ["user"],
      mutableBy: ["user", "agent"],
    },
    renderers: {
      listRow: AgentTemplateListRow,
      card: AgentTemplateCard,
      detail: AgentTemplateDetail,
    },
  });
}
