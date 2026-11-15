"use client";

// ---------------------------------------------------------------------------
// The EMAIL GATE FIELD RENDERERS on the conformance sample page (cinatra#4319).
//
// Mounts the REAL renderers an extension ships, loaded the way the run's gate
// loads them: through the build's field-renderer component map, keyed by binding
// id, checked against the props-contract version. The page names no extension:
// each surface names a host renderer KIND, and the binding is the one the
// build's generated bindings declare for that kind (bindingForKind). Nothing is
// substituted: when no binding answers, the map has no entry, or the module
// does not load, the mount draws nothing of the field and says so with
// `data-load-state`, so a missing renderer cannot pass for a drawn one.
//
// The gate hands a renderer a snapshot and takes its result back; this harness
// hands the same snapshot and takes nothing back, so no field sends, saves or
// fetches. Fixed data only: see gate-field-fixture-data.ts.
// ---------------------------------------------------------------------------

import { Suspense, lazy, type ComponentType, type ReactElement } from "react";

import {
  FIELD_RENDERER_PROPS_API_VERSION,
  type FieldRendererProps,
} from "@cinatra-ai/sdk-ui/field-renderer-props";
import { GENERATED_FIELD_RENDERER_BINDINGS } from "@/lib/generated/agent-bindings";
import { GENERATED_FIELD_RENDERER_COMPONENTS } from "@/lib/generated/field-renderer-components";

import {
  EMAIL_GATE_READINGS,
  EMAIL_GATE_SURFACES,
  SENDER_ALIASES,
  type EmailGateReading,
} from "./gate-field-fixture-data";

function Unavailable(): ReactElement {
  return <div data-load-state="unavailable" />;
}

/**
 * The binding the build declares for a renderer `kind`, among those that ship a
 * component. Refuses (null) when no such binding exists, and when the bindings
 * of the kind take their components from more than one package, because the
 * page could not tell which one the drawing means.
 */
export function bindingForKind(
  kind: string,
  bindings: ReadonlyArray<{ readonly id: string; readonly kind: string }> = GENERATED_FIELD_RENDERER_BINDINGS,
  components: Readonly<Record<string, { readonly packageName: string }>> = GENERATED_FIELD_RENDERER_COMPONENTS,
): string | null {
  const ids = bindings
    .filter((b) => b.kind === kind && Object.hasOwn(components, b.id))
    .map((b) => b.id);
  if (ids.length === 0) return null;
  const packages = new Set(ids.map((id) => components[id].packageName));
  return packages.size === 1 ? ids[0] : null;
}

function lazyRenderer(binding: string | null): ComponentType<FieldRendererProps> {
  return lazy(async () => {
    const entry = binding === null ? undefined : GENERATED_FIELD_RENDERER_COMPONENTS[binding];
    if (!entry || entry.propsApiVersion !== FIELD_RENDERER_PROPS_API_VERSION) {
      return { default: Unavailable };
    }
    try {
      const mod = (await entry.load()) as { default?: ComponentType<FieldRendererProps> };
      return { default: mod.default ?? Unavailable };
    } catch {
      return { default: Unavailable };
    }
  }) as ComponentType<FieldRendererProps>;
}

// One lazy component per kind, made once when this module loads, so the same
// kind always yields the same component and no component is made while
// rendering (react-hooks/static-components). Null prototype: a kind that is
// not one of the page's surfaces finds nothing here, not an Object member.
const RENDERER_BY_KIND: Readonly<Record<string, ComponentType<FieldRendererProps>>> = (() => {
  const byKind: Record<string, ComponentType<FieldRendererProps>> = Object.create(null);
  for (const s of EMAIL_GATE_SURFACES) {
    byKind[s.kind] ??= lazyRenderer(bindingForKind(s.kind));
  }
  return byKind;
})();

function noop(): void {}

function Reading({
  reading,
  kind,
  fieldName,
  label,
}: {
  reading: EmailGateReading;
  kind: string;
  fieldName: string;
  label?: string;
}): ReactElement {
  const Renderer = RENDERER_BY_KIND[kind] ?? Unavailable;
  return (
    <div data-variant={reading.variant} className="max-w-[640px]">
      <Suspense fallback={<div data-load-state="loading" />}>
        <Renderer
          fieldName={fieldName}
          schema={{ type: "string" }}
          value={reading.value}
          onChange={noop}
          disabled={reading.disabled}
          required={reading.required}
          error={reading.error ?? null}
          label={label}
          description={reading.description}
          mode={reading.mode}
          context={{ connectedApps: [], gmailAliases: SENDER_ALIASES }}
        />
      </Suspense>
    </div>
  );
}

/** The sender field, the drafts review and the recipients review, each under its conformance id. */
export function EmailGateConformanceFixtures(): ReactElement {
  return (
    <div className="flex flex-col gap-10">
      {EMAIL_GATE_SURFACES.map((s) => (
        <div
          key={s.surface}
          data-conformance-id={s.surface}
          data-state={s.dataState}
          data-field={s.dataField}
          className="flex flex-col gap-6"
        >
          {EMAIL_GATE_READINGS.filter((r) => r.surface === s.surface).map((reading) => (
            <Reading
              key={reading.variant}
              reading={reading}
              kind={s.kind}
              fieldName={s.fieldName}
              label={s.label}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
