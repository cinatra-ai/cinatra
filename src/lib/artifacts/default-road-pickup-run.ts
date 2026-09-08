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
  type DefaultRoadTarget,
} from "./default-road-pickup";
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
    return await pickUpDefaultRoadOutputs(
      {
        ...input,
        declaredKindExtension: declaredKindExtensionOf(ctx.producesRefs),
      },
      {
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
      },
    );
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
