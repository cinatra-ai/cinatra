"use client";

// Renders a `schema-config` connector's declared setup surface WITHOUT shipping
// any connector React. Reads the validated `SchemaConfigSurface`
// vocabulary and composes shadcn primitives per field kind — so a connector that
// declares `cinatra.uiSurface:"schema-config"` configures hot at runtime.
// Named actions + status probes dispatch through the host-owned action endpoint
// (`/api/extensions/{installId}/actions/{actionId}`); extensions never define
// their own Server Actions.

import { useCallback, useState } from "react";
import { CheckIcon, CopyIcon, PlusIcon, Trash2Icon } from "lucide-react";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Button } from "@/components/ui/button";
import { StatusPill, type StatusPillStatus } from "@/components/ui/status-pill";
import type {
  SchemaConfigField,
  SchemaConfigSurface,
  TextField,
  SecretField,
} from "@/lib/extension-schema-config";

export type SchemaConfigConnectorFormProps = {
  installId: string;
  packageName: string;
  surface: SchemaConfigSurface;
  /** Initial values for text / copyable-credential fields, keyed by field key. */
  initialValues?: Record<string, string>;
  /** Optional override for the Nango connect handler (default: host nango flow). */
  onConnect?: (providerConfigKey: string) => void;
};

async function invokeAction(installId: string, actionId: string, input: unknown): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  try {
    const res = await fetch(`/api/extensions/${encodeURIComponent(installId)}/actions/${encodeURIComponent(actionId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input ?? {}),
    });
    const body = (await res.json().catch(() => ({}))) as { result?: unknown; error?: string };
    return res.ok ? { ok: true, result: body.result } : { ok: false, error: body.error ?? `Request failed (${res.status}).` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Request failed." };
  }
}

export function SchemaConfigConnectorForm({
  installId,
  packageName,
  surface,
  initialValues = {},
  onConnect,
}: SchemaConfigConnectorFormProps) {
  return (
    <FieldSet data-testid="schema-config-form" data-package={packageName}>
      {surface.title ? <FieldLegend variant="label">{surface.title}</FieldLegend> : null}
      {surface.description ? <FieldDescription>{surface.description}</FieldDescription> : null}
      <FieldGroup>
        {surface.fields.map((field, i) => (
          <SchemaConfigFieldRow
            key={fieldKey(field, i)}
            field={field}
            installId={installId}
            initialValues={initialValues}
            onConnect={onConnect}
          />
        ))}
      </FieldGroup>
    </FieldSet>
  );
}

function fieldKey(field: SchemaConfigField, i: number): string {
  return "key" in field ? field.key : `${field.kind}-${i}`;
}

function SchemaConfigFieldRow({
  field,
  installId,
  initialValues,
  onConnect,
}: {
  field: SchemaConfigField;
  installId: string;
  initialValues: Record<string, string>;
  onConnect?: (providerConfigKey: string) => void;
}) {
  switch (field.kind) {
    case "text":
      return (
        <Field>
          <FieldLabel htmlFor={field.key}>{field.label}</FieldLabel>
          <Input id={field.key} name={field.key} placeholder={field.placeholder} defaultValue={initialValues[field.key]} required={field.required} />
          {field.description ? <FieldDescription>{field.description}</FieldDescription> : null}
        </Field>
      );
    case "secret":
      return (
        <Field>
          <FieldLabel htmlFor={field.key}>{field.label}</FieldLabel>
          <Input id={field.key} name={field.key} type="password" autoComplete="off" placeholder="••••••••" required={field.required} />
          <FieldDescription>{field.description ?? "Write-only — the stored value is never shown again."}</FieldDescription>
        </Field>
      );
    case "copyable-credential":
      return <CopyableCredentialRow field={field} value={initialValues[field.key]} />;
    case "nango-connect":
      return (
        <Field orientation="horizontal">
          <FieldLabel>{field.label}</FieldLabel>
          <FieldContent>
            <Button type="button" variant="outline" onClick={() => onConnect?.(field.providerConfigKey)}>
              {field.label}
            </Button>
            {field.description ? <FieldDescription>{field.description}</FieldDescription> : null}
          </FieldContent>
        </Field>
      );
    case "status-probe":
      return <StatusProbeRow field={field} installId={installId} />;
    case "named-action":
      return <NamedActionRow field={field} installId={installId} />;
    case "repeatable-list":
      return <RepeatableListRow field={field} />;
    default:
      return null;
  }
}

function CopyableCredentialRow({ field, value }: { field: Extract<SchemaConfigField, { kind: "copyable-credential" }>; value?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard denied — no-op */
    }
  }, [value]);
  return (
    <Field>
      <FieldLabel htmlFor={field.key}>{field.label}</FieldLabel>
      <InputGroup>
        <InputGroupInput id={field.key} readOnly value={value ?? ""} className="font-mono" />
        <InputGroupAddon align="inline-end">
          <InputGroupButton type="button" size="icon-xs" onClick={copy} aria-label={`Copy ${field.label}`} disabled={!value}>
            {copied ? <CheckIcon /> : <CopyIcon />}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      {field.description ? <FieldDescription>{field.description}</FieldDescription> : null}
    </Field>
  );
}

const PROBE_TO_PILL: Record<"idle" | "checking" | "ok" | "error", StatusPillStatus> = {
  idle: "idle",
  checking: "running",
  ok: "approved",
  error: "failed",
};

function StatusProbeRow({ field, installId }: { field: Extract<SchemaConfigField, { kind: "status-probe" }>; installId: string }) {
  const [state, setState] = useState<"idle" | "checking" | "ok" | "error">("idle");
  const [detail, setDetail] = useState<string | null>(null);
  const check = useCallback(async () => {
    setState("checking");
    setDetail(null);
    const r = await invokeAction(installId, field.actionId, {});
    setState(r.ok ? "ok" : "error");
    setDetail(r.ok ? null : r.error ?? "Probe failed.");
  }, [installId, field.actionId]);
  return (
    <Field orientation="horizontal">
      <FieldLabel>{field.label}</FieldLabel>
      <FieldContent className="flex-row items-center gap-3">
        <Button type="button" variant="outline" onClick={check} disabled={state === "checking"}>
          Check
        </Button>
        <StatusPill status={PROBE_TO_PILL[state]} />
        {detail ? <FieldDescription>{detail}</FieldDescription> : field.description ? <FieldDescription>{field.description}</FieldDescription> : null}
      </FieldContent>
    </Field>
  );
}

function NamedActionRow({ field, installId }: { field: Extract<SchemaConfigField, { kind: "named-action" }>; installId: string }) {
  const [pending, setPending] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  const run = useCallback(async () => {
    if (field.confirm && !window.confirm(field.confirm)) return;
    setPending(true);
    setDetail(null);
    const r = await invokeAction(installId, field.actionId, {});
    setPending(false);
    setDetail(r.ok ? "Done." : r.error ?? "Action failed.");
  }, [field.confirm, field.actionId, installId]);
  return (
    <Field orientation="horizontal">
      <FieldLabel>{field.label}</FieldLabel>
      <FieldContent>
        <Button type="button" onClick={run} disabled={pending}>
          {field.label}
        </Button>
        {detail ? <FieldDescription>{detail}</FieldDescription> : field.description ? <FieldDescription>{field.description}</FieldDescription> : null}
      </FieldContent>
    </Field>
  );
}

function RepeatableListRow({ field }: { field: Extract<SchemaConfigField, { kind: "repeatable-list" }> }) {
  const [rows, setRows] = useState<number[]>([0]);
  const addRow = useCallback(() => setRows((r) => [...r, (r[r.length - 1] ?? 0) + 1]), []);
  const removeRow = useCallback((id: number) => setRows((r) => (r.length > 1 ? r.filter((x) => x !== id) : r)), []);
  return (
    <Field>
      <FieldLabel>{field.label}</FieldLabel>
      <FieldContent className="gap-3">
        {rows.map((id) => (
          <Field key={id} orientation="horizontal" className="items-end">
            {field.itemFields.map((item: TextField | SecretField) => (
              <Field key={item.key} className="flex-1">
                <FieldLabel htmlFor={`${field.key}-${id}-${item.key}`}>{item.label}</FieldLabel>
                <Input
                  id={`${field.key}-${id}-${item.key}`}
                  name={`${field.key}[${id}].${item.key}`}
                  type={item.kind === "secret" ? "password" : "text"}
                  autoComplete="off"
                />
              </Field>
            ))}
            <Button type="button" variant="outline" size="icon" onClick={() => removeRow(id)} aria-label={`Remove ${field.itemLabel ?? "item"}`} disabled={rows.length <= 1}>
              <Trash2Icon />
            </Button>
          </Field>
        ))}
        <Button type="button" variant="outline" size="sm" className="self-start" onClick={addRow}>
          <PlusIcon data-icon="inline-start" />
          Add {field.itemLabel ?? "item"}
        </Button>
      </FieldContent>
      {field.description ? <FieldDescription>{field.description}</FieldDescription> : null}
    </Field>
  );
}
