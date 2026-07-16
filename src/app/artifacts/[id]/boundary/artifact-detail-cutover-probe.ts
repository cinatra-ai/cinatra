/**
 * G2 cutover probe for the ARTIFACT-DETAIL dispatch surface (epic #1620 / #1624
 * S6). Binds the pure, system-neutral cutover matrix
 * (`@cinatra-ai/objects/artifact-ui-cutover-matrix`) to the REAL detail-page
 * precedence leaf (`pickArtifactRenderer`), so the M1/M2 artifact-surface waves
 * (S4 #1630, S7 #1631) get a ready-made probe: synthesize each matrix case's
 * resolved inputs, run the actual precedence leaf, and map its dispatch to a
 * system-neutral outcome. The `dispatch.kind` decides the SYSTEM, so a viewer
 * that resolved as a semantic renderer (or vice-versa) reads as `cross-applied`
 * and fails the matrix — the "never cross-applied" invariant, checked against
 * the real precedence.
 *
 * SCOPE (honest): this probe proves the PRECEDENCE contract at the pure leaf. The
 * registry → generated-map → resolution integration (registration, org-effective
 * selection, first-party fallback) is proven END-TO-END through the actual
 * `resolveArtifactDispatchInputs` seam + the real registries in the G3 golden
 * test's "real arbitration" section (and the S2 golden test); render-time
 * single-mount + failure isolation is proven by the S2 ExtensionRendererSlot
 * tests. Each wave SHOULD supply its own `observe` closure driving its real
 * dispatch for maximum fidelity; this leaf probe is the shared reference binding.
 *
 * Pure (the leaf is pure); no React/DB. A wave imports `evaluateArtifactDetailArmCutover`
 * and asserts `report.ready` before deleting its legacy arm.
 */
import type { EffectiveIdentity } from "@cinatra-ai/objects/effective-identity";
import {
  evaluateArmCutover,
  type CutoverCaseId,
  type CutoverObservation,
  type CutoverReport,
  type CutoverSystem,
} from "@cinatra-ai/objects/artifact-ui-cutover-matrix";

import { pickArtifactRenderer, type ArtifactRenderDispatch } from "../renderer-dispatch";
import type { HandlerKind } from "../pick-handler";

/** Map the detail-page dispatch to a system-neutral cutover outcome. `system`
 * decides which extension dispatch kind is "on-system": a viewer must resolve as
 * `representation`, a semantic renderer as `semantic`; the other reads as a
 * cross-applied leak. `modulesExecuted: 1` records the leaf's SINGLE-DISPATCH
 * invariant — the pure precedence leaf is total and returns exactly one dispatch
 * per row (no losing claimant, no double-mount); render-time single-mount is
 * separately enforced by the failure-isolated ExtensionRendererSlot (S2). */
function outcomeOf(dispatch: ArtifactRenderDispatch, system: CutoverSystem): CutoverObservation {
  switch (dispatch.kind) {
    case "representation":
      return { outcome: system === "representation-viewer" ? "extension" : "cross-applied", modulesExecuted: 1 };
    case "semantic":
      return { outcome: system === "semantic-renderer" ? "extension" : "cross-applied", modulesExecuted: 1 };
    case "requires-rebuild":
      return { outcome: "requires-rebuild", modulesExecuted: 1, detail: `slot=${dispatch.slot}` };
    case "mime":
      return { outcome: "first-party-floor", modulesExecuted: 1, detail: `handler=${dispatch.handler}` };
    case "fallback":
      return { outcome: "generic-floor", modulesExecuted: 1 };
    default: {
      const _exhaustive: never = dispatch;
      return _exhaustive;
    }
  }
}

const EXT = "@vendor/example-artifact";

/** A representation-viewer arm probe (a MIME with a first-party host default —
 * pdf/image/…). Drives `pickArtifactRenderer` for each matrix world-state. */
export function representationViewerProbe(arm: {
  mime: string;
  firstPartyHandler: Exclude<HandlerKind, "fallback">;
  packageName?: string;
  generatedKey?: string;
}): (caseId: CutoverCaseId) => CutoverObservation {
  const pkg = arm.packageName ?? EXT;
  const generatedKey = arm.generatedKey ?? `${pkg}::preview`;
  const floor: EffectiveIdentity = { kind: "default-artifact", selectable: true, assertionId: "probe" };
  const extProvider = (built: boolean): ArtifactRenderDispatch =>
    pickArtifactRenderer({
      identity: floor,
      semantic: null,
      representation: { tier: "extension", packageName: pkg, generatedKey, pattern: arm.mime, built },
    });
  const firstPartyOnly = (): ArtifactRenderDispatch =>
    pickArtifactRenderer({
      identity: floor,
      semantic: null,
      representation: { tier: "first-party", handler: arm.firstPartyHandler },
    });
  const bareFloor = (): ArtifactRenderDispatch =>
    pickArtifactRenderer({ identity: floor, semantic: null, representation: null });

  return (caseId) => {
    switch (caseId) {
      case "provider-registered":
      case "enabled-and-selected":
      case "selected-via-correct-registry":
      case "precedence":
      case "single-module-executes":
        return outcomeOf(extProvider(true), "representation-viewer");
      case "disabled":
      case "uninstalled":
        return outcomeOf(firstPartyOnly(), "representation-viewer");
      case "incompatible":
        return outcomeOf(extProvider(false), "representation-viewer");
      case "failing":
      case "floor-recovery":
        // Render-time failure is isolated by the ExtensionRendererSlot error
        // boundary (S2); the recovered state is the generic floor, which the
        // leaf yields when nothing resolves (the ?renderer=generic world-state).
        return outcomeOf(bareFloor(), "representation-viewer");
      default: {
        const _exhaustive: never = caseId;
        return _exhaustive;
      }
    }
  };
}

/** A semantic-renderer arm probe (an object-type id whose per-org winner ships a
 * `detail` renderer). */
export function semanticRendererProbe(arm: {
  objectTypeId: string;
  extension?: string;
  generatedKey?: string;
}): (caseId: CutoverCaseId) => CutoverObservation {
  const ext = arm.extension ?? EXT;
  const generatedKey = arm.generatedKey ?? `${ext}::detail`;
  const winner: EffectiveIdentity = {
    kind: "extension",
    extension: ext,
    basis: "binding",
    selectable: true,
    assertionId: "probe",
  };
  const floor: EffectiveIdentity = { kind: "default-artifact", selectable: true, assertionId: "probe" };
  const semantic = (built: boolean): ArtifactRenderDispatch =>
    pickArtifactRenderer({
      identity: winner,
      semantic: { packageName: ext, generatedKey, built },
      representation: null,
    });
  const noWinner = (): ArtifactRenderDispatch =>
    pickArtifactRenderer({ identity: floor, semantic: null, representation: null });

  return (caseId) => {
    switch (caseId) {
      case "provider-registered":
      case "enabled-and-selected":
      case "selected-via-correct-registry":
      case "precedence":
      case "single-module-executes":
        return outcomeOf(semantic(true), "semantic-renderer");
      case "disabled":
      case "uninstalled":
        return outcomeOf(noWinner(), "semantic-renderer");
      case "incompatible":
        return outcomeOf(semantic(false), "semantic-renderer");
      case "failing":
      case "floor-recovery":
        return outcomeOf(noWinner(), "semantic-renderer");
      default: {
        const _exhaustive: never = caseId;
        return _exhaustive;
      }
    }
  };
}

/** Convenience: evaluate an artifact-detail arm against the whole matrix. */
export function evaluateArtifactDetailArmCutover(
  arm:
    | { system: "representation-viewer"; mime: string; firstPartyHandler: Exclude<HandlerKind, "fallback">; packageName?: string; generatedKey?: string }
    | { system: "semantic-renderer"; objectTypeId: string; extension?: string; generatedKey?: string },
): CutoverReport {
  if (arm.system === "representation-viewer") {
    return evaluateArmCutover({ system: arm.system, arm: arm.mime, observe: representationViewerProbe(arm) });
  }
  return evaluateArmCutover({ system: arm.system, arm: arm.objectTypeId, observe: semanticRendererProbe(arm) });
}
