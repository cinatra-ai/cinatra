import "server-only";

import type { ComponentType } from "react";
import type { ArtifactUiSlot } from "@cinatra-ai/sdk-extensions/artifact-contract";

import {
  GENERATED_ARTIFACT_RENDERERS,
  type GeneratedArtifactRendererEntry,
} from "@/lib/generated/artifact-renderers";
import { isDegradedExtensionLoad } from "@/lib/extension-load-guard";
import type { ArtifactRendererProps } from "@/lib/artifacts/artifact-renderer-props";

// ---------------------------------------------------------------------------
// Failure-isolated loader for extension-shipped artifact renderers
// (cinatra#1629, epic #1620 S2, AC-4 pre-render half).
//
// The dispatch spine resolves a row to a KEY into GENERATED_ARTIFACT_RENDERERS.
// This module turns that key into either a mounted renderer component OR a
// deterministic degrade — the caller renders the GENERIC renderer + a SANITIZED
// diagnostic (package + slot + failure class ONLY; the detailed error is
// telemetry). The taxonomy of PRE-RENDER failures:
//   - not-built        — the key is absent from this build (never built). The
//                        dispatch already routes this to requires-rebuild; this
//                        is the defensive belt if a caller loads a stale key.
//   - absent           — the guarded loader resolved the standardized degraded
//                        result (a post-build marketplace uninstall removed the
//                        module). Renders generic + "requires rebuild".
//   - invalid-export   — the module loaded but exports no component default.
//   - abi-incompatible — the build entry's propsApiVersion ≠ the host snapshot's.
//   - quarantined      — the key crossed the repeat-failure threshold; the host
//                        stops loading it and renders generic until restart.
// A PRESENT-but-BROKEN module (a top-level throw) is NOT degraded here — it
// RETHROWS (the guardedExtensionImport fail-loud contract), so it surfaces to
// the route-segment error boundary (AC-4 render-time half). Its failure is
// still counted toward quarantine so a persistently-throwing renderer eventually
// stops throwing and renders generic.
// ---------------------------------------------------------------------------

export type ArtifactRendererFailureClass =
  | "not-built"
  | "absent"
  | "invalid-export"
  | "abi-incompatible"
  | "quarantined";

export type ArtifactRendererLoadResult =
  | { ok: true; Component: ComponentType<ArtifactRendererProps>; entry: GeneratedArtifactRendererEntry }
  | { ok: false; failureClass: ArtifactRendererFailureClass };

/** A renderer key is quarantined after this many pre-render/load failures. */
export const ARTIFACT_RENDERER_QUARANTINE_THRESHOLD = 3;

// Process-local quarantine counter (Symbol.for so it survives duplicated module
// instances across Next.js bundler compilations — same anchor discipline as the
// object-type registry). Process-local + best-effort BY DESIGN: a stale worker
// that never saw the failures simply renders the renderer (or its own floor) —
// the floor is the safety net, not this counter (AC-3 teardown note).
const QUARANTINE_KEY = Symbol.for("@cinatra-ai/host:artifact-renderer-quarantine/v1");
type QuarantineHolder = { [QUARANTINE_KEY]?: Map<string, number> };
const quarantineHolder = globalThis as unknown as QuarantineHolder;
function quarantineCounts(): Map<string, number> {
  return (quarantineHolder[QUARANTINE_KEY] ??= new Map<string, number>());
}

export function isArtifactRendererQuarantined(generatedKey: string): boolean {
  return (quarantineCounts().get(generatedKey) ?? 0) >= ARTIFACT_RENDERER_QUARANTINE_THRESHOLD;
}

function recordRendererFailure(generatedKey: string): void {
  const counts = quarantineCounts();
  counts.set(generatedKey, (counts.get(generatedKey) ?? 0) + 1);
}

/** @internal test-only reset. */
export function _resetArtifactRendererQuarantineForTests(): void {
  quarantineCounts().clear();
}

/** A sanitized, telemetry-safe diagnostic string for a degrade — package + slot
 * + failure class only, never a raw error message or a manifest value. */
export function artifactRendererDiagnostic(
  packageName: string,
  slot: ArtifactUiSlot,
  failureClass: ArtifactRendererFailureClass,
): string {
  return `artifact renderer unavailable — package "${packageName}", slot "${slot}", reason "${failureClass}"`;
}

/**
 * Load and validate an extension-shipped renderer by its generated-map key.
 * Deterministic degrade for every pre-render failure class; a present-but-broken
 * module rethrows (route-segment error boundary). ONLY the resolved key's loader
 * is invoked — no other renderer module executes (AC-8 "only the resolved module
 * executes").
 */
export async function loadArtifactRenderer(args: {
  generatedKey: string;
  packageName: string;
  slot: ArtifactUiSlot;
  expectedPropsApiVersion: number;
}): Promise<ArtifactRendererLoadResult> {
  const { generatedKey, packageName, slot, expectedPropsApiVersion } = args;

  if (isArtifactRendererQuarantined(generatedKey)) {
    return { ok: false, failureClass: "quarantined" };
  }

  const entry = GENERATED_ARTIFACT_RENDERERS[generatedKey];
  if (!entry) {
    // Never built (defensive — dispatch routes this to requires-rebuild).
    return { ok: false, failureClass: "not-built" };
  }

  // ABI / props-contract compatibility is known at build time from the entry —
  // a deterministic pre-render check (no module executed).
  if (entry.propsApiVersion !== expectedPropsApiVersion) {
    recordRendererFailure(generatedKey);
    console.error(
      `[artifact-renderer] ${artifactRendererDiagnostic(packageName, slot, "abi-incompatible")} ` +
        `(build entry propsApiVersion ${entry.propsApiVersion} ≠ host ${expectedPropsApiVersion})`,
    );
    return { ok: false, failureClass: "abi-incompatible" };
  }

  let mod: unknown;
  try {
    mod = await entry.load();
  } catch (err) {
    // Present-but-broken module: fail loud (rethrow) → route-segment error
    // boundary. Count it toward quarantine so a persistent thrower is contained.
    recordRendererFailure(generatedKey);
    throw err;
  }

  if (isDegradedExtensionLoad(mod)) {
    // Post-build absence (marketplace uninstall after the maps were baked).
    console.error(
      `[artifact-renderer] ${artifactRendererDiagnostic(packageName, slot, "absent")}`,
    );
    return { ok: false, failureClass: "absent" };
  }

  const Component = (mod as { default?: unknown }).default;
  if (typeof Component !== "function") {
    recordRendererFailure(generatedKey);
    console.error(
      `[artifact-renderer] ${artifactRendererDiagnostic(packageName, slot, "invalid-export")}`,
    );
    return { ok: false, failureClass: "invalid-export" };
  }

  return { ok: true, Component: Component as ComponentType<ArtifactRendererProps>, entry };
}
