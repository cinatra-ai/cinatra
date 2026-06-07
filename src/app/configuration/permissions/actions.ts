"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { requireAdminSession } from "@/lib/auth-session";

export async function deleteUserAction(formData: FormData) {
  const session = await requireAdminSession();
  const userId = formData.get("userId");
  if (typeof userId !== "string" || userId.trim().length === 0) {
    throw new Error("Missing userId.");
  }
  if (userId === session.user.id) {
    throw new Error("You cannot delete your own account from this table.");
  }

  await auth.api.removeUser({
    headers: await headers(),
    body: { userId },
  });

  revalidatePath("/configuration/permissions");
}
