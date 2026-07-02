"use client";

// Renders a `schema-config` connector's declared setup surface WITHOUT shipping
// any connector React. Reads the validated `SchemaConfigSurface`
// vocabulary and composes shadcn primitives per field kind — so a connector that
// declares `cinatra.uiSurface:"schema-config"` configures hot at runtime.
// Named actions + status probes dispatch through the host-owned action endpoint
// (`/api/extensions/{installId}/actions/{actionId}`); extensions never define
// their own Server Actions.
//
// SECURITY: this renderer is pure presentation over a FAIL-CLOSED, parsed surface
// (`parseSchemaConfig` rejected any field carrying an unexpected/executable key).
// No field value is ever spread onto a DOM element or invoked — every value is
// rendered as text or used to choose a host-action id. `select.adminOnly` options
// are filtered against the HOST-evaluated `isAdmin` prop (the host re-rejects an
// admin-only value at the write handler — defense in depth).

import { useCallback, useEffect, useState } from "react";
import { CheckIcon, CopyIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { StatusPill, type StatusPillStatus } from "@/components/ui/status-pill";
import type {
  SchemaConfigField,
  SchemaConfigSurface,
  TextField,
  SecretField,
  SelectField,
  RecordListField,
  RecordListBadgeVariant,
  BannerField,
  BannerTone,
  AdvisoryField,
  DynamicSelectOptionsField,
  BooleanField,
  NumberField,
  FreeListField,
} from "@/lib/extension-schema-config";

export type SchemaConfigConnectorFormProps = {
  installId: string;
  packageName: string;
  surface: SchemaConfigSurface;
  /**
   * Whether the viewing actor is a platform admin — HOST-EVALUATED (never derived
   * in the package). Gates `select.adminOnly` options. The host write handler
   * re-rejects an admin-only value from a non-admin, so this is UX scoping only.
   */
  isAdmin?: boolean;
  /** Initial values for text / copyable-credential / select fields, keyed by field key. */
  initialValues?: Record<string, string>;
  /** Optional override for the Nango connect handler (default: host nango flow). */
  onConnect?: (providerConfigKey: string) => void;
};

type ActionResult = { ok: boolean; result?: unknown; error?: string };

async function invokeAction(installId: string, actionId: string, input: unknown): Promise<ActionResult> {
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

/** The banner identity an action result asks the form to display (`{ banner }`). */
function bannerNameFromResult(result: unknown): string | null {
  if (result && typeof result === "object" && "banner" in result) {
    const b = (result as { banner?: unknown }).banner;
    return typeof b === "string" && b ? b : null;
  }
  return null;
}

export function SchemaConfigConnectorForm({
  installId,
  packageName,
  surface,
  isAdmin = false,
  initialValues = {},
  onConnect,
}: SchemaConfigConnectorFormProps) {
  // Shared form-level state driven by action RESULTS:
  //  - `bannerName`: the active banner variant name (a create/delete result sets it).
  //  - `listEpoch`: bumped to force every record-list to re-fetch after a write.
  const [bannerName, setBannerName] = useState<string | null>(null);
  const [listEpoch, setListEpoch] = useState(0);

  const onActionResult = useCallback((result: ActionResult) => {
    if (!result.ok) {
      // An error result still surfaces a banner when an "error" variant exists.
      setBannerName("error");
      setListEpoch((e) => e + 1);
      return;
    }
    const name = bannerNameFromResult(result.result);
    if (name) setBannerName(name);
    // Any successful write may have changed the underlying rows — refresh lists.
    setListEpoch((e) => e + 1);
  }, []);

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
            isAdmin={isAdmin}
            initialValues={initialValues}
            onConnect={onConnect}
            bannerName={bannerName}
            listEpoch={listEpoch}
            onActionResult={onActionResult}
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
  isAdmin,
  initialValues,
  onConnect,
  bannerName,
  listEpoch,
  onActionResult,
}: {
  field: SchemaConfigField;
  installId: string;
  isAdmin: boolean;
  initialValues: Record<string, string>;
  onConnect?: (providerConfigKey: string) => void;
  bannerName: string | null;
  listEpoch: number;
  onActionResult: (result: ActionResult) => void;
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
      return <NamedActionRow field={field} installId={installId} onActionResult={onActionResult} />;
    case "repeatable-list":
      return <RepeatableListRow field={field} />;
    case "select":
      return <SelectRow field={field} isAdmin={isAdmin} initialValue={initialValues[field.key]} />;
    case "record-list":
      return <RecordListRow field={field} installId={installId} listEpoch={listEpoch} onActionResult={onActionResult} />;
    case "banner":
      return <BannerRow field={field} activeName={bannerName} />;
    case "advisory":
      return <AdvisoryRow field={field} installId={installId} />;
    case "dynamic-select-options":
      return <DynamicSelectRow field={field} installId={installId} initialValue={initialValues[field.key]} />;
    case "boolean":
      return <BooleanRow field={field} initialValue={initialValues[field.key]} />;
    case "number":
      return <NumberRow field={field} initialValue={initialValues[field.key]} />;
    case "free-list":
      return <FreeListRow field={field} initialValue={initialValues[field.key]} />;
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

function NamedActionRow({
  field,
  installId,
  onActionResult,
}: {
  field: Extract<SchemaConfigField, { kind: "named-action" }>;
  installId: string;
  onActionResult: (result: ActionResult) => void;
}) {
  const [pending, setPending] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  const run = useCallback(async () => {
    if (field.confirm && !window.confirm(field.confirm)) return;
    setPending(true);
    setDetail(null);
    const r = await invokeAction(installId, field.actionId, collectFormInputs());
    setPending(false);
    setDetail(r.ok ? "Done." : r.error ?? "Action failed.");
    onActionResult(r);
  }, [field.confirm, field.actionId, installId, onActionResult]);
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

/**
 * Collect the named text/secret/select inputs in the form into a flat JSON
 * object for a write named action (e.g. createServer). Reads from the live form
 * DOM (the renderer is uncontrolled for these fields). Never includes a field
 * whose name contains "[" (repeatable-list rows are out of scope for a flat
 * create action).
 */
function collectFormInputs(): Record<string, string> {
  if (typeof document === "undefined") return {};
  const form = document.querySelector<HTMLElement>('[data-testid="schema-config-form"]');
  if (!form) return {};
  const out: Record<string, string> = {};
  form
    .querySelectorAll<HTMLInputElement | HTMLSelectElement>("input[name], select[name]")
    .forEach((el) => {
      const name = el.getAttribute("name");
      if (!name || name.includes("[")) return;
      out[name] = el.value;
    });
  return out;
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

function SelectRow({
  field,
  isAdmin,
  initialValue,
}: {
  field: SelectField;
  isAdmin: boolean;
  initialValue?: string;
}) {
  // Filter admin-only options against the HOST-evaluated isAdmin flag — a
  // non-admin never sees (nor can pick) an admin-only option. The host write
  // handler re-rejects an admin-only value, so this is UX scoping only.
  const visibleOptions = field.options.filter((o) => isAdmin || !o.adminOnly);
  const fallback = visibleOptions[0]?.value;
  const initial =
    initialValue && visibleOptions.some((o) => o.value === initialValue)
      ? initialValue
      : field.defaultValue && visibleOptions.some((o) => o.value === field.defaultValue)
        ? field.defaultValue
        : fallback;
  const [value, setValue] = useState<string | undefined>(initial);
  return (
    <Field>
      <FieldLabel htmlFor={field.key}>{field.label}</FieldLabel>
      {/* Hidden input carries the selected value into collectFormInputs(). */}
      <Input type="hidden" name={field.key} value={value ?? ""} readOnly />
      <Select value={value} onValueChange={setValue}>
        <SelectTrigger id={field.key} aria-label={field.label}>
          <SelectValue placeholder={field.label} />
        </SelectTrigger>
        <SelectContent>
          {visibleOptions.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {field.description ? <FieldDescription>{field.description}</FieldDescription> : null}
    </Field>
  );
}

const BADGE_VARIANT_MAP: Record<RecordListBadgeVariant, React.ComponentProps<typeof Badge>["variant"]> = {
  outline: "outline",
  secondary: "secondary",
  destructive: "destructive",
  success: "success",
  warning: "warning",
  info: "info",
  ghost: "ghost",
  // No Badge "muted" variant — map to the closest neutral.
  muted: "secondary",
};

type RecordRow = Record<string, unknown> & { id?: unknown };

/** Normalize a list action result into an array of row objects. Accepts
 *  `{ servers }`, `{ items }`, `{ rows }`, or a bare array. */
function rowsFromListResult(result: unknown): RecordRow[] {
  if (Array.isArray(result)) return result.filter((r): r is RecordRow => !!r && typeof r === "object");
  if (result && typeof result === "object") {
    for (const key of ["servers", "items", "rows"]) {
      const v = (result as Record<string, unknown>)[key];
      if (Array.isArray(v)) return v.filter((r): r is RecordRow => !!r && typeof r === "object");
    }
  }
  return [];
}

function rowText(row: RecordRow, key: string): string {
  const v = row[key];
  return typeof v === "string" ? v : v == null ? "" : String(v);
}
function rowTruthy(row: RecordRow, key: string): boolean {
  const v = row[key];
  return v === true || (typeof v === "string" && v.length > 0);
}

function RecordListRow({
  field,
  installId,
  listEpoch,
  onActionResult,
}: {
  field: RecordListField;
  installId: string;
  listEpoch: number;
  onActionResult: (result: ActionResult) => void;
}) {
  const [rows, setRows] = useState<RecordRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // The fetch body. Returns the resolved state; the caller decides whether to
  // apply it (so the mount/epoch effect can ignore a stale response after
  // unmount). Sets `loading` ASYNCHRONOUSLY (after a microtask) so it is never a
  // synchronous setState inside the effect body.
  const fetchRows = useCallback(async () => {
    await Promise.resolve();
    setLoading(true);
    setError(null);
    const r = await invokeAction(installId, field.listActionId, {});
    setLoading(false);
    return r;
  }, [installId, field.listActionId]);

  const applyResult = useCallback((r: ActionResult) => {
    if (r.ok) {
      setRows(rowsFromListResult(r.result));
    } else {
      setRows([]);
      setError(r.error ?? "Could not load.");
    }
  }, []);

  const reload = useCallback(async () => {
    applyResult(await fetchRows());
  }, [fetchRows, applyResult]);

  // Reload on mount and whenever a write bumps the shared epoch. The fetch's
  // first setState runs after a microtask (see fetchRows), and a stale response
  // is dropped if the row unmounted mid-flight.
  useEffect(() => {
    let active = true;
    void (async () => {
      const r = await fetchRows();
      if (active) applyResult(r);
    })();
    return () => {
      active = false;
    };
  }, [fetchRows, applyResult, listEpoch]);

  const onDelete = useCallback(
    async (id: string) => {
      if (!field.deleteActionId) return;
      if (!window.confirm("Delete this entry?")) return;
      setDeletingId(id);
      const r = await invokeAction(installId, field.deleteActionId, { id });
      setDeletingId(null);
      onActionResult(r); // bumps the epoch → reload
    },
    [field.deleteActionId, installId, onActionResult],
  );

  return (
    <Field data-testid={`record-list-${field.listActionId}`}>
      <div className="flex items-center justify-between gap-2">
        <FieldLabel>{field.label}</FieldLabel>
        <Button type="button" variant="ghost" size="icon-xs" onClick={() => void reload()} aria-label="Refresh list" disabled={loading}>
          <RefreshCwIcon />
        </Button>
      </div>
      {field.description ? <FieldDescription>{field.description}</FieldDescription> : null}
      <FieldContent className="gap-2">
        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
        {rows === null && loading ? (
          <FieldDescription>Loading…</FieldDescription>
        ) : rows && rows.length === 0 ? (
          <FieldDescription data-testid="record-list-empty">{field.emptyState}</FieldDescription>
        ) : (
          (rows ?? []).map((row, i) => {
            const id = typeof row.id === "string" ? row.id : null;
            return (
              <div
                key={id ?? i}
                data-testid="record-list-item"
                className="flex items-start justify-between gap-3 rounded-md border border-border p-3"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="truncate text-sm font-medium">{rowText(row, field.itemTitleKey)}</div>
                  {field.itemSubtitleKey ? (
                    <div className="truncate text-xs text-muted-foreground">{rowText(row, field.itemSubtitleKey)}</div>
                  ) : null}
                  <div className="flex flex-wrap gap-1 pt-1">
                    {field.itemBadges
                      .filter((b) => rowTruthy(row, b.key))
                      .map((b) => (
                        <Badge key={b.key} variant={BADGE_VARIANT_MAP[b.variant]}>
                          {b.label}
                        </Badge>
                      ))}
                  </div>
                </div>
                {field.deleteActionId && id ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label={`Delete ${rowText(row, field.itemTitleKey) || "entry"}`}
                    disabled={deletingId === id}
                    onClick={() => void onDelete(id)}
                  >
                    <Trash2Icon />
                  </Button>
                ) : null}
              </div>
            );
          })
        )}
      </FieldContent>
    </Field>
  );
}

const BANNER_TONE_TO_VARIANT: Record<BannerTone, React.ComponentProps<typeof Alert>["variant"]> = {
  default: "default",
  destructive: "destructive",
  warning: "warning",
  success: "success",
  info: "info",
};

function BannerRow({ field, activeName }: { field: BannerField; activeName: string | null }) {
  const variant = activeName ? field.variants.find((v) => v.name === activeName) : undefined;
  if (!variant) return null;
  return (
    <Alert data-testid="schema-config-banner" variant={BANNER_TONE_TO_VARIANT[variant.tone]}>
      <AlertTitle>{field.label}</AlertTitle>
      <AlertDescription>{variant.message}</AlertDescription>
    </Alert>
  );
}

function AdvisoryRow({ field, installId }: { field: AdvisoryField; installId: string }) {
  const [ready, setReady] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await invokeAction(installId, field.probeActionId, {});
      if (cancelled) return;
      const v =
        r.ok && r.result && typeof r.result === "object" && "ready" in r.result
          ? (r.result as { ready?: unknown }).ready === true
          : false;
      setReady(v);
    })();
    return () => {
      cancelled = true;
    };
  }, [installId, field.probeActionId]);
  if (ready === null) return null;
  return (
    <Alert data-testid="schema-config-advisory" variant={BANNER_TONE_TO_VARIANT[field.tone]}>
      <AlertTitle>{field.label}</AlertTitle>
      <AlertDescription>{ready ? field.whenReady : field.whenNotReady}</AlertDescription>
    </Alert>
  );
}

type FetchedOption = { value: string; label: string };

/**
 * Normalize a dynamic-options action result into `{value,label}[]`. Accepts a
 * bare array, `{ options: [...] }`, or `{ items: [...] }`. Fail-closed: every
 * entry MUST carry a string `value` and `label`; anything else is dropped, and
 * duplicate values are de-duped (first wins). Values/labels are rendered as text
 * only — never spread onto a DOM element.
 */
function optionsFromResult(result: unknown): FetchedOption[] {
  let arr: unknown[] = [];
  if (Array.isArray(result)) arr = result;
  else if (result && typeof result === "object") {
    for (const key of ["options", "items"]) {
      const v = (result as Record<string, unknown>)[key];
      if (Array.isArray(v)) {
        arr = v;
        break;
      }
    }
  }
  const out: FetchedOption[] = [];
  const seen = new Set<string>();
  for (const o of arr) {
    if (!o || typeof o !== "object") continue;
    const value = (o as Record<string, unknown>).value;
    const label = (o as Record<string, unknown>).label;
    if (typeof value !== "string" || !value || typeof label !== "string" || !label) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push({ value, label });
  }
  return out;
}

/**
 * A select whose options are ACTION-SOURCED (cinatra#782). On mount it dispatches
 * `optionsAction` through the SAME host action endpoint (`invokeAction`) — no new
 * endpoint — and renders loading / error / empty / populated states. The hidden
 * `input[name=key]` carries the selected value into `collectFormInputs`, mirroring
 * the static `SelectRow`. A stale response after remount/action change is dropped
 * (active-flag pattern, like `RecordListRow`).
 */
function DynamicSelectRow({
  field,
  installId,
  initialValue,
}: {
  field: DynamicSelectOptionsField;
  installId: string;
  initialValue?: string;
}) {
  const [options, setOptions] = useState<FetchedOption[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [value, setValue] = useState<string | undefined>(undefined);

  useEffect(() => {
    let active = true;
    void (async () => {
      // Defer the first setState past a microtask so it is never a synchronous
      // setState inside the effect body (mirrors RecordListRow.fetchRows).
      await Promise.resolve();
      if (!active) return;
      setLoading(true);
      setError(null);
      const r = await invokeAction(installId, field.optionsAction, {});
      if (!active) return;
      setLoading(false);
      if (!r.ok) {
        setOptions([]);
        setError(r.error ?? "Could not load options.");
        return;
      }
      const opts = optionsFromResult(r.result);
      setOptions(opts);
      // Choose the initial value only from the fetched options: the saved value,
      // else the declared defaultValue, else the first option.
      const pick =
        (initialValue && opts.some((o) => o.value === initialValue) && initialValue) ||
        (field.defaultValue && opts.some((o) => o.value === field.defaultValue) && field.defaultValue) ||
        opts[0]?.value;
      setValue(pick || undefined);
    })();
    return () => {
      active = false;
    };
  }, [installId, field.optionsAction, field.defaultValue, initialValue]);

  return (
    <Field data-testid={`dynamic-select-${field.optionsAction}`}>
      <FieldLabel htmlFor={field.key}>{field.label}</FieldLabel>
      {/* Hidden input carries the selected value into collectFormInputs(). */}
      <Input type="hidden" name={field.key} value={value ?? ""} readOnly />
      {error ? (
        <Alert variant="destructive" data-testid="dynamic-select-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : options === null || loading ? (
        <FieldDescription data-testid="dynamic-select-loading">Loading options…</FieldDescription>
      ) : options.length === 0 ? (
        <FieldDescription data-testid="dynamic-select-empty">
          {field.placeholder ?? "No options available."}
        </FieldDescription>
      ) : (
        <Select value={value} onValueChange={setValue}>
          <SelectTrigger id={field.key} aria-label={field.label}>
            <SelectValue placeholder={field.placeholder ?? field.label} />
          </SelectTrigger>
          <SelectContent>
            {options.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {field.description ? <FieldDescription>{field.description}</FieldDescription> : null}
    </Field>
  );
}

/**
 * A boolean toggle (Switch). Only the HIDDEN input carries a `name`, serializing
 * `"true"`/`"false"` into `collectFormInputs` (the visible Switch is nameless);
 * the host write handler parses the exact string, not truthiness.
 */
function BooleanRow({ field, initialValue }: { field: BooleanField; initialValue?: string }) {
  const initial = initialValue !== undefined ? initialValue === "true" : field.defaultValue ?? false;
  const [checked, setChecked] = useState<boolean>(initial);
  return (
    <Field orientation="horizontal">
      <FieldLabel htmlFor={`${field.key}-toggle`}>{field.label}</FieldLabel>
      <FieldContent>
        {/* Hidden input is the ONLY named element — collectFormInputs reads it. */}
        <Input type="hidden" name={field.key} value={checked ? "true" : "false"} readOnly />
        <Switch id={`${field.key}-toggle`} checked={checked} onCheckedChange={setChecked} aria-label={field.label} />
        {field.description ? <FieldDescription>{field.description}</FieldDescription> : null}
      </FieldContent>
    </Field>
  );
}

/**
 * A numeric input with optional min/max/step. Uncontrolled so `collectFormInputs`
 * reads `el.value`; the min/max/step attributes are UX only — the host write
 * handler is the authoritative clamp.
 */
function NumberRow({ field, initialValue }: { field: NumberField; initialValue?: string }) {
  return (
    <Field>
      <FieldLabel htmlFor={field.key}>{field.label}</FieldLabel>
      <Input
        id={field.key}
        name={field.key}
        type="number"
        inputMode="numeric"
        min={field.min}
        max={field.max}
        step={field.step}
        placeholder={field.placeholder}
        required={field.required}
        defaultValue={initialValue ?? (field.defaultValue !== undefined ? String(field.defaultValue) : undefined)}
      />
      {field.description ? <FieldDescription>{field.description}</FieldDescription> : null}
    </Field>
  );
}

/**
 * An add/remove editor for a free-form string list. The visible entry inputs are
 * NAMELESS; a single hidden `input[name=key]` carries the non-empty entries as a
 * JSON `string[]` so it round-trips through `collectFormInputs` (which skips
 * indexed `key[i]` names). The host write handler `JSON.parse`s + re-validates it.
 */
function FreeListRow({ field, initialValue }: { field: FreeListField; initialValue?: string }) {
  const parseInitial = (): string[] => {
    if (!initialValue) return [""];
    try {
      const parsed = JSON.parse(initialValue);
      if (Array.isArray(parsed)) {
        const strings = parsed.filter((s): s is string => typeof s === "string");
        return strings.length > 0 ? strings : [""];
      }
    } catch {
      /* not JSON — start empty */
    }
    return [""];
  };
  const [entries, setEntries] = useState<string[]>(parseInitial);
  const setEntry = useCallback((i: number, v: string) => {
    setEntries((prev) => prev.map((e, idx) => (idx === i ? v : e)));
  }, []);
  const addEntry = useCallback(() => setEntries((prev) => [...prev, ""]), []);
  const removeEntry = useCallback(
    (i: number) => setEntries((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : [""])),
    [],
  );
  const serialized = JSON.stringify(entries.map((e) => e.trim()).filter((e) => e.length > 0));
  return (
    <Field>
      <FieldLabel>{field.label}</FieldLabel>
      {/* Single hidden input carries the whole list as JSON into collectFormInputs. */}
      <Input type="hidden" name={field.key} value={serialized} readOnly />
      <FieldContent className="gap-2">
        {entries.map((entry, i) => (
          <Field key={i} orientation="horizontal" className="items-end">
            <Input
              className="flex-1"
              aria-label={`${field.itemLabel ?? field.label} ${i + 1}`}
              placeholder={field.placeholder}
              value={entry}
              onChange={(e) => setEntry(i, e.target.value)}
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => removeEntry(i)}
              aria-label={`Remove ${field.itemLabel ?? "entry"}`}
              disabled={entries.length <= 1}
            >
              <Trash2Icon />
            </Button>
          </Field>
        ))}
        <Button type="button" variant="outline" size="sm" className="self-start" onClick={addEntry}>
          <PlusIcon data-icon="inline-start" />
          Add {field.itemLabel ?? "entry"}
        </Button>
      </FieldContent>
      {field.description ? <FieldDescription>{field.description}</FieldDescription> : null}
    </Field>
  );
}
