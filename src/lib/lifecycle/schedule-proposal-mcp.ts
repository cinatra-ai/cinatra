import "server-only";

// ---------------------------------------------------------------------------
// The schedule-proposal PRODUCER — `schedule_proposal_render` (cinatra#2569,
// epic #2564 S5). Design: design@6c20871b4108176c1d0193f19ecd2947f6c6355f
// `specs/app-lifecycle-cards.html` §VI.
//
// S1 registered `trigger_schedule_proposal` on the wire and deliberately left
// it UNMINTABLE — its `LIFECYCLE_PRODUCER_TOOLS` entry was an empty allowlist,
// "the correct fail-closed posture rather than a placeholder that accepts
// anything". This module is the tool that fills it, and it is the ONLY thing
// that can: the recognizer binds minting to the (cinatra self-MCP,
// `schedule_proposal_render`) tuple, so no connector, no external toolbox and
// no amount of "print this JSON" produces a schedule card.
//
// WHAT THE MODEL CAN AND CANNOT DO, precisely.
//
//   CAN: read a schedule out of what the user said, in the SELECTION vocabulary
//        the scheduling step uses, and show it as a card.
//   CANNOT: create a run, write a trigger row, arm a schedule, or cause any
//        server state to change. The tool's entire effect is a string.
//
// That is not a policy claim, it is the call graph: this handler mints a token
// and returns an envelope. `confirmTriggerScheduleProposal` — the only function
// that writes anything — is a server action reached from a browser session, and
// is not exposed as an MCP primitive on any surface.
//
// THE NAME AVOIDS EVERY DENIED VERB TOKEN, and that is deliberate rather than
// lucky. The delegated-chat policy denies `trigger`, `create`, `confirm` and
// `arm` as WHOLE TOKENS, precisely so the lifecycle-decision class stays
// unreachable by construction. `schedule_proposal_render` carries none of them
// and joins the two S3 `*_render` primitives on the read-only allowlist —
// naming it `agent_run_trigger_propose` would have required either widening
// that denylist or an override entry, both of which would weaken the very
// backstop that makes "the AI cannot arm a schedule" structural.
//
// GENERIC REFUSAL, ALWAYS. Every denial — no principal, a template out of
// reach, a schedule the form could not have produced, a past date, a missing
// signing key — returns the ONE fixed `LIFECYCLE_REFUSAL_RESULT` sentence. The
// result persists in `assistant_turns.content` and is re-fed to the model, so a
// refusal that named what was refused would be a durable enumeration oracle.
// This is the OPPOSITE rule from the Confirm path, whose refusals are
// deliberately specific — because there the audience is the human who pressed
// the button, not the model.
// ---------------------------------------------------------------------------

import { z } from "zod";
import type { McpRuntimeToolServer } from "@cinatra-ai/mcp-server";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";

import {
  LIFECYCLE_REFUSAL_RESULT,
  buildLifecycleViewEnvelope,
} from "@/lib/assistant-runtime/lifecycle-view-envelope";
// The PROPOSE LEAF, deliberately — not the full proposal service. This module
// is registered on the self-MCP server, which the app's auth plugins mount, so
// everything it can reach lands on five locked dev-perf route graphs. The
// confirm transaction and the install outbox are unreachable from a proposal
// and must stay unreachable from here; the route-graph ratchet measures it.
import { proposeTriggerSchedule } from "@cinatra-ai/agents/trigger-schedule-propose";

type McpToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
};

/**
 * THE STAGE A REFUSAL CAME FROM — the SERVER's record, never the reader's.
 *
 * The sentence stays generic (see the header: a refusal that named what was
 * refused would be a durable enumeration oracle in the transcript). What is new
 * is that the server can now tell its own cases apart. Before this, every one of
 * them produced one indistinguishable string on the wire AND no record at all,
 * so "which stage refuses this person's schedule" was unanswerable without
 * re-deriving it by hand — which is the whole reason cinatra#3052 had to be
 * measured before it could be fixed.
 *
 * It carries NO identifiers: not the person, not the org, not the agent, not the
 * schedule. A stage name is a fact about this build's own control flow, and
 * nothing in it is about any row.
 */
export type ScheduleProposalRefusalStage =
  | "no_request_context"
  | "a2a_frame"
  | "no_lifecycle_grant"
  | "no_identity"
  | "invalid_input"
  | "no_agent_named"
  | "two_agents_named"
  | "ref_refused"
  | "unknown_agent"
  | "cross_org"
  | "past_time"
  | "mint_failed"
  | "envelope_refused"
  | "threw";

/** The one prefix the record is written under, so it can be found by grep. */
export const SCHEDULE_PROPOSAL_REFUSAL_LOG_PREFIX = "[schedule-proposal] refused";

function refusal(stage: ScheduleProposalRefusalStage): McpToolResult {
  console.warn(`${SCHEDULE_PROPOSAL_REFUSAL_LOG_PREFIX} stage=${stage}`);
  return {
    content: [{ type: "text", text: LIFECYCLE_REFUSAL_RESULT }],
    structuredContent: { result: LIFECYCLE_REFUSAL_RESULT },
  };
}

/**
 * The tool's input — §VI's three option rows, in the builder's vocabulary.
 *
 * There is NO `cronExpression` field, by design: §VI states "There is no raw
 * cron field: the builder's selections are what the reader sees and confirms."
 * Accepting a cron would let the model propose a schedule the reader cannot see
 * expressed the way they would have built it, and would put a second
 * selections→cron translation in the system.
 */
const scheduleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("immediate") }).strict(),
  z
    .object({
      kind: z.literal("scheduled"),
      runAt: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/)
        .describe(
          "Local wall-clock date/time in `timezone`, e.g. '2026-07-14T09:00'. NOT UTC and NOT an ISO offset.",
        ),
      timezone: z.string().min(1).max(64).describe("IANA timezone, e.g. 'Europe/Berlin'."),
    })
    .strict(),
  z
    .object({
      kind: z.literal("recurring"),
      timezone: z.string().min(1).max(64).describe("IANA timezone, e.g. 'Europe/Berlin'."),
      selection: z
        .object({
          frequency: z.enum(["daily", "weekly", "monthly", "quarterly", "yearly"]),
          interval: z.number().int().min(1).max(52).describe("Repeat every N periods."),
          weekdays: z
            .array(z.number().int().min(0).max(6))
            .describe("For weekly: 0=Sunday … 6=Saturday. Weekdays Mon–Fri is [1,2,3,4,5]."),
          dayOfMonth: z.number().int().min(1).max(31),
          monthlyMode: z.enum(["date", "weekday"]),
          nthWeek: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
          monthlyWeekday: z.number().int().min(0).max(6),
          quarterAnchor: z.enum(["start", "end"]),
          yearlyMonth: z.number().int().min(1).max(12),
          hour: z.number().int().min(0).max(23),
          minute: z.number().int().min(0).max(59),
        })
        .strict(),
    })
    .strict(),
]);

/**
 * THE AGENT ARGUMENT, IN BOTH THE SHAPES A CONVERSATION HAS (cinatra#3052).
 *
 * `templateId` was the only one, and on the surface this defect was found on it
 * is a handle the assistant cannot hold: inside a third-party application the
 * closed widget toolbox exposes no primitive that returns a template id — the
 * one start it holds takes a package NAME and deliberately refuses ids, "a uuid
 * is not something a person names in a sentence". So the name the person said
 * arrived here as a name, the lookup missed, and they read the fixed refusal.
 *
 * EXACTLY ONE is required and both are optional at the schema level, because
 * the XOR is a decision this handler makes and records a stage for, not a shape
 * error: `agent_run` states the same rule for the same pair, and stating it the
 * same way keeps one contract in the model's head.
 */
const inputSchema = z
  .object({
    templateId: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe("The agent to schedule, by id. Use only when a prior tool result returned one."),
    packageName: z
      .string()
      .min(3)
      .max(214)
      .optional()
      .describe(
        "The agent to schedule, by its canonical scoped package name (it looks like '@cinatra-ai/<slug>'). Prefer this — it is the name the person says.",
      ),
    schedule: scheduleSchema,
  })
  .strict();

export const SCHEDULE_PROPOSAL_TOOL_NAME = "schedule_proposal_render";

/**
 * THE CARD IS THE WHOLE READING, AND THE MODEL IS TOLD SO (cinatra#3174 fix leg
 * 3).
 *
 * The second graded proof round measured a three-bullet schedule summary —
 * schedule, timezone, agent — drawn above the configured card, and failed four
 * checklist items per palette on it. Nothing in this tree composes that text:
 * the producer answers with an envelope, the platform's own start sentence is
 * one line, and the card draws no summary box of its own (its renderer is
 * asserted for exactly that). It is the assistant's own prose, and the one
 * place the product can rule it is the instruction this tool carries, which the
 * model reads on every turn that can draw this card.
 *
 * The rule is the drawing's own sentence: "No summary box is ever drawn, no
 * status label, and nothing stands between the reader and the form — the rows
 * are the reading."
 */
export const SCHEDULE_PROPOSAL_SAY_NOTHING_OVER_THE_CARD =
  "The card is the whole reading: after calling this, do NOT restate the schedule, the timezone, the agent or the recurrence in your reply, and draw no summary, list or status line above or below the card — the rows are the reading. One short sentence introducing the card is all a reply needs.";

export const SCHEDULE_PROPOSAL_TOOL_META = {
  description:
    "PROPOSE a schedule for an agent and show it in the conversation as its scheduling card. " +
    SCHEDULE_PROPOSAL_SAY_NOTHING_OVER_THE_CARD +
    " Name the agent the way the person did — pass `packageName` (the canonical scoped form looks like '@cinatra-ai/<slug>'), or `templateId` when a prior tool result returned one; pass exactly one. Creates NOTHING: no run, no schedule, no server record — the card asks the person to Confirm or Adjust, and only their Confirm arms anything. Use it whenever the person asks for an agent to run later or on a repeating schedule. Give the schedule the way the scheduling form expresses it (immediate / a local date-time / a recurrence), never as a cron expression. Answers a fixed 'not available to you' when the proposal cannot be made.",
  inputSchema,
} as const;

/**
 * Resolve the proposing principal from the MCP request CONTEXT — never from
 * tool input, and never from an A2A frame.
 *
 * A2A IS DELIBERATELY REFUSED. A proposal is a question put to a PERSON in a
 * conversation they are reading; an agent-to-agent frame has no such person and
 * no surface on which the card would be seen, so a proposal minted there could
 * only ever be confirmed by someone who never saw it.
 *
 * A WIDGET FRAME IS A PERSON, and is accepted (cinatra#2577, corrected
 * 2026-08-11) — the widget session is the user's own cinatra authentication and
 * the card is drawn in a conversation they are reading. It must still carry the
 * lifecycle GRANT: a widget session whose sign-in predates it holds none, and a
 * grantless frame gets the same fixed refusal every other denial produces. The
 * proposal itself remains a proposal on every surface: it writes nothing, and
 * only the person's own Confirm — a browser session action from the card, with
 * no transport-reachable primitive behind it — arms anything.
 */
function resolveProposer():
  | { ok: true; userId: string; orgId: string }
  | { ok: false; stage: ScheduleProposalRefusalStage } {
  const ctx = mcpRequestContextStorage.getStore();
  if (!ctx) return { ok: false, stage: "no_request_context" };
  if (ctx.a2aActorContext) return { ok: false, stage: "a2a_frame" };
  const delegated = ctx.delegatedActor;
  if (
    delegated?.delegation === "public_site_widget" &&
    delegated.lifecycleRead !== true
  ) {
    return { ok: false, stage: "no_lifecycle_grant" };
  }
  const userId = ctx.userId ?? null;
  const orgId = ctx.orgId ?? null;
  if (!userId || !orgId) return { ok: false, stage: "no_identity" };
  return { ok: true, userId, orgId };
}

export async function handleScheduleProposalRender(
  input: unknown,
): Promise<McpToolResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return refusal("invalid_input");
  const proposer = resolveProposer();
  if (!proposer.ok) return refusal(proposer.stage);

  try {
    const proposed = await proposeTriggerSchedule({
      // Whichever of the two the caller named — the XOR itself is the propose
      // leaf's rule, so this surface forwards and records rather than deciding
      // it a second time and drifting from the one that matters.
      ...(parsed.data.templateId === undefined
        ? {}
        : { templateId: parsed.data.templateId }),
      ...(parsed.data.packageName === undefined
        ? {}
        : { packageName: parsed.data.packageName }),
      userId: proposer.userId,
      orgId: proposer.orgId,
      schedule: parsed.data.schedule,
    });
    if (!proposed.ok) return refusal(proposed.reason);

    // The ref IS the proposal token — see the module header of
    // `trigger-schedule-proposal-token`. `buildLifecycleViewEnvelope` re-checks
    // the bound, so a token that would be clipped by the runtime's tool-result
    // cap refuses here rather than minting a card that points at nothing.
    const envelope = buildLifecycleViewEnvelope({
      viewType: "trigger_schedule_proposal",
      ref: proposed.token,
    });
    if (!envelope) return refusal("envelope_refused");
    return {
      content: [{ type: "text", text: envelope }],
      structuredContent: JSON.parse(envelope) as Record<string, unknown>,
    };
  } catch {
    // A store/transport failure must not become an existence signal either.
    return refusal("threw");
  }
}

export function registerScheduleProposalPrimitive(server: McpRuntimeToolServer): void {
  // The name is a STRING LITERAL here, not the constant above, and deliberately
  // so: `scripts/build-authz-inventory.mjs` discovers primitives by statically
  // matching `server.registerTool("<name>"` , so a constant would make this tool
  // INVISIBLE to the authz inventory — an MCP primitive with no recorded
  // resource/action classification, which is exactly what that generated file
  // exists to make impossible. The constant stays for typed consumers, and the
  // two are pinned equal by a test.
  server.registerTool(
    "schedule_proposal_render",
    { title: SCHEDULE_PROPOSAL_TOOL_NAME, ...SCHEDULE_PROPOSAL_TOOL_META },
    (async (input: unknown) => handleScheduleProposalRender(input)) as never,
  );
}

export function createScheduleProposalMcpModule() {
  return { registerCapabilities: registerScheduleProposalPrimitive };
}
