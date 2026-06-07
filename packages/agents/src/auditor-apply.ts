// ---------------------------------------------------------------------------
// auditor-apply
//
// Pure deterministic transform that applies an RFC 6902 subset (replace, add,
// remove) of suggested patches against an input object. Kept side-effect free
// so unit tests stay pure and the function is reusable on the client (preview)
// and server (persist) without divergence.
//
// RFC 6901 path walker rejects any path segment matching __proto__ /
// constructor / prototype to prevent prototype pollution.
// ---------------------------------------------------------------------------

import { z } from "zod";

export const SuggestionPatchSchema = z.object({
  id: z.string(),
  fieldPath: z.string(),
  op: z.enum(["replace", "add", "remove"]),
  value: z.unknown().optional(),
  message: z.string().optional(),
});

export type SuggestionPatch = z.infer<typeof SuggestionPatchSchema>;

export class AuditorApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditorApplyError";
  }
}

const FORBIDDEN_SEGMENT = /^(__proto__|constructor|prototype)$/;

/**
 * Decode an RFC 6901 JSON Pointer reference token: ~1 → /, ~0 → ~.
 */
function decodeSegment(seg: string): string {
  return seg.replace(/~1/g, "/").replace(/~0/g, "~");
}

/**
 * Parse a JSON Pointer into segments. Empty string → []. "/" → [""].
 * Throws if any segment is a forbidden prototype-mutation key.
 */
function parsePointer(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) {
    throw new AuditorApplyError(
      `Invalid JSON Pointer (must start with "/" or be empty): ${pointer}`,
    );
  }
  const segments = pointer
    .slice(1)
    .split("/")
    .map(decodeSegment);
  for (const seg of segments) {
    if (FORBIDDEN_SEGMENT.test(seg)) {
      throw new AuditorApplyError(
        `Forbidden path segment in JSON Pointer: ${seg} (prototype-pollution guard)`,
      );
    }
  }
  return segments;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Mutates `root` in place because `applyAuditorPatches` already cloned the
 * input once and applies patches sequentially against that single clone —
 * cloning again per patch would be quadratic on large data documents.
 */
function applyOne(root: unknown, patch: SuggestionPatch): unknown {
  const segments = parsePointer(patch.fieldPath);

  if (segments.length === 0) {
    if (patch.op === "replace" || patch.op === "add") {
      return patch.value;
    }
    if (patch.op === "remove") {
      throw new AuditorApplyError("Cannot remove the document root");
    }
  }

  // Walk to parent.
  let parent: unknown = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    if (Array.isArray(parent)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= parent.length) {
        throw new AuditorApplyError(
          `Invalid array index in JSON Pointer: ${seg}`,
        );
      }
      parent = parent[idx];
    } else if (isObject(parent)) {
      parent = parent[seg];
    } else {
      throw new AuditorApplyError(
        `Cannot traverse non-object/array at segment "${seg}"`,
      );
    }
  }

  const last = segments[segments.length - 1]!;

  if (Array.isArray(parent)) {
    if (patch.op === "add") {
      if (last === "-") {
        parent.push(patch.value);
      } else {
        const idx = Number(last);
        if (!Number.isInteger(idx) || idx < 0 || idx > parent.length) {
          throw new AuditorApplyError(`Invalid array index for add: ${last}`);
        }
        parent.splice(idx, 0, patch.value);
      }
    } else if (patch.op === "replace") {
      const idx = Number(last);
      if (!Number.isInteger(idx) || idx < 0 || idx >= parent.length) {
        throw new AuditorApplyError(`Invalid array index for replace: ${last}`);
      }
      parent[idx] = patch.value;
    } else {
      // remove
      const idx = Number(last);
      if (!Number.isInteger(idx) || idx < 0 || idx >= parent.length) {
        throw new AuditorApplyError(`Invalid array index for remove: ${last}`);
      }
      parent.splice(idx, 1);
    }
    return root;
  }

  if (isObject(parent)) {
    if (patch.op === "add" || patch.op === "replace") {
      parent[last] = patch.value;
    } else {
      delete parent[last];
    }
    return root;
  }

  throw new AuditorApplyError(
    `Cannot apply ${patch.op} on non-object/array parent at "${last}"`,
  );
}

/**
 * Deterministic, pure: applies suggestions whose ids are in `acceptedIds`
 * (in the order they appear in `suggestions`) to a structuredClone of `input`.
 * Throws AuditorApplyError on bad paths or prototype-pollution attempts.
 */
export function applyAuditorPatches<T>(
  input: T,
  suggestions: SuggestionPatch[],
  acceptedIds: string[],
): T {
  const accepted = new Set(acceptedIds);
  let out: unknown = structuredClone(input);
  for (const s of suggestions) {
    if (!accepted.has(s.id)) continue;
    out = applyOne(out, s);
  }
  return out as T;
}
