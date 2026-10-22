"use client";

// ---------------------------------------------------------------------------
// The EMAIL GATE FIELD RENDERERS on the conformance sample page (cinatra#4319).
//
// Mounts the REAL renderers @cinatra-ai/email-artifacts ships, loaded the way the
// run's gate loads them: through the build's field-renderer component map, keyed
// by binding id, checked against the props-contract version. Nothing is
// substituted: when the map has no entry, or the module does not load, the
// mount draws nothing of the field and says so with `data-load-state`, so a
// missing renderer cannot pass for a drawn one.
//
// The gate hands a renderer a snapshot and takes its result back; this harness
// hands the same snapshot and takes nothing back, so no field sends, saves or
// fetches. Fixed data only: see email-gate-fixture-data.ts.
// ---------------------------------------------------------------------------

import { Suspense, lazy, useMemo, type ComponentType, type ReactElement } from "react";

import {
  FIELD_RENDERER_PROPS_API_VERSION,
  type FieldRendererProps,
} from "@cinatra-ai/sdk-ui/field-renderer-props";
import { GENERATED_FIELD_RENDERER_COMPONENTS } from "@/lib/generated/field-renderer-components";

import {
  EMAIL_GATE_READINGS,
  EMAIL_GATE_SURFACES,
  SENDER_ALIASES,
  type EmailGateReading,
} from "./email-gate-fixture-data";

function Unavailable(): ReactElement {
  return <div data-load-state="unavailable" />;
}

function lazyRenderer(binding: string): ComponentType<FieldRendererProps> {
  return lazy(async () => {
    const entry = GENERATED_FIELD_RENDERER_COMPONENTS[binding];
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

function noop(): void {}

function Reading({
  reading,
  binding,
  fieldName,
  label,
}: {
  reading: EmailGateReading;
  binding: string;
  fieldName: string;
  label?: string;
}): ReactElement {
  const Renderer = useMemo(() => lazyRenderer(binding), [binding]);
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
              binding={s.binding}
              fieldName={s.fieldName}
              label={s.label}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
