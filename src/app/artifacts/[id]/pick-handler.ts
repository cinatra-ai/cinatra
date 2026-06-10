/**
 * MIME → detail-page handler selection for `/artifacts/[id]`.
 *
 * Extracted from `page.tsx` so the mapping is unit-testable without
 * mounting the server component (`__tests__/pick-handler.test.ts` pins
 * handler-selection parity with the preview route's allowlist).
 *
 * Detail-page handler selection MUST mirror the preview route's
 * allowlist so a MIME the page tries to render inline never lands on
 * a 415 from `/preview`. Types outside the allowlist (e.g. image/bmp,
 * video/quicktime, audio/midi) fall through to the fallback metadata
 * card instead of mounting a broken `<img>`/`<video>`/`<audio>`.
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
  if (mime === "text/markdown" || mime === "text/x-markdown") return "markdown";
  if (mime === "text/plain") return "text";
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("image/")) return "image";
  // The prefix checks run AFTER the allowlist gate, so they only ever
  // classify the exact allowlisted media MIMEs — no wildcard widening.
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "fallback";
}
