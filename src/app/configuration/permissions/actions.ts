"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { requireAdminSession } from "@/lib/auth-session";
import {
  isBuiltInCinatraAssistantUserId,
  isExtensionOwnedAssistantPrincipal,
  EXTENSION_OWNED_ASSISTANT_DELETE_MESSAGE,
} from "@/lib/assistant-users";

/** Result of a delete attempt — a typed object (not a thrown error) so a REFUSAL
 *  carries its directing message to the admin. A thrown Server Action error has
 *  its message replaced by a generic digest in production; RETURNING the message
 *  as data is the only way the guard text actually reaches the UI (cinatra#1880
 *  W5 AC#3) — the same catch-and-return pattern deleteAssistantAction uses. */
export type DeleteUserResult = { ok: true } | { ok: false; error: string };

export async function deleteUserAction(formData: FormData): Promise<DeleteUserResult> {
  const session = await requireAdminSession();
  const userId = formData.get("userId");
  if (typeof userId !== "string" || userId.trim().length === 0) {
    return { ok: false, error: "Missing userId." };
  }
  if (userId === session.user.id) {
    return { ok: false, error: "You cannot delete your own account from this table." };
  }
  // The built-in Cinatra assistant principal is registration-owned and
  // load-bearing (I3/I4 + host attribution): refuse deletion here too — this
  // Better-Auth removeUser path bypasses deleteAssistantUser's own guard
  // (cinatra#1037 P1.3/P1.4). Deleting it would strand @cinatra's handle +
  // template link until the next boot re-seed.
  if (await isBuiltInCinatraAssistantUserId(userId)) {
    return { ok: false, error: "The built-in Cinatra assistant cannot be deleted." };
  }
  // Extension-owned assistant principals are non-deletable from this surface too
  // (cinatra#1880 W5 AC#3) — their lifecycle is package install/archive only. The
  // Permissions removeUser path bypasses deleteAssistantUser's own guard, so the
  // same refusal is enforced here directly. Standalone principals are unaffected.
  if (await isExtensionOwnedAssistantPrincipal(userId)) {
    return { ok: false, error: EXTENSION_OWNED_ASSISTANT_DELETE_MESSAGE };
  }

  await auth.api.removeUser({
    headers: await headers(),
    body: { userId },
  });

  revalidatePath("/configuration/permissions");
  return { ok: true };
}
