/**
 * DOES A MID-RUN GATE'S CONTINUE STILL WAIT FOR ITS RENDERER? (cinatra#3380.)
 *
 * A mid-run gate's field renderer writes its answer into the surface's buffer
 * through `onChange`, and the surface's own Continue sends that buffer. A
 * renderer that offers a choice (a list the person picks one row of) writes
 * nothing until the person picks, and nothing is picked for them. A Continue
 * that is available before the pick resumes the run with no answer at all.
 *
 * THE DECLARATION IS THE GATE'S, IN THE SCHEMA'S OWN `x-` NAMESPACE. A gate
 * property whose schema carries `"x-required": true` is a value the gate's
 * renderer must produce before the Continue may send. This is the same hint the
 * setup road already writes on a required field's own schema and the schema
 * field renderer already reads (cinatra#3582); here it is read on the
 * properties of a mid-run gate's schema. Both input-schema roads copy `x-` keys
 * verbatim, so a pack declares it in its step's `inputMessageSchema` and no
 * other place has to change.
 *
 * The object-level `required` list is NOT read. Mid-run gates already declare
 * `required: ["decision"]` for an answer the Continue itself gives (the
 * approval), and their renderers write `userResponse`, never `decision`; a rule
 * over that list would leave those gates with a Continue that never comes back.
 *
 * The same reading of "nothing" as the setup road (`isBlankSubValue` in
 * schema-field-renderer.tsx, `isBlankSetupValue` in review-task-actions.ts):
 * absent, null, a string that trims to empty, or an empty list. `0` and `false`
 * are answers. A property that declares a `default` is answered by that default
 * (cinatra#3452) and holds nothing.
 *
 * Only what the RENDERER wrote counts — the buffer the Continue sends — never
 * the gate's own current values: those are what the run handed the screen, not
 * an answer the person gave on it.
 *
 * Generic by construction: it reads a schema and a buffer, never a renderer id
 * or an agent name. A gate that declares nothing is held by nothing.
 */

function isBlankRendererValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** The property keys a gate's schema declares its renderer must produce. */
export function gateRequiredRendererKeys(
  schema: Record<string, unknown> | null | undefined,
): string[] {
  if (!schema || typeof schema !== "object") return [];
  const properties = (schema as { properties?: unknown }).properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    return [];
  }
  const keys: string[] = [];
  for (const [key, declared] of Object.entries(properties as Record<string, unknown>)) {
    if (!declared || typeof declared !== "object" || Array.isArray(declared)) continue;
    const property = declared as Record<string, unknown>;
    if (property["x-required"] !== true) continue;
    if (Object.prototype.hasOwnProperty.call(property, "default")) continue;
    keys.push(key);
  }
  return keys;
}

/**
 * `true` while the gate declares a value its renderer must produce and the
 * renderer has not yet written one into `buffered`.
 */
export function gateAwaitsRendererValue(
  schema: Record<string, unknown> | null | undefined,
  buffered: Record<string, unknown> | null | undefined,
): boolean {
  const keys = gateRequiredRendererKeys(schema);
  if (keys.length === 0) return false;
  const written = buffered ?? {};
  return keys.some((key) =>
    isBlankRendererValue(
      Object.prototype.hasOwnProperty.call(written, key) ? written[key] : undefined,
    ),
  );
}
