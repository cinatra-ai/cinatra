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
// Every other throw is answered with one fixed sentence. The server log records
// that sentence's stage, the tool, the run and a word for the error's class
// from a fixed list, never text taken from the error (src/lib/failure-log.ts).
// A caller-facing refusal answered with its own text is not logged. Reading the error and writing the
// log can never throw out of this module or change the answer.
//
// Pure module apart from its runtime imports, so it is unit-testable in
// isolation, the same posture as the other passthrough seams.

import { PrimitiveInvocationError } from "@cinatra-ai/mcp-client";
import { logFailure } from "@/lib/failure-log";

/** The body of a tool call that stopped on an error outside the allow-list. */
export const PASSTHROUGH_UNEXPECTED_ERROR =
  "the tool call failed on an unexpected error; the failure is logged on the server";

/** The body of a call whose actor context could not be built. */
export const PASSTHROUGH_ACTOR_CONTEXT_ERROR =
  "failed to build actor context; the failure is logged on the server";

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

/** The caller-facing refusal's own message, or null. Never a throw. */
function callerFacingText(err: unknown): string | null {
  try {
    if (!isCallerFacingError(err)) return null;
    const message: unknown = err.message;
    return typeof message === "string" ? message : null;
  } catch {
    return null;
  }
}

/**
 * The text a failure answers with: the caller-facing refusal's own message,
 * or the fixed sentence `fixed`, with the stage, the tool, the run and the
 * error's class word logged on the server. The caller-facing refusal is not
 * logged: its text is the caller's own answer.
 */
export function passthroughFailureText(
  err: unknown,
  context: { tool: string; runId: string; stage: string },
  fixed: string = PASSTHROUGH_UNEXPECTED_ERROR,
): string {
  const own = callerFacingText(err);
  if (own !== null) return own;
  return passthroughFixedFailureText(err, context, fixed);
}

/**
 * The fixed sentence `fixed` for every error, caller-facing or not: for a
 * stage whose failure is never the caller's own refusal (the actor context).
 */
export function passthroughFixedFailureText(
  err: unknown,
  context: { tool: string; runId: string; stage: string },
  fixed: string,
): string {
  logFailure(
    `[agents-passthrough] ${context.stage} failed; the error's own text is not logged`,
    { tool: context.tool, runId: context.runId },
    err,
  );
  return fixed;
}
