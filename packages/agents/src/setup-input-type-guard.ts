/**
 * Declared-type guard for setup inputs (cinatra#2484).
 *
 * The defect: an agent StartNode input declared `type: "object"` was satisfiable
 * by a bare string. The Setup form rendered it as one free-text field, the run
 * started with `inputParams.idea = "<a sentence>"`, and the step downstream got
 * a string where its contract required an object — failing far from the cause
 * (`titleFrom output "title" did not resolve to a non-empty string`).
 *
 * The renderer now makes that unsubmittable, but the renderer is only ONE entry
 * point. `inputParams` is also populated at run CREATION (the `agent_run` MCP
 * tool, chat extraction, the API) — and the setup loop's pending-field filter
 * tests key PRESENCE only, so a pre-supplied `{"idea": "bare text"}` skips the
 * gate entirely and dispatches. This module is the shared assertion both server
 * chokepoints call, so the invariant does not depend on which door the value
 * came through:
 *
 *   - `execution.ts` setup loop — before dispatch, over the whole inputParams.
 *   - `review-task-actions.ts` setup-resume — before the inputParams merge.
 *
 * PURITY CONTRACT: no React, no `"use client"`, no `server-only`, no DB or host
 * `@/` imports — it is imported from both a server action module and the
 * execution worker, and a shared leaf is what keeps those two from importing
 * each other. Mirrors the constraints documented in `hitl-gate-submit.ts` and
 * `agent-builder-ids.ts`.
 */

/** Human-readable JSON type, for the rejection message. */
export function describeJsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "string") return "a string";
  if (typeof value === "object") {
    const name = (value as object).constructor?.name;
    // Name the class so a rejected `Date` does not read as "an object".
    return name && name !== "Object" ? `a ${name}` : "an object";
  }
  return `a ${typeof value}`;
}

/**
 * A JSON OBJECT — not merely `typeof x === "object"` (codex round 1).
 *
 * `typeof`+`!Array.isArray` admits CLASS INSTANCES, and a class instance is not
 * interchangeable with a JSON object at the boundary this guard protects. A
 * `Date` is the concrete bypass: server-action deserialization revives real
 * `Date` instances, so `{idea: <Date>}` would clear a `typeof` check and then
 * `JSON.stringify` it to `"2026-08-07T…"` — landing a STRING in an
 * object-typed input, which is exactly the defect this guard exists to stop.
 * `Map`/`Set` are the same class of problem one step quieter: they stringify to
 * `{}`, silently emptying the input.
 *
 * Accepts only a plain object literal or a null-prototype object (what
 * `JSON.parse` and the DB's `jsonb` round-trip actually produce).
 */
function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

export type DeclaredProperties = Record<string, Record<string, unknown>>;

/**
 * Throw when a value violates its input's DECLARED `object` type.
 *
 * Deliberately narrow in TYPE: only `object`-typed inputs are checked, because
 * that is the class that silently degraded. A string input receiving a number
 * is left alone, so no existing agent's setup changes behaviour beyond the
 * defect being fixed. Undeclared keys are also left alone — the grouped
 * setup-resume path's own allowlist owns that check.
 *
 * Deliberately DEEP in shape: recursion follows declared sub-`properties`, so
 * `{details: {metadata: "bare text"}}` is caught when both are declared
 * objects. A one-level check would only move the hole down a level.
 *
 * `undefined` is ABSENCE, not a violation: a grouped form leaves an untouched
 * optional object field `undefined` and `JSON.stringify` drops the key on the
 * way to the merge. Requiredness is the setup loop's own concern — it re-emits
 * the gate for a still-missing required field — so rejecting absence here would
 * break every blank optional object input.
 *
 * @param errorPrefix prepended to the thrown message so each call site reads in
 *   its own terms ("Setup approval rejected" vs "Run cannot start").
 */
export function assertValuesMatchDeclaredObjectTypes(
  properties: DeclaredProperties,
  values: Record<string, unknown>,
  errorPrefix: string,
  path: string[] = [],
): void {
  for (const [key, value] of Object.entries(values)) {
    const declared = properties[key] as
      | { type?: string; properties?: DeclaredProperties }
      | undefined;
    if (declared?.type !== "object") continue;
    if (value === undefined) continue;
    const label = [...path, key].join(".");
    if (!isPlainJsonObject(value)) {
      throw new Error(
        `${errorPrefix}: input "${label}" is declared type "object" but received ` +
          `${describeJsonType(value)}. Submit a JSON object for this input.`,
      );
    }
    if (declared.properties && typeof declared.properties === "object") {
      assertValuesMatchDeclaredObjectTypes(
        declared.properties,
        value as Record<string, unknown>,
        errorPrefix,
        [...path, key],
      );
    }
  }
}
