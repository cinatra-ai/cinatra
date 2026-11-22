// agent_source_review's two pure checks: the deterministic review and the
// triviality predicate. Moved unchanged out of handlers.ts (cinatra#4264 A1b;
// file-size ratchet: keep the primitive hub under its ceiling). handlers.ts
// imports both and re-exports runDeterministicReview, so every caller keeps
// its import path.

import {
  scanOasForLiteralSecrets,
  scanOasForUntrustedUrls,
  scanOasForLlmBridgeWiring,
  scanOasForLlmMetadata,
  scanOasForStartNodeInputsWithoutRequired,
  type ReviewFinding,
} from "../validate-agent-json";

/**
 * Pure deterministic review: aggregates the three scan functions from
 * validate-agent-json.ts and partitions by severity. All v1 scans emit
 * severity: "blocker", so warnings/suggestions are currently empty for
 * the deterministic surface — future scans may emit other severities.
 *
 *
 * author-controlled allow-list that downgraded `untrusted_external_url`
 * blockers to warnings. Author-supplied OAS metadata MUST NOT be able to
 * defang a security finding — that's a publish-gate bypass. A future
 * server-side allow-list (managed in code or config, not in OAS) is the
 * correct path if specific MCPToolBox URLs need to be permitted.
 *
 * IDEMPOTENCE: pure function over a single parsed OAS. Calling twice on
 * byte-identical input yields byte-identical arrays (no Date.now(), no
 * randomUUID, no side effects).
 */
export function runDeterministicReview(parsedOas: Record<string, unknown>): {
  blockers: ReviewFinding[];
  warnings: ReviewFinding[];
  suggestions: ReviewFinding[];
} {
  const findings: ReviewFinding[] = [
    ...scanOasForLiteralSecrets(parsedOas),
    ...scanOasForUntrustedUrls(parsedOas),
    ...scanOasForLlmBridgeWiring(parsedOas),
    // review-gate parity for the LLM
    // metadata scanner. Compile-gate already calls this scanner; without
    // mirroring it here, `agent_source_review` returns clean and the
    // immediately-following `agent_source_compile` rejects on the same OAS.
    ...scanOasForLlmMetadata(parsedOas),
    // Warning-only HITL scanner: NOT
    // wired into `validateOasAgentJson()` (hard gate) because some agents
    // legitimately accept programmatic-only StartNode inputs (orchestrators
    // wire values via sub-flow DataFlowEdges). Surfacing via
    // `agent_source_review` so the chat assistant catches the missing-
    // metadata.cinatra.required pattern that silently dropped the user's
    // `webpage-image-count` URL prompt.
    ...scanOasForStartNodeInputsWithoutRequired(parsedOas),
  ];
  const blockers: ReviewFinding[] = [];
  const warnings: ReviewFinding[] = [];
  const suggestions: ReviewFinding[] = [];
  for (const f of findings) {
    if (f.severity === "blocker") blockers.push(f);
    else if (f.severity === "warning") warnings.push(f);
    else suggestions.push(f);
  }
  return { blockers, warnings, suggestions };
}

/**
 * Triviality predicate. Trivial OAS skips the agent-planner
 * advisory dispatch.
 *
 * Trivial iff ALL of:
 * - zero InputMessageNode entries (no HITL)
 * - zero FlowNode entries (no subflow)
 * - zero A2AAgent entries (no peer agent invocation)
 * - zero MCPToolBox entries with a non-cinatra id/name (no external MCP)
 * - at most ONE executable step (AgentNode-backed-by-Agent OR ApiNode).
 *   OutputMessageNode does NOT count toward this quota — it is structural.
 */
export function isTrivialOas(parsedOas: Record<string, unknown>): boolean {
  const refs = parsedOas["$referenced_components"];
  if (!refs || typeof refs !== "object") {
    // No referenced components — degenerate / minimal. Treat as trivial.
    return true;
  }
  let executableSteps = 0;
  for (const value of Object.values(refs as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    const type = entry["component_type"];
    if (typeof type !== "string") continue;
    if (type === "InputMessageNode") return false;
    if (type === "FlowNode") return false;
    if (type === "A2AAgent") return false;
    if (type === "MCPToolBox") {
      // External iff neither id nor name starts with "cinatra-". The internal
      // cinatra-mcp toolbox is the only one that is always-trivial.
      const id = typeof entry["id"] === "string" ? (entry["id"] as string) : "";
      const name =
        typeof entry["name"] === "string" ? (entry["name"] as string) : "";
      const isCinatraInternal =
        id.startsWith("cinatra-") || name.startsWith("cinatra-");
      if (!isCinatraInternal) return false;
    }
    if (type === "AgentNode") {
      // AgentNode is only executable when it has an embedded Agent (with
      // system_prompt etc.) — the test fixture binds it via
      // { agent: { $component_ref: "inner_agent" } }. Count any
      // AgentNode that carries an `agent` field as an executable LLM step.
      if (entry["agent"]) executableSteps += 1;
    }
    if (type === "ApiNode") {
      executableSteps += 1;
    }
  }
  return executableSteps <= 1;
}
