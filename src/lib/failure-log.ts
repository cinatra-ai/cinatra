// A FAILURE LOG WITHOUT EXCEPTION TEXT THAT NEVER THROWS (cinatra#4223).
//
// A thrown value's message, or its string form, can carry a connection string,
// a credential, a table name or a provider's own answer. So can anything else
// the thrown value chooses for itself: its class name, its `code`, or what a
// proxy reports for them. A failure's server log therefore records a fixed
// sentence, the caller's own identifiers and one word from FAILURE_CLASSES,
// never any text taken from the thrown value.
//
// The word is chosen by identity: the first class of FAILURE_CLASSES the value
// is an instance of, else "other". The classes are the ones this code handles
// (the passthrough's caller-facing refusals) and the built-in error classes. No
// error code is logged: no code here defines or handles one, so the set of
// codes it may log is empty. A log line that cannot be written is dropped, so
// logging never changes the answer a caller gets.

import { PrimitiveInvocationError } from "@cinatra-ai/mcp-client";
import { ZodError } from "zod";

/**
 * The classes a failure's log line may name, in the order they are tried.
 * `ZodError` is zod's classic error class: zod answers `instanceof` for it by
 * the trait set zod writes on the errors it builds. (`ZodRealError` is not
 * used: its `instanceof` also answers true for every `Error`.)
 */
const FAILURE_CLASSES: ReadonlyArray<readonly [string, (err: unknown) => boolean]> = [
  ["ZodError", (err) => err instanceof ZodError],
  ["PrimitiveInvocationError", (err) => err instanceof PrimitiveInvocationError],
  ["TypeError", (err) => err instanceof TypeError],
  ["RangeError", (err) => err instanceof RangeError],
  ["SyntaxError", (err) => err instanceof SyntaxError],
  ["Error", (err) => err instanceof Error],
];

/** One word from FAILURE_CLASSES, or "other". Never text from the thrown value; never a throw. */
export function failureClass(err: unknown): { errorClass: string } {
  for (const [word, isInstance] of FAILURE_CLASSES) {
    try {
      if (isInstance(err)) return { errorClass: word };
    } catch {
      /* a proxy trap or a getter that throws is not that class */
    }
  }
  return { errorClass: "other" };
}

/**
 * Log a failure as `sentence`, the caller's `fields` and the error's class
 * word. Never text from the error, and never a throw.
 */
export function logFailure(sentence: string, fields: Record<string, string>, err: unknown): void {
  try {
    console.error(sentence, { ...fields, ...failureClass(err) });
  } catch {
    /* a log line that cannot be written is dropped; the answer never depends on it */
  }
}

/** Log a fixed `sentence` with the caller's `fields` only. Never a throw. */
export function logFixedLine(sentence: string, fields: Record<string, string>): void {
  try {
    console.error(sentence, { ...fields });
  } catch {
    /* dropped, as above */
  }
}
