// Pure chat empty-state badge + caption selection, extracted from
// `chat-page.tsx` so the mode-driven branching is unit-testable without
// rendering the full client component. The component imports these and
// feeds the result straight into <SkillBadgeCloud> / the empty-state h1.
//
// No "use client" — this module holds data + pure functions only (the
// lucide icon refs are component values, harmless in any bundle).

import { Bot, Workflow } from "lucide-react";

import type { SkillBadge } from "./skill-badge-cloud";

/** Chat empty-state mode passed from the route (`?mode=…`). */
export type ChatBadgeMode = "create-agent" | "create-workflow" | undefined;

// Always shown first in the badge cloud, regardless of skill catalog state
// or prompt filter.
export const BUILD_AGENT_BADGE: SkillBadge = {
  id: "__pinned_build_agent__",
  name: "Build an agent",
  prefillText: "I want to build an agent. Help me design it.\n\nThe agent's name is: ",
  icon: Bot,
  pinned: true,
};

// Pinned beside the agent badge — the chat-workflow-authoring assistant
// skill drives the rest of the flow once the user types into the prompt.
export const BUILD_WORKFLOW_BADGE: SkillBadge = {
  id: "__pinned_build_workflow__",
  name: "Build a workflow",
  prefillText: "I want to build a workflow. Help me design it.\n\nThe workflow's name is: ",
  icon: Workflow,
  pinned: true,
};

/**
 * True when `text` exactly matches a pinned starter-badge prefill. Clicking a
 * pinned badge seeds the composer with this exact text; an older build also
 * persisted that seed to localStorage, so it would re-hydrate on a fresh chat
 * load. Used as a `PromptField.shouldDiscardStoredValue` predicate to evict
 * such a stale seed. Exact-match only — a genuine user draft never matches.
 */
export function isPinnedBadgePrefill(text: string): boolean {
  return (
    text === BUILD_AGENT_BADGE.prefillText ||
    text === BUILD_WORKFLOW_BADGE.prefillText
  );
}

/**
 * Badge-cloud contents by chat mode. ORDER IS LOAD-BEARING:
 *   - create-agent    → [agent] only
 *   - create-workflow → [workflow] only
 *   - default chat    → [agent, workflow]
 *
 * Only the two pinned build badges are surfaced below the prompt window;
 * dynamic skill-catalog badges are intentionally not shown.
 */
export function selectChatBadges(mode: ChatBadgeMode): SkillBadge[] {
  if (mode === "create-agent") return [BUILD_AGENT_BADGE];
  if (mode === "create-workflow") return [BUILD_WORKFLOW_BADGE];
  return [BUILD_AGENT_BADGE, BUILD_WORKFLOW_BADGE];
}

/**
 * Empty-state h1 caption by chat mode. Falls back to the rotating greeting
 * in default chat.
 */
export function chatEmptyStateCaption(mode: ChatBadgeMode, greeting: string): string {
  if (mode === "create-agent") return "Create a new agent";
  if (mode === "create-workflow") return "Create a new workflow";
  return greeting;
}
