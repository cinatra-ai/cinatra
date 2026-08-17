// ---------------------------------------------------------------------------
// Delegated chat MCP tool EXPOSURE (selective, deterministic, zero-AI-cost).
//
// WHAT THIS IS NOT. It is not an authorization boundary and it never widens
// one. `delegated-chat-tool-policy.ts` stays the single authority on what a
// delegated chat request may SEE and CALL: every name this module can emit is
// run back through `isDelegatedChatMcpToolAllowed`, so a topic map that drifts
// can only ever emit a SUBSET of the allowlist. The call-time handler guard in
// the MCP runtime server is unchanged and still refuses anything the policy
// refuses, whatever a provider was told.
//
// WHAT IT IS. The chat turn hands the provider ONE hosted MCP reference. That
// reference can carry a restriction list (`allowed_tools` on OpenAI's hosted
// MCP entry; the equivalent per-tool `configs` restriction on Anthropic's
// `mcp_toolset`), and the provider bills the catalog it resolves on the
// caller's behalf as input tokens. Exposing all ~83 read/dispatch primitives on
// a turn that asks "which connectors are active?" therefore bills a catalog the
// turn cannot use. This module answers ONE question, deterministically and
// without a model call:
//
//   Given the conversation so far, which SUBSET of the allowlist can this turn
//   plausibly use?
//
// THE SHAPE IS STATIC TIERS, NOT PER-TURN RELEVANCE SCORING. A per-turn
// bespoke list would fragment the provider prompt cache: OpenAI caches the
// longest matching request prefix, and the tool block is part of that prefix,
// so a list that differs on every turn destroys reuse exactly the way a
// per-turn token in the prefix does (cinatra#2771 lever 2). Instead there is a
// small, fixed set of CANONICAL topics; a turn selects whole topics, and the
// emitted list is the sorted union. Two turns on the same topic emit
// byte-identical lists.
//
// STICKY BY CONSTRUCTION. Topic detection reads the WHOLE conversation, not
// just the latest message, so a topic raised on turn 3 stays selected for turn
// 9. Exposure inside one conversation is therefore monotone: it grows toward
// the full catalog and never silently drops a tool the model was already using.
//
// FAIL OPEN ON EXPOSURE, NEVER ON ADMISSION. A finite keyword vocabulary can
// never recognise every way a person phrases a request: "find Jane Doe" is a
// CRM question and "plot revenue by month" is a dashboard question, and neither
// carries a vocabulary word. Narrowing those turns to the core floor would take
// away a tool the model genuinely needed, which is a behaviour regression and
// strictly worse than paying for schemas. So an unrecognised SUBSTANTIVE turn
// gets the WHOLE catalog — the pre-#2771 behaviour — and only a turn the core
// floor demonstrably serves is narrowed:
//
//   · a topic matched                     → core + those topics
//   · nothing matched, and the turn is
//     small talk or a core-vocabulary
//     question (agents, runs, connectors,
//     screens, projects, objects)         → core only
//   · nothing matched, and the turn says
//     something else                      → the full catalog
//
// The cost win therefore comes from the turns we can POSITIVELY identify, not
// from guessing at the rest. Widening the vocabulary later moves turns out of
// the third bucket and is a pure improvement; it can never take a tool away.
//
// FULL-CATALOG REACHABILITY, four ways, all proven by test:
//   1. the union of `core` + every topic IS the whole allowlist;
//   2. any topic keyword anywhere in the conversation selects that topic;
//   3. an unrecognised substantive turn gets the whole allowlist (above);
//   4. `mode: "full"` (operator escape hatch, see `resolveChatToolExposureMode`)
//      emits exactly `delegatedChatAllowedToolNames()`.
//
// BOUNDARY WITH THE ADMISSION MECHANISM. This module builds ON TOP of the
// existing allow-list accessor. It never reads `ALLOWED_EXACT` directly and
// never decides admission. A later change that replaces the allow-list SOURCE
// keeps working: it only has to keep `delegatedChatAllowedToolNames()` +
// `isDelegatedChatMcpToolAllowed` answering, and the drift test below reports
// any name the topic map has not classified (such a name falls back to `core`,
// i.e. always exposed — an unclassified tool loses cost, never reach).
//
// Dependency-free on purpose, exactly like the policy module it sits on.
// ---------------------------------------------------------------------------

import {
  delegatedChatAllowedToolNames,
  isDelegatedChatMcpToolAllowed,
} from "./delegated-chat-tool-policy";

/**
 * The canonical topics. ORDER IS PART OF THE CONTRACT: it is the sort order
 * `ChatToolExposure.topics` reports in, so two equal selections describe
 * themselves identically.
 */
export const CHAT_TOOL_TOPICS = [
  "agent_authoring",
  "artifacts",
  "crm",
  "dashboards",
  "extensions_admin",
  "lifecycle",
  "marketing",
  "observability",
  "sites",
  "skills",
] as const;

export type ChatToolTopic = (typeof CHAT_TOOL_TOPICS)[number];

/** `core` is not a topic — it is the floor every turn carries. */
export type ChatToolTier = "core" | ChatToolTopic;

export type ChatToolExposureMode = "tiered" | "full";

/**
 * The always-exposed floor: the primitives an ARBITRARY turn plausibly needs
 * before it has said what it is about. Discovery (what screens/extensions/
 * connectors exist), the chat's core purpose (find an agent, dispatch it, poll
 * it), and the two canonical object reads.
 *
 * Deliberately small. Everything else is one keyword away.
 */
const CORE_TOOLS: readonly string[] = [
  "agent_get",
  "agent_list",
  "agent_run",
  "agent_run_get",
  "agent_run_list",
  "agent_run_messages_list",
  "agent_run_stop",
  "connector_inventory_list",
  "extensions_search",
  "objects_get",
  "objects_list",
  "projects_get",
  "projects_list",
  "skills_catalog_list",
  "skills_installed_list",
  "system_screen_lookup",
];

/**
 * The topic partition. Every entry must be an allowed name, and no name may
 * appear twice — both asserted by the module's own suite, so an edit that
 * breaks the partition fails CI rather than quietly changing what chat sees.
 */
const TOPIC_TOOLS: Readonly<Record<ChatToolTopic, readonly string[]>> = {
  agent_authoring: [
    "agent_creation_request_edit",
    "agent_creation_request_get",
    "agent_creation_request_list",
    "agent_creation_request_propose",
    "agent_registry_list",
    "agent_version_diff",
    "agent_version_get",
    "agent_version_list",
  ],
  artifacts: [
    "artifact_assertion_get",
    "artifact_assertion_list",
    "artifact_authoring_chain_get",
    "artifact_authoring_emit",
    "artifact_extension_get",
    "artifact_extension_search",
    "artifact_representation_get",
    "artifact_representation_latest",
    "artifact_representation_list",
    "artifacts_get",
    "artifacts_list",
  ],
  crm: [
    "crm_account_get",
    "crm_account_search",
    "crm_contact_find_by_email",
    "crm_contact_get",
    "crm_contact_search",
    "crm_list_get",
    "crm_list_members_get",
    "crm_list_search",
  ],
  dashboards: [
    "dashboards_create",
    "dashboards_cube_chart",
    "dashboards_cube_discover",
    "dashboards_cube_load",
    "dashboards_cube_validate",
    "dashboards_get",
    "dashboards_list",
    "dashboards_update",
  ],
  extensions_admin: ["extensions_purge", "extensions_purge_execute"],
  lifecycle: [
    "artifact_review_gate_render",
    "artifact_review_gates_list",
    "schedule_proposal_render",
    "verification_record_render",
  ],
  marketing: [
    "blog_project_get",
    "blog_project_list",
    "campaigns_get",
    "campaigns_list",
    "email_outreach_campaign_get",
    "email_outreach_campaign_list",
    "media_feeds_list",
  ],
  observability: [
    "metric_cost_budget_get",
    "metric_cost_by_agent",
    "metric_cost_by_provider",
    "metric_cost_recent_events",
    "metric_cost_summary",
    "metric_cost_timeseries",
    "metric_usage_events",
    "metric_usage_summary",
  ],
  sites: [
    "drupal_instances_list",
    "gmail_aliases_list",
    "linkedin_accounts_list",
    "wordpress_site_tool_call",
    "wordpress_site_tools_list",
  ],
  skills: [
    "skills_installed_get",
    "skills_installed_resolve_for_agent",
    "skills_library_list",
    "skills_personal_get",
    "skills_personal_list",
    "skills_personal_list_for_agent",
  ],
};

/**
 * Selection vocabulary. `words` match WHOLE alphanumeric tokens of the
 * conversation (so "list" never matches inside "listen"); `phrases` match as
 * substrings of the lowercased text, for multi-word intents a single token
 * cannot express.
 *
 * Kept deliberately generous: a false POSITIVE costs one topic's schemas on
 * that conversation, while a false NEGATIVE costs the model a tool it needed.
 */
const TOPIC_VOCABULARY: Readonly<
  Record<ChatToolTopic, { words: readonly string[]; phrases: readonly string[] }>
> = {
  agent_authoring: {
    words: ["version", "versions", "registry", "propose", "proposal", "diff", "scaffold"],
    phrases: ["new agent", "create an agent", "build an agent", "author an agent", "creation request"],
  },
  artifacts: {
    words: ["artifact", "artifacts", "representation", "assertion", "document", "deliverable"],
    phrases: [],
  },
  crm: {
    words: [
      "crm", "contact", "contacts", "account", "accounts", "lead", "leads",
      "company", "companies", "segment", "audience", "customer", "customers",
      "prospect", "prospects",
    ],
    phrases: [],
  },
  dashboards: {
    words: [
      "dashboard", "dashboards", "chart", "charts", "graph", "graphs", "plot",
      "cube", "cubes", "kpi", "kpis", "visualize", "visualise", "trend", "trends",
    ],
    phrases: [],
  },
  extensions_admin: {
    words: ["purge"],
    phrases: ["blast radius", "remove the extension", "uninstall the extension"],
  },
  lifecycle: {
    words: ["review", "reviews", "gate", "gates", "approval", "approvals", "verification", "schedule", "scheduled", "recurring", "cron"],
    phrases: [],
  },
  marketing: {
    words: ["campaign", "campaigns", "blog", "newsletter", "outreach", "feed", "feeds", "podcast"],
    phrases: [],
  },
  observability: {
    words: ["cost", "costs", "spend", "spent", "usage", "tokens", "budget", "bill", "billing", "price", "pricing", "analytics"],
    phrases: [],
  },
  sites: {
    words: ["wordpress", "wp", "drupal", "site", "sites", "gmail", "linkedin", "page", "pages"],
    phrases: [],
  },
  skills: {
    words: ["skill", "skills"],
    phrases: [],
  },
};

/**
 * The vocabulary the CORE FLOOR itself serves. A turn that uses one of these and
 * matches no topic is narrowed to core, because the tools it plausibly wants are
 * already there: agent discovery/dispatch/polling, the connector inventory, the
 * screen lookup, the extension search, projects and the canonical object reads.
 *
 * This is the ONLY positive evidence that narrowing is safe. Everything else
 * falls through to the full catalog.
 */
const CORE_VOCABULARY: readonly string[] = [
  "agent", "agents", "run", "runs", "running", "ran", "dispatch", "dispatched",
  "connector", "connectors", "connection", "connections", "connected",
  "screen", "screens", "page", "extension", "extensions", "install", "installed",
  "project", "projects", "object", "objects", "status", "queue", "queued",
  "cancel", "stop", "poll", "platform", "cinatra",
];

/**
 * Pure small talk: a turn made only of these tokens says nothing about what the
 * model may need, and the core floor is the right answer for it.
 */
const SMALL_TALK: readonly string[] = [
  "hi", "hey", "hello", "yo", "hallo", "moin", "thanks", "thank", "thx", "ty",
  "cheers", "ok", "okay", "k", "cool", "nice", "great", "sure", "yes", "no",
  "yep", "nope", "please", "sorry", "bye", "goodbye", "you", "u", "how", "are",
  "doing", "good", "morning", "afternoon", "evening", "night", "help", "there",
  "hi5", "welcome", "and", "the", "a", "an", "is", "it", "im", "i", "m",
];

/** Phrases that ask, in plain language, for everything. */
const EXPOSE_ALL_PHRASES: readonly string[] = [
  "all tools",
  "all your tools",
  "every tool",
  "full tool catalog",
  "full catalogue",
  "full catalog",
];

export type ChatToolExposureInput = {
  /**
   * Every message body of the conversation this turn belongs to, oldest first.
   * Roles are irrelevant: a topic the ASSISTANT raised is as good a reason to
   * keep its tools exposed as one the user raised.
   */
  conversationText: readonly string[];
  /** Defaults to `"tiered"`. `"full"` restores the pre-#2771 whole catalog. */
  mode?: ChatToolExposureMode;
};

/**
 * How the list was arrived at. Reported so an operator reading the turn log can
 * tell a narrowing from a fail-open, and so the tests can name the three
 * canonical outcomes instead of inferring them from a length.
 */
export type ChatToolExposureReason =
  /** Topics matched: core + those topics. */
  | "topic_match"
  /** No topic, but the turn is small talk or a core-vocabulary question. */
  | "core_served"
  /** No topic and nothing recognised: the WHOLE catalog, as before #2771. */
  | "unrecognized_fail_open"
  /** The operator escape hatch or an explicit `mode: "full"`. */
  | "mode_full";

export type ChatToolExposure = {
  mode: ChatToolExposureMode;
  reason: ChatToolExposureReason;
  /** Selected topics, in `CHAT_TOOL_TOPICS` order. Empty on a core-only turn. */
  topics: readonly ChatToolTopic[];
  /** The exposure list: sorted, de-duplicated, always a subset of the allowlist. */
  toolNames: readonly string[];
};

/**
 * The tier a name belongs to, or `null` when the name is not chat-allowed at
 * all. An ALLOWED name the topic map has not classified answers `"core"` — an
 * unclassified tool is always exposed, so drift costs tokens and never reach.
 */
export function delegatedChatToolTierOf(name: string): ChatToolTier | null {
  const normalized = name.toLowerCase();
  if (!isDelegatedChatMcpToolAllowed(normalized)) return null;
  for (const topic of CHAT_TOOL_TOPICS) {
    if (TOPIC_TOOLS[topic].includes(normalized)) return topic;
  }
  return "core";
}

/** Allowed names the topic map has NOT classified (drift reporter for tests). */
export function unclassifiedDelegatedChatToolNames(): readonly string[] {
  const classified = new Set<string>([
    ...CORE_TOOLS,
    ...CHAT_TOOL_TOPICS.flatMap((t) => [...TOPIC_TOOLS[t]]),
  ]);
  return delegatedChatAllowedToolNames().filter((n) => !classified.has(n));
}

/** Names the topic map claims that the policy would NOT allow (drift reporter). */
export function overclaimedDelegatedChatToolNames(): readonly string[] {
  const allowed = new Set(delegatedChatAllowedToolNames());
  return [...CORE_TOOLS, ...CHAT_TOOL_TOPICS.flatMap((t) => [...TOPIC_TOOLS[t]])]
    .filter((n) => !allowed.has(n))
    .sort();
}

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

/**
 * The topics a conversation selects. Pure, deterministic, allocation-bounded:
 * one lowercase pass and one tokenize pass over the joined text.
 */
export function selectChatToolTopics(
  conversationText: readonly string[],
): readonly ChatToolTopic[] {
  const joined = conversationText.join("\n").toLowerCase();
  if (EXPOSE_ALL_PHRASES.some((p) => joined.includes(p))) {
    return [...CHAT_TOOL_TOPICS];
  }
  const tokens = tokenize(joined);
  return CHAT_TOOL_TOPICS.filter((topic) => {
    const vocab = TOPIC_VOCABULARY[topic];
    if (vocab.words.some((w) => tokens.has(w))) return true;
    return vocab.phrases.some((p) => joined.includes(p));
  });
}

/**
 * Is this conversation one the CORE FLOOR demonstrably serves?
 *
 * True when it is pure small talk, or when it uses at least one core-vocabulary
 * word (agents, runs, connectors, screens, projects, objects, extensions). Any
 * other wording is treated as unrecognised, and unrecognised means the full
 * catalog — see the fail-open note at the top of this file.
 */
export function isCoreServedConversation(
  conversationText: readonly string[],
): boolean {
  const tokens = tokenize(conversationText.join("\n"));
  if (tokens.size === 0) return true;
  if (CORE_VOCABULARY.some((w) => tokens.has(w))) return true;
  const smallTalk = new Set(SMALL_TALK);
  return [...tokens].every((t) => smallTalk.has(t));
}

/**
 * THE ENTRY POINT. Deterministic and byte-stable: the same input yields the
 * same array, in the same order, every time.
 *
 * The result is a HINT to the provider about which primitives to resolve. It is
 * never consulted when a call arrives — `isDelegatedChatMcpToolAllowed` decides
 * that, server-side, per call, exactly as before.
 */
export function resolveDelegatedChatToolExposure(
  input: ChatToolExposureInput,
): ChatToolExposure {
  const allowed = delegatedChatAllowedToolNames();
  const mode: ChatToolExposureMode = input.mode ?? "tiered";
  if (mode === "full") {
    return {
      mode,
      reason: "mode_full",
      topics: [...CHAT_TOOL_TOPICS],
      toolNames: allowed,
    };
  }
  const topics = selectChatToolTopics(input.conversationText);
  if (topics.length === 0 && !isCoreServedConversation(input.conversationText)) {
    // Nothing recognised. Fail OPEN on exposure: the model keeps every tool it
    // had before #2771, because a missing tool is a behaviour regression and a
    // paid-for schema is only a cost.
    return {
      mode,
      reason: "unrecognized_fail_open",
      topics: [...CHAT_TOOL_TOPICS],
      toolNames: allowed,
    };
  }
  const selected = new Set<string>(CORE_TOOLS);
  for (const topic of topics) {
    for (const name of TOPIC_TOOLS[topic]) selected.add(name);
  }
  // Any allowed name the map never classified is core (see the doc comment on
  // `delegatedChatToolTierOf`) — added here so drift cannot hide a tool.
  for (const name of unclassifiedDelegatedChatToolNames()) selected.add(name);
  // The final narrowing: nothing leaves this function that the POLICY would not
  // allow, however this file is edited.
  const toolNames = [...selected]
    .filter((name) => isDelegatedChatMcpToolAllowed(name))
    .sort();
  return {
    mode,
    reason: topics.length > 0 ? "topic_match" : "core_served",
    topics,
    toolNames,
  };
}

/**
 * The operator escape hatch. `CINATRA_CHAT_TOOL_EXPOSURE=full` restores the
 * pre-#2771 behaviour (the whole catalog on every turn) without a deploy of
 * different code; anything else — including absent — is `"tiered"`.
 */
export function resolveChatToolExposureMode(
  env: Record<string, string | undefined>,
): ChatToolExposureMode {
  return env.CINATRA_CHAT_TOOL_EXPOSURE?.trim().toLowerCase() === "full"
    ? "full"
    : "tiered";
}
