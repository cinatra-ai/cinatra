// Field-renderer component resolution wiring (cinatra#1625, epic #1620 S8 — M3
// spine). The CLIENT-safe analog of the artifact-renderer loader
// (src/lib/artifacts/artifact-renderer-loader.ts, S2): it turns a field-renderer
// BINDING id into either a mounted extension-shipped renderer OR a deterministic
// degrade — and the caller (the ExtensionFieldRenderer wrapper) renders the
// SchemaFieldRenderer FLOOR on any degrade (AC4: never blank/crash).
//
// SEPARATE KEYSPACE: the generated build table
// (src/lib/generated/field-renderer-components.ts) is keyed by field-renderer
// binding id and is DISTINCT from GENERATED_ARTIFACT_RENDERERS and from the
// neutral host KIND table (register-default-renderers.ts). A binding ABSENT from
// the map resolves to its host KIND component (behavior-preserving); the map is
// empty on day one, so every binding stays on the host path until its claimant
// slice migrates the component and declares cinatra.fieldRenderers[].component.
//
// BOUNDARY: field renderers are interactive client components registered into
// the client-side registry, so this module is CLIENT-safe — it does NOT (and
// cannot) use the server-only guardedExtensionImport / degraded-result guard.
// The graceful degrade is owned here (pre-render failure classes) plus the
// wrapper's error boundary (render-time throws).

import type { ComponentType } from "react";
import type { FieldRendererProps } from "./field-renderer-registry";
import {
  GENERATED_FIELD_RENDERER_COMPONENTS,
  type GeneratedFieldRendererComponentEntry,
} from "@/lib/generated/field-renderer-components";

/**
 * The host's field-renderer props-contract version. A build map entry whose
 * `propsApiVersion` differs is degraded (abi-incompatible) — the extension was
 * built against a different FieldRendererProps shape, so the host renders the
 * floor rather than pass a mismatched props object.
 *
 * SINGLE AUTHORITY (cinatra#1625): the integer is owned by the public props leaf
 * `@cinatra-ai/sdk-ui/field-renderer-props` (the same contract a claiming
 * extension pins its `component.propsApiVersion` against); this module re-exports
 * it so in-core call sites keep importing it from `@cinatra-ai/agents` unchanged.
 * There must not be a second copy of the value.
 */
import { FIELD_RENDERER_PROPS_API_VERSION } from "@cinatra-ai/sdk-ui/field-renderer-props";
export { FIELD_RENDERER_PROPS_API_VERSION };

/** Pre-render failure taxonomy (client analog of the S2 artifact-renderer
 * classes, minus the server-only "absent"/quarantine machinery). Every class
 * degrades to the SchemaFieldRenderer floor at the call site. */
export type FieldRendererComponentFailureClass =
  | "not-in-map" // the binding id is absent from the build map (not migrated / not built)
  | "load-failed" // the literal dynamic import rejected (chunk genuinely unavailable)
  | "invalid-export" // the module loaded but exports no component default
  | "abi-incompatible"; // the build entry's propsApiVersion != the host's

export type FieldRendererComponentLoadResult =
  | {
      ok: true;
      Component: ComponentType<FieldRendererProps>;
      entry: GeneratedFieldRendererComponentEntry;
    }
  | { ok: false; failureClass: FieldRendererComponentFailureClass };

// Test-overridable view of the build map (module-level hook, mirroring the S2
// loader's test resets). Production reads the generated map directly.
let componentMapOverride:
  | Record<string, GeneratedFieldRendererComponentEntry>
  | null = null;

function componentMap(): Record<string, GeneratedFieldRendererComponentEntry> {
  return componentMapOverride ?? GENERATED_FIELD_RENDERER_COMPONENTS;
}

/** @internal test-only: install a fixture build map. */
export function __setFieldRendererComponentMapForTests(
  map: Record<string, GeneratedFieldRendererComponentEntry>,
): void {
  componentMapOverride = map;
}

/** @internal test-only: restore the real generated build map. */
export function __resetFieldRendererComponentMapForTests(): void {
  componentMapOverride = null;
}

/** True when a binding id has a migrated component in THIS build — the signal
 * the registration path uses to route the binding to the extension component
 * instead of the host KIND component. */
export function hasFieldRendererComponent(bindingId: string): boolean {
  return Object.prototype.hasOwnProperty.call(componentMap(), bindingId);
}

/** A sanitized, telemetry-safe diagnostic — package + binding + failure class
 * only, never a raw error message or a manifest value. */
export function fieldRendererComponentDiagnostic(
  packageName: string,
  bindingId: string,
  failureClass: FieldRendererComponentFailureClass,
): string {
  return `field renderer unavailable — package "${packageName}", binding "${bindingId}", reason "${failureClass}"`;
}

/**
 * Load + validate an extension-shipped field renderer by its binding id. Only
 * the resolved binding's loader is invoked — no other renderer module executes
 * (AC4 "only the resolved module executes"). Every failure resolves to a
 * deterministic degrade; the caller renders the SchemaFieldRenderer floor.
 */
export async function loadFieldRendererComponent(args: {
  bindingId: string;
  expectedPropsApiVersion?: number;
}): Promise<FieldRendererComponentLoadResult> {
  const expected = args.expectedPropsApiVersion ?? FIELD_RENDERER_PROPS_API_VERSION;
  const entry = componentMap()[args.bindingId];
  if (!entry) {
    return { ok: false, failureClass: "not-in-map" };
  }

  // ABI / props-contract compatibility is known from the build entry — a
  // deterministic pre-load check (no module executed).
  if (entry.propsApiVersion !== expected) {
    console.error(
      `[field-renderer] ${fieldRendererComponentDiagnostic(entry.packageName, args.bindingId, "abi-incompatible")} ` +
        `(build entry propsApiVersion ${entry.propsApiVersion} != host ${expected})`,
    );
    return { ok: false, failureClass: "abi-incompatible" };
  }

  let mod: unknown;
  try {
    mod = await entry.load();
  } catch {
    // CLIENT never-crash floor (AC4): a load failure degrades to the floor
    // rather than propagating (unlike the server artifact-renderer loader, which
    // rethrows to a route-segment error boundary). Diagnostic only — the raw
    // error is telemetry, not surfaced.
    console.error(
      `[field-renderer] ${fieldRendererComponentDiagnostic(entry.packageName, args.bindingId, "load-failed")}`,
    );
    return { ok: false, failureClass: "load-failed" };
  }

  const Component = (mod as { default?: unknown }).default;
  if (typeof Component !== "function") {
    console.error(
      `[field-renderer] ${fieldRendererComponentDiagnostic(entry.packageName, args.bindingId, "invalid-export")}`,
    );
    return { ok: false, failureClass: "invalid-export" };
  }

  return {
    ok: true,
    Component: Component as ComponentType<FieldRendererProps>,
    entry,
  };
}
