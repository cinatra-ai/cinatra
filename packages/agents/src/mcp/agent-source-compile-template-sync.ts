// The agent_source_compile DB write-back, extracted from mcp/handlers.ts as its
// own slice (cinatra#3208 file-size ratchet). One vertical concern: after a
// recompile has rewritten agent.json on disk, re-project the compiled result
// onto the agent_templates row so subsequent runs read the current source
// WITHOUT recompiling. The version-pairing rule the block encodes is the whole
// reason it is worth a file of its own, so it is documented once, here.
import { updateAgentTemplate, readAgentTemplateByPackageName } from "../store";
import { serializeArtifactBindingDeclaration } from "../artifact-binding";
import type { CompiledAgentOas } from "../oas-compiler";

/**
 * Sync packageVersion + compiled approvalPolicy + inputSchema + outputSchema
 * + prompt (as taskSpec) to the DB template so subsequent runs reflect the
 * current on-disk OAS Flow.
 *
 * VERSION-PAIRED COLUMNS. `hasArtifactBindings` (cinatra#2498) and
 * `artifactBindings` (cinatra#3208) are re-projected on every recompile — a
 * source edit that adds, removes or moves a binding must move both, or the
 * run-completion materializer resolves against a declaration the run did not
 * execute. Both ride THIS SAME update as `packageVersion`: two separate writes
 * left a window where a run reading mid-write saw the NEW package_version
 * paired with the OLD flag (or vice versa), defeating the version-pin guard
 * that trusts them exactly when read alongside their OWN package_version. One
 * UPDATE statement moves all three atomically.
 *
 * PAIRED, NEVER INDEPENDENT. Unlike every install path, `packageVersion` here
 * is OPTIONAL — a dev iterating on local source can recompile without bumping
 * the version string at all. `undefined` means "leave the column unchanged"
 * (the store patch convention), so an unpaired write would silently re-point
 * the two columns at whatever package_version the row ALREADY had, and a run
 * pinned to that untouched version would trust values never computed FOR it.
 * So with no version to confirm against, ALL THREE are omitted and the columns
 * keep exactly what the last version-paired write set.
 *
 * Best-effort by contract: the compile itself has already succeeded and
 * written the file, so a DB failure here is warned and swallowed, never
 * surfaced as a compile error.
 */
export async function syncCompiledTemplateToDb(
  agentPackageName: string,
  agentPackageVersion: string | null | undefined,
  compiled: CompiledAgentOas,
): Promise<void> {
  try {
    const template = await readAgentTemplateByPackageName(agentPackageName);
    if (!template) return;
    await updateAgentTemplate(template.id, {
      approvalPolicy: compiled.approvalPolicy as Parameters<typeof updateAgentTemplate>[1]["approvalPolicy"],
      inputSchema: compiled.inputSchema as Parameters<typeof updateAgentTemplate>[1]["inputSchema"],
      outputSchema: (compiled.outputSchema ?? undefined) as Parameters<typeof updateAgentTemplate>[1]["outputSchema"] | undefined,
      taskSpec: compiled.prompt ?? undefined,
      hitlScreens: compiled.hitlScreens,
      type: compiled.type,
      // Persist triggerMode + gatedSteps so the runtime gate and Trigger tab UI
      // can read them directly from agent_templates without recompiling.
      triggerMode: compiled.triggerMode,
      gatedSteps: compiled.gatedSteps,
      packageVersion: agentPackageVersion ?? undefined,
      hasArtifactBindings: agentPackageVersion ? compiled.hasArtifactBindings : undefined,
      artifactBindings: agentPackageVersion
        ? compiled.artifactBindings
          ? serializeArtifactBindingDeclaration(compiled.artifactBindings)
          : null
        : undefined,
    });
  } catch (versionSyncErr) {
    console.warn(`[agent_source_compile] DB sync failed:`, versionSyncErr);
  }
}
