"use server";

import { revalidatePath } from "next/cache";
import { requireAdminSession } from "@/lib/auth-session";
import {
  renameAssistantHandleByPrincipal,
  normalizeAssistantHandle,
  AssistantNamespaceCollisionError,
} from "@/lib/better-auth-db";
import { isFlatToken } from "@cinatra-ai/sdk-extensions/assistant-declaration";

// The manual "create assistant" action was DELETED (cinatra#1037 P1.4): assistant
// PRINCIPAL minting is now the exclusive job of assistant-agent registration
// (src/lib/assistant-agent-registration.ts, invariant I3). The action here manages
// an already-registered principal's SINGLE resolving tag (the handle). It re-checks
// `requireAdminSession()` and `revalidatePath`s the surface.
//
// cinatra#1880 W5 rework (owner rulings 2026-07-23 / 2026-07-24 (groganz)): the
// surface manages exactly ONE mutable tag per assistant — the RESOLVING tag (the
// handle) — as an ALWAYS-editable text field (a literal "@" is rendered OUTSIDE the
// field; the value carries no "@"), the built-in Cinatra tag included, with its
// Save/Reset controls always visible. Collision protection is preserved (a tag
// can't steal another assistant's tag or handle — the handle rename is
// collision-checked against BOTH namespace tables; a collision surfaces as an
// @-prefixed TOAST). Per the 2026-07-24 ruling the per-assistant access/audience
// control was REMOVED from this page (access is configured on the respective
// extension's own settings); the pause switch and the delete button were removed
// earlier — so the page-level audience/pause/resume/delete server actions are gone
// with the controls they backed. The audience SUBSTRATE
// (`replaceAssistantAudienceGrants` + the `assistant_audience` reads/tests), the
// pause substrate (core__0076 + the reader), and the deletion substrate are all
// untouched — only the page controls and their now-orphaned page actions are
// removed. The delivery/endpoint config never lived on this page.

const SURFACE = "/configuration/assistants";

/** Result of a mutating registry action — a typed object so the client can render
 *  the failure (a namespace collision, a validation error) as a TOAST. A tag
 *  rename echoes the persisted (normalized) token so the always-editable field can
 *  re-sync to exactly what the store now holds. */
export type AssistantActionResult =
  | { ok: true; tag?: string }
  | { ok: false; error: string; conflictWith?: { token: string; ownedBy: "handle" | "alias" } };

/** Normalize + validate a flat-token tag, returning the normalized token or an
 *  inline error result. */
function normalizeAliasToken(raw: string): { token: string } | { error: string } {
  const normalized = normalizeAssistantHandle(raw);
  if (!normalized || !isFlatToken(normalized)) {
    return {
      error: `"${raw}" is not a valid tag — use lowercase letters, digits, and single - or _ separators.`,
    };
  }
  return { token: normalized };
}

/** A namespace collision, rendered @-prefixed (the tag is always shown with its
 *  leading `@`) so the toast names the exact contested tag. */
function collisionResult(err: AssistantNamespaceCollisionError): AssistantActionResult {
  return {
    ok: false,
    error: `@${err.token} is already claimed as a ${err.ownedBy}.`,
    conflictWith: { token: err.token, ownedBy: err.ownedBy },
  };
}

// ---------------------------------------------------------------------------
// The SINGLE editable tag — the RESOLVING tag (the handle). One mutable tag per
// assistant, no locked tag, editable for EVERY assistant including the built-in
// Cinatra one (owner ruling 2026-07-23 (groganz)). The rename is routed through
// the W1 advisory-locked namespace primitive `renameAssistantHandleByPrincipal`,
// which is keyed by the STABLE principal id and collision-checks the desired token
// against BOTH the handle and the alias tables — so a tag can never steal another
// assistant's tag or handle. A collision surfaces as a TOAST.
// ---------------------------------------------------------------------------

export async function renameAssistantTagAction(args: {
  assistantUserId: string;
  tag: string;
}): Promise<AssistantActionResult> {
  await requireAdminSession();
  if (!args.assistantUserId) return { ok: false, error: "assistantUserId required" };
  const norm = normalizeAliasToken(args.tag);
  if ("error" in norm) return { ok: false, error: norm.error };
  let next: string | null;
  try {
    next = await renameAssistantHandleByPrincipal(args.assistantUserId, norm.token);
    if (!next) {
      // No handle row to rename (a degenerate/partial registration with no
      // resolving tag). The always-editable field still renders; this is the
      // defensive server refusal, surfaced as a toast.
      return { ok: false, error: "This assistant has no resolving tag to change." };
    }
  } catch (err) {
    if (err instanceof AssistantNamespaceCollisionError) return collisionResult(err);
    throw err;
  }
  revalidatePath(SURFACE);
  return { ok: true, tag: next };
}

// The per-assistant access/audience control (owner ruling 2026-07-24 (groganz)),
// the pause switch, and the delete button were REMOVED from this page — so their
// page-level server actions (`setAssistantAudienceAction`, pause/resume, delete)
// are gone with the controls they backed. The audience SUBSTRATE
// (`replaceAssistantAudienceGrants` + the `assistant_audience` reads in the
// admin/enforcement registries, with their tests), the pause SUBSTRATE (core__0076
// + `pauseAssistant`/`resumeAssistant`/`listPausedAssistantIds` in better-auth-db.ts,
// enforced fail-closed by the registry reader + its resolver tests), and the
// deletion SUBSTRATE (`deleteAssistantUser` + the extension-owned guard in
// assistant-users.ts, with its tests) are all untouched — only the page controls
// and their now-orphaned page actions are removed. Access for an installed
// assistant is configured on the respective extension's own settings surface.
