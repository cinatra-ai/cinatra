// THE PASSTHROUGH'S FIXED FAILURE TEXTS (cinatra#4223).
//
// The passthrough answers the flow runtime, and through it the run's own
// steps and their tool results. A thrown exception's message can name a
// schema, a table, a connection or a provider's own answer, so it never
// becomes the body of a failure. Two kinds of error are the caller's own
// refusal, and the caller acts on their answer:
//
//   - a ZodError: the input did not parse against the primitive's schema. Its
//     answer is built from its issues only (each path and code, and for a type
//     error the expected type), never from its own message (cinatra#4465): the
//     marker that identifies a zod error can be written by any code, and a
//     wrapper can keep it with a message of its own. The marker is read first,
//     so an error that carries it is answered this way even when it is also a
//     PrimitiveInvocationError, whatever its `issues` holds. A marked error
//     whose `issues` is missing or not a list, or with no issue, or with an
//     issue or a list length it cannot read, is answered with the fixed
//     sentence below.
//   - a PrimitiveInvocationError without the zod marker: a primitive's stated
//     refusal, written by the primitive for its caller (for example "the type
//     is not registered"). It keeps its own text when that text is a string.
//
// Every other throw, and every refusal above that falls back to the fixed
// sentence, is answered with one fixed sentence. The server log records that
// sentence's stage, the tool, the run and a word for the error's class from a
// fixed list, never text taken from the error (src/lib/failure-log.ts). Only an
// answer of a refusal's own text, or of a text built from its issues, is not
// logged. Reading the error and writing the log can never throw out of this
// module or change the answer.
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

/** The first words of the answer to an input-schema error; its issues follow. */
export const PASSTHROUGH_SCHEMA_ERROR = "the input does not match the tool's input schema";

/**
 * True when the error carries the zod marker: an Error whose `_zod.traits` is a
 * Set holding "ZodError" or "$ZodError", whatever its `issues` holds. Any code
 * in the process can write it. callerFacingText reads it before the primitive
 * check, so a marked error never answers its own message, even when its
 * `issues` is missing or not a list.
 */
function hasZodMarker(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const traits = (err as { _zod?: { traits?: unknown } })._zod?.traits;
  return traits instanceof Set && (traits.has("ZodError") || traits.has("$ZodError"));
}

/**
 * A zod error, recognised by the trait zod writes on every error it builds
 * (hasZodMarker) and an `issues` list.
 *
 * Not `instanceof ZodError`: zod 4 answers `instanceof` through its own
 * `Symbol.hasInstance`, which can take a shortcut through the class's `Error`
 * parent, and a second copy of zod in the module graph is a second class. The
 * trait set is what that check reads for a zod-built error. It is not proof
 * that zod built the error: any code in the process can write the same set and
 * an `issues` array. So a zod error's answer never reads its message, only its
 * issues, and only in the fixed forms of `schemaErrorText`.
 */
export function isZodError(err: unknown): boolean {
  return hasZodMarker(err) && Array.isArray((err as { issues?: unknown }).issues);
}

/**
 * True when the error is of a kind the caller may be answered with: a zod
 * error (isZodError), or a primitive's stated refusal. Not proof that zod
 * built the error, and not proof of the answer: callerFacingText answers an
 * error with the zod marker from its issues, a primitive's refusal without the
 * marker with its own text, and gives the fixed sentence, logged, to a marked
 * error with no readable issue list (missing, not a list, empty or unreadable)
 * and to a refusal whose message is not a string.
 */
export function isCallerFacingError(err: unknown): err is Error {
  return err instanceof PrimitiveInvocationError || isZodError(err);
}

/** The issue codes zod 4 writes. Any other code reads as "invalid". */
const ZOD_ISSUE_CODES: ReadonlySet<string> = new Set([
  "invalid_type",
  "too_big",
  "too_small",
  "invalid_format",
  "not_multiple_of",
  "unrecognized_keys",
  "invalid_union",
  "invalid_key",
  "invalid_element",
  "invalid_value",
  "custom",
]);

/** The type words an invalid_type issue may name. Any other word is not shown. */
const ZOD_EXPECTED_TYPES: ReadonlySet<string> = new Set([
  "string",
  "number",
  "int",
  "bigint",
  "boolean",
  "symbol",
  "undefined",
  "null",
  "void",
  "never",
  "date",
  "object",
  "record",
  "array",
  "tuple",
  "map",
  "set",
  "file",
  "function",
  "promise",
  "nan",
]);

const MAX_ISSUES = 20;
const MAX_PATH_SEGMENTS = 16;
/** The largest length a JavaScript array can have. */
const MAX_ARRAY_LENGTH = 2 ** 32 - 1;
/** A path segment shown as a field name: letters, digits, `_`, `$` and `-`, 1 to 64 of them. */
const PATH_KEY = /^[A-Za-z0-9_$-]{1,64}$/;

/**
 * A list's length, read once, or null when it is not a non-negative safe
 * integer of at most MAX_ARRAY_LENGTH: a Proxy over an array passes
 * Array.isArray and can answer any value for `length`.
 */
function listLength(list: readonly unknown[]): number | null {
  const length: unknown = list.length;
  if (typeof length !== "number") return null;
  if (!Number.isSafeInteger(length)) return null;
  if (length < 0) return null;
  if (length > MAX_ARRAY_LENGTH) return null;
  return length;
}

/**
 * An issue's path as `a.b[0].c`: a non-negative safe integer as `[n]`, a key
 * of PATH_KEY's form as a name, any other segment as `[?]`, at most
 * MAX_PATH_SEGMENTS segments (then `[...]`); an empty path as `(input)`.
 * Null when the path is not a list or its length is not a list length
 * (listLength).
 */
function pathText(path: unknown): string | null {
  if (!Array.isArray(path)) return null;
  const length = listLength(path);
  if (length === null) return null;
  if (length === 0) return "(input)";
  let text = "";
  for (let i = 0; i < Math.min(length, MAX_PATH_SEGMENTS); i++) {
    const segment: unknown = path[i];
    if (typeof segment === "number" && Number.isSafeInteger(segment) && segment >= 0) {
      text += `[${segment}]`;
    } else if (typeof segment === "string" && PATH_KEY.test(segment)) {
      text += i === 0 ? segment : `.${segment}`;
    } else {
      text += "[?]";
    }
  }
  return length > MAX_PATH_SEGMENTS ? `${text}[...]` : text;
}

/** One issue as `<path>: <code>[, expected <type>]`, or null when it is not an object with a readable path list. */
function issueText(issue: unknown): string | null {
  if (typeof issue !== "object" || issue === null) return null;
  const fields = issue as { path?: unknown; code?: unknown; expected?: unknown };
  const path = pathText(fields.path);
  if (path === null) return null;
  const rawCode = fields.code;
  const code = typeof rawCode === "string" && ZOD_ISSUE_CODES.has(rawCode) ? rawCode : "invalid";
  const expected = fields.expected;
  const typeWord =
    code === "invalid_type" && typeof expected === "string" && ZOD_EXPECTED_TYPES.has(expected)
      ? `, expected ${expected}`
      : "";
  return `${path}: ${code}${typeWord}`;
}

/**
 * The answer to a zod error, built from its issues only: PASSTHROUGH_SCHEMA_ERROR,
 * then at most MAX_ISSUES issues joined by "; ", then the count of the rest.
 * Null (the fixed sentence answers) when there is no issue, when the list's
 * length is not a list length (listLength), or when an issue cannot be read;
 * every zod error the tests build from a failed parse carries at least one
 * issue. Never a throw.
 */
function schemaErrorText(err: unknown): string | null {
  try {
    const issues: unknown = (err as { issues?: unknown }).issues;
    if (!Array.isArray(issues)) return null;
    const count = listLength(issues);
    if (count === null || count === 0) return null;
    const parts: string[] = [];
    for (let i = 0; i < Math.min(count, MAX_ISSUES); i++) {
      const part = issueText(issues[i]);
      if (part === null) return null;
      parts.push(part);
    }
    if (count > MAX_ISSUES) parts.push(`and ${count - MAX_ISSUES} more`);
    return `${PASSTHROUGH_SCHEMA_ERROR}: ${parts.join("; ")}`;
  } catch {
    return null;
  }
}

/**
 * The caller-facing refusal's answer, or null: an error with the zod marker
 * (hasZodMarker, whatever its `issues` holds) gets its text built from its
 * issues, read first so that a primitive's refusal that also carries the
 * marker never answers its own message; a
 * primitive's refusal without the marker gets its own message when that
 * message is a string. Null (the fixed sentence answers, logged) for a marked
 * error with no readable issue and for a refusal whose message is not a
 * string. Never a throw.
 */
function callerFacingText(err: unknown): string | null {
  try {
    if (hasZodMarker(err)) return schemaErrorText(err);
    if (!(err instanceof PrimitiveInvocationError)) return null;
    const message: unknown = err.message;
    return typeof message === "string" ? message : null;
  } catch {
    return null;
  }
}

/**
 * The text a failure answers with: a zod error's text built from its issues,
 * a primitive's refusal's own message, or the fixed sentence `fixed`, with the
 * stage, the tool, the run and the error's class word logged on the server.
 * Only an answer from callerFacingText is not logged: its text is the caller's
 * own answer. A caller-facing error that callerFacingText cannot answer (a
 * marked error with no readable issue, a refusal whose message is not a
 * string) gets the fixed sentence and is logged.
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
