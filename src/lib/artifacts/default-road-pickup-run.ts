import "server-only";
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";
import { registerAllObjectTypes } from "@/lib/register-all-object-types";
import { resolveUploadArtifactType } from "./upload-artifact-type-map";
import { resolveBoundArtifactTarget } from "./resolve-bound-artifact-type";
import {
  loadRunDerivationContext,
  resolveRunScopeOwnership,
  writeClaimedArtifact,
} from "./run-artifact-materializer";
import {
  pickUpDefaultRoadOutputs,
  type DefaultRoadPickupOutcome,
  type DefaultRoadPickupDeps,
  type DefaultRoadTarget,
  type RunFileBinding,
} from "./default-road-pickup";
import {
  RunFolderRefusal,
  listRunOutputFiles,
  markRunFolderPickedUp,
  readRunOutputFile,
} from "./run-folder";
import { readAgentTemplateName } from "./run-artifact-titles";

// ---------------------------------------------------------------------------
// The DEFAULT ROAD's production wiring (cinatra#3029). The pure pickup lives in
// ./default-road-pickup; this module supplies its four host-sourced seams and
// NAMES NO PACK: the base for a form is read from the object-type registry
// through the UPLOAD's own exactly-one rule (`resolveUploadArtifactType`), and
// the extension the writer needs is the DEFINING package the registry already
// records for that type. Core never special-cases a package.
// ---------------------------------------------------------------------------

/**
 * Resolve one form to a write target, one rung of section 3's target ladder at
 * a time. `declaredKindExtension` non-null asks ONLY the agent's declared kind
 * (and returns null when it does not accept the form); null asks the form's
 * base by the upload's exactly-one rule.
 */
async function resolveDefaultRoadTarget(input: {
  orgId: string;
  mime: string;
  declaredKindExtension: string | null;
}): Promise<DefaultRoadTarget | null> {
  registerAllObjectTypes();
  let extension = input.declaredKindExtension;
  if (extension === null) {
    // The base extension for the form BY THE UPLOAD'S EXACTLY-ONE RULE: exactly
    // one installed required-base artifact type accepts the form, or nothing does.
    const resolved = resolveUploadArtifactType(input.mime);
    if (!resolved.ok) return null;
    const definer = objectTypeRegistry.getRegisteringPackage(resolved.objectTypeId);
    if (typeof definer !== "string" || definer.length === 0) return null;
    extension = definer;
  }
  const target = await resolveBoundArtifactTarget({
    orgId: input.orgId,
    extension,
    bindingObjectTypeId: undefined,
    producesObjectTypeId: undefined,
  });
  if (!target.ok) return null;
  // The declared kind only wins WHEN IT ACCEPTS THE FORM.
  if (!target.target.acceptedFileMimeTypes.includes(input.mime)) return null;
  return { extension, ...target.target };
}

/**
 * The agent's DECLARED KIND: the extension it declares when it declares exactly
 * one `produces` ref. Several declared kinds are no single declared kind, so the
 * road falls straight through to the form's base.
 */
export function declaredKindExtensionOf(
  producesRefs: ReadonlyArray<{ extension: string }>,
): string | null {
  const distinct = Array.from(new Set(producesRefs.map((r) => r.extension)));
  return distinct.length === 1 ? distinct[0] : null;
}

/**
 * THE ROAD'S PRODUCTION SEAMS, in one place (cinatra#3030). Exported so the
 * real-surface suite drives the pickup through the SAME target resolution, the
 * SAME write path, the SAME ownership derivation and the SAME run folder the
 * product uses — a test that substituted any of them would prove only that the
 * substitute agrees with itself.
 */
export function defaultRoadPickupDeps(scope: {
  orgId: string;
  runId: string;
}): DefaultRoadPickupDeps {
  return {
    resolveTarget: resolveDefaultRoadTarget,
    write: (w) =>
      writeClaimedArtifact({
        ...w,
        // ONE ledger row per item, carrying the ladder's deciding rung.
        detection: {
          rung: w.detection.rung,
          reason: w.detection.reason,
          confidence: w.detection.confidence,
          model: w.detection.model,
        },
      }),
    resolveOwnership: resolveRunScopeOwnership,
    readRunTitleParts: async (templateId) => ({
      agentName: await readAgentTemplateName(templateId),
    }),
    readRunFile: async ({ relPath }) => {
      try {
        const read = await readRunOutputFile({
          orgId: scope.orgId,
          runId: scope.runId,
          relPath,
        });
        return { ok: true, bytes: read.bytes };
      } catch (err) {
        if (err instanceof RunFolderRefusal) {
          return {
            ok: false,
            reason: err.reason === "not_found" ? "file_missing" : "file_refused",
            error: err.message,
          };
        }
        return {
          ok: false,
          reason: "file_refused",
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    markPickedUp: ({ files }) =>
      markRunFolderPickedUp({
        orgId: scope.orgId,
        runId: scope.runId,
        at: new Date(),
        files,
      }),
  };
}

/**
 * The retention tier's traffic-driven caller (cinatra#3030, item 0.21). The
 * pickup is the process that reads run folders, so it is also the process that
 * sweeps the ones whose grace period has run out. NEVER throws and never
 * affects the run: a folder that could not be deleted is swept on the next
 * pickup or at the next boot.
 */
async function sweepRunFoldersQuietly(): Promise<void> {
  try {
    const { sweepRunFolders } = await import("./run-folder-retention");
    const summary = await sweepRunFolders();
    if (summary.deleted > 0) {
      console.log(
        `[run-folder-retention] swept ${summary.deleted} run folder(s) past their grace period`,
      );
    }
  } catch (err) {
    console.warn(
      `[run-folder-retention] sweep failed (harmless; retried on the next pickup): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * The run package's FILE-sourced bindings (cinatra#3030, item 0.22), in the
 * shape the pure pickup reads. A binding whose content source is an OUTPUT is
 * not one of these — the materializer already resolved it.
 */
function fileBindingsOf(
  collected: ReadonlyArray<{
    nodeId: string;
    outputId: string;
    binding: {
      extension: string;
      objectTypeId?: string;
      declaredMime?: string;
      titleFromFirstLine?: boolean;
      fileFrom?: string;
      filePattern?: string;
    };
  }>,
): RunFileBinding[] {
  const out: RunFileBinding[] = [];
  for (const entry of collected) {
    const { fileFrom, filePattern } = entry.binding;
    if (fileFrom === undefined && filePattern === undefined) continue;
    out.push({
      outputId: entry.outputId,
      nodeId: entry.nodeId,
      extension: entry.binding.extension,
      objectTypeId: entry.binding.objectTypeId ?? null,
      declaredMime: entry.binding.declaredMime ?? null,
      titleFromFirstLine: entry.binding.titleFromFirstLine === true,
      ...(fileFrom === undefined ? {} : { fileFrom }),
      ...(filePattern === undefined ? {} : { filePattern }),
    });
  }
  return out;
}

/**
 * Run the default road for one terminally-successful run. NEVER throws — the
 * caller splices the outcomes into the run's own record and the run's verdict
 * is untouched (the #2486 materialization-honesty gate governs DECLARED
 * bindings only; an undeclared output the road could not file is not a broken
 * promise).
 */
export async function runDefaultRoadPickup(input: {
  runId: string;
  orgId: string;
  templateId: string;
  packageVersion: string | null;
  createdBy: string | null;
  endNodeOutputs: Record<string, unknown> | null;
  boundOutputIds: readonly string[];
}): Promise<DefaultRoadPickupOutcome[]> {
  try {
    const ctx = await loadRunDerivationContext({
      templateId: input.templateId,
      packageVersion: input.packageVersion,
    });
    // THE RUN FOLDER, listed where it lives (cinatra#3030, item 0.22). A
    // listing failure is a warning and never a run failure: the end-node half
    // of the road still runs, and a folder that could not be read is a fact on
    // the record rather than a lost run.
    let runFiles: Array<{ relPath: string; byteLength: number }> = [];
    try {
      runFiles = (await listRunOutputFiles({ orgId: input.orgId, runId: input.runId })).map(
        (file) => ({ relPath: file.relPath, byteLength: file.byteLength }),
      );
    } catch (err) {
      console.warn(
        `[default-road] run=${input.runId} could not list the run folder ` +
          `(the end-node outputs still take the road): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const outcomes = await pickUpDefaultRoadOutputs(
      {
        ...input,
        declaredKindExtension: declaredKindExtensionOf(ctx.producesRefs),
        runFiles,
        fileBindings: fileBindingsOf(ctx.bindings),
      },
      defaultRoadPickupDeps({ orgId: input.orgId, runId: input.runId }),
    );
    // The retention tier's traffic-driven pass — AFTER this run's own pickup
    // wrote its receipt, so this run's folder is measured against its own
    // grace period like every other.
    await sweepRunFoldersQuietly();
    return outcomes;
  } catch (err) {
    // The road is best-effort by contract: a failure to even START it is one
    // visible outcome, never a run failure.
    return [
      {
        ok: false,
        outputId: "(default-road)",
        ledgerOutputId: "(default-road)",
        rung: null,
        mime: null,
        extension: null,
        error: `the default road could not run: ${err instanceof Error ? err.message : String(err)}`,
        bytes: 0,
      },
    ];
  }
}
