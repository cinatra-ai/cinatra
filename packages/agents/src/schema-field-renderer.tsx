"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { resolveFieldLabel } from "./humanize-field-name";

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
  /**
   * TRUE REGISTRY-BYPASS FLOOR (cinatra#1625, codex convergence 2026-07-20). When
   * set, this renderer does NOT re-enter `fieldRendererRegistry` — it renders the
   * schema-driven fallback directly. This is the ONLY safe way to use
   * SchemaFieldRenderer AS A FLOOR: the registry-first path (below) re-resolves
   * `fieldName`+`schema`, and a HEURISTIC condition (e.g. the gmail-sender
   * sender-name whitelist) matches on the FIELD NAME, so it survives x-renderer
   * stripping and would re-resolve THIS renderer (or the extension wrapper that
   * degrades to it) forever. Stripping `x-renderer` only defeats STRICT-ID
   * conditions; the bypass defeats both. Use `SchemaOnlyFloorRenderer` (below) or
   * pass this flag wherever the floor is rendered (the ExtensionFieldRenderer
   * wrapper + the migrated host KIND-table floors).
   */
  bypassRegistry?: boolean;
};

function isLikelyMultiline(schema: Record<string, unknown>): boolean {
  const explicit = (schema as { ["x-multiline"]?: boolean })["x-multiline"];
  if (typeof explicit === "boolean") return explicit;
  // `format: "multiline"` is the OAS-authorable spelling of the same hint.
  // Both inputSchema pipelines (oas-compiler.ts step 7 and
  // input-schema-resolver.ts deriveFullSchemaFromOas) propagate `format`
  // verbatim from StartNode inputs, so an extension OAS can opt a prose
  // field (e.g. blog-pipeline-agent's `brief`) into textarea rendering
  // without new plumbing. Unrecognized formats are inert everywhere else:
  // the uri/email branches below match exact values and jsonSchemaToZod
  // ignores `format` entirely.
  if ((schema as { format?: string }).format === "multiline") return true;
  const description = (schema as { description?: string }).description ?? "";
  return description.length > 80;
}

// ---------------------------------------------------------------------------
// OBJECT-typed inputs (cinatra#2484)
//
// An `object`-typed input used to fall through every branch below and land on
// the string fallback: one free-text box that accepted a bare sentence and sent
// a type-violating `input_params` into the run (the downstream step then got a
// string where its prompt required `{title, summary, outline}`). Two shapes
// replace that, both of which emit a REAL object (or refuse to submit):
//
//   - `json_schema.properties` declared → STRUCTURED sub-fields
//     (`StructuredObjectField`). Each sub-field re-uses the existing
//     schema-driven rendering, so `array` sub-fields get the repo's
//     one-value-per-line list input for free.
//   - no properties (the schema-less object, e.g. blog-draft-writer@0.1.2)
//     → a JSON textarea (`JsonObjectField`) whose only accepted value is a
//     parseable JSON object. A plain string is refused with a visible message.
// ---------------------------------------------------------------------------

/** Always-visible guidance under a schema-less object input. */
export const OBJECT_INPUT_JSON_HINT =
  'This field expects a JSON object — for example {"title": "…"}.';

/**
 * The REJECTION copy shown when the box holds something that is not a JSON
 * object. Deliberately distinct from the guidance hint above: the two are
 * rendered together, and repeating one sentence twice reads as a glitch rather
 * than as an error.
 */
export const OBJECT_INPUT_NOT_AN_OBJECT_ERROR =
  'This is not a JSON object. Plain text is not accepted — enter an object like {"title": "…"}.';

/** Shown when Continue is pressed on an empty object box. */
export const OBJECT_INPUT_EMPTY_ERROR = "Enter a JSON object for this field.";

/**
 * A sub-object that IS an object but is missing its own required keys. Distinct
 * from OBJECT_INPUT_NOT_AN_OBJECT_ERROR on purpose (codex round 3): telling a
 * user their perfectly well-formed object "is not a JSON object" points them at
 * something that is not wrong.
 */
export const OBJECT_INPUT_INCOMPLETE_ERROR =
  "This object is missing required fields.";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type ParsedObject =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; message: string };

/** Parse the JSON textarea contents. Only a JSON OBJECT is accepted. */
export function parseJsonObjectInput(text: string): ParsedObject {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, message: "Required" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, message: OBJECT_INPUT_NOT_AN_OBJECT_ERROR };
  }
  if (!isPlainObject(parsed)) return { ok: false, message: OBJECT_INPUT_NOT_AN_OBJECT_ERROR };
  return { ok: true, value: parsed };
}

/** A sub-value that is absent, blank, or an empty list counts as "not given". */
function isBlankSubValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * Every declared-schema violation under `schema`, as dotted paths
 * (cinatra#2484, codex round 1).
 *
 * Validation has to RECURSE, not stop at level 1. A nested object's own
 * `StructuredObjectField` assembles `{}` when its required children are blank —
 * a perfectly plain object — so a parent that only asks "is this an object?"
 * accepts a nested object it knows to be incomplete. Enforcing the same two
 * rules at every declared level is what makes the guarantee compositional
 * instead of true only at the top.
 *
 * Two rules, applied at each level:
 *   - a value under a declared `object` is a JSON object (the #2484 invariant);
 *   - a declared-`required` sub-key is not blank.
 *
 * ARRAYS are traversed too (codex round 2). `{type:"array", items:{type:"object"}}`
 * is a declared object schema like any other; skipping it left
 * `{sections: ["bare text"]}` accepted, which is this issue's defect one
 * container deeper.
 *
 * Each error carries a `kind` so the UI can say the right thing: a blank
 * required sub-key is "Required", a type violation is "not a JSON object".
 * Reporting both as the latter mislabels half of them.
 */
export type ObjectSchemaError = { path: string; kind: "missing" | "not-an-object" };

export function collectObjectSchemaErrors(
  schema: Record<string, unknown>,
  value: unknown,
  path: string[] = [],
): ObjectSchemaError[] {
  const type = (schema as { type?: string }).type;

  if (type === "array") {
    const items = (schema as { items?: Record<string, unknown> }).items;
    if (!items || !Array.isArray(value)) return [];
    return value.flatMap((entry, i) =>
      collectObjectSchemaErrors(items, entry, [...path, String(i)]),
    );
  }

  if (type !== "object") return [];
  if (!isPlainObject(value)) {
    return [{ path: path.join("."), kind: "not-an-object" }];
  }

  const properties =
    (schema as { properties?: Record<string, Record<string, unknown>> }).properties ?? {};
  const required = Array.isArray((schema as { required?: unknown }).required)
    ? ((schema as { required: unknown[] }).required.filter(
        (n): n is string => typeof n === "string",
      ))
    : [];

  const errors: ObjectSchemaError[] = [];
  const missing = new Set<string>();
  for (const key of required) {
    if (isBlankSubValue(value[key])) {
      missing.add(key);
      errors.push({ path: [...path, key].join("."), kind: "missing" });
    }
  }
  for (const [key, sub] of Object.entries(properties)) {
    const child = value[key];
    if (child === undefined) continue; // absence is the required check's business
    if (missing.has(key)) continue; // already reported as missing; don't double-report
    errors.push(...collectObjectSchemaErrors(sub, child, [...path, key]));
  }
  return errors;
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
  const { fieldName, schema, value, onChange, disabled, required, error: callerError, context, onBusyChange, saveNow, assistResponseKey, mode, registerFlush, hideSubmit, bypassRegistry } = props;

  const title = (schema as { title?: string }).title;
  const description = (schema as { description?: string }).description;
  const label = resolveFieldLabel(fieldName, title, description);

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
    // Bypass floors own their flush directly — they never delegate to a
    // registry-matched renderer, so the "a matched renderer registers its own
    // flush" guard must not consult the registry (which would re-match a
    // heuristic condition and mis-skip this floor's flush).
    if (!bypassRegistry && fieldRendererRegistry.resolve(fieldName, schema, context)) return;
    const t = (schema as { type?: string }).type;
    const enumVals = (schema as { enum?: unknown[] }).enum;
    if (t === "boolean" || (Array.isArray(enumVals) && enumVals.length > 0)) return;
    // OBJECT-typed inputs (cinatra#2484) render one of the object sub-components
    // below, and EACH registers its own flush (which emits a real object, or the
    // unparseable raw text so the schema layer rejects it). Registering the
    // generic string flush here would overwrite the child's registration — the
    // parent effect runs AFTER the child's — and push a bare string back.
    if (t === "object") return;
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

  // 1) Registry-first — SKIPPED for a bypass floor. A floor that re-entered the
  // registry could re-resolve the very binding whose degrade rendered it (a
  // heuristic condition matches on fieldName and survives x-renderer stripping),
  // recursing until crash — the opposite of the AC4 never-blank/never-crash
  // floor. `bypassRegistry` renders the schema-driven fallback directly.
  const matched = bypassRegistry
    ? null
    : fieldRendererRegistry.resolve(fieldName, schema, context);
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

  // Object -> structured sub-fields (properties declared) or a JSON textarea.
  // NEVER the plain string fallback: that is the cinatra#2484 defect.
  if (type === "object") {
    const objectProperties = (schema as {
      properties?: Record<string, Record<string, unknown>>;
    }).properties;
    const shared = {
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
      hideSubmit,
      registerFlush,
    };
    if (objectProperties && Object.keys(objectProperties).length > 0) {
      return <StructuredObjectField {...shared} />;
    }
    return <JsonObjectField {...shared} />;
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

// ---------------------------------------------------------------------------
// Object sub-renderers (cinatra#2484)
// ---------------------------------------------------------------------------

type ObjectFieldProps = {
  fieldName: string;
  schema: Record<string, unknown>;
  value: unknown;
  onChange: (next: unknown) => void;
  disabled?: boolean;
  required?: boolean;
  error?: string | null;
  label: string;
  description?: string;
  context: FieldRendererContext;
  hideSubmit?: boolean;
  registerFlush?: (fn: () => Promise<void>) => void;
};

/**
 * STRUCTURED object input — the `json_schema.properties` leg.
 *
 * Renders one sub-field per declared property (re-using the schema-driven
 * rendering below the registry, so `string` gets an input/textarea and `array`
 * gets the existing one-value-per-line list input) and emits a REAL object.
 * Required sub-properties (`json_schema.required`) are enforced here so the
 * per-field Setup surface — which has no Zod layer around it — cannot submit an
 * incomplete object either.
 *
 * Sub-fields render through the registry BYPASS floor: a sub-property name is
 * an agent-authored key like `title`/`senderName`, and a heuristic registry
 * condition matching on field NAME would otherwise hijack it with a renderer
 * that knows nothing about this object.
 */
function StructuredObjectField(props: ObjectFieldProps) {
  const {
    fieldName, schema, value, onChange, disabled, required, error,
    label, description, context, hideSubmit, registerFlush,
  } = props;

  const properties = useMemo(
    () =>
      ((schema as { properties?: Record<string, Record<string, unknown>> })
        .properties ?? {}) as Record<string, Record<string, unknown>>,
    [schema],
  );
  const visible = useMemo(
    () =>
      Object.keys(properties).filter(
        (name) => !(properties[name] as { "x-hidden"?: boolean })["x-hidden"],
      ),
    [properties],
  );

  // Requiredness is enforced only over sub-fields the user can actually SEE
  // (codex round 3). A required `x-hidden` property renders no input, so
  // validating it would deadlock the form: permanently blocked on a field that
  // is never shown and can never be filled. Hidden values arrive pre-seeded or
  // not at all; either way the server-side guard is the backstop, not this form.
  const subRequired = useMemo(() => {
    const declared = Array.isArray((schema as { required?: unknown }).required)
      ? ((schema as { required: unknown[] }).required.filter(
          (n): n is string => typeof n === "string",
        ))
      : [];
    return declared.filter((n) => visible.includes(n));
  }, [schema, visible]);

  const ordered = useMemo(
    () => [
      ...subRequired.filter((n) => visible.includes(n)),
      ...visible.filter((n) => !subRequired.includes(n)),
    ],
    [visible, subRequired],
  );

  // `value` IS this field's own value on every surface: the grouped form passes
  // `field.value`, and the per-field panels unwrap their envelope at the call
  // site (`setupFieldRendererValue`, cinatra#2484 codex round 2). The
  // declared-key filter is belt-and-braces against a stray extra key, NOT an
  // envelope defence — guessing provenance in the renderer was unsound and the
  // heuristic that tried it is gone.
  const [draft, setDraft] = useState<Record<string, unknown>>(() => {
    if (!isPlainObject(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([k]) => k in properties));
  });
  const draftRef = useRef(draft);
  const setSub = useCallback((key: string, next: unknown) => {
    draftRef.current = { ...draftRef.current, [key]: next };
    setDraft(draftRef.current);
  }, []);

  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  const subFlushes = useRef<Map<string, () => Promise<void>>>(new Map());
  const registerSubFlush = useCallback(
    (name: string) => (fn: () => Promise<void>) => {
      subFlushes.current.set(name, fn);
    },
    [],
  );

  const [missing, setMissing] = useState<string[]>([]);
  const [invalid, setInvalid] = useState<string[]>([]);
  // Sub-objects that ARE objects but whose own required keys are blank — a
  // different problem from `invalid`, and told apart so the copy is accurate.
  const [incomplete, setIncomplete] = useState<string[]>([]);
  const [showErrors, setShowErrors] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Drop blank OPTIONAL sub-values so the run never receives `summary: ""`;
  // blank REQUIRED sub-values are kept so the schema layer sees them missing.
  const assemble = useCallback((raw: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(properties)) {
      const v = raw[key];
      if (v === undefined) continue;
      if (!subRequired.includes(key) && isBlankSubValue(v)) continue;
      out[key] = v;
    }
    return out;
  }, [properties, subRequired]);

  const flushSubFields = useCallback(async () => {
    await Promise.all([...subFlushes.current.values()].map((fn) => fn()));
    return assemble(draftRef.current);
  }, [assemble]);

  /**
   * Sub-properties that are THEMSELVES declared `type: "object"` but hold
   * something that violates their own declared schema (cinatra#2484, codex
   * round 1). Two distinct failures live here:
   *
   *  - a nested SCHEMA-LESS object renders its own JSON box, whose flush
   *    deliberately pushes the RAW unparseable text so the grouped Zod layer can
   *    reject it. On the per-field Setup surface there is NO Zod layer, and the
   *    server's type gate only inspects the TOP-LEVEL input — it sees `idea` is
   *    an object and waves a nested `{details: "bare text"}` straight through.
   *  - a nested STRUCTURED object assembles `{}` when its own required children
   *    are blank. That IS a plain object, so a "is it an object?" check passes it
   *    — and an object known to be incomplete gets submitted.
   *
   * `collectObjectSchemaErrors` applies both rules at EVERY declared level, so
   * the guarantee is compositional rather than true only at the top. Paths come
   * back dotted (`details.metadata`); the first segment is the sub-field to mark.
   */
  const nestedErrors = useCallback(
    (assembled: Record<string, unknown>) => {
      // Drop ONLY level-1 `missing` — that is `subRequired`'s job, and it drives
      // the per-sub-field "Required" markers. Everything else is kept, including
      // a level-1 TYPE violation (`details` holding raw text): its path has no
      // dot, so filtering by depth alone silently discarded exactly the error
      // this field exists to report.
      const errors = collectObjectSchemaErrors({ type: "object", properties }, assembled).filter(
        (e) => e.path.includes(".") || e.kind !== "missing",
      );
      // Keep the two KINDS apart (codex round 3). A sub-object that is merely
      // INCOMPLETE ("details.title is blank") is not the same problem as one
      // that is not an object at all, and reporting both as "expects a JSON
      // object" tells the user to fix something that is not wrong. Dedupe by
      // first path segment so several errors inside one sub-object mark it once.
      const firstSegments = (kind: ObjectSchemaError["kind"]) =>
        [...new Set(errors.filter((e) => e.kind === kind).map((e) => e.path.split(".")[0]!))]
          .filter((k) => k in properties);
      const notObject = firstSegments("not-an-object");
      // A sub-object already flagged as "not an object" is not ALSO "incomplete".
      const incomplete = firstSegments("missing").filter((k) => !notObject.includes(k));
      return { notObject, incomplete };
    },
    [properties],
  );

  // The flush is registered ONCE (its identity must stay stable), but it has to
  // validate against the CURRENT schema — `properties`/`required` can change
  // without a remount. Route the body through a ref so the registration is
  // stable while the rules it applies are always the latest.
  const validate = useCallback(
    (assembled: Record<string, unknown>) => {
      const { notObject, incomplete } = nestedErrors(assembled);
      return {
        miss: subRequired.filter((k) => isBlankSubValue(assembled[k])),
        bad: notObject,
        incomplete,
      };
    },
    [subRequired, nestedErrors],
  );
  const validateRef = useRef(validate);
  useEffect(() => { validateRef.current = validate; }, [validate]);
  const flushRef = useRef(flushSubFields);
  useEffect(() => { flushRef.current = flushSubFields; }, [flushSubFields]);

  useEffect(() => {
    if (!registerFlush) return;
    registerFlush(async () => {
      const assembled = await flushRef.current();
      const { miss, bad, incomplete } = validateRef.current(assembled);
      setMissing(miss);
      setInvalid(bad);
      setIncomplete(incomplete);
      // Surface ALL classes — an invalid or incomplete nested object is as
      // blocking as a missing required field, so hiding its message would leave
      // the user with a form that refuses to advance and says nothing about why.
      if (miss.length > 0 || bad.length > 0 || incomplete.length > 0) setShowErrors(true);
      onChangeRef.current(assembled);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerFlush]); // stable — refs always read the latest draft AND schema

  const handleContinue = async () => {
    const assembled = await flushRef.current();
    const { miss, bad, incomplete: inc } = validateRef.current(assembled);
    setMissing(miss);
    setInvalid(bad);
    setIncomplete(inc);
    const blocked = miss.length > 0 || bad.length > 0 || inc.length > 0;
    setShowErrors(blocked);
    if (blocked) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onChange(assembled);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Could not submit. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-3" data-testid={`object-field-${fieldName}`}>
      <div className="flex flex-col gap-1">
        <Label className="text-foreground">
          {label}
          {required ? " *" : <span className="ml-1 font-normal text-muted-foreground">(optional)</span>}
        </Label>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      <div className="flex flex-col gap-4 rounded-control border border-line p-3">
        {ordered.map((key) => (
          <SchemaOnlyFloorRenderer
            key={key}
            fieldName={key}
            schema={properties[key] ?? {}}
            value={draft[key]}
            onChange={(next: unknown) => setSub(key, next)}
            disabled={disabled || submitting}
            required={subRequired.includes(key)}
            error={
              showErrors && missing.includes(key)
                ? "Required"
                : showErrors && invalid.includes(key)
                  ? OBJECT_INPUT_NOT_AN_OBJECT_ERROR
                  : showErrors && incomplete.includes(key)
                    ? OBJECT_INPUT_INCOMPLETE_ERROR
                    : null
            }
            context={context}
            mode="edit"
            hideSubmit
            registerFlush={registerSubFlush(key)}
          />
        ))}
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {showErrors && missing.length > 0 ? (
        <p className="text-xs text-destructive">
          Fill in the required {missing.length === 1 ? "field" : "fields"}: {missing.join(", ")}.
        </p>
      ) : null}
      {showErrors && invalid.length > 0 ? (
        <p className="text-xs text-destructive">
          {invalid.length === 1 ? "This field expects" : "These fields expect"} a JSON
          object: {invalid.join(", ")}.
        </p>
      ) : null}
      {showErrors && incomplete.length > 0 ? (
        <p className="text-xs text-destructive">
          Complete the required {incomplete.length === 1 ? "field" : "fields"} in:{" "}
          {incomplete.join(", ")}.
        </p>
      ) : null}
      {submitError ? <p className="text-xs text-destructive">{submitError}</p> : null}
      {!hideSubmit && (
        <div>
          <Button size="sm" disabled={disabled || submitting} onClick={() => void handleContinue()}>
            {submitting ? "Submitting…" : "Continue"}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * SCHEMA-LESS object input — the validation leg.
 *
 * The input declares `type: "object"` but carries no `json_schema.properties`
 * (blog-draft-writer@0.1.2 is the canonical case), so there are no sub-fields
 * to build. The field's only representation is text, so the honest contract is
 * a JSON textarea: a parseable JSON OBJECT is accepted and forwarded as a real
 * object; anything else — a bare sentence above all — is refused with a visible
 * message and never submitted.
 *
 * On the grouped Setup form the unparseable text is ALSO pushed into form state
 * so the Zod layer rejects it independently; the server-side setup-resume path
 * rejects it a third time (review-task-actions), so no surface can smuggle a
 * string into an object-typed input.
 */
function JsonObjectField(props: ObjectFieldProps) {
  const {
    fieldName, value, onChange, disabled, required, error,
    label, description, hideSubmit, registerFlush,
  } = props;

  // `value` IS this field's own value on every surface — the per-field panels
  // unwrap their envelope at the call site (`setupFieldRendererValue`,
  // cinatra#2484 codex round 2), so this branch no longer has to guess.
  //
  // A string seeds verbatim (so a half-typed entry, or the value the old
  // free-text fallback stored, is visible and correctable rather than
  // vanishing); an already-OBJECT value renders as pretty JSON so a run's own
  // saved input is not silently blanked and then wiped on re-submit.
  const [text, setText] = useState<string>(() => {
    if (typeof value === "string") return value;
    if (isPlainObject(value)) return JSON.stringify(value, null, 2);
    return "";
  });
  const textRef = useRef(text);
  useEffect(() => { textRef.current = text; }, [text]);

  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  // The flush is registered once; `required` decides what an EMPTY box pushes,
  // and it can change without a remount, so read it through a ref rather than
  // the mount-time closure (codex round 2).
  const requiredRef = useRef(required);
  useEffect(() => { requiredRef.current = required; }, [required]);

  const [showRequired, setShowRequired] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const parsed = useMemo(() => parseJsonObjectInput(text), [text]);
  const isEmpty = text.trim() === "";
  // The shape error is shown as soon as the user types something unparseable;
  // the empty-box message only after a submit attempt.
  const shapeError = !isEmpty && !parsed.ok ? parsed.message : null;
  const emptyError = isEmpty && showRequired ? OBJECT_INPUT_EMPTY_ERROR : null;
  const displayError = error ?? shapeError ?? emptyError;

  useEffect(() => {
    if (!registerFlush) return;
    registerFlush(async () => {
      const raw = textRef.current;
      if (raw.trim() === "") {
        // Required + empty pushes "" (rejected by the object schema); optional +
        // empty pushes undefined so the key is simply absent.
        onChangeRef.current(requiredRef.current ? "" : undefined);
        return;
      }
      const result = parseJsonObjectInput(raw);
      onChangeRef.current(result.ok ? result.value : raw);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerFlush]); // stable — refs always read the latest text AND requiredness

  const handleContinue = async () => {
    const raw = textRef.current;
    if (raw.trim() === "") {
      // An empty box is not an object, so the visible Continue NEVER submits it —
      // independently of `required`. The per-field Setup surface does not pass
      // `required` at all (agentic-run-panel renders the gate's single field
      // without it), so keying this on `required` would let a blank box submit
      // `undefined` for a genuinely required input — which the setup-resume path
      // then cannot serialize. Requiredness is not what makes a bare "" invalid
      // here; the declared `object` type is.
      setShowRequired(true);
      return;
    }
    const result = parseJsonObjectInput(raw);
    if (!result.ok) return; // shapeError is already visible — never submit a non-object
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onChange(result.value);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Could not submit. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={`field-${fieldName}`} className="text-foreground">
        {label}
        {required ? " *" : <span className="ml-1 font-normal text-muted-foreground">(optional)</span>}
      </Label>
      <Textarea
        id={`field-${fieldName}`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={disabled || submitting}
        rows={5}
        className="border-line font-mono text-xs"
        placeholder={'{\n  "title": "…"\n}'}
        aria-invalid={displayError ? true : undefined}
      />
      <p className="text-xs text-muted-foreground">{OBJECT_INPUT_JSON_HINT}{description ? ` ${description}` : ""}</p>
      {displayError ? <p className="text-xs text-destructive">{displayError}</p> : null}
      {submitError ? <p className="text-xs text-destructive">{submitError}</p> : null}
      {!hideSubmit && (
        <div>
          <Button
            size="sm"
            disabled={disabled || submitting || !!shapeError}
            onClick={() => void handleContinue()}
          >
            {submitting ? "Submitting…" : "Continue"}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * The canonical TRUE registry-bypass floor (cinatra#1625, codex convergence
 * 2026-07-20). `SchemaFieldRenderer` with `bypassRegistry` forced on: it renders
 * the schema-driven fallback WITHOUT re-entering `fieldRendererRegistry`, so no
 * condition — strict-id OR the sender-name HEURISTIC — can re-resolve the binding
 * whose degrade produced this floor. Register THIS (never the raw
 * `SchemaFieldRenderer`) as a migrated host KIND-table floor, and render it as
 * the ExtensionFieldRenderer wrapper's degrade fallback. Behaviour-preserving vs
 * the raw floor's OUTPUT (same schema-driven UI); it only removes the recursion
 * hazard and the reliance on every caller stripping `x-renderer` first.
 */
export function SchemaOnlyFloorRenderer(props: Omit<Props, "bypassRegistry">) {
  return <SchemaFieldRenderer {...props} bypassRegistry />;
}
