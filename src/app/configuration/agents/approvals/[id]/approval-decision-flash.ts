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
  // cinatra#2597: an approve no longer publishes "private-scoped" — it grants
  // access at the scope the reviewer chose in the decision form (cinatra#1327).
  { param: "status", value: "approved", message: "The proposal was approved and published to the access scope you chose.", variant: "success" },
  { param: "status", value: "rejected", message: "The proposal was rejected; the author can edit and resubmit.", variant: "success" },
  { param: "status", value: "published", message: "The held proposal was re-published.", variant: "success" },
  { param: "error", value: "unauthorized", message: "Unauthorized — an admin session is required.", variant: "error" },
  { param: "error", value: "no-active-org", message: "No active organization.", variant: "error" },
  { param: "error", value: "reason-required", message: "A rejection reason is required.", variant: "error" },
  // -------------------------------------------------------------------------
  // cinatra#2597 — SELF-RESOLVABLE refusals. Each one tells the reviewer what to
  // do next instead of collapsing into "see server logs" (the dead end): the
  // #1327 access-scope requirement in particular is resolved entirely from this
  // page, by choosing a scope. Still codes-only — the raw primitive message is
  // logged server-side and never reflected into the redirect URL.
  // -------------------------------------------------------------------------
  { param: "error", value: "scope-required", message: "Choose who can access this agent (organization, team, or project) before approving.", variant: "error" },
  // The refusal covers both "you may not grant there" and a check that could
  // not complete, so the message states the outcome without asserting which.
  { param: "error", value: "scope-forbidden", message: "The selected scope could not be granted. Choose a scope you administer, or try again.", variant: "error" },
  // Terminal for this page: the agent is ALREADY published, so there is no
  // decision left to retry here — access is set on the agent's Permissions.
  { param: "error", value: "scope-not-applied", message: "The agent was published, but the access scope was not applied — it stays restricted. Set access on the agent's Permissions.", variant: "error" },
  { param: "error", value: "stale-snapshot", message: "The proposal changed since this page loaded. Reload to see the new snapshot, then decide again.", variant: "error" },
  { param: "error", value: "snapshot-missing", message: "The submission carried no snapshot token. Reload the page and decide again.", variant: "error" },
  { param: "error", value: "already-decided", message: "This proposal is no longer pending — it was decided elsewhere. Reload to see its current status.", variant: "error" },
  // The request read is scoped to the ACTIVE organization, so "not found" also
  // covers "exists, but not in the org you are currently acting in" — the
  // message must not assert deletion it cannot know about.
  { param: "error", value: "not-found", message: "This request is not available in your active organization. It may have been removed, or your active organization changed.", variant: "error" },
  // The collision is raised at PUBLISH, after the decision has already moved the
  // request to `approved` — so the fix is not "resubmit" (an approved request
  // cannot be edited); it is to free the name and re-run the publish from the
  // Retry publish panel this page then shows.
  { param: "error", value: "name-collision", message: "Another agent already uses this package name. The proposal is held at approved — free the name, then use Retry publish.", variant: "error" },
  { param: "error", value: "self-approval", message: "You cannot approve a proposal you authored — another administrator must decide it.", variant: "error" },
  { param: "error", value: "decision-failed", message: "The decision could not be recorded. See server logs for details.", variant: "error" },
  { param: "error", value: "publish-failed", message: "The proposal could not be re-published. See server logs for details.", variant: "error" },
];
