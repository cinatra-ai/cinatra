"use client";

// ---------------------------------------------------------------------------
// HITL interrupt form (cinatra#1311 — AG-UI interactive layer).
// ---------------------------------------------------------------------------
// Renders an open `AgUiInterrupt` (from an AG-UI INTERRUPT event) as a schema-
// driven approval form and calls `onSubmit(values)` — the host wires that to
// the RESUME round-trip. This is the generic fallback renderer: it reads the
// interrupt's JSON-Schema `properties`/`required` and emits one input per
// primitive field, pre-populated from `interrupt.values`. A zero-field
// interrupt renders a bare Approve button (a pure gate).
//
// NOTE: when `interrupt.values.presentation` carries a PresentationHint (S1
// contract), the host may route to its richer per-hint renderer instead; that
// dispatch is a host concern, not baked into this generic fallback. The pure
// field extraction (`schemaFields`) is exported for host reuse + testing.

import { useState } from "react";

import type { AgUiInterrupt } from "../ag-ui-reducer";

export type HitlField = {
  name: string;
  type: string;
  title?: string;
  required: boolean;
};

const PRIMITIVE_TYPES = new Set(["string", "number", "integer", "boolean"]);

/**
 * Extract the primitive form fields from an interrupt's JSON Schema. Pure —
 * safe to unit test and to reuse in a host's own renderer. Non-object schemas
 * and non-primitive properties are skipped.
 */
export function schemaFields(schema: Record<string, unknown>): HitlField[] {
  const props = schema.properties;
  if (!props || typeof props !== "object" || Array.isArray(props)) return [];
  const required = Array.isArray(schema.required)
    ? new Set(schema.required.filter((r): r is string => typeof r === "string"))
    : new Set<string>();
  const out: HitlField[] = [];
  for (const [name, raw] of Object.entries(props as Record<string, unknown>)) {
    const def = (raw ?? {}) as Record<string, unknown>;
    const type = typeof def.type === "string" ? def.type : "string";
    if (!PRIMITIVE_TYPES.has(type)) continue;
    out.push({
      name,
      type,
      title: typeof def.title === "string" ? def.title : undefined,
      required: required.has(name),
    });
  }
  return out;
}

function initialValue(field: HitlField, values: Record<string, unknown>): string {
  const v = values[field.name];
  if (v === undefined || v === null) return "";
  return typeof v === "boolean" ? (v ? "true" : "false") : String(v);
}

export function HitlInterruptForm({
  interrupt,
  onSubmit,
  submitting = false,
}: {
  interrupt: AgUiInterrupt;
  onSubmit: (values: Record<string, unknown>) => void;
  submitting?: boolean;
}) {
  const fields = schemaFields(interrupt.schema);
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.name, initialValue(f, interrupt.values)])),
  );

  function submit() {
    const values: Record<string, unknown> = {};
    for (const f of fields) {
      const raw = draft[f.name] ?? "";
      if (raw === "") continue;
      if (f.type === "boolean") values[f.name] = /^(true|yes|y|on)$/i.test(raw);
      else if (f.type === "number" || f.type === "integer") {
        const n = Number(raw);
        if (Number.isFinite(n)) values[f.name] = n;
      } else values[f.name] = raw;
    }
    onSubmit(values);
  }

  return (
    <form
      className="my-3 flex flex-col gap-3 rounded-lg border border-line bg-surface p-3"
      data-hitl-interrupt
      data-x-renderer={interrupt.xRenderer}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {fields.map((f) => (
        <label key={f.name} className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">
            {f.title ?? f.name}
            {f.required && <span className="text-red-500"> *</span>}
          </span>
          <input
            className="rounded-md border border-line bg-surface-muted px-2 py-1 text-foreground"
            name={f.name}
            value={draft[f.name] ?? ""}
            onChange={(e) =>
              setDraft((d) => ({ ...d, [f.name]: e.target.value }))
            }
          />
        </label>
      ))}
      <button
        type="submit"
        disabled={submitting}
        className="self-start rounded-md border border-line bg-surface-muted px-3 py-1.5 text-sm text-foreground disabled:opacity-50"
      >
        {fields.length === 0 ? "Approve" : "Submit"}
      </button>
    </form>
  );
}
