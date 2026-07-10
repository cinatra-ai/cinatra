// ---------------------------------------------------------------------------
// citation_group — citations / source panel renderable (cinatra#1220, S4).
//
// Registers `/chat`'s citations / source-panel family as a first-class typed
// DATA_PART so a citation set can ride the one wire and any surface renders it.
// Each source `url` is sanitized to a safe scheme at parse time.
// ---------------------------------------------------------------------------

import { z } from "zod";

import type { RenderableViewBase } from "../renderable-views";
import { safeUrl } from "./safe-url";

export const CITATION_GROUP_SCHEMA_VERSION = 1 as const;

export const citationSourceSchema = z.object({
  title: z.string().min(1).max(500),
  url: z
    .string()
    .max(4_000)
    .optional()
    .transform((v) => safeUrl(v)),
  snippet: z.string().max(2_000).optional(),
});

export const citationGroupViewSchema = z.object({
  viewType: z.literal("citation_group"),
  schemaVersion: z.literal(CITATION_GROUP_SCHEMA_VERSION),
  label: z.string().max(200).optional(),
  sources: z.array(citationSourceSchema).min(1).max(100),
});

export type CitationGroupView = z.infer<typeof citationGroupViewSchema>;

type _AssertBase = CitationGroupView extends RenderableViewBase ? true : never;
const _assertBase: _AssertBase = true;
void _assertBase;

declare module "../renderable-views" {
  interface RenderableViewRegistry {
    citation_group: CitationGroupView;
  }
}
