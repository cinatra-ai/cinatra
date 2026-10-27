// THE PASSTHROUGH'S FIXED FAILURE TEXTS (cinatra#4223).
//
// The passthrough answers the flow runtime, and through it the run's own
// steps and their tool results. A thrown exception's message can name a
// schema, a table, a connection or a provider's own answer, so it never
// becomes the body of a failure. Two kinds of error are the caller's own
// refusal and keep their text, because the caller acts on it:
//
//   - a PrimitiveInvocationError: a primitive's stated refusal, written by the
//     primitive for its caller (for example "the type is not registered");
//   - a ZodError: the input did not parse against the primitive's schema; the
//     text names the caller's own fields.
//
// Every other throw is answered with one fixed sentence. Its detail is logged
// on the server, against the tool and the run, and nowhere else.
//
// Pure module apart from its one runtime import, so it is unit-testable in
// isolation, the same posture as the other passthrough seams.

import { PrimitiveInvocationError } from "@cinatra-ai/mcp-client";

/** The body of a tool call that stopped on an error outside the allow-list. */
export const PASSTHROUGH_UNEXPECTED_ERROR =
  "the tool call failed on an unexpected error; the detail is logged on the server";

/** The body of a call whose actor context could not be built. */
export const PASSTHROUGH_ACTOR_CONTEXT_ERROR =
  "failed to build actor context; the detail is logged on the server";

/**
 * A zod error, recognised by the trait zod writes on every error it builds.
 *
 * Not `instanceof ZodError`: zod 4 answers `instanceof` through its own
 * `Symbol.hasInstance`, which can take a shortcut through the class's `Error`
 * parent, and a second copy of zod in the module graph is a second class. The
 * trait set is what that check reads for a zod-built error, and only zod's
 * constructor writes it.
 */
export function isZodError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const traits = (err as { _zod?: { traits?: unknown } })._zod?.traits;
  return (
    traits instanceof Set &&
    (traits.has("ZodError") || traits.has("$ZodError")) &&
    Array.isArray((err as { issues?: unknown }).issues)
  );
}

/** True when the error's own text is a stated refusal for the caller. */
export function isCallerFacingError(err: unknown): err is Error {
  return err instanceof PrimitiveInvocationError || isZodError(err);
}

/**
 * The text a failure answers with: the caller-facing refusal's own message,
 * or the fixed sentence `fixed` with the detail logged on the server.
 */
export function passthroughFailureText(
  err: unknown,
  context: { tool: string; runId: string; stage: string },
  fixed: string = PASSTHROUGH_UNEXPECTED_ERROR,
): string {
  if (isCallerFacingError(err)) return err.message;
  console.error(
    `[agents-passthrough] ${context.stage} failed`,
    { tool: context.tool, runId: context.runId },
    err instanceof Error ? err.message : String(err),
  );
  return fixed;
}
