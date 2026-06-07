import { revalidatePath } from "next/cache";
import { requireAdminSession } from "@/lib/auth-session";
import {
  approveDynamicObjectType,
  archiveDynamicObjectType,
} from "../auto-registrar";

/**
 * Server action: transition a dynamic object type from `proposed` to `active`.
 * Admin-only. Revalidates the registry page on success.
 *
 * Per CLAUDE.md "Server Actions" rule: the `"use server"` directive lives
 * INSIDE the async function (not at file top).
 */
export async function approveDynamicObjectTypeAction(typeId: string): Promise<void> {
  "use server";
  await requireAdminSession();
  await approveDynamicObjectType(typeId);
  revalidatePath("/data/types");
}

/**
 * Server action: transition a dynamic object type to `archived`.
 * Admin-only. Revalidates the registry page on success. The DB row is preserved.
 */
export async function archiveDynamicObjectTypeAction(typeId: string): Promise<void> {
  "use server";
  await requireAdminSession();
  await archiveDynamicObjectType(typeId);
  revalidatePath("/data/types");
}
