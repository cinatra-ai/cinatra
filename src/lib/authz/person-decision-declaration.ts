/**
 * A primitive registration's declaration that its handler evaluates the
 * person's answered decision itself (cinatra#3745, criterion 5b).
 *
 * The host names no tool for this. The registration that owns a handler
 * declares it, at the place the handler enters the host's primitive registry,
 * in the same way a registration declares that its tool acts outward. The host
 * reads the declaration from the handler it actually executes, never from the
 * request or the tool name.
 *
 * FAIL-CLOSED: a handler that does not declare it is not person-decision
 * evaluating, and every unreadable value reads as not declared. The declaration
 * alone admits nothing: the deterministic passthrough reads it only for a
 * run-scoped tool that the host stamped with a verified submission, and every
 * other boundary ceiling still applies.
 */

const DECLARED_KEY = Symbol.for("@cinatra-ai/host:person-decision-evaluating-handlers/v1");
const holder = globalThis as unknown as { [DECLARED_KEY]?: WeakSet<object> };
const declaredHandlers = holder[DECLARED_KEY] ??= new WeakSet<object>();

/** Declares that this registered handler evaluates the person's answered
 * decision itself. Returns the same handler, so a registration wraps it in place. */
export function declarePersonDecisionEvaluation<T extends (...args: never[]) => unknown>(handler: T): T {
  declaredHandlers.add(handler);
  return handler;
}

/** True only for a handler whose registration declared it. */
export function registrationEvaluatesPersonDecision(handler: unknown): boolean {
  return typeof handler === "function" && declaredHandlers.has(handler);
}
