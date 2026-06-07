"use server";

import { requireAuthSession } from "@/lib/auth-session";
import { readAgentRunById, updateAgentRunTitle, countRunsByTitle } from "./store";

export async function saveRunName(
  runId: string,
  name: string,
): Promise<{ ok: boolean }> {
  const session = await requireAuthSession().catch(() => null);
  const userId = session?.user?.id ?? null;
  if (!userId) return { ok: false };

  const run = await readAgentRunById(runId);
  if (!run) return { ok: false };

  // Ownership check
  if (run.runBy && run.runBy !== userId) return { ok: false };

  // Run name lives canonically on agent_runs.title.
  // Name edits are allowed at any stage of the run lifecycle.
  await updateAgentRunTitle(runId, name);

  return { ok: true };
}

// ---------------------------------------------------------------------------
// ensureOrCheckRunNameAction
//
// Called before the user approves the first HITL step (setup form).
//
// - If run.title is null/empty (user never edited the name): auto-generate a
//   unique name using MacOS-style numbering ("Base", "Base (1)", "Base (2)",
//   …), save it, and return { ok: true, name, nameChanged: true }.
//
// - If run.title is set (user edited it): check uniqueness within the same
//   template + user scope. If a duplicate exists return
//   { ok: false, existingName } so the caller can show an error and open the
//   name field for re-editing. If unique, return { ok: true, name, nameChanged: false }.
// ---------------------------------------------------------------------------

export async function ensureOrCheckRunNameAction(
  runId: string,
  baseName: string,
): Promise<
  | { ok: true; name: string; nameChanged: boolean }
  | { ok: false; existingName: string }
> {
  const session = await requireAuthSession().catch(() => null);
  const userId = session?.user?.id ?? null;
  if (!userId) return { ok: false, existingName: "" };

  const run = await readAgentRunById(runId);
  if (!run) return { ok: false, existingName: "" };
  if (run.runBy && run.runBy !== userId) return { ok: false, existingName: "" };

  const currentTitle = run.title?.trim() ?? "";

  if (!currentTitle) {
    // Not yet named — auto-generate a unique name.
    const uniqueName = await generateUniqueName(run.templateId, userId, baseName, runId);
    await updateAgentRunTitle(runId, uniqueName);
    return { ok: true, name: uniqueName, nameChanged: true };
  }

  // User set a title — verify it is unique within this template + user.
  const duplicateCount = await countRunsByTitle(run.templateId, userId, currentTitle, runId);
  if (duplicateCount > 0) {
    return { ok: false, existingName: currentTitle };
  }

  return { ok: true, name: currentTitle, nameChanged: false };
}

// Always numbered from (1): "Name (1)", "Name (2)", …
async function generateUniqueName(
  templateId: string,
  userId: string,
  baseName: string,
  excludeRunId: string,
): Promise<string> {
  for (let i = 1; i <= 999; i++) {
    const candidate = `${baseName} (${i})`;
    const count = await countRunsByTitle(templateId, userId, candidate, excludeRunId);
    if (count === 0) return candidate;
  }
  return `${baseName} (${Date.now()})`;
}
