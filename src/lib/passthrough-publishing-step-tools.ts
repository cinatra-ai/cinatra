import "server-only";
import type { PrimitiveInvocationRequest } from "@cinatra-ai/mcp-client";
import { triggerEmailSendPrimitiveMetadata, createTriggerEmailSendHandlers } from "@cinatra-ai/trigger-email-send";

/**
 * THE PUBLISHING-STEP DECLARATION OF A PRIMITIVE (cinatra#3089).
 *
 * A primitive's owning package may declare, in its own metadata, that the
 * deterministic passthrough road (`/api/agents/passthrough`) serves it, and
 * only as the call of a declared publishing step: `passthroughPublishingStep:
 * true`. The road reads that declaration here; it names no package and no tool
 * itself. A declared primitive is served only when the calling step is a listed
 * publishing step of the run's compiled flow and its newest publish decision
 * reads `released` (`publishingStepCallReleased` in `@cinatra-ai/agents`).
 *
 * A source is one host-wired primitive package: its metadata and the factory of
 * its handlers. Only the boolean `true` declares; a name that no source
 * carries, or that more than one source carries, is not declared.
 *
 * The road performs a declared primitive's effect at most once per released
 * decision: the factory takes a `beforeEffect` step that runs after a handler
 * has read its arguments and before the package's use case starts. A step that
 * throws stops the call there, so a refused argument uses no decision and a
 * call whose decision is already used never reaches the effect.
 */

export type PassthroughPrimitiveMetadata = {
  readonly name: string;
  readonly passthroughPublishingStep?: boolean;
};

export type PassthroughPrimitiveHandler = (request: PrimitiveInvocationRequest<unknown>) => Promise<unknown>;

export type PassthroughPrimitiveSource = {
  readonly metadata: readonly PassthroughPrimitiveMetadata[];
  readonly loadHandlers: (beforeEffect: BeforeEffect) => Promise<Record<string, unknown>>;
};

/** Runs after a handler read its arguments and before the use case starts; a throw stops the call. */
export type BeforeEffect = () => Promise<void>;

const noStep: BeforeEffect = async () => {};

/** The use cases with `beforeEffect` run before each of their functions. */
export function withBeforeEffect<T extends object>(useCases: T, beforeEffect: BeforeEffect): T {
  const guarded: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(useCases)) {
    guarded[name] =
      typeof value === "function"
        ? async (...args: unknown[]) => {
            await beforeEffect();
            return (value as (...a: unknown[]) => unknown).apply(useCases, args);
          }
        : value;
  }
  return guarded as T;
}

const HOST_PRIMITIVE_SOURCES: readonly PassthroughPrimitiveSource[] = [
  {
    metadata: triggerEmailSendPrimitiveMetadata,
    // The use cases load the mail and object stores, so they are imported only
    // when a declared primitive of this source is called.
    loadHandlers: async (beforeEffect) => {
      const { createTriggerEmailSendUseCases } = await import("@/lib/trigger-email-send-use-cases");
      return createTriggerEmailSendHandlers(withBeforeEffect(createTriggerEmailSendUseCases(), beforeEffect));
    },
  },
];

type Declaration = { source: PassthroughPrimitiveSource; entry: PassthroughPrimitiveMetadata };

function declaringSource(
  tool: string,
  sources: readonly PassthroughPrimitiveSource[],
): Declaration | null {
  if (typeof tool !== "string" || tool === "") return null;
  let match: Declaration | null = null;
  for (const source of sources) {
    for (const entry of source.metadata) {
      if (entry.name !== tool) continue;
      if (match) return null;
      match = { source, entry };
    }
  }
  return match && match.entry.passthroughPublishingStep === true ? match : null;
}

/** True when exactly one host-wired package carries `tool` and declares it a publishing step's passthrough call. */
export function declaresPassthroughPublishingStep(
  tool: string,
  sources: readonly PassthroughPrimitiveSource[] = HOST_PRIMITIVE_SOURCES,
): boolean {
  return declaringSource(tool, sources) !== null;
}

/** The handler of a declared `tool` from its own source, or null (undeclared, or no function under the name). Its
 *  use case runs only after `beforeEffect` returns. */
export async function loadPassthroughPublishingStepHandler(
  tool: string,
  options: { beforeEffect?: BeforeEffect; sources?: readonly PassthroughPrimitiveSource[] } = {},
): Promise<PassthroughPrimitiveHandler | null> {
  const sources = options.sources ?? HOST_PRIMITIVE_SOURCES;
  const declaration = declaringSource(tool, sources);
  if (!declaration) return null;
  // The handler is found by the name the package's own metadata carries, read
  // from the package's own handler table as a map: the caller's text only
  // selects a declaration, it is never used as a property name.
  const handlers = new Map(Object.entries(await declaration.source.loadHandlers(options.beforeEffect ?? noStep)));
  const handler = handlers.get(declaration.entry.name);
  return typeof handler === "function" ? (handler as PassthroughPrimitiveHandler) : null;
}
