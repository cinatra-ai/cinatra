"use server";

import { revalidatePath } from "next/cache";
import { requireAdminSession } from "@/lib/auth-session";
import {
  deleteAssistantUser,
  isBuiltInCinatraAssistantUserId,
} from "@/lib/assistant-users";
import { deleteAssistantProfile } from "@/lib/assistant-profiles";
import {
  renameAssistantHandleByPrincipal,
  replaceAssistantAudienceGrants,
  pauseAssistant,
  resumeAssistant,
  normalizeAssistantHandle,
  AssistantNamespaceCollisionError,
} from "@/lib/better-auth-db";
import { isFlatToken } from "@cinatra-ai/sdk-extensions/assistant-declaration";

// The manual "create assistant" action was DELETED (cinatra#1037 P1.4): assistant
// PRINCIPAL minting is now the exclusive job of assistant-agent registration
// (src/lib/assistant-agent-registration.ts, invariant I3). The actions here manage
// an already-registered principal's registry facets — its SINGLE resolving tag
// (the handle) + its audience + pause + lifecycle. EVERY action re-checks
// `requireAdminSession()` and `revalidatePath`s the surface.
//
// cinatra#1880 W5 rework (owner ruling 2026-07-23 (groganz)): the surface manages
// exactly ONE mutable tag per assistant — the RESOLVING tag (the handle) — with no
// locked/immutable tag and no per-package alias list; the built-in Cinatra tag is
// editable too. Collision protection is preserved (a tag can't steal another
// assistant's tag or handle — the handle rename is collision-checked against BOTH
// namespace tables). The audience becomes the shipped access picker. The
// delivery/endpoint config (webhook URL + secret + OAuth client rotation) no
// longer lives on this page.

const SURFACE = "/configuration/assistants";

/** Result of a mutating registry action — a typed object so the client can render
 *  the failure (a namespace collision, a validation error) as a TOAST. */
export type AssistantActionResult =
  | { ok: true }
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
  try {
    const next = await renameAssistantHandleByPrincipal(args.assistantUserId, norm.token);
    if (!next) {
      // No handle row to rename (a degenerate/partial registration with no
      // resolving tag). The UI does not offer the editor in that state; this is
      // the defensive server refusal.
      return { ok: false, error: "This assistant has no resolving tag to change." };
    }
  } catch (err) {
    if (err instanceof AssistantNamespaceCollisionError) return collisionResult(err);
    throw err;
  }
  revalidatePath(SURFACE);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Audience editor (AC#2) — now the shipped access picker. The client renders the
// canonical `AccessCombobox` (multiple mode) and submits the selected scope tokens
// as a SET; this action maps them to `assistant_audience` grants and ATOMICALLY
// replaces the package's grant set (`replaceAssistantAudienceGrants` — one
// transaction, validated fail-closed), so a multi-grant edit is all-or-nothing
// (never a partial / fail-open ACL state) and takes effect on the next
// authorization decision across every W2 surface through the ONE registry reader.
// The picker's Personal ("owner") token and a bare id-less `org` token have no
// audience representation (the audience vocabulary is the connector access scopes
// minus `user`) and are dropped — an all-`owner` selection maps to zero grants,
// i.e. visible to no one (fail-closed). A token that is neither a known scope nor
// one of those two intentional drops is REJECTED (never silently dropped — that
// would let a malformed payload wipe every valid grant).
// ---------------------------------------------------------------------------

type AudienceGrant = { subjectKind: string; subjectId: string | null };

function grantKey(g: AudienceGrant): string {
  return `${g.subjectKind}:${g.subjectId ?? ""}`;
}

/** Map access-picker scope tokens → audience grant tuples (deduped), or an error
 *  string. A scoped token (`org:`/`team:`/`project:`) with an empty/whitespace tail
 *  is a MALFORMED scope and is rejected — silently dropping it would map to an
 *  empty desired set and wipe every valid grant (codex rounds 1–2). `owner` and a
 *  bare id-less `org` are the only intentional drops. */
function tokensToAudienceGrants(
  tokens: readonly string[],
): { grants: AudienceGrant[] } | { error: string } {
  const out: AudienceGrant[] = [];
  const seen = new Set<string>();
  const push = (g: AudienceGrant) => {
    const k = grantKey(g);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(g);
    }
  };
  const scoped = (kind: string, prefix: string, t: string): { error: string } | null => {
    const id = t.slice(prefix.length).trim();
    if (!id) return { error: `Malformed access scope "${t}".` };
    push({ subjectKind: kind, subjectId: id });
    return null;
  };
  for (const t of tokens) {
    if (t === "workspace") push({ subjectKind: "workspace", subjectId: null });
    else if (t === "admin") push({ subjectKind: "admin", subjectId: null });
    else if (t.startsWith("org:")) {
      const err = scoped("organization", "org:", t);
      if (err) return err;
    } else if (t.startsWith("team:")) {
      const err = scoped("team", "team:", t);
      if (err) return err;
    } else if (t.startsWith("project:")) {
      const err = scoped("project", "project:", t);
      if (err) return err;
    } else if (t === "owner" || t === "org") {
      // Intentionally no audience grant (Personal / id-less org).
    } else {
      return { error: `Unrecognized access scope "${t}".` };
    }
  }
  return { grants: out };
}

export async function setAssistantAudienceAction(args: {
  packageName: string;
  tokens: string[];
}): Promise<AssistantActionResult> {
  await requireAdminSession();
  if (!args.packageName) {
    return { ok: false, error: "Only installed assistants have an editable audience." };
  }
  const mapped = tokensToAudienceGrants(args.tokens);
  if ("error" in mapped) return { ok: false, error: mapped.error };
  try {
    // ATOMIC all-or-nothing replace: on any failure the DB is left UNCHANGED (the
    // transaction rolls back), so there is never a partial / fail-open ACL state,
    // and the surface's persisted state still matches what it last read.
    await replaceAssistantAudienceGrants(args.packageName, mapped.grants);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not update access." };
  }
  revalidatePath(SURFACE);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Pause control — installation-wide, principal-keyed. The builtin is never paused.
// ---------------------------------------------------------------------------

export async function pauseAssistantAction(args: {
  assistantUserId: string;
}): Promise<AssistantActionResult> {
  const session = await requireAdminSession();
  if (!args.assistantUserId) return { ok: false, error: "assistantUserId required" };
  if (await isBuiltInCinatraAssistantUserId(args.assistantUserId)) {
    return { ok: false, error: "The built-in Cinatra assistant cannot be paused." };
  }
  await pauseAssistant(args.assistantUserId, session.user.id);
  revalidatePath(SURFACE);
  return { ok: true };
}

export async function resumeAssistantAction(args: {
  assistantUserId: string;
}): Promise<AssistantActionResult> {
  await requireAdminSession();
  if (!args.assistantUserId) return { ok: false, error: "assistantUserId required" };
  await resumeAssistant(args.assistantUserId);
  revalidatePath(SURFACE);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Lifecycle — delete (extension-owned refused, AC#3). Delivery/endpoint config
// (webhook + OAuth client rotation) is NOT managed on this page (owner ruling
// 2026-07-23 (groganz)).
// ---------------------------------------------------------------------------

export async function deleteAssistantAction(args: {
  id: string;
}): Promise<AssistantActionResult> {
  await requireAdminSession();
  if (!args.id) return { ok: false, error: "id required" };
  try {
    await deleteAssistantUser(args.id);
  } catch (err) {
    // Includes the builtin guard AND the extension-owned guard (AC#3 directing
    // message: "Uninstall the package to remove it.").
    return { ok: false, error: err instanceof Error ? err.message : "Could not delete the assistant." };
  }
  deleteAssistantProfile(args.id);
  revalidatePath(SURFACE);
  return { ok: true };
}
