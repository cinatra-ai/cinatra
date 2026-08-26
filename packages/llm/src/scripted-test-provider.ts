import { randomUUID } from "node:crypto";

import type { LlmResponse, OrchestrateStreamInput } from "./types";

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

/**
 * The SCHEDULE-PROPOSAL intent (epic #2564 §VI).
 *
 * Matched against the USER'S INSTRUCTIONS ONLY, exactly like the two intents
 * above, and it stands in for the same one decision: which tool this turn
 * calls. A person who asks for an agent to run later is asking for the §VI
 * card, and the producer that draws it is `schedule_proposal_render`.
 *
 * WHY THIS ARM EXISTS. The lifecycle-pull arm can name only the two `*_render`
 * primitives, so no turn on a key-free stack could ever reach the schedule
 * producer, and the §VI card could not be photographed in a conversation at
 * all. The arm adds no authority: the tool it names WRITES NOTHING (it mints a
 * signed, expiring proposal token and returns the S1 envelope), and every check
 * behind it — the caller's principal, the org boundary, the template's reach —
 * is the shipped one.
 */
const SCHEDULE_PROPOSAL_INTENT = /\b(schedule|scheduled|scheduling|recurring|recurrence)\b/i;

/**
 * Does this turn's instruction ask for a schedule proposal?
 *
 * Exported for the same reason `scriptedTurnAsksForLifecyclePull` is: the
 * intent reading belongs to the model layer, so the host asks the provider
 * rather than deriving a second answer of its own.
 */
export function scriptedTurnAsksForScheduleProposal(instructions: string): boolean {
  return SCHEDULE_PROPOSAL_INTENT.test(instructions);
}

/** The producer this provider may drive for §VI. THE NAME IS THE CONTRACT — it
 *  must equal the registered name (`src/lib/lifecycle/schedule-proposal-mcp.ts`)
 *  and sit in `LIFECYCLE_PRODUCER_TOOLS.trigger_schedule_proposal`, or the call
 *  refuses at the transport and no card mints. */
export const SCRIPTED_SCHEDULE_PROPOSAL_TOOL = "schedule_proposal_render";

/**
 * The agent template the person named, or null.
 *
 * The SAME identifier shape `scriptedTurnNamesAgentRun` reads, under its own
 * name because it names a different subject: an agent template, not a run. This
 * provider holds no store and cannot resolve "the blog writer" to a row, so the
 * turn names its subject by identifier and the REAL primitive decides whether
 * that subject exists and whether the asker may reach it. Naming one grants
 * nothing.
 */
export function scriptedTurnNamesScheduleTemplate(instructions: string): string | null {
  return instructions.match(AGENT_RUN_ID_PATTERN)?.[0] ?? null;
}

/**
 * The hour and minute the person asked for, defaulting to 09:00.
 *
 * A wall clock, read out of the sentence. Nothing here invents a date: the
 * proposal this arm asks for is a RECURRING one, which carries no date at all.
 */
function scriptedScheduleTimeOfDay(instructions: string): { hour: number; minute: number } {
  const match = instructions.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (!match) return { hour: 9, minute: 0 };
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/**
 * Emit the §VI producer call: `schedule_proposal_render` for the template the
 * person named, on a daily recurrence at the hour they asked for.
 *
 * THIS ARM SYNTHESIZES THE SCHEDULE SHAPE, and that is worth saying plainly
 * rather than leaving a reader to infer it. Only two values come out of the
 * sentence — the template and the time of day. Everything else is a fixed
 * selection this module chooses: a `recurring` kind, the `UTC` timezone, a
 * `daily` frequency at interval 1, and the calendar fields the schema requires
 * but a daily recurrence does not use. A real model would read all of them off
 * the request; this stand-in does not, so a capture driven through it proves the
 * PRODUCER and the CARD, never the model's reading of a schedule.
 *
 * DAILY, deliberately. §VI's option rows are a builder's selections, and the
 * simplest selection that exercises the whole producer is a daily recurrence —
 * it needs no future date, so the proposal can never be refused for a runAt in
 * the past.
 *
 * A turn that names no template dispatches NOTHING. Guessing one would put a
 * stranger's identifier into a proposal.
 */
async function runScriptedScheduleProposal(input: {
  instructions: string;
  callSelfMcpTool: ScriptedSelfMcpDispatch;
  onToolCall: (call: { id: string; name: string }) => void;
  onToolResult: (result: { id: string; name: string; result: string }) => void;
}): Promise<boolean> {
  const templateId = scriptedTurnNamesScheduleTemplate(input.instructions);
  if (!templateId) return false;
  const { hour, minute } = scriptedScheduleTimeOfDay(input.instructions);
  const id = randomUUID();
  input.onToolCall({ id, name: SCRIPTED_SCHEDULE_PROPOSAL_TOOL });
  const result = await input.callSelfMcpTool({
    name: SCRIPTED_SCHEDULE_PROPOSAL_TOOL,
    args: {
      templateId,
      schedule: {
        kind: "recurring",
        timezone: "UTC",
        selection: {
          frequency: "daily",
          interval: 1,
          weekdays: [],
          dayOfMonth: 1,
          monthlyMode: "date",
          nthWeek: 1,
          monthlyWeekday: 1,
          quarterAnchor: "start",
          yearlyMonth: 1,
          hour,
          minute,
        },
      },
    },
  });
  input.onToolResult({ id, name: SCRIPTED_SCHEDULE_PROPOSAL_TOOL, result });
  return true;
}

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


// ---------------------------------------------------------------------------
// The AGENT START (cinatra#2935, lifecycle-b W5d).
// ---------------------------------------------------------------------------
// The reference arm above SHOWS a run somebody already started. This one STARTS
// one, and it exists because W5d moved that job to the assistant. From the plan
// (PLAN: Agents Lifecycle (B), section 4):
//
//   "starting an agent by naming it becomes something the assistant does — an
//    agent tag is addressed to the conversation's assistant, which starts the
//    agent; nothing dispatches before the model."
//
// With nothing dispatching before the model, a key-free development stack had
// no way to start an agent from a conversation at all: the assistant is now the
// only road, and on such a stack the assistant is this stand-in. So the reading
// lives HERE, in the model layer, beside every other reading this module makes
// (`scriptedTurnAsksForLifecyclePull`, `scriptedTurnAsksForScheduleProposal`,
// `scriptedTurnNamesAgentRun`) and for the reason those give: choosing which
// primitive a turn calls is the one thing a real model decides on this path, so
// the host asks the provider instead of deriving an intent of its own.
//
// THIS IS NOT THE REMOVED PRE-ROUTER COMING BACK, and the difference is
// structural rather than a matter of degree. What W5d removed was a SERVER
// reader that ran BEFORE the model, on the real product path, in every runtime,
// and short-circuited the turn hard. What is added here reads a sentence AS the
// model, on a path `assertScriptedProviderNotProduction` fences to an explicit
// development runtime, and decides exactly one thing: which tool to call. The
// REAL `agent_run` primitive still resolves the template, runs the whole
// authorization ladder, applies the creation preflight, evaluates the
// recommendation checkpoint and decides whether the run parks. This module
// starts nothing itself and reports nothing it was not told.
//
// WHAT IS STOOD IN FOR, SAID EXACTLY: the model's reading of the sentence, and
// its wording of the answer. Nothing below it.
// ---------------------------------------------------------------------------

/**
 * The START verb.
 *
 * Naming an agent is not asking for one to run — "what does
 * `@cinatra-ai/lint-policy-agent` do?" names one and asks for prose — so a verb
 * is required beside the name. The list is the one a person actually writes;
 * it is matched against the USER'S INSTRUCTIONS ONLY, exactly like every other
 * intent in this module.
 *
 * IT IS A BLUNT READING, AND THAT IS STATED RATHER THAN HIDDEN. A verb anywhere
 * in the sentence beside a package name anywhere else is enough, so "do not run
 * `@cinatra-ai/<slug>`" reads as a start, exactly as a poor model would read it.
 * Two things bound what that can cost. The arm exists ONLY under
 * `assertScriptedProviderNotProduction`'s explicit development runtime, so no
 * real conversation can reach it; and the reading grants nothing — the REAL
 * primitive decides whether the template exists, whether it may run here, and
 * whether the caller may run it, so the worst outcome is one refused or one
 * extra run on a throwaway stack.
 */
const AGENT_START_INTENT = /\b(use|run|invoke|call|dispatch|execute|launch)\b/i;

/**
 * The canonical package form, `@cinatra-ai/<slug>`.
 *
 * Read from the LOWERCASED sentence: npm scope and package names are lowercase
 * by definition, and the chat client's own mention tokenizer folds case when it
 * lexes a scoped reference, so `@Cinatra-AI/Some-Agent` and
 * `@cinatra-ai/some-agent` are one identifier and must resolve to one package.
 */
const CANONICAL_AGENT_PACKAGE_PATTERN = /@cinatra-ai\/([a-z][a-z0-9-]*)/;

/**
 * The legacy `cinatra_<slug>` wording, which is what a person writes when they
 * want NO mention token in the sentence at all.
 *
 * Read from the RAW text, case-SENSITIVELY, and that is deliberate: this form
 * produces no mention token, so it has no client tokenizer to be in parity
 * with, while folding case would read ordinary shouted identifiers such as
 * `CINATRA_THEME` as an agent and try to start one.
 */
const LEGACY_AGENT_PACKAGE_PATTERN = /\bcinatra_([a-z][a-z0-9-]+)(?:[-_ ]tool|\b)/;

/**
 * The agent this turn asks to start, as a canonical package name, or null.
 *
 * Exported for the reason `scriptedTurnAsksForLifecyclePull` is: a host that
 * must decide something BEFORE the turn — which the cookie-session `/chat`
 * branch does — asks the provider rather than deriving a second answer.
 *
 * Naming a package grants nothing. The name is inert on its own: the REAL
 * primitive decides whether that template exists, whether it may be run at all
 * on this instance, and whether this caller may run it.
 */
export function scriptedTurnStartsAgent(instructions: string): string | null {
  if (!AGENT_START_INTENT.test(instructions)) return null;
  const canonical = instructions.toLowerCase().match(CANONICAL_AGENT_PACKAGE_PATTERN);
  if (canonical) return `@cinatra-ai/${canonical[1]}`;
  const legacy = instructions.match(LEGACY_AGENT_PACKAGE_PATTERN);
  if (legacy) return `@cinatra-ai/${legacy[1]}`;
  return null;
}

/**
 * The `inputParams` the person wrote into the sentence, as the JSON STRING the
 * primitive takes — `"{}"` when they wrote none.
 *
 * A real model reads the inputs out of the request; this reads only the ones
 * stated outright, anchored on the parameter's own name so an example object
 * quoted in prose is not mistaken for the request. It INVENTS nothing: a
 * sentence carrying no inputs starts the agent with none, and the primitive's
 * own schema decides whether that is enough.
 */
export function scriptedTurnAgentInputParams(instructions: string): string {
  const marker = instructions.match(/\binput[\s_]?params?\b\s*[:=]?\s*(?=\{)/i);
  if (!marker || marker.index === undefined) return "{}";
  const start = instructions.indexOf("{", marker.index);
  if (start === -1) return "{}";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < instructions.length; i += 1) {
    const ch = instructions[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth > 0) continue;
      try {
        const parsed: unknown = JSON.parse(instructions.slice(start, i + 1));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return JSON.stringify(parsed);
        }
      } catch {
        return "{}";
      }
      return "{}";
    }
  }
  return "{}";
}

/** What the start primitive answered, read defensively. */
function parseAgentStartAnswer(result: string): {
  runId: string | null;
  status: string | null;
  error: string | null;
} {
  try {
    const parsed: unknown = JSON.parse(result);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { runId: null, status: null, error: null };
    }
    const record = parsed as { runId?: unknown; status?: unknown; error?: unknown };
    return {
      runId: typeof record.runId === "string" && record.runId ? record.runId : null,
      status: typeof record.status === "string" && record.status ? record.status : null,
      error: typeof record.error === "string" && record.error ? record.error : null,
    };
  } catch {
    return { runId: null, status: null, error: null };
  }
}

/**
 * Call the REAL `agent_run` primitive, then SAY what it answered.
 *
 * THE TEXT IS A REPORT, NOT A CLAIM. Both sentences are chosen by the STATUS
 * the primitive returned, so neither can be true of a turn where the other
 * happened: a run that parked is described as parked, a run that did not is
 * described as running, and a start the primitive refused says so and names the
 * refusal verbatim. That conditional is the same one the removed pre-router
 * made — it moved to the assistant with the job.
 *
 * IT IS ALSO THE ONLY PLACE THE RUN ID CAN COME FROM ON SCREEN. A tool result
 * feeds the turn's status line and renders no inline text, so a turn that never
 * says the id never names the run it started. The reader gets the card either
 * way; the sentence is what makes the turn readable beside it.
 *
 * EVENT TENSE, deliberately: this text is persisted with the turn and re-read
 * long after the card beside it has settled. "The run paused" records what
 * happened; "the run is paused" would keep asserting a state that stopped being
 * true the moment somebody decided.
 */
async function runScriptedAgentStart(input: {
  packageName: string;
  instructions: string;
  callSelfMcpTool: ScriptedSelfMcpDispatch;
  onText: (chunk: string) => void;
  onToolCall: (call: { id: string; name: string }) => void;
  onToolResult: (result: { id: string; name: string; result: string }) => void;
}): Promise<void> {
  const id = randomUUID();
  input.onToolCall({ id, name: SCRIPTED_AGENT_RUN_TOOL });
  const result = await input.callSelfMcpTool({
    name: SCRIPTED_AGENT_RUN_TOOL,
    args: {
      packageName: input.packageName,
      inputParams: scriptedTurnAgentInputParams(input.instructions),
    },
  });
  input.onToolResult({ id, name: SCRIPTED_AGENT_RUN_TOOL, result });

  const answer = parseAgentStartAnswer(result);
  if (!answer.runId) {
    input.onText(
      `I tried to dispatch \`${input.packageName}\` but the server returned: ` +
        `${answer.error ?? result}.`,
    );
    return;
  }
  const status = answer.status ?? "queued";
  input.onText(
    status === "pending_input"
      ? `Dispatched \`${input.packageName}\` (runId: \`${answer.runId}\`, status: ` +
          `\`${status}\`). The run paused for a decision on the recommended skills.`
      : `Dispatched \`${input.packageName}\` (runId: \`${answer.runId}\`, status: ` +
          `\`${status}\`). The agent is running — I'll keep polling for its progress.`,
  );
}

/** The pull primitives this provider may drive. NAMES ARE THE CONTRACT — they
 *  must equal the producer's registered names (`src/lib/lifecycle/lifecycle-pull-mcp.ts`)
 *  or the call refuses at the transport and no card mints. */
export const SCRIPTED_LIFECYCLE_LIST_TOOL = "artifact_review_gates_list";
export const SCRIPTED_LIFECYCLE_GATE_RENDER_TOOL = "artifact_review_gate_render";
export const SCRIPTED_LIFECYCLE_VERIFICATION_RENDER_TOOL = "verification_record_render";

/**
 * The card ref the person named, or null.
 *
 * A REF SHAPE, not "any token": the sealed base64url handle the list primitive
 * mints (`encodeLifecycleGateRef` — AES-GCM over the run + review task), which is
 * far longer than any word and carries no `.` or `/`. The floor is deliberately
 * above a uuid's 36 characters so `scriptedTurnNamesAgentRun`'s subject can never
 * be read as a ref.
 *
 * WHY A TURN MAY NAME ONE, said exactly. `artifact_review_gates_list` answers
 * with the OLDEST few gates a caller may read, and a verification reading exists
 * only for a target that has actually been repaired — so on any real backlog the
 * head of the list is almost never the item with a reading, and a provider that
 * can only ever render `refs[0]` cannot show one. A real model asked about a
 * SPECIFIC item renders that item; this is the same stand-in
 * `scriptedTurnNamesAgentRun` already makes for the run card, and it is safe for
 * the same reason: the ref is opaque and inert on its own — the REAL primitive
 * decodes it, re-runs the whole S1 ladder (run READ, then the gate, then the
 * record) and answers the fixed "not available to you" for anything the asker may
 * not see. Naming a ref grants nothing.
 */
const LIFECYCLE_CARD_REF_PATTERN = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{48,512}(?![A-Za-z0-9_-])/;

/**
 * Does this turn's instruction name a lifecycle card ref to show?
 *
 * Exported for the same reason `scriptedTurnAsksForLifecyclePull` and
 * `scriptedTurnNamesAgentRun` are: the intent reading belongs to the model layer,
 * so a host that must decide something before the turn asks the provider rather
 * than deriving a second answer of its own.
 */
export function scriptedTurnNamesLifecycleRef(instructions: string): string | null {
  return instructions.match(LIFECYCLE_CARD_REF_PATTERN)?.[0] ?? null;
}

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
  // A SCHEDULE REQUEST is answered FIRST, and it never lists. §VI's card is a
  // proposal about a template, so there is no backlog to discover and no ref to
  // render — listing here would draw a review gate for a person who asked to
  // schedule an agent.
  //
  // A schedule turn that names no template dispatches NOTHING, and it stops
  // unless the PULL predicate independently claims the same sentence. Falling
  // through unconditionally would answer "schedule something for me later" with
  // a review-gate listing — this seam inventing an intent nobody expressed. A
  // sentence that genuinely asks both still reaches the pull, exactly as before
  // this arm existed, because the pull's own predicate decides that.
  if (scriptedTurnAsksForScheduleProposal(input.instructions)) {
    const proposed = await runScriptedScheduleProposal(input);
    if (proposed) return true;
    if (!scriptedTurnAsksForLifecyclePull(input.instructions)) return true;
  }

  // A NAMED REF short-circuits the LIST. Listing is the discovery step, and a
  // turn that already names the item has nothing to discover — so this renders
  // exactly what was asked for, once. The primitive still decides whether the
  // asker may see it.
  const namedRef = scriptedTurnNamesLifecycleRef(input.instructions);
  if (namedRef) {
    const namedTool = VERIFICATION_INTENT.test(input.instructions)
      ? SCRIPTED_LIFECYCLE_VERIFICATION_RENDER_TOOL
      : SCRIPTED_LIFECYCLE_GATE_RENDER_TOOL;
    const namedId = randomUUID();
    input.onToolCall({ id: namedId, name: namedTool });
    const namedResult = await input.callSelfMcpTool({
      name: namedTool,
      args: { ref: namedRef },
    });
    input.onToolResult({ id: namedId, name: namedTool, result: namedResult });
    return true;
  }

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

  // THE AGENT START (cinatra#2935, lifecycle-b W5d) — BELOW the two pull
  // readings, never above them. A review or a schedule question is the more
  // specific reading of a sentence that could be taken as both ("run the review
  // gate check"), so every turn those two claim keeps the answer it has today,
  // byte for byte, and only a turn they BOTH decline can start anything.
  if (
    !scriptedTurnAsksForLifecyclePull(input.instructions) &&
    !scriptedTurnAsksForScheduleProposal(input.instructions)
  ) {
    const startPackage = scriptedTurnStartsAgent(input.instructions);
    if (startPackage) {
      try {
        await runScriptedAgentStart({
          packageName: startPackage,
          instructions: input.instructions,
          callSelfMcpTool: input.callSelfMcpTool,
          onText: input.onText,
          onToolCall: input.onToolCall,
          onToolResult: input.onToolResult,
        });
      } catch {
        // A dispatcher that threw started nothing this module may speak for, so
        // the turn keeps the text it already streamed and mints no card — the
        // same degradation the pull arm takes, for the same reason.
      }
      return;
    }
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

// ---------------------------------------------------------------------------
// The BRIDGE path (cinatra#2910).
//
// `/api/llm-bridge` is the surface an agent run performs its model call on. It
// resolves a runtime (`resolveConfiguredLlmRuntime`) and executes it
// (`runResolvedSkillAwareDeterministicLlmTask`); both resolve a real provider
// adapter, so a credential-free stack answered every agent model call with
// `503 NO_LLM_PROVIDER` even with this provider enabled — the chat surface had
// a scripted seam and the agent-run surface had none.
//
// The two functions below are that seam, and they live HERE — beside the fence
// — rather than in the orchestration barrel, so the decision to serve scripted
// output and the assertion that refuses it outside development are the same
// module, read together, and reachable from a test without loading the barrel.
// ---------------------------------------------------------------------------

/**
 * The model id a scripted runtime reports. It is deliberately not a real
 * provider model: anything that records the model of a scripted run records a
 * name no provider answers to.
 */
export const SCRIPTED_TEST_MODEL = "scripted-test-model";

/** The runtime the bridge resolves when this provider serves the call. */
export type ScriptedLlmRuntime = { provider: "scripted"; model: string };

/**
 * The scripted runtime, or `null` when the flag is off.
 *
 * FENCE. `assertScriptedProviderNotProduction` runs before a runtime can be
 * produced, so a set flag under anything other than an explicit development
 * runtime THROWS here rather than yielding a runtime a caller could execute.
 * With the flag off this is a no-op returning `null` — the caller's existing
 * "nothing resolved" answer, unchanged.
 *
 * LAST RESORT, never a preference: the caller consults this only after real
 * adapter resolution found nothing, so an install that HAS a configured
 * provider keeps resolving that provider even with the flag set.
 */
export function resolveScriptedLlmRuntime(env: EnvLike = process.env): ScriptedLlmRuntime | null {
  if (!isScriptedTestProviderEnabled(env)) return null;
  assertScriptedProviderNotProduction(env);
  return { provider: "scripted", model: SCRIPTED_TEST_MODEL };
}

/** Is this the scripted runtime? A type guard so consumers narrow instead of casting. */
export function isScriptedLlmRuntime(
  runtime: { provider: string } | null | undefined,
): runtime is ScriptedLlmRuntime {
  return runtime?.provider === "scripted";
}

/**
 * The depth past which a node yields a plain string instead of its declared
 * type. A bound is required — a `$ref`-recursive schema would otherwise not
 * terminate — and the cap is part of the documented contract above, not an
 * implementation detail a caller may assume away.
 */
const SCRIPTED_SCHEMA_MAX_DEPTH = 6;

/**
 * A deterministic value for one JSON-schema node — CONFORMING BY TYPE, not by
 * constraint.
 *
 * The bridge's callers ask for structured output (`output_schema`) and parse
 * the response as JSON, so a scripted completion has to answer in the TYPE
 * SHAPE the caller declared or the run fails one frame later on a parse error
 * instead of a 503. Every string leaf carries `UAT_SENTINEL`, so a scripted
 * value is recognisable wherever it surfaces and can never be mistaken for a
 * model's own words.
 *
 * This is NOT a JSON-Schema implementation, and callers must not read it as
 * one. EXACTLY these keywords are honored, checked IN THIS ORDER — the first
 * that applies wins, so a node carrying both `enum` and `const` answers with
 * the enum's first member, not the const: the depth cap, then `enum`, then
 * `const`, then the union keywords, then `type`:
 *
 *  - `const` — the pinned value (it is the only conforming one);
 *  - `enum` — the FIRST member;
 *  - `oneOf` / `anyOf` / `allOf` — the FIRST member, recursively. `allOf` is
 *    therefore NOT composed: constraints declared in its later members are not
 *    applied, so an `allOf` that splits a shape across members yields only the
 *    first member's shape;
 *  - `type` — `object` (the members named in `required`, or every declared
 *    property when `required` is absent; a required name with no declared
 *    property schema still appears), `array` (EXACTLY ONE element),
 *    `string`, `number` / `integer`, `boolean`, `null`. A node with no usable
 *    type yields a string;
 *  - depth — a node deeper than `SCRIPTED_SCHEMA_MAX_DEPTH` yields a STRING
 *    whatever its declared type, so a deeply nested or recursive schema stops
 *    matching its own declaration at that depth.
 *
 * Everything else is IGNORED, and the value is only conforming-by-type:
 * numeric bounds (`minimum` / `maximum` / `multipleOf` — numbers are always
 * `0`), size bounds (`minItems` / `maxItems` — arrays are always length 1;
 * `minLength` / `maxLength` — strings are always the sentinel string),
 * `pattern` / `format`, `additionalProperties`, `not`, `if` / `then` / `else`,
 * `dependent*`, and `$ref` / `$defs`. A caller that validates a scripted
 * response against a schema carrying any of those may see it rejected — which
 * is correct: this provider stands in for a model's SHAPE, not its judgement.
 */
function scriptedValueForSchema(
  schema: unknown,
  propertyName: string,
  depth: number,
): unknown {
  const node = (schema ?? {}) as Record<string, unknown>;
  const scriptedString = `${UAT_SENTINEL}: scripted ${propertyName}`;
  if (depth > SCRIPTED_SCHEMA_MAX_DEPTH) return scriptedString;

  const enumValues = Array.isArray(node.enum) ? node.enum : null;
  if (enumValues && enumValues.length > 0) return enumValues[0];
  // A pinned `const` IS the only conforming value.
  if ("const" in node) return node.const;

  // A union declaration picks its FIRST member — deterministic, and the member
  // an author lists first is the one they described the shape with.
  // FIRST member only — including for `allOf`, which is therefore not composed
  // (see the contract above).
  const union = ["oneOf", "anyOf", "allOf"].find((k) => Array.isArray(node[k]));
  if (union) {
    const members = node[union] as unknown[];
    if (members.length > 0) {
      return scriptedValueForSchema(members[0], propertyName, depth + 1);
    }
  }

  const type = Array.isArray(node.type) ? node.type[0] : node.type;
  // Value keywords only: NO bound (`minimum`, `minItems`, `minLength`, …) is
  // read here. See the contract above — conforming by type, not by constraint.
  switch (type) {
    case "object": {
      const properties = (node.properties ?? {}) as Record<string, unknown>;
      const required = Array.isArray(node.required)
        ? (node.required as string[])
        : null;
      // Required-only when the schema names required members (the minimal
      // conforming object); otherwise every declared property. A required name
      // with no declared property schema still appears — omitting it would
      // produce an object the caller's own validator rejects.
      const names = required ?? Object.keys(properties);
      const out: Record<string, unknown> = {};
      for (const name of names) {
        out[name] = scriptedValueForSchema(properties[name], name, depth + 1);
      }
      return out;
    }
    case "array":
      // ONE element, ALWAYS: enough for a consumer that iterates, small enough
      // that a scripted payload never grows unbounded — and `minItems` is not
      // consulted, so a schema demanding more is not satisfied.
      return [scriptedValueForSchema(node.items, `${propertyName} item`, depth + 1)];
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    case "null":
      return null;
    case "string":
      return scriptedString;
    default:
      // An untyped node (`{}` / `true`) accepts anything; a string says the
      // most about where the value came from.
      return scriptedString;
  }
}

/**
 * The deterministic completion the bridge returns for a scripted runtime.
 *
 * It is the single-shot sibling of `runScriptedStream`: no network, no adapter,
 * no tools — the model layer, and only it, is stood in for. Everything the
 * bridge does around this call (its token auth, the run-token binding, skill
 * injection, the efficacy ledger) is untouched and still real.
 *
 * FENCE. The production assertion runs FIRST, so no scripted bytes can be
 * produced outside an explicit development runtime even if a scripted runtime
 * value reached execution some other way. A runtime that arrives with the flag
 * OFF is a wiring defect, not a state to serve — it throws rather than
 * inventing output nobody asked for.
 */
export function runScriptedBridgeCompletion(
  input: {
    system?: string | null;
    user?: string | null;
    outputSchema?: Record<string, unknown> | null;
    model?: string | null;
  },
  env: EnvLike = process.env,
): LlmResponse {
  assertScriptedProviderNotProduction(env);
  if (!isScriptedTestProviderEnabled(env)) {
    throw new Error(
      `A scripted LLM runtime reached execution while ${SCRIPTED_TEST_PROVIDER_ENV} is ` +
        `not set to "${SCRIPTED_TEST_PROVIDER_VALUE}". The scripted runtime is only ` +
        `constructible under the flag, so this is a wiring defect.`,
    );
  }
  const instructions = (input.user ?? "").slice(0, 120);
  const text = input.outputSchema
    ? JSON.stringify(scriptedValueForSchema(input.outputSchema, "output", 0))
    : `${UAT_SENTINEL}: deterministic bridge reply. You said: "${instructions}".`;
  return {
    text,
    status: "completed",
    incompleteReason: null,
    // No provider was called, so there is no native body to report: the raw
    // body states exactly what produced the text.
    rawBody: JSON.stringify({
      provider: SCRIPTED_TEST_PROVIDER_VALUE,
      model: input.model ?? SCRIPTED_TEST_MODEL,
      text,
    }),
    model: input.model ?? SCRIPTED_TEST_MODEL,
    // No `usage`: nothing was spent, so nothing is metered.
  };
}
