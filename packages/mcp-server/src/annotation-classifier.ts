// Annotation classifier (cinatra#2017 S2 slice K3, design §3.4 / D5).
//
// Reads the MCP annotation hints a site advertises for a tool and derives an
// ADVISORY handling class (destructive > write > read). The class feeds the S5
// destructive-confirmation hook (invoker step 3) and the `tools_list`
// `derivedClass` field. It NEVER decides availability and can only ADD friction —
// site annotations can never LOOSEN handling (security-spine item #1). S5 extends
// this with cinatra's own known-destructive name set as an additive floor; S4
// consumes it ("advertised write/destructive never injected").
//
// CARRIER (S1-proven): `ability.meta.annotations → tool.annotations`. On a triad
// server the per-ability annotations exist ONLY via
// `get-ability-info.meta.annotations`; the classifier reads the INNER ability's
// annotations, NEVER the wire triad tool's (the `execute-ability`-is-destructive
// trap, §3.4 / S1 §C3). This module is pure over the already-extracted raw
// annotation object; extraction is the transport's job.
//
// COERCION: accepts both the standard MCP hint keys
// (`readOnlyHint`/`destructiveHint`/`idempotentHint`) and the WP-format keys
// (`readonly`/`destructive`/`idempotent`) the mcp-adapter emits; coerces valid
// string / numeric booleans (`"true"`, `"false"`, `1`, `0`) and DROPS
// uninterpretable values (unknown → unannotated → write-class).

/** The advisory handling class. Structurally identical to the SDK contract's
 *  `SiteToolDerivedClass` (kept local so mcp-server needs no value edge). */
export type AnnotationClass = "read" | "write" | "destructive";

/**
 * Coerce a loosely-typed annotation value to a boolean, or `undefined` when it
 * is uninterpretable (dropped). Accepts real booleans, the string forms
 * `"true"`/`"false"` (case-insensitive, trimmed), and the numerics `1`/`0`.
 */
export function coerceAnnotationBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return undefined;
  }
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true") return true;
    if (v === "false") return false;
    if (v === "1") return true;
    if (v === "0") return false;
    return undefined;
  }
  return undefined;
}

/**
 * Read a hint from the annotation object, preferring the standard MCP key and
 * falling back to the WP-format key. Returns the coerced boolean or `undefined`.
 */
function readHint(
  annotations: Record<string, unknown> | null | undefined,
  standardKey: string,
  wpKey: string,
): boolean | undefined {
  if (!annotations || typeof annotations !== "object") return undefined;
  const standard = coerceAnnotationBool(annotations[standardKey]);
  if (standard !== undefined) return standard;
  return coerceAnnotationBool(annotations[wpKey]);
}

/**
 * Classify a tool's raw annotations into an advisory handling class.
 *
 * Precedence (destructive > write > read):
 *   - `destructiveHint`/`destructive` truthy  → `destructive` (wins even when a
 *     contradictory `readOnlyHint:true` is also present — the safe reading);
 *   - else `readOnlyHint`/`readonly` truthy   → `read`;
 *   - else                                    → `write` (the DEFAULT — covers
 *     unannotated / unknown / uninterpretable; a mis-guess costs a governance
 *     hop, never an ungoverned mutation).
 */
export function classifyAnnotations(
  rawAnnotations: Record<string, unknown> | null | undefined,
): AnnotationClass {
  const destructive = readHint(rawAnnotations, "destructiveHint", "destructive");
  if (destructive === true) return "destructive";
  const readOnly = readHint(rawAnnotations, "readOnlyHint", "readonly");
  if (readOnly === true) return "read";
  return "write";
}
