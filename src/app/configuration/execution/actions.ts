"use server";

// Execution-plane settings server action (exec-plane S1b activation,
// cinatra#2138 deliverable 5).

import { revalidatePath } from "next/cache";

import { requireAdminSession } from "@/lib/auth-session";
import {
  writeExecutionPlaneSettings,
  type ExecutionEgressMode,
  type ExecutionPlaneMode,
} from "@/lib/execution/execution-plane-settings";

export async function saveExecutionPlaneSettingsAction(formData: FormData): Promise<void> {
  await requireAdminSession();
  // `writeExecutionPlaneSettings` is the fail-closed choke point: it coerces the
  // vocabulary and REFUSES a mode this slice cannot honor (`remote`), so a
  // hand-crafted POST cannot persist a placement the boot phase would ignore.
  writeExecutionPlaneSettings({
    mode: String(formData.get("mode") ?? "") as ExecutionPlaneMode,
    egressMode: String(formData.get("egressMode") ?? "") as ExecutionEgressMode,
    egressAllowlist: String(formData.get("egressAllowlist") ?? ""),
  });
  revalidatePath("/configuration/execution");
}
