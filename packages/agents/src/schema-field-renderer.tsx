"use client";

import { useEffect, useRef, useState } from "react";
import { LinkIcon, MailIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  fieldRendererRegistry,
  type FieldRendererContext,
  type FieldRendererProps,
  type RendererMode,
} from "./field-renderer-registry";

type Props = {
  fieldName: string;
  schema: Record<string, unknown>;
  value: unknown;
  onChange: (next: unknown) => void;
  disabled?: boolean;
  required?: boolean;
  error?: string | null;
  context: FieldRendererContext;
  onBusyChange?: (busy: boolean) => void;
  saveNow?: (value: unknown) => Promise<void>;
  assistResponseKey?: number;
  mode?: RendererMode;
  registerFlush?: (fn: () => Promise<void>) => void;
  /** When true, skip the internal Continue button. See FieldRendererProps. */
  hideSubmit?: boolean;
};

function isLikelyMultiline(schema: Record<string, unknown>): boolean {
  const explicit = (schema as { ["x-multiline"]?: boolean })["x-multiline"];
  if (typeof explicit === "boolean") return explicit;
  const description = (schema as { description?: string }).description ?? "";
  return description.length > 80;
}

function isValidUrl(value: string): boolean {
  if (!value) return true;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function isValidEmail(value: string): boolean {
  if (!value) return true;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function SchemaFieldRenderer(props: Props) {
  const { fieldName, schema, value, onChange, disabled, required, error: callerError, context, onBusyChange, saveNow, assistResponseKey, mode, registerFlush, hideSubmit } = props;

  const title = (schema as { title?: string }).title;
  const description = (schema as { description?: string }).description;
  const label = title ?? description ?? fieldName;

  // Local state for text-entry inputs (string, url, email, number, array).
  // onChange in HITL context calls approveReviewTask; these inputs need local
  // state so the user can finish typing before submitting.
  const [localValue, setLocalValue] = useState<string>(() => {
    if (typeof value === "string") return value;
    if (typeof value === "number") return String(value);
    if (Array.isArray(value)) return value.map((v) => String(v)).join("\n");
    return "";
  });

  // Sync localValue when the parent externally changes value (e.g. AI suggestions via
  // form.setValue). Safe alongside user typing because this component never calls
  // field.onChange while typing — it uses registerFlush — so field.value only changes
  // when the parent explicitly sets it, not on each keystroke.
  useEffect(() => {
    if (typeof value === "string") setLocalValue(value);
    else if (typeof value === "number") setLocalValue(String(value));
    else if (Array.isArray(value)) setLocalValue(value.map((v) => String(v)).join("\n"));
  }, [value]);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Refs so flush callback always reads latest value without re-registering
  const localValueRef = useRef(localValue);
  useEffect(() => { localValueRef.current = localValue; }, [localValue]);
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  // When inside a grouped form, register a flush that pushes buffered localValue
  // into react-hook-form's internal store before Zod validation runs.
  // Registry-matched renderers register their own flush; boolean/enum call onChange
  // directly and need no flush.
  useEffect(() => {
    if (!registerFlush) return;
    if (fieldRendererRegistry.resolve(fieldName, schema, context)) return;
    const t = (schema as { type?: string }).type;
    const enumVals = (schema as { enum?: unknown[] }).enum;
    if (t === "boolean" || (Array.isArray(enumVals) && enumVals.length > 0)) return;
    registerFlush(async () => {
      const v = localValueRef.current;
      if (t === "number" || t === "integer") {
        if (v === "") { onChangeRef.current(undefined); return; }
        const parsed = t === "integer" ? parseInt(v, 10) : Number(v);
        if (!Number.isNaN(parsed)) onChangeRef.current(parsed);
      } else if (t === "array") {
        onChangeRef.current(v.split("\n").map((s) => s.trim()).filter(Boolean));
      } else {
        onChangeRef.current(v);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerFlush]); // stable — registerFlush is useCallback; refs always current

  const handleSubmit = async (submitValue: unknown) => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onChange(submitValue);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Could not submit. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  // Build the normalized FieldRendererProps that both registry renderers
  // and the in-file fallback paths receive.
  const normalized: FieldRendererProps = {
    fieldName,
    schema,
    value,
    onChange,
    disabled,
    required,
    error: callerError ?? null,
    label,
    description,
    context,
    onBusyChange,
    saveNow,
    assistResponseKey,
    mode,
    registerFlush,
    hideSubmit,
  };

  // 1) Registry-first
  const matched = fieldRendererRegistry.resolve(fieldName, schema, context);
  if (matched) {
    const Renderer = matched.renderer;
    return <Renderer {...normalized} />;
  }

  // 2) Schema-driven fallback
  const type = (schema as { type?: string }).type;
  const format = (schema as { format?: string }).format;
  const enumValues = (schema as { enum?: unknown[] }).enum;
  const placeholder = (schema as { ["x-placeholder"]?: string })["x-placeholder"];

  // Enum -> Select
  if (Array.isArray(enumValues) && enumValues.length > 0) {
    const enumTitles = (schema as { "x-enum-titles"?: string[] })["x-enum-titles"];
    const stringValue = value == null ? "" : String(value);
    return (
      <div className="flex flex-col gap-2">
        <Label htmlFor={`field-${fieldName}`} className="text-foreground">{label}{required ? " *" : <span className="ml-1 font-normal text-muted-foreground">(optional)</span>}</Label>
        <Select value={stringValue} onValueChange={(next) => onChange(next)} disabled={disabled}>
          <SelectTrigger id={`field-${fieldName}`} className="border-line">
            <SelectValue placeholder={placeholder ?? label} />
          </SelectTrigger>
          <SelectContent>
            {enumValues.map((option, idx) => (
              <SelectItem key={String(option)} value={String(option)}>
                {enumTitles?.[idx] ?? String(option)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
        {callerError ? <p className="text-xs text-destructive">{callerError}</p> : null}
      </div>
    );
  }

  // Boolean -> Checkbox
  if (type === "boolean") {
    const boolValue = Boolean(value);
    return (
      <div className="flex items-start gap-3">
        <Checkbox
          id={`field-${fieldName}`}
          checked={boolValue}
          onCheckedChange={(next) => onChange(Boolean(next))}
          disabled={disabled}
        />
        <div className="flex flex-col">
          <Label htmlFor={`field-${fieldName}`} className="text-foreground">{label}{required ? " *" : <span className="ml-1 font-normal text-muted-foreground">(optional)</span>}</Label>
          {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
        </div>
      </div>
    );
  }

  // Number / integer
  if (type === "number" || type === "integer") {
    const numError = localValue.length > 0 && Number.isNaN(type === "integer" ? parseInt(localValue, 10) : Number(localValue)) ? "Enter a valid number." : null;
    const displayError = callerError ?? numError;
    const submitNum = () => {
      const raw = localValue;
      if (raw === "") return handleSubmit(undefined);
      const parsed = type === "integer" ? parseInt(raw, 10) : Number(raw);
      if (!Number.isNaN(parsed)) return handleSubmit(parsed);
    };
    return (
      <div className="flex flex-col gap-2">
        <Label htmlFor={`field-${fieldName}`} className="text-foreground">{label}{required ? " *" : <span className="ml-1 font-normal text-muted-foreground">(optional)</span>}</Label>
        <Input
          id={`field-${fieldName}`}
          type="number"
          value={localValue}
          onChange={(e) => setLocalValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !displayError && !submitting) void submitNum(); }}
          disabled={disabled || submitting}
          className="border-line"
          aria-invalid={displayError ? true : undefined}
        />
        {displayError ? <p className="text-xs text-destructive">{displayError}</p> : null}
        {submitError ? <p className="text-xs text-destructive">{submitError}</p> : null}
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
        {!hideSubmit && (
          <div>
            <Button size="sm" disabled={disabled || submitting || !!displayError} onClick={() => void submitNum()}>
              {submitting ? "Submitting…" : "Continue"}
            </Button>
          </div>
        )}
      </div>
    );
  }

  // Array -> textarea (one value per line). Documented v1 limitation: lossy
  // (trims whitespace, drops empty lines). For structured arrays the agent
  // author should register a custom renderer via the registry.
  if (type === "array") {
    return (
      <div className="flex flex-col gap-2">
        <Label htmlFor={`field-${fieldName}`} className="text-foreground">{label}{required ? " *" : <span className="ml-1 font-normal text-muted-foreground">(optional)</span>}</Label>
        <Textarea
          id={`field-${fieldName}`}
          value={localValue}
          onChange={(e) => setLocalValue(e.target.value)}
          disabled={disabled || submitting}
          rows={4}
          className="border-line"
        />
        <p className="text-xs text-muted-foreground">One value per line. {description ?? ""}</p>
        {callerError ? <p className="text-xs text-destructive">{callerError}</p> : null}
        {submitError ? <p className="text-xs text-destructive">{submitError}</p> : null}
        {!hideSubmit && (
          <div>
            <Button size="sm" disabled={disabled || submitting} onClick={() => void handleSubmit(localValue.split("\n").map((s) => s.trim()).filter(Boolean))}>
              {submitting ? "Submitting…" : "Continue"}
            </Button>
          </div>
        )}
      </div>
    );
  }

  // String with format=uri
  if (type === "string" && format === "uri") {
    const localError = localValue.length > 0 && !isValidUrl(localValue) ? "Enter a valid URL." : null;
    const displayError = callerError ?? localError;
    return (
      <Field>
        <FieldLabel htmlFor={`field-${fieldName}`}>{label}{required ? " *" : <span className="ml-1 font-normal text-muted-foreground">(optional)</span>}</FieldLabel>
        <InputGroup>
          <InputGroupAddon>
            <LinkIcon aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            id={`field-${fieldName}`}
            type="url"
            inputMode="url"
            value={localValue}
            onChange={(e) => setLocalValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !displayError && !submitting) void handleSubmit(localValue); }}
            disabled={disabled || submitting}
            placeholder={placeholder ?? "https://example.com"}
            aria-invalid={displayError ? true : undefined}
          />
        </InputGroup>
        {displayError ? <FieldDescription className="text-destructive">{displayError}</FieldDescription> : null}
        {submitError ? <FieldDescription className="text-destructive">{submitError}</FieldDescription> : null}
        {description ? <FieldDescription>{description}</FieldDescription> : null}
        {!hideSubmit && (
          <div>
            <Button size="sm" disabled={disabled || submitting || !!displayError} onClick={() => void handleSubmit(localValue)}>
              {submitting ? "Submitting…" : "Continue"}
            </Button>
          </div>
        )}
      </Field>
    );
  }

  // String with format=email
  if (type === "string" && format === "email") {
    const localError = localValue.length > 0 && !isValidEmail(localValue) ? "Enter a valid email address." : null;
    const displayError = callerError ?? localError;
    return (
      <Field>
        <FieldLabel htmlFor={`field-${fieldName}`}>{label}{required ? " *" : <span className="ml-1 font-normal text-muted-foreground">(optional)</span>}</FieldLabel>
        <InputGroup>
          <InputGroupAddon>
            <MailIcon aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            id={`field-${fieldName}`}
            type="email"
            inputMode="email"
            value={localValue}
            onChange={(e) => setLocalValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !displayError && !submitting) void handleSubmit(localValue); }}
            disabled={disabled || submitting}
            placeholder={placeholder ?? "name@example.com"}
            aria-invalid={displayError ? true : undefined}
          />
        </InputGroup>
        {displayError ? <FieldDescription className="text-destructive">{displayError}</FieldDescription> : null}
        {submitError ? <FieldDescription className="text-destructive">{submitError}</FieldDescription> : null}
        {description ? <FieldDescription>{description}</FieldDescription> : null}
        {!hideSubmit && (
          <div>
            <Button size="sm" disabled={disabled || submitting || !!displayError} onClick={() => void handleSubmit(localValue)}>
              {submitting ? "Submitting…" : "Continue"}
            </Button>
          </div>
        )}
      </Field>
    );
  }

  // String fallback — textarea or single-line
  if (isLikelyMultiline(schema)) {
    return (
      <div className="flex flex-col gap-2">
        <Label htmlFor={`field-${fieldName}`} className="text-foreground">{label}{required ? " *" : <span className="ml-1 font-normal text-muted-foreground">(optional)</span>}</Label>
        <Textarea
          id={`field-${fieldName}`}
          value={localValue}
          onChange={(e) => setLocalValue(e.target.value)}
          disabled={disabled || submitting}
          rows={5}
          className="border-line"
          placeholder={placeholder}
        />
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
        {callerError ? <p className="text-xs text-destructive">{callerError}</p> : null}
        {submitError ? <p className="text-xs text-destructive">{submitError}</p> : null}
        {!hideSubmit && (
          <div>
            <Button size="sm" disabled={disabled || submitting} onClick={() => void handleSubmit(localValue)}>
              {submitting ? "Submitting…" : "Continue"}
            </Button>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={`field-${fieldName}`} className="text-foreground">{label}{required ? " *" : <span className="ml-1 font-normal text-muted-foreground">(optional)</span>}</Label>
      <Input
        id={`field-${fieldName}`}
        type="text"
        value={localValue}
        onChange={(e) => setLocalValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !submitting) void handleSubmit(localValue); }}
        disabled={disabled || submitting}
        className="border-line"
        placeholder={placeholder}
      />
      {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      {callerError ? <p className="text-xs text-destructive">{callerError}</p> : null}
      {submitError ? <p className="text-xs text-destructive">{submitError}</p> : null}
      {!hideSubmit && (
        <div>
          <Button size="sm" disabled={disabled || submitting} onClick={() => void handleSubmit(localValue)}>
            {submitting ? "Submitting…" : "Continue"}
          </Button>
        </div>
      )}
    </div>
  );
}
