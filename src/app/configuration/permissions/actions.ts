"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { requireAdminSession } from "@/lib/auth-session";
import { isBuiltInCinatraAssistantUserId } from "@/lib/assistant-users";

export async function deleteUserAction(formData: FormData) {
  const session = await requireAdminSession();
  const userId = formData.get("userId");
  if (typeof userId !== "string" || userId.trim().length === 0) {
    throw new Error("Missing userId.");
  }
  if (userId === session.user.id) {
    throw new Error("You cannot delete your own account from this table.");
  }
  // The built-in Cinatra assistant principal is registration-owned and
  // load-bearing (I3/I4 + host attribution): refuse deletion here too — this
  // Better-Auth removeUser path bypasses deleteAssistantUser's own guard
  // (cinatra#1037 P1.3/P1.4). Deleting it would strand @cinatra's handle +
  // template link until the next boot re-seed.
  if (await isBuiltInCinatraAssistantUserId(userId)) {
    throw new Error("The built-in Cinatra assistant cannot be deleted.");
  }

  await auth.api.removeUser({
    headers: await headers(),
    body: { userId },
  });

  revalidatePath("/configuration/permissions");
}
