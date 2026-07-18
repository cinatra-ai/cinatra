// Approval-vocabulary boundary check (llm-providers S2, #1713 AC2) — the ONE
// shared enforcement every extension-produced MCP tool entry crosses before it
// can reach an LLM injection path. TWO boundaries route through it:
//
//   - `external-mcp-toolbox-loader.server.ts` (`sanitizeExternalMcpToolboxTools`)
//     — manifest-driven `providesExternalMcpToolbox` toolbox modules;
//   - `llm-toolbox-providers.ts` (`buildToolboxProviderTools`) — registration-
//     driven `llm-toolbox` capability providers (apify today).
//
// Extension code may be built against a STALE vendored SDK, so entries can
// still carry the retired three-value `requireApproval` vocabulary, or plain
// garbage. The rules (fail closed — approval intent must never silently
// auto-execute):
//
//   - `approval` present but not "auto_execute"/"approval_required" → DROP the
//     entry (an unknown token must never fall through to a provider map where
//     it would read as auto-execute).
//   - legacy `requireApproval: "always" | "read-only"` → DROP the entry: that
//     is approval INTENT the new key no longer carries; silently auto-executing
//     it would be the exact downgrade AC2 retires.
//   - legacy `requireApproval: "never"` → STRIP the key (semantically identical
//     to the `auto_execute` default) and keep the tool.
//   - well-formed entries (absent / auto_execute / approval_required) pass
//     through unchanged — enforcing `approval_required` against a provider's
//     declared capability is the adapters' job, not the boundary's.
//
// PURE module (no `server-only`, no `@/` imports beyond types) so both
// server-only boundaries and their tests consume it directly.

type ApprovalCarryingTool = {
  serverLabel: string;
  approval?: "auto_execute" | "approval_required";
};

/**
 * Validate one extension-produced MCP tool entry's approval vocabulary.
 * Returns the (possibly legacy-key-stripped) tool, or `null` when the entry
 * must be dropped. `source` names the producing boundary/extension for the
 * warn line.
 */
export function checkMcpApprovalVocabulary<T extends ApprovalCarryingTool>(
  source: string,
  tool: T,
): T | null {
  const candidate = tool as T & { requireApproval?: unknown };
  if (
    candidate.approval !== undefined &&
    candidate.approval !== "auto_execute" &&
    candidate.approval !== "approval_required"
  ) {
    console.warn(
      `[mcp-approval-vocabulary] ${source} tool "${tool.serverLabel}" carries an ` +
        `unknown approval value ${JSON.stringify(candidate.approval)} — dropped (fail closed)`,
    );
    return null;
  }
  if ("requireApproval" in candidate) {
    if (candidate.requireApproval === "never") {
      // Pure vocabulary residue with identical semantics — strip and keep.
      const rest: T & { requireApproval?: unknown } = { ...candidate };
      delete rest.requireApproval;
      return rest;
    }
    console.warn(
      `[mcp-approval-vocabulary] ${source} tool "${tool.serverLabel}" carries the ` +
        `retired requireApproval value ${JSON.stringify(candidate.requireApproval)} — dropped ` +
        `(approval intent must be re-declared as approval: "approval_required"; rebuild the ` +
        `extension against the current SDK)`,
    );
    return null;
  }
  return tool;
}
