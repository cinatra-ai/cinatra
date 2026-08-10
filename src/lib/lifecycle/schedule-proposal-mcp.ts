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

function refusal(): McpToolResult {
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

const inputSchema = z
  .object({
    templateId: z.string().min(1).max(128).describe("The agent to schedule."),
    schedule: scheduleSchema,
  })
  .strict();

export const SCHEDULE_PROPOSAL_TOOL_NAME = "schedule_proposal_render";

export const SCHEDULE_PROPOSAL_TOOL_META = {
  description:
    "PROPOSE a schedule for an agent and show it in the conversation as its scheduling card. Creates NOTHING: no run, no schedule, no server record — the card asks the person to Confirm or Adjust, and only their Confirm arms anything. Use it whenever the person asks for an agent to run later or on a repeating schedule. Give the schedule the way the scheduling form expresses it (immediate / a local date-time / a recurrence), never as a cron expression. Answers a fixed 'not available to you' when the proposal cannot be made.",
  inputSchema,
} as const;

/**
 * Resolve the proposing principal from the MCP request CONTEXT — never from
 * tool input, and never from an A2A frame.
 *
 * A2A IS DELIBERATELY REFUSED. A proposal is a question put to a PERSON in a
 * conversation they are reading; an agent-to-agent frame has no such person and
 * no surface on which the card would be seen, so a proposal minted there could
 * only ever be confirmed by someone who never saw it. The same reasoning is why
 * §IX marks this card first-party only.
 */
function resolveProposer(): { userId: string; orgId: string } | null {
  const ctx = mcpRequestContextStorage.getStore();
  if (!ctx) return null;
  if (ctx.a2aActorContext) return null;
  const userId = ctx.userId ?? null;
  const orgId = ctx.orgId ?? null;
  if (!userId || !orgId) return null;
  return { userId, orgId };
}

export async function handleScheduleProposalRender(
  input: unknown,
): Promise<McpToolResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return refusal();
  const proposer = resolveProposer();
  if (!proposer) return refusal();

  try {
    const proposed = await proposeTriggerSchedule({
      templateId: parsed.data.templateId,
      userId: proposer.userId,
      orgId: proposer.orgId,
      schedule: parsed.data.schedule,
    });
    if (!proposed.ok) return refusal();

    // The ref IS the proposal token — see the module header of
    // `trigger-schedule-proposal-token`. `buildLifecycleViewEnvelope` re-checks
    // the bound, so a token that would be clipped by the runtime's tool-result
    // cap refuses here rather than minting a card that points at nothing.
    const envelope = buildLifecycleViewEnvelope({
      viewType: "trigger_schedule_proposal",
      ref: proposed.token,
    });
    if (!envelope) return refusal();
    return {
      content: [{ type: "text", text: envelope }],
      structuredContent: JSON.parse(envelope) as Record<string, unknown>,
    };
  } catch {
    // A store/transport failure must not become an existence signal either.
    return refusal();
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
