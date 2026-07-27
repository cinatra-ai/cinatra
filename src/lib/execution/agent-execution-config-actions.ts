"use server";

// Server actions for the per-agent execution-config surface (exec-plane S3
// slice B, cinatra#1708; epic #1705).
//
// Two things this action is deliberately strict about:
//
//  1. AUTHORITY is re-resolved server-side. The client cannot talk the surface
//     into writing a project-agent column for an agent whose environment is
//     owned by its package manifest — a packaged agent's recipe is reviewed in
//     its package (epic D8), and a hidden field claiming otherwise is refused.
//  2. The submission goes through the SAME fail-closed parser the trusted
//     builder hashes its recipe from. What this action accepts is exactly what
//     the builder can build; a malformed entry comes back with the parser's own
//     errors rather than being sanitized into something the author did not ask
//     for.
//
// Approving the change is the agent's ordinary config path: the write lands on
// the live template row and the NEXT immutable version snapshot captures it
// (`buildSnapshotFromTemplate`), so a pinned run keeps mounting the environment
// its own version declared.

import { revalidatePath } from "next/cache";

import {
  parseAgentExecutionConfigSubmission,
  readAgentTemplateByPackageName,
  writeAgentExecutionConfig,
  type AgentExecutionConfigSubmission,
} from "@cinatra-ai/agents";
import { requireAdminSession } from "@/lib/auth-session";
import { readManifestEnvironmentClaim } from "@/lib/execution/agent-execution-config-load";

export type SaveAgentExecutionConfigResult = { ok: true } | { ok: false; errors: string[] };

export async function saveAgentExecutionConfigAction(input: {
  packageName: string;
  submission: AgentExecutionConfigSubmission;
}): Promise<SaveAgentExecutionConfigResult> {
  await requireAdminSession();

  // The TARGET is derived server-side from the authorized package name — never
  // taken from the caller (codex round-1 finding b2). A client-supplied
  // template id would let an authorized-for-package-A request write package B's
  // row, including one whose environment its manifest owns.
  const template = await readAgentTemplateByPackageName(input.packageName);
  if (!template) {
    return {
      ok: false,
      errors: ["This agent no longer exists on this instance — nothing was saved."],
    };
  }

  const manifest = await readManifestEnvironmentClaim(input.packageName, {
    installedExtension: true,
  });
  if (manifest.readFailed) {
    return {
      ok: false,
      errors: [
        "This agent's package manifest could not be read, so its execution config " +
          "cannot be changed here. Reinstall or repair the package first.",
      ],
    };
  }
  if (manifest.environment != null) {
    return {
      ok: false,
      errors: [
        "This agent declares its environment in its package manifest " +
          "(cinatra.execution.environment). Change it there and publish a new " +
          "version — it cannot be overridden from this instance.",
      ],
    };
  }

  const parsed = parseAgentExecutionConfigSubmission(input.submission);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };

  const written = await writeAgentExecutionConfig(template.id, parsed.config);
  if (!written) {
    return {
      ok: false,
      errors: ["This agent no longer exists on this instance — nothing was saved."],
    };
  }
  revalidatePath(`/configuration/extensions/settings/agent/${input.packageName}`);
  return { ok: true };
}
