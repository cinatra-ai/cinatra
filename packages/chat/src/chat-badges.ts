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

// ---------------------------------------------------------------------------
// Empty-state greeting (moved VERBATIM from chat-page.tsx by cinatra#1218 —
// pure copy selection belongs beside the badge/caption selection above, and
// chat-page.tsx is a tracked file-size bottleneck at its ceiling).
// ---------------------------------------------------------------------------

const CINATRA_QUOTES = [
  "I did it my way.",
  "The best is yet to come.",
  "Fly me to the moon.",
  "That's life — you're riding high in April, shipped in May.",
  "Start spreading the news.",
  "And now, the end is near, and so I face the final deploy.",
  "I've got you under my skin — err, my API.",
  "Come fly with me, let's fly, let's fly away.",
  "Luck be a lady tonight.",
  "The best revenge is massive success.",
  "You gotta love livin', baby, 'cause dyin' is a pain in the ass.",
  "I'm not the type to be pushed around. — Cinatra",
  "Alcohol may be man's worst enemy, but the bible says love your enemy.",
  "Don't hide your scars. They make you who you are.",
  "I feel sorry for people who don't drink. When they wake up, that's as good as they're gonna feel all day.",
  "The big lesson in life is never be scared of anyone or anything. — Cinatra",
  "You only go around once, but if you play your cards right, once is enough.",
  "May you live to be 100 and may the last voice you hear be mine. — Cinatra",
  "Cock your hat — angles are attitudes.",
];

export function getGreeting() {
  const hour = new Date().getHours();
  const pick = (options: string[]) => options[Math.floor(Math.random() * options.length)];

  // ~1 in 6 chance to show a Cinatra quote instead of a regular greeting.
  if (Math.random() < 1 / 6) {
    return pick(CINATRA_QUOTES);
  }

  if (hour < 5) return pick(["Burning the midnight oil?", "Late night session?", "Night owl mode."]);
  if (hour < 12) return pick(["Good morning.", "Morning. What are we building?", "Fresh start. What's the plan?"]);
  if (hour < 17) return pick(["Good afternoon.", "How can I help?", "What's next on the list?"]);
  if (hour < 21) return pick(["Good evening.", "Evening session. What do you need?", "How can I help?"]);
  return pick(["Working late?", "Late one tonight?", "Night shift. What do you need?"]);
}

export const DEFAULT_GREETING = "How can I help?";
