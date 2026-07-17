/**
 * MIME → detail-page FIRST-PARTY handler selection for `/artifacts/[id]`.
 *
 * Extracted from `page.tsx` so the mapping is unit-testable without
 * mounting the server component (`__tests__/pick-handler.test.ts`).
 *
 * G2 CUTOVER (epic #1620 M1 Slice B, cinatra#1630): the pdf / image / audio /
 * video detail arms MIGRATED into the system `-artifact` bases — those MIME
 * families now resolve to their build-bundled extension renderer through the
 * representation-provider registry (the boot registrar binds them for every
 * org), so `pickHandler` no longer selects a host handler for them. What remains
 * host-side is the core-owned never-blank FLOOR: escaped plain-text (STAY) and
 * markdown (DEFER — held core-side until a built-in claimant ships centrally-
 * specified sanitization). A MIME with no remaining host handler and no system
 * base returns `fallback` (the generic floor) — never a blank.
 *
 * The `HandlerKind` TYPE deliberately still enumerates the migrated media kinds:
 * it is the vocabulary of the pure dispatch leaf + the G2 cutover matrix probe
 * (which represents each cut arm's pre-migration first-party handler). Only the
 * runtime SELECTION here is narrowed.
 */
import { PREVIEW_INLINE_MIME_ALLOWLIST_FOR_TESTS } from "@/lib/artifacts/artifact-read";

export type HandlerKind =
  | "markdown"
  | "text"
  | "pdf"
  | "image"
  | "video"
  | "audio"
  | "fallback";

export function pickHandler(mime: string): HandlerKind {
  if (!PREVIEW_INLINE_MIME_ALLOWLIST_FOR_TESTS.has(mime)) return "fallback";
  // The floor the host still owns: markdown (DEFER) + escaped plain-text (STAY).
  if (mime === "text/markdown" || mime === "text/x-markdown") return "markdown";
  if (mime === "text/plain") return "text";
  // pdf / image / audio / video MIGRATED to the system `-artifact` bases (G2
  // cutover) — they resolve to the extension representation viewer, not a host
  // handler; an unmatched allowlisted MIME therefore falls to the generic floor.
  return "fallback";
}
