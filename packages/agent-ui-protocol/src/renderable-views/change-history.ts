// ---------------------------------------------------------------------------
// change_history — undo / change-history affordance renderable (cinatra#1220,
// S4).
//
// Registers `/chat`'s `UndoActionChip` / `recentUndoableChangeSetForRunAction`
// applied-change family as a first-class typed DATA_PART, reconciled with the
// change-diff family: a `content_change_proposal` is a PROPOSED edit; a
// `change_history` entry is an ALREADY-APPLIED changeset that may be undoable.
//
// SCOPE: display of the history + undoable flag only. Wiring an undo entry to an
// authoritative reversing write is the same surface-registered apply capability
// deferred with the no-reload apply half (#1214 / #1037 P4.1) — out of slice.
// ---------------------------------------------------------------------------

import { z } from "zod";

import type { RenderableViewBase } from "../renderable-views";

export const CHANGE_HISTORY_SCHEMA_VERSION = 1 as const;

export const changeHistoryEntrySchema = z.object({
  /** The run that produced the changeset (the chip's `runId`). */
  runId: z.string().min(1).max(200),
  label: z.string().min(1).max(500),
  undoable: z.boolean(),
  /** Identifier of the applied changeset, when the surface tracks one. */
  changeSetId: z.string().max(200).optional(),
  appliedAt: z.number().int().nonnegative().optional(),
});

export const changeHistoryViewSchema = z.object({
  viewType: z.literal("change_history"),
  schemaVersion: z.literal(CHANGE_HISTORY_SCHEMA_VERSION),
  entries: z.array(changeHistoryEntrySchema).min(1).max(200),
});

export type ChangeHistoryView = z.infer<typeof changeHistoryViewSchema>;

type _AssertBase = ChangeHistoryView extends RenderableViewBase ? true : never;
const _assertBase: _AssertBase = true;
void _assertBase;

declare module "../renderable-views" {
  interface RenderableViewRegistry {
    change_history: ChangeHistoryView;
  }
}
