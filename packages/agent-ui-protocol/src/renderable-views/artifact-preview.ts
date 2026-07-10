// ---------------------------------------------------------------------------
// artifact_preview — file / artifact preview renderable (cinatra#1220, S4).
//
// Registers the "artifact / file preview" class from the epic inventory as a
// first-class typed DATA_PART so any assistant can emit a downloadable/openable
// artifact and every surface draws it identically. The `href` is sanitized to a
// safe scheme at the SCHEMA layer (see safe-url); a dropped href renders as an
// inert (non-link) row.
// ---------------------------------------------------------------------------

import { z } from "zod";

import type { RenderableViewBase } from "../renderable-views";
import { safeUrl } from "./safe-url";

export const ARTIFACT_PREVIEW_SCHEMA_VERSION = 1 as const;

export const artifactPreviewViewSchema = z.object({
  viewType: z.literal("artifact_preview"),
  schemaVersion: z.literal(ARTIFACT_PREVIEW_SCHEMA_VERSION),
  name: z.string().min(1).max(500),
  /** Coarse kind used to pick an icon/affordance. */
  kind: z
    .enum(["file", "image", "document", "archive", "other"])
    .optional(),
  mimeType: z.string().max(200).optional(),
  /** Sanitized at parse time to an allowlisted scheme; unsafe → undefined. */
  href: z
    .string()
    .max(4_000)
    .optional()
    .transform((v) => safeUrl(v)),
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  description: z.string().max(2_000).optional(),
});

export type ArtifactPreviewView = z.infer<typeof artifactPreviewViewSchema>;

type _AssertBase = ArtifactPreviewView extends RenderableViewBase ? true : never;
const _assertBase: _AssertBase = true;
void _assertBase;

declare module "../renderable-views" {
  interface RenderableViewRegistry {
    artifact_preview: ArtifactPreviewView;
  }
}
