// -----------------------------------------------------------------------------
// Agent-creation approval decision codes-only flash protocol.
//
// The decision server actions (./actions.ts) report an outcome by redirecting to
// `/configuration/agents/approvals/<id>` with a stable CODE on `?status=<code>`
// (success) or `?error=<code>` (failure). The <SearchParamToast> island mounted
// on THIS PAGE (not inside the @cinatra-ai/agents screen) maps each code to the
// STATIC message here — it NEVER toasts URL-derived text (a crafted
// `?error=<spoofed link>` maps to no entry and is ignored; the raw MCP error is
// logged server-side). Co-locating the map + island mount at the page keeps the
// client toast island OUT of the @cinatra-ai/agents screens.tsx module graph,
// which is reachable from the server API routes (/api/mcp, /api/a2a,
// /api/llm-bridge) and /chat — mounting it in the screen leaked the island onto
// those routes' first-party graph (route-graph ratchet). Mirrors the co-located
// instance-flash.ts / registries-flash.ts / setup-flash.ts precedents.
// -----------------------------------------------------------------------------

import type { SearchParamToastConfig } from "@/components/search-param-toast";

export const APPROVAL_DECISION_TOASTS: SearchParamToastConfig[] = [
  { param: "status", value: "approved", message: "The proposal was approved and published (private-scoped).", variant: "success" },
  { param: "status", value: "rejected", message: "The proposal was rejected; the author can edit and resubmit.", variant: "success" },
  { param: "status", value: "published", message: "The held proposal was re-published.", variant: "success" },
  { param: "error", value: "unauthorized", message: "Unauthorized — an admin session is required.", variant: "error" },
  { param: "error", value: "no-active-org", message: "No active organization.", variant: "error" },
  { param: "error", value: "reason-required", message: "A rejection reason is required.", variant: "error" },
  { param: "error", value: "decision-failed", message: "The decision could not be recorded. See server logs for details.", variant: "error" },
  { param: "error", value: "publish-failed", message: "The proposal could not be re-published. See server logs for details.", variant: "error" },
];
