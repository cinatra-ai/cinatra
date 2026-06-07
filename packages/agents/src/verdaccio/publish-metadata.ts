import type { CompiledStep } from "../store";

export type DerivedPublishMetadata = {
  compiledPlan: CompiledStep[];
  riskLevel: "low" | "medium" | "high" | "critical";
  toolAccess: string[];
  hasApprovalGates: boolean;
};

function normalizeCompiledPlan(rawPlan: unknown): CompiledStep[] {
  if (Array.isArray(rawPlan)) {
    return rawPlan as CompiledStep[];
  }

  if (typeof rawPlan === "string") {
    try {
      const parsed = JSON.parse(rawPlan);
      return Array.isArray(parsed) ? (parsed as CompiledStep[]) : [];
    } catch {
      return [];
    }
  }

  return [];
}

function deriveRiskLevel(compiledPlan: CompiledStep[]): "low" | "medium" | "high" | "critical" {
  const classes = new Set(compiledPlan.map((step) => step.riskClass));
  if (classes.has("delete")) return "critical";
  if (classes.has("send_external_message") || classes.has("financial_commitment")) return "high";
  if (classes.has("draft_create")) return "medium";
  return "low";
}

export function derivePublishMetadataFromSnapshot(
  snapshot: Record<string, unknown>,
): DerivedPublishMetadata {
  const compiledPlan = normalizeCompiledPlan(snapshot.compiledPlan ?? snapshot.steps ?? []);
  const toolAccess = [...new Set(compiledPlan.map((step) => step.toolName).filter(Boolean))].sort();

  return {
    compiledPlan,
    riskLevel: deriveRiskLevel(compiledPlan),
    toolAccess,
    hasApprovalGates: compiledPlan.some((step) => step.requiresApproval),
  };
}
