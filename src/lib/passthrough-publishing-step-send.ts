import "server-only";
import type { PrimitiveInvocationRequest } from "@cinatra-ai/mcp-client";
import { triggerEmailSendPrimitiveMetadata } from "@cinatra-ai/trigger-email-send";

/**
 * THE CALL OF A DIRECT PASSTHROUGH PUBLISHING STEP (cinatra#3745).
 *
 * A flow's publishing step can be an ApiNode that calls a host send tool on the
 * deterministic passthrough road (`/api/agents/passthrough`), with no model in
 * between. Such a tool is declared by its owning package, in its own metadata
 * (`passthroughPublishingStep`, with its split of shown and routing arguments);
 * the road names no tool for it. The road
 * serves it only as that step's call, after the person released the step's
 * publish decision, and only once per decision:
 *
 *   - the route admits it only for a verified step with an executing-source
 *     proof whose released decision the call check claimed (publishCallAllowed);
 *   - right before the effect (after the handler read its arguments), the
 *     decision is used through the single-use consumption of the guarded
 *     outward run action (checkOutwardRunAction, then consumeRunActionDecision,
 *     cinatra#4827), with the host tool's owner identity;
 *   - before that, every input the send refuses up front is refused, so such a
 *     call uses no decision (initialSendInputsPresent);
 *   - the consumption binds the call to the decision of its own visit (the
 *     runtime's signed `s3` decision id, on the frame) and to what the person
 *     reviewed: a shown argument must be one its card displayed, a routing
 *     argument the value frozen with the decision (callArgumentsReleased),
 *     compared under the decision row's lock.
 *
 * Every refusal is the consumption's own refusal class with a fixed code, which
 * the route answers with its fixed 403. A refusal uses nothing.
 */

type ArgumentRoles = { readonly shown: readonly string[]; readonly routing: readonly string[] };

/** The primitive its package declares a publishing step's passthrough call, with its argument split, from that metadata. */
function declaredEntry(tool: string): { name: string; roles: ArgumentRoles } | null {
  if (typeof tool !== "string" || tool === "") return null;
  const entries = (triggerEmailSendPrimitiveMetadata as ReadonlyArray<{ name: string; passthroughPublishingStep?: ArgumentRoles }>)
    .filter((entry) => entry.name === tool);
  const roles = entries.length === 1 ? entries[0]!.passthroughPublishingStep : undefined;
  return roles && Array.isArray(roles.shown) && Array.isArray(roles.routing) ? { name: entries[0]!.name, roles } : null;
}

/** True when the tool's owning package declares it servable as a released publishing step's passthrough call. */
export function declaresPublishingStepTool(tool: string): boolean {
  return declaredEntry(tool) !== null;
}

export type PublishingStepHandler = (request: PrimitiveInvocationRequest<unknown>) => Promise<unknown>;

/**
 * Use the person's released decision for this one call: the frame's step proof and the host owner are checked
 * (checkOutwardRunAction), then the decision of the frame's verified visit is consumed once with the call's arguments
 * bound to it by the tool's declared split. `frame` is the route's run frame; `args` are the call's prepared
 * arguments. Throws the refusal.
 */
export async function usePublishingStepDecision(frame: unknown, toolName: string, args: unknown): Promise<void> {
  const entry = declaredEntry(toolName);
  if (entry === null) throw new Error("not a publishing-step tool");
  const { checkOutwardRunAction } = await import("@/lib/extension-host-context");
  const { consumeRunActionDecision } = await import("@cinatra-ai/agents/store");
  const { HOST_PRIMITIVE_OWNER_PACKAGE, HOST_PRIMITIVE_RELEASE_VERSION } = await import(
    "@cinatra-ai/mcp-server/capability-plan"
  );
  const checked = checkOutwardRunAction({ frame, toolName, subject: null,
    owner: { kind: "host", packageName: HOST_PRIMITIVE_OWNER_PACKAGE, version: HOST_PRIMITIVE_RELEASE_VERSION } });
  await consumeRunActionDecision({ orgId: checked.orgId, runId: checked.runId, authority: checked.authority,
    proof: checked.proof, action: checked.action, subject: null,
    ...(checked.publishDecisionId !== undefined ? { publishDecisionId: checked.publishDecisionId } : {}),
    arguments: { values: args, shown: entry.roles.shown, routing: entry.roles.routing } });
}

/**
 * The handler of a publishing-step tool, from its own package, whose effect starts only after `beforeEffect`
 * returned (it runs after the handler parsed its arguments, so a refused argument uses no decision). Null for any
 * other tool.
 */
export async function loadPublishingStepHandler(
  tool: string,
  beforeEffect: () => Promise<void>,
): Promise<PublishingStepHandler | null> {
  const name = declaredEntry(tool)?.name ?? null;
  if (name === null) return null;
  const { createTriggerEmailSendHandlers } = await import("@cinatra-ai/trigger-email-send");
  const { createTriggerEmailSendUseCases, initialSendInputsPresent, INITIAL_SEND_INPUT_REFUSAL } = await import(
    "@/lib/trigger-email-send-use-cases"
  );
  const useCases = createTriggerEmailSendUseCases() as unknown as Record<string, unknown>;
  // Every use case starts only after `beforeEffect` returned. An input the send refuses up front is refused first, so
  // it uses no decision (the handler's schema already refused a malformed campaign or reference).
  const guarded = Object.fromEntries(Object.entries(useCases).map(([key, fn]) => [key, typeof fn !== "function" ? fn
    : async (...args: unknown[]) => {
      if (key === "startInitialSend" && !initialSendInputsPresent((args[0] ?? {}) as Record<string, string | undefined>)) {
        throw new Error(INITIAL_SEND_INPUT_REFUSAL);
      }
      await beforeEffect();
      return (fn as (...a: unknown[]) => unknown).apply(useCases, args);
    }]));
  const handlers = createTriggerEmailSendHandlers(guarded as unknown as Parameters<typeof createTriggerEmailSendHandlers>[0]);
  // The handler is found by the name the package's metadata carries, never by the caller's text as a property name.
  const handler = new Map<string, unknown>(Object.entries(handlers)).get(name);
  return typeof handler === "function" ? (handler as PublishingStepHandler) : null;
}
