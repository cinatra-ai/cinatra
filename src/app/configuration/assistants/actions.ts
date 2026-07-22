"use server";

import { revalidatePath } from "next/cache";
import { requireAdminSession } from "@/lib/auth-session";
import {
  deleteAssistantUser,
  rotateAssistantClient,
  isBuiltInCinatraAssistantUserId,
} from "@/lib/assistant-users";
import { upsertAssistantProfile, deleteAssistantProfile } from "@/lib/assistant-profiles";
import {
  claimAssistantAliasExclusive,
  removeAssistantAlias,
  renameAssistantAlias,
  addAssistantAudienceGrant,
  removeAssistantAudienceGrant,
  pauseAssistant,
  resumeAssistant,
  normalizeAssistantHandle,
  AssistantNamespaceCollisionError,
} from "@/lib/better-auth-db";
import { isFlatToken } from "@cinatra-ai/sdk-extensions/assistant-declaration";

// The manual "create assistant" action was DELETED (cinatra#1037 P1.4): assistant
// PRINCIPAL minting is now the exclusive job of assistant-agent registration
// (src/lib/assistant-agent-registration.ts, invariant I3). The actions here manage
// an already-registered principal's registry facets (aliases, audience, pause) plus
// its OAuth client + webhook + lifecycle. EVERY action re-checks
// `requireAdminSession()` and `revalidatePath`s the surface (cinatra#1880 W5).

const SURFACE = "/configuration/assistants";

/** Result of a mutating registry action — a typed object so the client can render
 *  an INLINE error (naming a namespace conflict) rather than a generic toast. */
export type AssistantActionResult =
  | { ok: true }
  | { ok: false; error: string; conflictWith?: { token: string; ownedBy: "handle" | "alias" } };

/** Normalize + validate a flat-token alias, returning the normalized token or an
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

function collisionResult(err: AssistantNamespaceCollisionError): AssistantActionResult {
  return {
    ok: false,
    error: `"${err.token}" is already claimed as a ${err.ownedBy}.`,
    conflictWith: { token: err.token, ownedBy: err.ownedBy },
  };
}

// ---------------------------------------------------------------------------
// Aliases (AC#1) — add / rename / remove through the W1 advisory-locked namespace.
// ---------------------------------------------------------------------------

export async function addAssistantAliasAction(args: {
  packageName: string;
  alias: string;
}): Promise<AssistantActionResult> {
  await requireAdminSession();
  if (!args.packageName) return { ok: false, error: "This assistant has no package to attach a tag to." };
  const norm = normalizeAliasToken(args.alias);
  if ("error" in norm) return { ok: false, error: norm.error };
  try {
    // Strict claim: a token owned by another package (or a handle, or the builtin)
    // is an INLINE CONFLICT (AC#1), never a silent steal.
    await claimAssistantAliasExclusive(norm.token, args.packageName);
  } catch (err) {
    if (err instanceof AssistantNamespaceCollisionError) return collisionResult(err);
    throw err;
  }
  revalidatePath(SURFACE);
  return { ok: true };
}

export async function renameAssistantAliasAction(args: {
  packageName: string;
  oldAlias: string;
  newAlias: string;
}): Promise<AssistantActionResult> {
  await requireAdminSession();
  if (!args.packageName) return { ok: false, error: "This assistant has no package to attach a tag to." };
  const norm = normalizeAliasToken(args.newAlias);
  if ("error" in norm) return { ok: false, error: norm.error };
  try {
    await renameAssistantAlias(args.oldAlias, norm.token, args.packageName);
  } catch (err) {
    if (err instanceof AssistantNamespaceCollisionError) return collisionResult(err);
    throw err;
  }
  revalidatePath(SURFACE);
  return { ok: true };
}

export async function removeAssistantAliasAction(args: {
  alias: string;
  source: string;
  packageName: string;
}): Promise<AssistantActionResult> {
  await requireAdminSession();
  if (args.source === "builtin") {
    return { ok: false, error: "The built-in cinatra tag is reserved and cannot be removed." };
  }
  // The removal is ALWAYS scoped to the owning package (cinatra#1880 W5). The
  // alias is the table PK, so an UNSCOPED delete-by-alias would drop whichever
  // package owns the token — a stale/crafted call for another assistant's tag.
  // Require the owning package and pass it through so one assistant's editor can
  // never remove another package's alias (defense-in-depth; the reserved builtin
  // is already refused above and is additionally protected by removeAssistantAlias).
  if (!args.packageName) {
    return { ok: false, error: "This tag has no owning package to scope the removal to." };
  }
  await removeAssistantAlias(args.alias, args.packageName);
  revalidatePath(SURFACE);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Audience editor (AC#2) — platform-admin only; each subject kind persisted.
// ---------------------------------------------------------------------------

export async function addAssistantAudienceAction(args: {
  packageName: string;
  subjectKind: string;
  subjectId?: string | null;
}): Promise<AssistantActionResult> {
  await requireAdminSession();
  if (!args.packageName) {
    return { ok: false, error: "Only installed assistants have an editable audience." };
  }
  try {
    await addAssistantAudienceGrant(args.packageName, args.subjectKind, args.subjectId ?? null);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not add the grant." };
  }
  revalidatePath(SURFACE);
  return { ok: true };
}

export async function removeAssistantAudienceAction(args: {
  packageName: string;
  subjectKind: string;
  subjectId?: string | null;
}): Promise<AssistantActionResult> {
  await requireAdminSession();
  if (!args.packageName) {
    return { ok: false, error: "Only installed assistants have an editable audience." };
  }
  try {
    await removeAssistantAudienceGrant(args.packageName, args.subjectKind, args.subjectId ?? null);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not remove the grant." };
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
// Lifecycle — delete (extension-owned refused, AC#3) / rotate / webhook.
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

export async function rotateAssistantClientAction(formData: FormData) {
  await requireAdminSession();
  const id = String(formData.get("id") ?? "");
  if (!id) throw new Error("id required");
  const result = await rotateAssistantClient(id);
  revalidatePath(SURFACE);
  return result;
}

export async function setAssistantWebhookAction(formData: FormData) {
  await requireAdminSession();
  const assistantUserId = String(formData.get("assistantUserId") ?? "");
  const webhookUrl = String(formData.get("webhookUrl") ?? "").trim() || undefined;
  const webhookSecret = String(formData.get("webhookSecret") ?? "").trim() || undefined;
  if (!assistantUserId) throw new Error("assistantUserId required");
  upsertAssistantProfile({
    assistantUserId,
    webhookUrl,
    webhookSecret,
    updatedAt: new Date().toISOString(),
  });
  revalidatePath(SURFACE);
}
