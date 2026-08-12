import { randomUUID } from "node:crypto";

import type { OrchestrateStreamInput } from "./types";

// ---------------------------------------------------------------------------
// Deterministic, test-only LLM provider for the WordPress/Drupal Playwright
// UATs. It is NOT a recorded transcript and makes NO network calls: it inspects
// the last user message + the CMS context embedded in the system prompt and
// emits scripted stream callbacks.
//
// Scope: this proves the widget → stream → SSE-frame integration round-trips
// end-to-end (button → mount → prompt → text/changes frames). It deliberately
// does NOT exercise a real CMS mutation via WayFlow — the scripted tool result
// stands in for the content-editor agent's output.
//
// Activation: env CINATRA_TEST_LLM_PROVIDER=scripted (set only by the UAT
// harness). It is fail-loud under production runtime so it can never serve a
// real user.
// ---------------------------------------------------------------------------

export const SCRIPTED_TEST_PROVIDER_ENV = "CINATRA_TEST_LLM_PROVIDER";
export const SCRIPTED_TEST_PROVIDER_VALUE = "scripted";

/** Sentinel the UAT specs assert appears in the streamed assistant reply. */
export const UAT_SENTINEL = "CINATRA_UAT_OK";

type EnvLike = Record<string, string | undefined>;

export function isScriptedTestProviderEnabled(env: EnvLike = process.env): boolean {
  return env[SCRIPTED_TEST_PROVIDER_ENV] === SCRIPTED_TEST_PROVIDER_VALUE;
}

/**
 * Fail-loud unless the scripted provider is enabled under an EXPLICIT
 * development runtime. Allow-list (not deny-list) so an unset / misspelled /
 * production runtime mode can never serve scripted output: enabled requires
 * `CINATRA_RUNTIME_MODE === "development"` AND `NODE_ENV !== "production"`.
 * Called unconditionally at the stream entry — a no-op unless the env flag is
 * set, so it costs nothing on the real path.
 */
export function assertScriptedProviderNotProduction(env: EnvLike = process.env): void {
  if (!isScriptedTestProviderEnabled(env)) return;
  if (env.CINATRA_RUNTIME_MODE !== "development" || env.NODE_ENV === "production") {
    throw new Error(
      `${SCRIPTED_TEST_PROVIDER_ENV}=${SCRIPTED_TEST_PROVIDER_VALUE} is set but the ` +
        `runtime is not an explicit development runtime ` +
        `(CINATRA_RUNTIME_MODE=${env.CINATRA_RUNTIME_MODE ?? "<unset>"}, ` +
        `NODE_ENV=${env.NODE_ENV ?? "<unset>"}). The scripted deterministic LLM ` +
        `provider is a test-only UAT affordance and must NEVER run outside development.`,
    );
  }
}

const EDIT_INTENT =
  /\b(edit|change|rewrite|update|revise|tighten|shorten|summar|title|headline|add|append|fix)\b/i;

/**
 * The LIFECYCLE-PULL intent (cinatra#2683, epic #2564 S8f proof).
 *
 * Matched against the USER'S INSTRUCTIONS ONLY, exactly like `EDIT_INTENT`.
 * When it fires AND the runtime supplied a real self-MCP dispatcher, this
 * provider CALLS the read-only lifecycle pull primitives instead of answering
 * with prose — the deterministic stand-in for the ONE decision a real model
 * makes on this path: which tool to call, with which arguments.
 */
const LIFECYCLE_PULL_INTENT =
  /\b(review|reviews|gate|gates|waiting|approval|approvals|verification|verified|check)\b/i;

/**
 * Does this turn's instruction ask for the lifecycle pull?
 *
 * The PROVIDER's own reading, exported so a host can ask BEFORE it builds a
 * dispatcher — which is what the cookie-session `/chat` branch does
 * (cinatra#2683). The decision stays here, in the model layer, for the reason the
 * whole seam exists: choosing which primitive a turn calls is the one thing a
 * real model decides on this path, so the runtime asks the provider instead of
 * re-deriving an intent of its own. The runtime's own use of the answer is
 * narrow and stated where it is made: only a turn this predicate accepts takes
 * the scripted short-circuit on `/chat`, so every other cookie-session turn under
 * the test flag keeps resolving its real adapter exactly as it did.
 */
export function scriptedTurnAsksForLifecyclePull(instructions: string): boolean {
  return LIFECYCLE_PULL_INTENT.test(instructions);
}

/**
 * Does the instruction ask for the VERIFICATION reading rather than the review
 * gate itself? Narrow on purpose: `verification_record_render` and
 * `artifact_review_gate_render` take the SAME ref, so the only thing that
 * selects between them is what the person asked for.
 */
const VERIFICATION_INTENT = /\b(verification|verified|verify)\b/i;

// ---------------------------------------------------------------------------
// The AGENT-RUN scenario (cinatra#2683, epic #2564 S8f — the undo chip's mount).
// ---------------------------------------------------------------------------
// The inline run card and the "Undo last action" chip beside it render under ONE
// condition: an assistant turn carrying an `agent_run` tool part whose result
// named a run. On a key-free stack nothing ever produced one — the deterministic
// provider only knew the CMS edit stand-in and the lifecycle pull — so the chip
// had no mount site at all, and the parity proof could not photograph it.
//
// WHAT IS STOOD IN FOR, SAID EXACTLY. The DISPATCH is — precisely as the CMS
// content-editor stand-in above stands in for that dispatch. This module calls
// no agent, starts no run and observes no status: it emits the reference part a
// real model emits after dispatching, naming the run THE PERSON NAMED, and
// nothing else. It deliberately reports NO status, because it has not seen one.
//
// WHAT IS NOT STOOD IN FOR — and this is the part that makes the view worth
// photographing. The run is real or nothing draws: the inline panel resolves it
// server-side under the reader's own standing, and the chip beside it asks the
// §VI eligibility gate (`/api/chat/undo-candidate` with the host's own
// credential; the cookie action on `/chat`) whether THIS reader may still
// reverse something this run did. A run that does not exist, or a change-set
// this reader may not touch, draws no chip. So this is a mount site, never a
// prop, and an evidence capture of it is a capture of those real reads.
//
// TEST-ONLY, FENCED THE SAME WAY. It lives behind the same
// `assertScriptedProviderNotProduction` gate as the lifecycle branch, and it is
// reachable only from the scripted turn functions below.
// ---------------------------------------------------------------------------

/**
 * The run id the person named, or null.
 *
 * An IDENTIFIER SHAPE, not "any token": a uuid, optionally carrying the `run-`
 * prefix this deployment's agent-run rows are keyed by (verified against a live
 * `cinatra.agent_runs` table — every row is `run-<uuid>`; the bare-uuid form is
 * accepted too so this does not depend on that prefix being universal). The
 * narrowness is the point — "undo that" names no run, and a turn that guessed
 * one would put a stranger's identifier on a third-party site's screen.
 */
const AGENT_RUN_ID_PATTERN =
  /(?<![0-9a-zA-Z-])(?:run-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-zA-Z-])/i;

/** The tool name the sink reads the run id off. THE NAME IS THE CONTRACT — the
 *  AG-UI sink pins the inline run card's id from an `agent_run` tool_result and
 *  from nothing else. */
export const SCRIPTED_AGENT_RUN_TOOL = "agent_run";

/**
 * Does this turn's instruction name an agent run to show?
 *
 * Exported for the same reason `scriptedTurnAsksForLifecyclePull` is: the intent
 * reading belongs to the model layer, so a host that has to decide something
 * before the turn asks the provider rather than re-deriving a second answer.
 */
export function scriptedTurnNamesAgentRun(instructions: string): string | null {
  return instructions.match(AGENT_RUN_ID_PATTERN)?.[0] ?? null;
}

/**
 * Emit the run part: one `agent_run` tool_call plus the tool_result whose
 * `{ runId }` the sink parses into the DATA_PART that pins the inline card.
 *
 * The result carries the RUN ID AND NOTHING ELSE — no status, no summary. This
 * module dispatched nothing, so it has no status to report, and the panel reads
 * the run's real state itself.
 */
function runScriptedAgentRunReference(input: {
  runId: string;
  onToolCall: (call: { id: string; name: string }) => void;
  onToolResult: (result: { id: string; name: string; result: string }) => void;
}): void {
  const id = randomUUID();
  input.onToolCall({ id, name: SCRIPTED_AGENT_RUN_TOOL });
  input.onToolResult({
    id,
    name: SCRIPTED_AGENT_RUN_TOOL,
    result: JSON.stringify({ runId: input.runId }),
  });
}

/** The pull primitives this provider may drive. NAMES ARE THE CONTRACT — they
 *  must equal the producer's registered names (`src/lib/lifecycle/lifecycle-pull-mcp.ts`)
 *  or the call refuses at the transport and no card mints. */
export const SCRIPTED_LIFECYCLE_LIST_TOOL = "artifact_review_gates_list";
export const SCRIPTED_LIFECYCLE_GATE_RENDER_TOOL = "artifact_review_gate_render";
export const SCRIPTED_LIFECYCLE_VERIFICATION_RENDER_TOOL = "verification_record_render";

/**
 * The REAL self-MCP dispatcher the runtime injects. The provider holds no
 * transport, no token and no knowledge of the sink: it names a tool and passes
 * arguments, and receives back whatever the REAL primitive answered, verbatim.
 *
 * THE ANTI-FABRICATION RULE, STRUCTURALLY. This provider can not mint a
 * lifecycle envelope even if it tried: the envelope is built by the producer
 * (`buildLifecycleViewEnvelope`) inside the tool handler, and the sink accepts
 * it only from the (serverLabel `cinatra`, allowlisted tool) tuple, which the
 * RUNTIME stamps from the dispatch it actually performed. A string this module
 * invented would carry no such provenance and would be dropped by
 * `recognizeLifecycleViewEnvelope` — which is exactly the point.
 */
export type ScriptedSelfMcpDispatch = (call: {
  name: string;
  args: Record<string, unknown>;
}) => Promise<string>;

/** The list primitive's answer shape — refs, and nothing else. */
function parseRefs(result: string): string[] {
  try {
    const parsed: unknown = JSON.parse(result);
    if (typeof parsed !== "object" || parsed === null) return [];
    const refs = (parsed as { refs?: unknown }).refs;
    if (!Array.isArray(refs)) return [];
    return refs.filter((r): r is string => typeof r === "string" && r.length > 0);
  } catch {
    return [];
  }
}

/**
 * Drive the REAL read-only lifecycle pull, one primitive at a time, forwarding
 * every real result verbatim. Returns true when at least one call was made, so
 * the caller knows the turn already answered with tool work.
 *
 * The sequence is the one the producer's own tool descriptions prescribe:
 * LIST the refs the caller may read, then RENDER one of them. Both results —
 * including the fixed refusal sentence — travel to the sink unchanged.
 */
async function runScriptedLifecyclePull(input: {
  instructions: string;
  callSelfMcpTool: ScriptedSelfMcpDispatch;
  onToolCall: (call: { id: string; name: string }) => void;
  onToolResult: (result: { id: string; name: string; result: string }) => void;
}): Promise<boolean> {
  const listId = randomUUID();
  input.onToolCall({ id: listId, name: SCRIPTED_LIFECYCLE_LIST_TOOL });
  const listResult = await input.callSelfMcpTool({
    name: SCRIPTED_LIFECYCLE_LIST_TOOL,
    args: {},
  });
  input.onToolResult({
    id: listId,
    name: SCRIPTED_LIFECYCLE_LIST_TOOL,
    result: listResult,
  });

  const refs = parseRefs(listResult);
  if (refs.length === 0) return true;

  const renderTool = VERIFICATION_INTENT.test(input.instructions)
    ? SCRIPTED_LIFECYCLE_VERIFICATION_RENDER_TOOL
    : SCRIPTED_LIFECYCLE_GATE_RENDER_TOOL;
  const renderId = randomUUID();
  input.onToolCall({ id: renderId, name: renderTool });
  const renderResult = await input.callSelfMcpTool({
    name: renderTool,
    args: { ref: refs[0] },
  });
  input.onToolResult({ id: renderId, name: renderTool, result: renderResult });
  return true;
}

/**
 * Deterministic stand-in for the CONTENT-EDITOR AGENT'S REPLY TEXT on the
 * widget-stream relay path (cinatra#246 architecture). The widget stream route
 * calls this INSTEAD of the A2A dispatch when the scripted provider is enabled
 * — after every fail-closed auth check has already run, so the dual-token
 * path, the live membership re-checks, and the instance binding stay fully
 * real; only the agent leg (WayFlow → /api/llm-bridge → provider) is stood in
 * for, exactly the suite's documented scope ("does NOT exercise a real CMS
 * mutation via WayFlow").
 *
 * Shape contract: the return value is the same TEXT a real content-editor
 * agent emits, so the route's one JSON→SSE frame mapping is exercised
 * unchanged by scripted and real replies alike:
 *   - an edit intent → the agent's structured JSON
 *     `{ postId|nodeId, changes:[{field,before,after}] }` (→ `changes` frame,
 *     the widget's diff card);
 *   - anything else → a sentinel-bearing plain-text reply (→ `text` frame).
 * Intent is matched against the USER'S INSTRUCTIONS ONLY — never a prompt
 * template — mirroring `runScriptedStream`'s last-user-message matching.
 */
export function buildScriptedContentEditorReplyText(input: {
  /** The end user's editing instruction (the latest user message). */
  instructions: string;
  /** CMS id key: WordPress carries `postId`, Drupal carries `nodeId`. */
  idKey: "postId" | "nodeId";
  /** The trusted CMS context's id value (may be empty). */
  idValue: string;
}): string {
  if (EDIT_INTENT.test(input.instructions)) {
    return JSON.stringify({
      [input.idKey]: input.idValue,
      changes: [
        {
          field: "title",
          before: "UAT seeded title",
          after: "UAT seeded title (edited by the deterministic provider)",
        },
      ],
    });
  }
  const cms = input.idKey === "nodeId" ? "Drupal" : "WordPress";
  return (
    `${UAT_SENTINEL}: deterministic test reply for ${cms}. ` +
    `You said: "${input.instructions.slice(0, 120)}".`
  );
}

/**
 * Deterministic widget-assistant turn for the WP/Drupal Playwright UATs on the
 * UNIFIED `/api/assistants/chat` broker path (cinatra#1221 S5 / #1919 AC3).
 *
 * Unlike `runScriptedStream` (which feeds the host `stream()` seam once an
 * adapter has already resolved) this emits the RUNTIME's `send` vocabulary via
 * typed callbacks so `runAssistantTurn` can short-circuit BEFORE
 * `resolveDefaultAdapter()`. The deterministic UAT app carries no provider
 * creds, so adapter resolution would otherwise resolve null and fail the widget
 * turn with "No LLM provider configured." before this stream could answer — the
 * exact defect this restores (#1919 AC3).
 *
 * Sequence (SAME shape a real content-editor turn produces, so the widget's
 * frame handling is exercised unchanged):
 *   - a sentinel-bearing text reply (→ `TEXT_MESSAGE_CONTENT`), always; and
 *   - on an edit intent, one `*_content_editor_run` tool_call (→
 *     `TOOL_CALL_START`, the widget's content-edit key that triggers the
 *     apply/reload) plus its tool_result.
 * Intent is matched against the USER'S INSTRUCTIONS ONLY (never a prompt
 * template), mirroring `runScriptedStream`'s last-user-message matching. The CMS
 * (WordPress vs Drupal, → tool name + id key) is selected from the bound
 * assistant handle, the server-verified widget principal's own field — never a
 * model- or body-supplied value.
 */
export async function runScriptedWidgetAssistantTurn(input: {
  /** The end user's latest message (the editing instruction). */
  instructions: string;
  /** The bound assistant handle ("wordpress" | "drupal" | …); selects the CMS. */
  assistantHandle: string;
  onText: (chunk: string) => void;
  onToolCall: (call: { id: string; name: string }) => void;
  onToolResult: (result: { id: string; name: string; result: string }) => void;
  /**
   * The REAL self-MCP dispatcher (cinatra#2683). OPTIONAL: when absent — every
   * pre-existing caller, and the WP/Drupal UAT specs — this turn behaves exactly
   * as it did, so the twelve scenarios are unaffected. When present, a lifecycle
   * question drives the REAL read-only pull primitives through it.
   */
  callSelfMcpTool?: ScriptedSelfMcpDispatch;
}): Promise<void> {
  const isDrupal = input.assistantHandle.trim().toLowerCase() === "drupal";
  const idKey: "postId" | "nodeId" = isDrupal ? "nodeId" : "postId";
  const toolName = isDrupal
    ? "drupal_content_editor_run"
    : "wordpress_content_editor_run";
  const cms = isDrupal ? "Drupal" : "WordPress";

  const reply =
    `${UAT_SENTINEL}: deterministic test reply for ${cms}. ` +
    `You said: "${input.instructions.slice(0, 120)}".`;
  for (const chunk of reply.match(/[\s\S]{1,24}/g) ?? [reply]) {
    input.onText(chunk);
  }

  // The LIFECYCLE PULL takes precedence over the edit stand-in when both could
  // match ("update the review" is a review question, not a CMS edit), and it is
  // reachable ONLY when the runtime injected a real dispatcher. A dispatcher
  // that throws degrades to the plain text reply above — the honest outcome for
  // a tool call that did not happen, and never a fabricated card.
  if (input.callSelfMcpTool && LIFECYCLE_PULL_INTENT.test(input.instructions)) {
    try {
      await runScriptedLifecyclePull({
        instructions: input.instructions,
        callSelfMcpTool: input.callSelfMcpTool,
        onToolCall: input.onToolCall,
        onToolResult: input.onToolResult,
      });
      return;
    } catch {
      return;
    }
  }

  // THE AGENT-RUN REFERENCE (cinatra#2683). Below the lifecycle branch because a
  // lifecycle question is the more specific reading of a turn that is both — and
  // above the CMS stand-in because naming a run is not an editing instruction,
  // however many editing words surround it.
  const namedRun = scriptedTurnNamesAgentRun(input.instructions);
  if (namedRun) {
    runScriptedAgentRunReference({
      runId: namedRun,
      onToolCall: input.onToolCall,
      onToolResult: input.onToolResult,
    });
    return;
  }

  if (EDIT_INTENT.test(input.instructions)) {
    const id = randomUUID();
    input.onToolCall({ id, name: toolName });
    input.onToolResult({
      id,
      name: toolName,
      result: JSON.stringify({
        // The write-target id is the server-derived one at the real seam; the
        // deterministic stand-in leaves it empty (the UAT asserts the round-trip
        // + no-direct-egress, not a specific id).
        [idKey]: "",
        changes: [
          {
            field: "title",
            before: "UAT seeded title",
            after: "UAT seeded title (edited by the deterministic provider)",
          },
        ],
      }),
    });
  }
}

/**
 * Deterministic COOKIE-SESSION `/chat` turn (cinatra#2683, epic #2564 S8f — the
 * parity proof's comparison view).
 *
 * The widget turn above answers a CMS editing question and, when asked a
 * lifecycle question, calls the real pull primitives. `/chat` is not a CMS
 * surface, so this turn is ONLY the lifecycle pull: it streams one sentinel line
 * so the transcript reads like a turn rather than a bare tool trace, then names
 * the primitives and forwards what they answered, byte for byte.
 *
 * WHAT IS STOOD IN FOR, EXACTLY. The model layer, and only it. The runtime
 * reaches this function only for a turn `scriptedTurnAsksForLifecyclePull`
 * accepts, and everything after the name is real: the runtime's dispatcher
 * carries the chat surface's OWN `cinatra.chat.mcp-obo` token to the real
 * self-MCP, the delegated-chat tool policy decides whether the primitive may be
 * called at all, and the producer mints the envelope or refuses. This module
 * cannot mint a card: a string it composed carries no dispatch provenance, so the
 * runtime emits it unlabelled and the sink's recognizer drops it.
 *
 * A dispatcher that throws degrades to the streamed text — the honest outcome of
 * a tool call that did not happen, never a fabricated card.
 */
export async function runScriptedChatAssistantTurn(input: {
  /** The end user's latest message. */
  instructions: string;
  /** The REAL self-MCP dispatcher the runtime injects (chat-token flavour). */
  callSelfMcpTool: ScriptedSelfMcpDispatch;
  onText: (chunk: string) => void;
  onToolCall: (call: { id: string; name: string }) => void;
  onToolResult: (result: { id: string; name: string; result: string }) => void;
}): Promise<void> {
  const reply =
    `${UAT_SENTINEL}: deterministic chat reply. ` +
    `You said: "${input.instructions.slice(0, 120)}".`;
  for (const chunk of reply.match(/[\s\S]{1,24}/g) ?? [reply]) {
    input.onText(chunk);
  }

  try {
    await runScriptedLifecyclePull({
      instructions: input.instructions,
      callSelfMcpTool: input.callSelfMcpTool,
      onToolCall: input.onToolCall,
      onToolResult: input.onToolResult,
    });
  } catch {
    // The turn keeps the text it already streamed and mints nothing.
  }
}

function lastUserMessage(input: OrchestrateStreamInput): string {
  const messages = input.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role === "user" && typeof m.content === "string") return m.content;
  }
  return "";
}

/**
 * Emit a deterministic stream for the UATs. Always streams a sentinel-bearing
 * text reply; when the prompt expresses an edit intent, also emits one
 * content-editor tool result (which the widget stream route maps to a `changes`
 * SSE frame), with `postId`/`nodeId` taken from the system-prompt CMS context.
 */
export async function runScriptedStream(input: OrchestrateStreamInput): Promise<void> {
  const system = input.system ?? "";
  const lastUser = lastUserMessage(input);
  const isDrupal = /Drupal context/i.test(system) || /\bnodeId:/.test(system);
  const idKey = isDrupal ? "nodeId" : "postId";
  const toolName = isDrupal
    ? "drupal_content_editor_run"
    : "wordpress_content_editor_run";
  const idMatch = system.match(new RegExp(`${idKey}:\\s*([^\\n]*)`));
  const idVal = (idMatch?.[1] ?? "").trim();

  try {
    input.onStepStart(1);
    const reply =
      `${UAT_SENTINEL}: deterministic test reply for ` +
      `${isDrupal ? "Drupal" : "WordPress"}. You said: "${lastUser.slice(0, 120)}".`;
    for (const chunk of reply.match(/[\s\S]{1,24}/g) ?? [reply]) {
      input.onTextDelta(chunk);
    }
    if (EDIT_INTENT.test(lastUser)) {
      input.onToolResult({
        id: randomUUID(),
        name: toolName,
        result: JSON.stringify({
          [idKey]: idVal,
          changes: [
            {
              field: "title",
              before: "UAT seeded title",
              after: "UAT seeded title (edited by the deterministic provider)",
            },
          ],
        }),
      });
    }
    input.onStepEnd(1);
  } catch (err) {
    input.onError(err instanceof Error ? err : new Error(String(err)));
  }
}
