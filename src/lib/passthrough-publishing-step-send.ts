import "server-only";
import type { PrimitiveInvocationRequest } from "@cinatra-ai/mcp-client";
import { triggerEmailSendPrimitiveMetadata } from "@cinatra-ai/trigger-email-send";

/**
 * THE CALL OF A DIRECT PASSTHROUGH PUBLISHING STEP (cinatra#3745).
 *
 * A flow's publishing step can be an ApiNode that calls a host send tool on the
 * deterministic passthrough road (`/api/agents/passthrough`), with no model in
 * between. Such a tool is declared by its owning package, in its own metadata
 * (`passthroughPublishingStep: true`); the road names no tool for it. The road
 * serves it only as that step's call, after the person released the step's
 * publish decision, and only once per decision:
 *
 *   - the route admits it only for a verified step with an executing-source
 *     proof whose released decision the call check claimed (publishCallAllowed);
 *   - right before the effect (after the handler read its arguments), the
 *     decision is used through the single-use consumption of the guarded
 *     outward run action (checkOutwardRunAction, then consumeRunActionDecision,
 *     cinatra#4827), with the host tool's owner identity;
 *   - the consumption binds the call to what the person reviewed: every argument
 *     of the call must be the value the released decision surfaced under the
 *     same name (callArgumentsReleased), compared under the decision row's lock.
 *
 * Every refusal is the consumption's own refusal class with a fixed code, which
 * the route answers with its fixed 403. A refusal uses nothing.
 */

/** The name of a primitive its package declares a publishing step's passthrough call, read from that metadata. */
function declaredName(tool: string): string | null {
  if (typeof tool !== "string" || tool === "") return null;
  const entries = (triggerEmailSendPrimitiveMetadata as ReadonlyArray<{ name: string; passthroughPublishingStep?: true }>)
    .filter((entry) => entry.name === tool);
  return entries.length === 1 && entries[0]!.passthroughPublishingStep === true ? entries[0]!.name : null;
}

/** True when the tool's owning package declares it servable as a released publishing step's passthrough call. */
export function declaresPublishingStepTool(tool: string): boolean {
  return declaredName(tool) !== null;
}

export type PublishingStepHandler = (request: PrimitiveInvocationRequest<unknown>) => Promise<unknown>;

/**
 * Use the person's released decision for this one call: the frame's step proof and the host owner are checked
 * (checkOutwardRunAction), then the decision is consumed once with the call's arguments bound to the values it
 * surfaced. `frame` is the route's run frame; `args` are the call's prepared arguments. Throws the refusal.
 */
export async function usePublishingStepDecision(frame: unknown, toolName: string, args: unknown): Promise<void> {
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
    arguments: args });
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
  const name = declaredName(tool);
  if (name === null) return null;
  const { createTriggerEmailSendHandlers } = await import("@cinatra-ai/trigger-email-send");
  const { createTriggerEmailSendUseCases } = await import("@/lib/trigger-email-send-use-cases");
  const useCases = createTriggerEmailSendUseCases() as unknown as Record<string, unknown>;
  // Every use case starts only after `beforeEffect` returned.
  const guarded = Object.fromEntries(Object.entries(useCases).map(([key, fn]) => [key, typeof fn !== "function" ? fn
    : async (...args: unknown[]) => { await beforeEffect(); return (fn as (...a: unknown[]) => unknown).apply(useCases, args); }]));
  const handlers = createTriggerEmailSendHandlers(guarded as unknown as Parameters<typeof createTriggerEmailSendHandlers>[0]);
  // The handler is found by the name the package's metadata carries, never by the caller's text as a property name.
  const handler = new Map<string, unknown>(Object.entries(handlers)).get(name);
  return typeof handler === "function" ? (handler as PublishingStepHandler) : null;
}
