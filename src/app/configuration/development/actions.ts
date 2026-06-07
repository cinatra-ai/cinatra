"use server";

import { revalidatePath } from "next/cache";
import { requireAdminSession } from "@/lib/auth-session";
import { setMcpPublicBaseUrl } from "@cinatra-ai/mcp-server/credentials";

/**
 * Persist the workspace's public base URL. Pass an empty/null URL to clear it.
 * `getPublicMcpServerUrl()` reads the saved value on the next request, so the
 * change takes effect without a dev-server restart.
 */
export async function setMcpPublicBaseUrlAction(input: {
  url: string | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  await requireAdminSession();
  try {
    setMcpPublicBaseUrl(input.url);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  revalidatePath("/configuration/development");
  revalidatePath("/configuration/mcp");
  return { ok: true };
}
