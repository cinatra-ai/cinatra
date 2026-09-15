// ---------------------------------------------------------------------------
// THE TOOL NAMES THAT START A RUN FROM A CONVERSATION (cinatra#2935,
// lifecycle-b W5d).
//
// A run started by naming an agent appears in the thread as its own card. Two
// production gates decide whether it does, and until this slice both compared
// against ONE literal:
//
//   · the turn's sink emits the durable `agent_run` DATA_PART — the reducer
//     contract's only sanctioned source for the inline card's runId — for a
//     tool result whose name matches;
//   · the renderer mounts `<InlineAgentRunCard>` for a tool_call part whose
//     name matches and which carries a runId.
//
// WHY THERE IS MORE THAN ONE NAME NOW. Removing the pre-model sentence-matcher
// gave the site widget its own narrowly scoped start (`agent_named_start`),
// because its closed, kind-keyed allowlist deliberately does not hold
// `agent_run` (cinatra#2790 pins that). The RUN is the same run; only the name
// on the durable part differs by host. Leaving the two gates on the single
// literal would have meant a widget start that succeeds and draws nothing —
// silence with a run behind it, which is the exact failure this plan removes.
//
// DELIBERATELY A CLOSED SET, and a small one. Membership is what makes a tool
// result eligible to pin a runId onto a card, so an entry here is a decision
// about what may put a lifecycle card on screen. It lives in this leaf, with no
// imports, beside the two renderers that read it. The server-side sink keeps
// its OWN copy of the same list rather than importing this one — the sink is in
// the app tree, the renderers are in the chat package, and neither vitest root
// resolves the other's specifier — and a test pins the two lists EQUAL in both
// directions. That is the same dependency-free doctrine the delegated tool
// policies use for their allowlists, and for the same reason: a duplicated
// literal that is machine-compared cannot drift, while a cross-tree import that
// only some roots resolve fails at collection time rather than at review.
// ---------------------------------------------------------------------------

/**
 * The `agent_run` primitive — the road every start takes underneath, and the
 * name the chat assistant calls it by.
 */
export const AGENT_RUN_TOOL_NAME = "agent_run";

/**
 * The site widget's one narrowly scoped start. Same road, different door: the
 * handler resolves the person's own live standing and invokes `agent_run` in
 * process under it.
 */
export const NAMED_AGENT_START_TOOL_NAME = "agent_named_start";

/** Every tool name whose result may carry a started run's id. */
export const RUN_START_TOOL_NAMES: readonly string[] = [
  AGENT_RUN_TOOL_NAME,
  NAMED_AGENT_START_TOOL_NAME,
];

/** Does a tool result / tool call of this name start a run from a conversation? */
export function isRunStartToolName(name: string | null | undefined): boolean {
  return typeof name === "string" && RUN_START_TOOL_NAMES.includes(name);
}
