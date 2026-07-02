/**
 * Pure tab-resolution for the unified /configuration/approvals page (#390).
 *
 * The sidebar "Approvals" pill links here with NO `?tab=`, and its badge
 * aggregates BOTH pending workflow approvals AND admin agent creation requests.
 * Defaulting to a fixed Workflows tab meant that when the only pending item was
 * an agent request, the badge landed the user on an empty "No pending
 * approvals" view. This resolver picks the populated tab on a no-tab landing.
 *
 * Rules:
 *  - An explicit `tab` (`"workflows"` | `"agents"`) is always honored.
 *  - On a no-tab landing, default to `"agents"` ONLY when there are zero pending
 *    workflow approvals AND ≥1 pending agent request; otherwise `"workflows"`.
 *  - Agent counts are caller-supplied auth-aware (0 for non-admins), so a
 *    non-admin is never steered to `"agents"`.
 *
 * Kept side-effect-free and import-light so it is unit-testable in isolation
 * (the page server component's full module graph cannot be imported here).
 */
export function resolveApprovalsActiveTab(input: {
  explicitTab: string | undefined;
  pendingWorkflows: number;
  pendingAgents: number;
}): "workflows" | "agents" {
  const { explicitTab, pendingWorkflows, pendingAgents } = input;
  if (explicitTab === "agents") return "agents";
  if (explicitTab === "workflows") return "workflows";
  // No explicit tab — land on the populated tab.
  return pendingWorkflows === 0 && pendingAgents > 0 ? "agents" : "workflows";
}
