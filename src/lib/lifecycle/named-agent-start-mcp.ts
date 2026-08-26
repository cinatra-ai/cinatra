// ---------------------------------------------------------------------------
// THE NAMED-AGENT START — one narrowly scoped self-MCP primitive
// (cinatra#2935, lifecycle-b W5d).
//
// From the plan (PLAN: Agents Lifecycle (B), section 4):
//
//   "The sentence-matcher that started an agent whenever it saw a verb next to
//    a package name | The conversation's assistant starts the agent itself, and
//    the run appears in the thread as its own card — inside a third-party
//    application too, where the widget's assistant starts it through an
//    authorized start of its own under the widget's credential minted fresh at
//    the call, so removing the matcher, today the widget's only way to start an
//    agent, loses nothing."
//
//   "Once the matcher is gone the widget keeps the capability the right way: its
//    assistant gets one narrowly scoped start, authorized afresh from the
//    widget's own credential at the call and fenced to the agents the signed-in
//    person may start — the same class of grant the lent control uses."
//
// WHO NEEDS IT, AND WHO DOES NOT. The chat page's assistant already reaches
// `agent_run` on the delegated-chat allowlist, and `agent_run` is the road every
// start takes underneath — so chat needs no second name and does not get one.
// The widget's allowlist is CLOSED and kind-keyed and deliberately does not hold
// `agent_run` (cinatra#2790 pins that). This primitive is the ONE narrowly
// scoped entry that widening costs: no `templateId`, no timeout, no polling
// surface — a package name and the inputs the person asked for.
//
// "THE SAME CLASS OF GRANT THE LENT CONTROL USES" IS THE CREDENTIAL, NOT A
// TICKET. What the plan says about the lent control on the widget is exactly
// what is built here: "In the site widget the authority to decide is built fresh
// from the widget's own credential at the moment of the call, never from the
// conversation's weaker runtime." So this handler resolves the acting person's
// LIVE standing at the call through `resolveBoundTurnActor` — the SAME one
// assembly the lent action uses — and starts the run as that person. It does NOT
// demand a per-message single-use grant, because there is no bound card and no
// control to name: the plan mints that grant "when a message is sent with a
// bound card", and inventing a second grant with nothing to name would be an
// authority nothing could honour.
//
// FIVE GATES, IN THIS ORDER, EVERY ONE FAIL-CLOSED:
//
//   1. A PLACEABLE FRAME. The acting person and organization come from the
//      request frame the transport verified — the widget's own OBO credential,
//      or a first-party chat frame — never from a tool argument, because an
//      argument is something a model can invent.
//   2. THE PERSON'S OWN CREDENTIAL, RESOLVED LIVE. Membership now, org role now,
//      teams now, project grants now, platform tier now. A membership revoked
//      between the send and the call is honoured. Never the delegated token's
//      hints, whose whole point is that they are weaker.
//   3. A NAMED AGENT. One package name, in the canonical scoped shape. No
//      template id: a uuid is not something a person names in a sentence, and
//      accepting one here would widen the widget onto rows it cannot see.
//   4. THE AGENT THE PERSON MAY START. `agent_run`'s own execute gate runs under
//      the credential from gate 2 — the install scope, the run access tiers, the
//      project binding. An agent the person may not start is REFUSED, and the
//      refusal is the platform's own, relayed word for word.
//   5. THE ONE ROAD. The start is `agent_run` invoked in process, so it reaches
//      `createAgentRunForLaunchFrame` → `launchAgentRun` exactly as every other
//      producer does. Nothing here creates a run; the creation fence stays whole
//      and the inventory test still enumerates one producer, not two.
//
// NEVER A SILENT NO-OP. Every refusal above answers in words the assistant
// relays. The plan's rule for the tool-less case is the same shape from the
// other side: a conversation whose model cannot use tools says so when asked to
// act, and this primitive is one of the things it cannot reach.
// ---------------------------------------------------------------------------

import "server-only";

import { z } from "zod";
import type { McpRuntimeToolServer } from "@cinatra-ai/mcp-server";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";
import {
  createInProcessPrimitiveTransport,
  invokePrimitive,
  type PrimitiveActorContext,
} from "@cinatra-ai/mcp-client";

import { RUN_START_REPLY_RULE } from "@cinatra-ai/agents/run-status";

import { resolveBoundTurnActor } from "@/lib/lifecycle/bound-turn-actor";

// THE START PATH IS IMPORTED LAZILY, AND THAT IS A MEASUREMENT, NOT A STYLE
// CHOICE — the same reason `lent-action-mcp.ts` defers its two decision paths.
// This module is registered on the MCP server, which is reachable from
// `/api/mcp`, `/api/a2a`, `/api/llm-bridge` and `/chat`, four routes carrying
// LOCKED first-party-graph budgets (the route-graph ratchet). The agent-builder
// handler bundle is large and runs only when a person actually starts an agent.
//
// THE SPECIFIER IS THE NARROW SUBPATH, NOT THE BARREL, and that is an
// authorization property rather than a taste one. An opaque
// `await import("@cinatra-ai/agents")` grants the WHOLE barrel, which puts this
// file on every org-write writer row the barrel re-exports
// (`createAgentRun` among them) — the org-write boundary gate's R4 rule, and it
// is right to say so: this module has no business naming a run creator. The
// handler subpath carries the primitive dispatch table and nothing else, so the
// only run creation it can reach is the one `agent_run` performs behind its own
// gates.
type CreateAgentBuilderPrimitiveHandlers = typeof import(
  "@cinatra-ai/agents/mcp-handlers"
)["createAgentBuilderPrimitiveHandlers"];

async function loadAgentBuilderHandlers(): Promise<CreateAgentBuilderPrimitiveHandlers> {
  const mod = await import("@cinatra-ai/agents/mcp-handlers");
  return mod.createAgentBuilderPrimitiveHandlers;
}

/** The primitive's name. Exported so the policy, the carve-out and the rule's
 *  own test name the same string rather than three literals that can drift. */
export const NAMED_AGENT_START_PRIMITIVE = "agent_named_start";

/**
 * THE NAME CARRIES `start` ON PURPOSE, and the token is on both delegated
 * policies' verb backstop as of this slice. So the primitive cannot reach EITHER
 * perimeter without an explicit, disclosed exception plus its typed `CarveOut`
 * twin — which is exactly the visibility this one widening is supposed to have.
 * A name chosen to slip past the backstop would have concealed the class the
 * primitive belongs to. Same doctrine as `lifecycle_bound_card_decide`
 * (cinatra#2932), and stated here so the two exceptions read alike.
 */

/**
 * The refusal when this turn cannot be placed on a person at all — no frame, no
 * attributable user, no organization, or no membership in it right now.
 *
 * ONE SENTENCE FOR EVERY CASE, deliberately indistinguishable: a caller learning
 * WHICH would learn about standing they do not hold. It is about the CALLER'S
 * OWN turn, so it discloses nothing about any row.
 */
export const NAMED_AGENT_START_NO_AUTHORITY =
  "This conversation is not allowed to start an agent. Nothing was started.";

/** The refusal when the message named nothing that could be an agent package. */
export const NAMED_AGENT_START_NO_AGENT_NAMED =
  "No agent was named. Nothing was started.";

/**
 * The canonical scoped package shape, and the ONLY thing this primitive accepts.
 *
 * A `templateId` is deliberately not in the schema: a uuid is not something a
 * person names in a sentence, and every id-shaped argument a model can invent is
 * a row it might reach that the person never mentioned. The vendor scope is open
 * because the operator's own namespace is a legitimate scope (`agent_run`'s
 * resolver aliases it to the canonical one); the SHAPE is what is pinned.
 */
const PACKAGE_NAME_RE = /^@[a-z0-9][a-z0-9._-]*\/[a-z][a-z0-9._-]*$/;

const inputSchema = z
  .object({
    /** The agent the person named, as its canonical scoped package name. */
    packageName: z.string().min(3).max(214),
    /**
     * The inputs the person asked for, as a stringified JSON object — the same
     * argument shape `agent_run` takes, so nothing is re-invented here. ABSENT
     * becomes `{}` and the run's own setup screen asks for what it still needs,
     * which is the road a missing input already takes today. UNPARSEABLE is not
     * silently discarded (convergence round 1, finding 4): it is passed through
     * and `agent_run` answers its own "inputParams must be a valid JSON string.",
     * which this surface relays like every other refusal. Dropping a person's
     * typed inputs to make a call succeed would be the worse of the two
     * failures.
     */
    inputParams: z.string().max(20_000).optional(),
  })
  .strict();

/**
 * THE WORDS THIS DOOR GIVES THE MODEL.
 *
 * Its own half says what the door is for; the reply half is `RUN_START_REPLY_RULE`
 * — the platform's ONE rule, imported rather than re-typed, so this door and
 * `agent_run` cannot drift into telling two hosts two different things. That
 * drift is not hypothetical: it is what the final W5d captures caught.
 */
export const NAMED_AGENT_START_TOOL_DESCRIPTION =
  "Start the agent the person named, as that person, with their permissions. " +
  "Use it when the person asks to use, run, start or dispatch an agent and names its package " +
  "(the canonical scoped form looks like '@cinatra-ai/<slug>'). " +
  "Pass the inputs they gave you in `inputParams` as a stringified JSON object; leave it out when they gave none. " +
  "It starts at most one run. " +
  RUN_START_REPLY_RULE;

type McpToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
};

function say(payload: Record<string, unknown>): McpToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function refuse(message: string): McpToolResult {
  return say({ ok: false, message });
}

/** The acting person, as this module reads them off the request frame. */
type FramePerson = {
  readonly userId: string;
  readonly orgId: string;
  /** Is a person sitting in front of this turn? True for both hosts here. */
  readonly humanPresent: true;
};

/**
 * GATE 1 — a placeable frame.
 *
 * The identity is the FRAME's: the widget delegation's verified `cwu_` subject
 * and org, or the first-party chat frame's. A tool argument never contributes.
 *
 * AN EXPLICIT DELEGATION IS REQUIRED, not merely a placeable identity
 * (convergence round 1, finding 2). An earlier revision refused only a frame
 * whose delegation was explicitly something else, which admitted every frame
 * carrying NO delegated actor at all — a machine or service-account MCP caller
 * with a resolvable user and org — and then stamped it `launchOrigin: "chat"`,
 * telling the coordinator a person was watching when none was. That is the same
 * defect cinatra#2892 closed on the removed pre-router, and it belongs closed
 * here too: the two conversation delegations are named, and everything else —
 * an agent-run OBO frame, an A2A frame, an unplaceable one, a bare one — yields
 * null and the fixed refusal. "The assistant starts the agent the person named"
 * is a statement about a person, and a headless caller has none.
 */
export function readFramePerson(): FramePerson | null {
  const ctx = mcpRequestContextStorage.getStore();
  if (!ctx) return null;
  const delegation = ctx.delegatedActor?.delegation;
  if (delegation !== "chat" && delegation !== "public_site_widget") return null;
  const userId = ctx.userId ?? null;
  const orgId = ctx.orgId ?? null;
  if (!userId || !orgId) return null;
  return { userId, orgId, humanPresent: true };
}

/**
 * The primitive envelope the start is made with.
 *
 * IT CARRIES THE LIVE STANDING FROM GATE 2 AND NOTHING ELSE. Every axis the
 * run's execute gate reads — organization, org role, teams, project grants,
 * platform tier — comes from the resolution done at the call, never from the
 * delegated token's own hints, which are deliberately narrower than the person's
 * real standing and would silently deny them their own agent.
 *
 * `launchOrigin: "chat"` is a fact of THIS call frame, not a claim anyone made:
 * both hosts this primitive serves are a conversation with a person in front of
 * it. It is a CONSTANT here — no request field, no primitive input, and nothing
 * the model emits can influence it — and the coordinator still re-derives
 * presence from BOTH halves (a verified interactive surface AND a resolvable
 * human owner), so this is the truthful half rather than the whole answer.
 *
 * Exported so the database tier drives the REAL builder rather than a copy of
 * it: "under the person's own rights" is a property of this function, and a
 * fixture that rebuilt the envelope itself would prove only that it agrees with
 * itself.
 */
export function buildStartActorEnvelope(
  person: { readonly userId: string; readonly orgId: string },
  actorCtx: { readonly roleHints?: Record<string, unknown> | null },
): PrimitiveActorContext {
  const hints = (actorCtx.roleHints ?? {}) as {
    platformRole?: "platform_admin" | "member";
    orgRole?: "org_owner" | "org_admin" | "member";
    teamIds?: string[];
    projectIds?: string[];
    projectGrants?: unknown[];
  };
  return {
    actorType: "human",
    source: "mcp",
    userId: person.userId,
    orgId: person.orgId,
    platformRole: hints.platformRole,
    orgRole: hints.orgRole,
    teamIds: hints.teamIds ?? [],
    projectGrants: (hints.projectGrants ?? []) as never,
    projectIds: hints.projectIds ?? [],
    launchOrigin: "chat",
  } as PrimitiveActorContext;
}

/**
 * Start the agent the person named.
 *
 * Every early return is one of the two fixed sentences. The only place a richer
 * message appears is the platform's OWN answer, relayed verbatim once
 * `agent_run` has run — including its refusal for an agent the person may not
 * start, which is precisely the sentence the plan says must be relayed rather
 * than re-written.
 */
export async function handleNamedAgentStart(
  input: unknown,
  deps: {
    readonly readFrame?: typeof readFramePerson;
    readonly resolveActor?: typeof resolveBoundTurnActor;
    /**
     * The start itself. Non-generic on purpose: the answer is the primitive's
     * own shape and this module reads it defensively either way, so a generic
     * here would only push an unprovable cast onto every caller.
     */
    readonly invoke?: (
      actor: PrimitiveActorContext,
      args: { packageName: string; inputParams: string },
    ) => Promise<unknown>;
  } = {},
): Promise<McpToolResult> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return refuse(NAMED_AGENT_START_NO_AGENT_NAMED);

  // GATE 3 — a named agent, in the canonical shape. Checked before any store
  // read so a malformed name costs nothing and discloses nothing.
  const packageName = parsed.data.packageName.trim().toLowerCase();
  if (!PACKAGE_NAME_RE.test(packageName)) {
    return refuse(NAMED_AGENT_START_NO_AGENT_NAMED);
  }

  // GATE 1 — a placeable frame.
  const readFrame = deps.readFrame ?? readFramePerson;
  const person = readFrame();
  if (!person) return refuse(NAMED_AGENT_START_NO_AUTHORITY);

  // GATE 2 — the person's own credential, resolved LIVE at the call.
  const resolveActor = deps.resolveActor ?? resolveBoundTurnActor;
  const actorCtx = await resolveActor({ userId: person.userId, orgId: person.orgId });
  if (!actorCtx) return refuse(NAMED_AGENT_START_NO_AUTHORITY);

  const actor = buildStartActorEnvelope(person, actorCtx);

  // GATES 4 AND 5 — the agent the person may start, and the one road.
  //
  // `agent_run` owns both: it runs the runnable/readiness gates, the creation
  // preflight, `enforceRunAccess(execute)` and the project binding under the
  // envelope above, and then launches through the coordinator. Nothing is
  // re-implemented here and nothing is relaxed — this primitive is a narrower
  // DOOR onto that road, never a second one.
  const inputParams = parsed.data.inputParams ?? "{}";
  const invoke =
    deps.invoke ??
    (async (a: PrimitiveActorContext, args: { packageName: string; inputParams: string }) => {
      const createHandlers = await loadAgentBuilderHandlers();
      const transport = createInProcessPrimitiveTransport(createHandlers());
      return invokePrimitive<
        { packageName: string; inputParams: string },
        unknown
      >(transport, {
        primitiveName: "agent_run",
        input: args,
        actor: a,
        mode: "deterministic",
      });
    });

  let out: {
    runId?: string;
    status?: string;
    error?: string;
    code?: string;
    /** The platform's own report for the start, minted by `agent_run`. */
    message?: string;
  } | null;
  try {
    out = (await invoke(actor, { packageName, inputParams })) as typeof out;
  } catch {
    // A THROW IS NOT A SENTENCE. `agent_run` answers its refusals as data; a
    // throw is a transport or store failure, and this surface may not invent a
    // reason for one. The honest answer is that nothing started.
    return refuse(NAMED_AGENT_START_NO_AUTHORITY);
  }

  if (!out || typeof out !== "object" || !out.runId) {
    // THE PLATFORM'S OWN REFUSAL, RELAYED. "An agent you may not start" arrives
    // here as `agent_run`'s own `error` string — the same sentence the run page
    // gives — and it is passed through untouched. Never a silent no-op, and
    // never a sentence this module composed about somebody else's rule.
    const message = typeof out?.error === "string" && out.error.length > 0
      ? out.error
      : NAMED_AGENT_START_NO_AUTHORITY;
    return say({
      ok: false,
      message,
      ...(typeof out?.code === "string" ? { code: out.code } : {}),
    });
  }

  // THE DURABLE ANSWER. The conversation draws the run's card from this tool
  // result, and the card carries its own link to the run page. A path composed
  // from a run id does not exist, so no URL is put on this wire (cinatra#2729
  // defect 1) and the status is COPIED, never derived — a parked run must reach
  // the transcript as parked so the held-turn card contract can rebuild its
  // card after a reload.
  //
  // AND THE PLATFORM'S REPORT RIDES WITH IT (cinatra#2935, lifecycle-b W5d),
  // relayed exactly as `agent_run` minted it — the same treatment this surface
  // already gives a refusal, and for the same reason. Without a sentence in the
  // answer the assistant has nothing to say back and reads the envelope out
  // instead, which is what a reader inside a third-party application was shown.
  // NOTHING IS INVENTED: an answer that carries no report gets none put on it,
  // because a sentence composed here would be this surface's words about
  // somebody else's act rather than the platform's own.
  return say({
    ok: true,
    runId: out.runId,
    status: out.status ?? "queued",
    ...(typeof out.message === "string" && out.message.length > 0
      ? { message: out.message }
      : {}),
  });
}

export function registerNamedAgentStartPrimitive(server: McpRuntimeToolServer): void {
  // REGISTERED UNDER ITS LITERAL NAME, not the constant above, and that is not a
  // style choice: `scripts/build-authz-inventory.mjs` machine-scans
  // `server.registerTool("…")` string arguments to build the authz inventory,
  // and the structural rule tests read THAT inventory. A constant here would
  // keep this widening OUT of the machine-scanned record — the exact opposite of
  // naming the exception where it is enforced. The constant and this literal are
  // pinned equal by the policy test.
  server.registerTool(
    "agent_named_start",
    {
      title: NAMED_AGENT_START_PRIMITIVE,
      description: NAMED_AGENT_START_TOOL_DESCRIPTION,
      inputSchema,
    },
    (async (input: unknown) => handleNamedAgentStart(input)) as never,
  );
}

export function createNamedAgentStartMcpModule() {
  return { registerCapabilities: registerNamedAgentStartPrimitive };
}
