"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowRight, LinkIcon, MailIcon } from "lucide-react";
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

/**
 * THE CONTROL FLOOR EVERY GATE PAGE DRAWS (cinatra#3047 fix leg 8).
 *
 * The ratified drawing, `specs/app-artifact-review.html` section I: "the
 * primary Continue, right-aligned over a hairline floor: the same control
 * floor every gate page draws". The drawing's own markup for that floor is a
 * right-aligned row over a one-pixel line rule, with the arrow glyph after the
 * word — which is exactly what the approval card's own floor already draws
 * (`flex justify-end pt-2 border-t border-line`, `ArrowRight` after the label).
 *
 * Every single-field branch below wrapped its submit in a bare box instead:
 * left-aligned, no rule, no glyph. On the run page's input step that box IS the
 * gate's floor — there is no other control on the page — so the eighth proof
 * round photographed a gate whose Continue stood on nothing. One floor, stated
 * once and taken by every branch, so the renderer cannot drift from the card.
 *
 * `hideSubmit` is unchanged: where the form owns the one control, no floor is
 * drawn at all, because the floor belongs to whoever draws the control.
 */
function GateControlFloor({ children }: { children: ReactNode }) {
  return <div className="flex justify-end pt-2 border-t border-line">{children}</div>;
}

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
//   - `x-object-text-property` declared → ONE text control
//     (`SingleTextObjectField`). See its own docblock below.
//   - `json_schema.properties` declared → STRUCTURED sub-fields
//     (`StructuredObjectField`). Each sub-field re-uses the existing
//     schema-driven rendering, so `array` sub-fields get the repo's
//     one-value-per-line list input for free.
//   - no properties (the schema-less object, e.g. blog-draft-writer@0.1.2)
//     → a JSON textarea (`JsonObjectField`) whose only accepted value is a
//     parseable JSON object. A plain string is refused with a visible message.
// ---------------------------------------------------------------------------

/**
 * The OAS-authorable hint that collapses an object input to ONE text control.
 *
 * An extension writes it on the input's own `json_schema`, naming ONE declared
 * `string` sub-property:
 *
 *     "json_schema": {
 *       "x-object-text-property": "title",
 *       "properties": { "title": {"type": "string"}, … },
 *       "required": ["title"]
 *     }
 *
 * Both inputSchema pipelines (`oas-compiler.ts` step 7 and
 * `input-schema-resolver.ts` `deriveFullSchemaFromOas`) copy every `x-…` key
 * from `json_schema` onto the compiled property verbatim, so no new plumbing is
 * needed per hint.
 *
 * The hint is a PRESENTATION statement, never a contract change: the emitted
 * value is still a real object. It exists because a structured object form is
 * the wrong surface for an input a human writes as one thought — an "idea", a
 * "brief" — while the DOWNSTREAM contract stays an object the rest of the
 * pipeline can fill key by key.
 */
export const OBJECT_TEXT_PROPERTY_KEY = "x-object-text-property";

/**
 * Resolve the single-text property for an object schema, or `null`.
 *
 * FAILS SAFE: the hint is honored only when it names a declared `string`
 * sub-property. A hint pointing at an undeclared key, at a non-string, or at
 * nothing leaves the object on the structured/JSON legs rather than rendering a
 * control that would emit a value the schema rejects.
 */
export function resolveObjectTextProperty(
  schema: Record<string, unknown>,
): string | null {
  const declared = (schema as Record<string, unknown>)[OBJECT_TEXT_PROPERTY_KEY];
  if (typeof declared !== "string" || declared.trim() === "") return null;
  const properties = (schema as {
    properties?: Record<string, Record<string, unknown>>;
  }).properties;
  if (!properties || typeof properties !== "object") return null;
  const target = properties[declared] as { type?: string } | undefined;
  if (!target || target.type !== "string") return null;
  return declared;
}

/**
 * Shown when the single-text object control is submitted empty. Names the FIELD
 * — "Idea is required." — because the whole point of this leg is that the user
 * sees one field with one name; an error mentioning a sub-key they were never
 * shown ("title is required") would point at something that is not on screen.
 */
export function objectTextPropertyRequiredError(label: string): string {
  return `${label} is required.`;
}

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

/**
 * Is this object field one the SURFACE explicitly declared optional?
 *
 * Three states, not two (cinatra#2484 review round). `required === false` is a
 * DECLARATION — the grouped Setup form passes `required={isRequired}` for every
 * field and `StructuredObjectField` passes `required={subRequired.includes(key)}`
 * for every sub-field — and a field declared optional must be omittable: leaving
 * it empty submits nothing for it rather than blocking the form. `required ===
 * undefined` is the ABSENCE of a declaration, which is not the same claim: the
 * per-field Setup panels render the gate's single field without the prop, and
 * the setup interrupt loop only ever prompts for REQUIRED fields
 * (`pendingFields = requiredFields.filter(...)` in execution.ts). Treating that
 * silence as "optional" would let a blank box submit `undefined` for a genuinely
 * required input, so an undeclared field FAILS CLOSED and keeps the empty-object
 * rejection.
 */
function isDeclaredOptional(required: boolean | undefined): boolean {
  return required === false;
}

/**
 * Blank ALL THE WAY DOWN — the test for "the user gave this object nothing".
 *
 * `isBlankSubValue` stops at the top level, and an untouched NESTED object does
 * not assemble to nothing: its own sub-field flushes push `""` for each declared
 * string, so a blank `{details: {depth: ""}}` looks non-blank to a shallow check
 * and an optional parent could not be omitted (codex round, PR #2510). Recursing
 * through objects and arrays is what makes "untouched" mean the same thing at
 * every depth. A `0` or `false` leaf is NOT blank — those are answers.
 */
function isDeeplyBlankValue(value: unknown): boolean {
  if (isBlankSubValue(value)) return true;
  if (Array.isArray(value)) return value.every(isDeeplyBlankValue);
  if (isPlainObject(value)) return Object.values(value).every(isDeeplyBlankValue);
  return false;
}

/**
 * A stable, order-independent key for "did this value actually change?".
 *
 * Used ONLY to decide whether the PARENT replaced an object field's `value`,
 * never for anything user-visible. Identity comparison is useless here: the
 * per-field panels build `value` inline
 * (`setupFieldRendererValue({ ...currentValues, ...bufferedHitlValue }, …)`),
 * so a fresh object arrives on every parent render and an identity-keyed sync
 * would wipe the sub-fields the user is in the middle of filling.
 */
function valueIdentityKey(value: unknown): string {
  if (value === undefined || typeof value === "function") return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(valueIdentityKey).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${valueIdentityKey(v)}`)
    .join(",")}}`;
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
    // An extension may declare that this object is written as ONE thought. The
    // hint is checked FIRST because it is a narrower statement than "has
    // properties" — and it is honored only when it names a declared string
    // sub-property, so an unusable hint degrades to the structured leg below.
    const textProperty = resolveObjectTextProperty(schema);
    if (textProperty) {
      return <SingleTextObjectField {...shared} textProperty={textProperty} />;
    }
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
          <GateControlFloor>
            <Button className="gap-1.5" size="sm" disabled={disabled || submitting || !!displayError} onClick={() => void submitNum()}>
              {submitting ? "Submitting…" : "Continue"}
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </GateControlFloor>
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
          <GateControlFloor>
            <Button className="gap-1.5" size="sm" disabled={disabled || submitting} onClick={() => void handleSubmit(localValue.split("\n").map((s) => s.trim()).filter(Boolean))}>
              {submitting ? "Submitting…" : "Continue"}
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </GateControlFloor>
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
          <GateControlFloor>
            <Button className="gap-1.5" size="sm" disabled={disabled || submitting || !!displayError} onClick={() => void handleSubmit(localValue)}>
              {submitting ? "Submitting…" : "Continue"}
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </GateControlFloor>
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
          <GateControlFloor>
            <Button className="gap-1.5" size="sm" disabled={disabled || submitting || !!displayError} onClick={() => void handleSubmit(localValue)}>
              {submitting ? "Submitting…" : "Continue"}
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </GateControlFloor>
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
          <GateControlFloor>
            <Button className="gap-1.5" size="sm" disabled={disabled || submitting} onClick={() => void handleSubmit(localValue)}>
              {submitting ? "Submitting…" : "Continue"}
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </GateControlFloor>
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
        <GateControlFloor>
          <Button className="gap-1.5" size="sm" disabled={disabled || submitting} onClick={() => void handleSubmit(localValue)}>
            {submitting ? "Submitting…" : "Continue"}
            <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </GateControlFloor>
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
 * SINGLE-TEXT object input — the `x-object-text-property` leg.
 *
 * ONE visible editable control, named after the FIELD (not after a sub-key),
 * whose text becomes one declared string property of a real object. The
 * downstream contract is unchanged: what leaves this control is
 * `{…carried, [textProperty]: text}`, never a bare string, so the cinatra#2484
 * invariant ("an object-typed input never submits a string") holds here exactly
 * as it does on the structured and JSON legs.
 *
 * Three behaviours are worth naming:
 *
 *   - COMPANION KEYS SURVIVE. A run seeded from an upstream producer can arrive
 *     with the whole object (`{title, summary, outline}`). Emitting only the
 *     text property would silently DELETE the companions, so the incoming
 *     declared keys are carried and only the text property is overwritten. A
 *     fresh setup form (no incoming value) therefore emits exactly the minimum
 *     object — the one the schema declares required.
 *   - EMPTY FAILS LOUD. A blank box on a field that is not declared-optional
 *     does not submit: Continue shows a visible error naming the field, and the
 *     grouped-form flush pushes the object WITHOUT the text property so the Zod
 *     layer refuses it independently. Same two-layer refusal as JsonObjectField.
 *   - DECLARED-OPTIONAL STILL OMITS. `required === false` is a declaration that
 *     the field may be skipped, so a blank box submits `undefined` and the key
 *     is absent. Absence of the prop is NOT such a declaration — see
 *     `isDeclaredOptional`.
 */
function SingleTextObjectField(props: ObjectFieldProps & { textProperty: string }) {
  const {
    fieldName, schema, value, onChange, disabled, required, error,
    label, description, hideSubmit, registerFlush, textProperty,
  } = props;

  const properties = useMemo(
    () =>
      ((schema as { properties?: Record<string, Record<string, unknown>> })
        .properties ?? {}) as Record<string, Record<string, unknown>>,
    [schema],
  );

  /**
   * The declared companion keys this control must not destroy. Filtered to
   * DECLARED properties (a stray extra key is not this field's to forward) and
   * with the text property removed — that one is always rewritten from the box.
   */
  const carried = useMemo(() => {
    if (!isPlainObject(value)) return {} as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(value).filter(
        ([k]) => k in properties && k !== textProperty && !isDeeplyBlankValue(value[k]),
      ),
    );
  }, [value, properties, textProperty]);

  /**
   * What the box shows. An object value shows its own text property; a STRING
   * value shows verbatim, so a half-typed entry (or a value the pre-hint
   * rendering stored) is visible and correctable rather than vanishing.
   */
  const seed = useMemo(() => {
    if (typeof value === "string") return value;
    if (isPlainObject(value)) {
      const own = value[textProperty];
      return typeof own === "string" ? own : "";
    }
    return "";
  }, [value, textProperty]);

  const [text, setText] = useState<string>(seed);
  const textRef = useRef(text);
  useEffect(() => { textRef.current = text; }, [text]);

  // Re-sync only when the EXTERNAL value changes (mirrors the string branch).
  // Typing never moves `seed`, so this cannot fight the user mid-sentence.
  const syncedSeedRef = useRef(seed);
  useEffect(() => {
    if (seed === syncedSeedRef.current) return;
    syncedSeedRef.current = seed;
    setText(seed);
  }, [seed]);

  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  // Requiredness decides what an EMPTY box emits and can change without a
  // remount, so read it through a ref rather than the mount-time closure
  // (mirrors JsonObjectField and StructuredObjectField).
  const requiredRef = useRef(required);
  useEffect(() => { requiredRef.current = required; }, [required]);

  const buildValue = useCallback(
    (raw: string): Record<string, unknown> => {
      const trimmed = raw.trim();
      const out: Record<string, unknown> = { ...carried };
      if (trimmed !== "") out[textProperty] = trimmed;
      return out;
    },
    [carried, textProperty],
  );
  const buildValueRef = useRef(buildValue);
  useEffect(() => { buildValueRef.current = buildValue; }, [buildValue]);

  const [showRequired, setShowRequired] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const isEmpty = text.trim() === "";
  const displayError =
    error ?? (isEmpty && showRequired ? objectTextPropertyRequiredError(label) : null);

  useEffect(() => {
    if (!registerFlush) return;
    registerFlush(async () => {
      const raw = textRef.current;
      if (raw.trim() === "") {
        if (isDeclaredOptional(requiredRef.current)) {
          onChangeRef.current(undefined);
          return;
        }
        // Push the object WITHOUT the text property: the Zod layer sees the
        // required key missing and refuses to advance, and the local message
        // below tells the user which field it was.
        setShowRequired(true);
        onChangeRef.current(buildValueRef.current(""));
        return;
      }
      onChangeRef.current(buildValueRef.current(raw));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerFlush]); // stable — refs always read the latest text AND requiredness

  const handleContinue = async () => {
    const raw = textRef.current;
    if (raw.trim() === "") {
      if (!isDeclaredOptional(required)) {
        setShowRequired(true);
        return;
      }
      setShowRequired(false);
      setSubmitting(true);
      setSubmitError(null);
      try {
        await onChange(undefined);
      } catch (err) {
        setSubmitError(err instanceof Error ? err.message : "Could not submit. Please try again.");
      } finally {
        setSubmitting(false);
      }
      return;
    }
    setShowRequired(false);
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onChange(buildValue(raw));
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Could not submit. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const placeholder = (schema as { ["x-placeholder"]?: string })["x-placeholder"];
  const multiline = isLikelyMultiline(schema);
  const controlProps = {
    id: `field-${fieldName}`,
    value: text,
    onChange: (e: { target: { value: string } }) => {
      setText(e.target.value);
      if (showRequired) setShowRequired(false);
    },
    disabled: disabled || submitting,
    placeholder,
    className: "border-line",
    "aria-invalid": displayError ? true : undefined,
  };

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={`field-${fieldName}`} className="text-foreground">
        {label}
        {required ? " *" : <span className="ml-1 font-normal text-muted-foreground">(optional)</span>}
      </Label>
      {multiline ? (
        <Textarea {...controlProps} rows={4} />
      ) : (
        <Input {...controlProps} type="text" />
      )}
      {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      {displayError ? <p className="text-xs text-destructive">{displayError}</p> : null}
      {submitError ? <p className="text-xs text-destructive">{submitError}</p> : null}
      {!hideSubmit && (
        <GateControlFloor>
          <Button className="gap-1.5" size="sm" disabled={disabled || submitting} onClick={() => void handleContinue()}>
            {submitting ? "Submitting…" : "Continue"}
            <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </GateControlFloor>
      )}
    </div>
  );
}

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
  const deriveDraft = useCallback(
    (raw: unknown): Record<string, unknown> => {
      if (!isPlainObject(raw)) return {};
      return Object.fromEntries(Object.entries(raw).filter(([k]) => k in properties));
    },
    [properties],
  );

  const [draft, setDraft] = useState<Record<string, unknown>>(() => deriveDraft(value));
  const draftRef = useRef(draft);
  const setSub = useCallback((key: string, next: unknown) => {
    draftRef.current = { ...draftRef.current, [key]: next };
    setDraft(draftRef.current);
  }, []);

  // Tracks the last `value` this field synced FROM. See the sync effect below,
  // which is placed after `clearErrors` so it can drop now-stale markers.
  const syncedValueKeyRef = useRef<string>(valueIdentityKey(deriveDraft(value)));

  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  // The flush is registered once; requiredness decides what an UNTOUCHED object
  // emits and can change without a remount, so read it through a ref rather than
  // the mount-time closure (mirrors JsonObjectField).
  const requiredRef = useRef(required);
  useEffect(() => { requiredRef.current = required; }, [required]);

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

  /**
   * An object field the surface declared OPTIONAL and the user left entirely
   * blank is OMITTED — `undefined`, so the key is simply absent from the payload
   * — instead of being validated (cinatra#2484 review round).
   *
   * Without this an optional object carrying its own `required` sub-keys could
   * not be skipped at all: an untouched field assembles `{}`, `{}` fails the
   * sub-required check, and the grouped form refuses to advance over a field the
   * user was never obliged to fill. "Entirely blank" is judged on the assembled
   * value and RECURSIVELY (`isDeeplyBlankValue`), so a field that was typed into
   * and then cleared — and an untouched nested object whose own flush pushed
   * `{depth: ""}` — omit the same way a never-touched one does. Partially filled
   * stays validated: you either omit the object or complete it.
   */
  const omittableEmpty = useCallback(
    (assembled: Record<string, unknown>) =>
      isDeclaredOptional(requiredRef.current) &&
      Object.values(assembled).every(isDeeplyBlankValue),
    [],
  );

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
  const omittableEmptyRef = useRef(omittableEmpty);
  useEffect(() => { omittableEmptyRef.current = omittableEmpty; }, [omittableEmpty]);

  /**
   * Clear every blocking marker — the field turned out to be omitted, or the
   * parent replaced the value the markers were computed against.
   *
   * Each setter preserves the existing reference when it is already empty, so
   * calling this on a no-op sync cannot cascade a render.
   */
  const clearErrors = useCallback(() => {
    const emptied = (prev: string[]) => (prev.length === 0 ? prev : []);
    setMissing(emptied);
    setInvalid(emptied);
    setIncomplete(emptied);
    setShowErrors(false);
  }, []);
  const clearErrorsRef = useRef(clearErrors);
  useEffect(() => { clearErrorsRef.current = clearErrors; }, [clearErrors]);

  // Re-sync `draft` when the PARENT replaces `value` (cinatra#2484 review round).
  //
  // The initializer above ran ONCE. The string/number/array branches of
  // SchemaFieldRenderer reconcile through the `value` effect near the top of the
  // file; this field had no equivalent, so an AI-assist suggestion merged into
  // `bufferedHitlValue` — which both panels spread into the renderer's `value` —
  // reached `value` and stopped there, never appearing in the rendered
  // sub-fields.
  //
  // Gated on the VALUE changing, not on the `value` prop's identity: the panels
  // rebuild that object every render (see `valueIdentityKey`). An in-progress
  // edit never reaches `value` — sub-fields buffer through `registerFlush` and
  // `setSub` keeps them local — so "the serialized value actually changed" is
  // precisely the parent-drove-this signal, and typing is never clobbered.
  //
  // The incoming value is MERGED over the draft rather than replacing it, which
  // is where an object field has to diverge from the scalar branches above. A
  // scalar has ONE slot, so replacing it is the whole update; an object has
  // independent slots and a parent update mentions only some of them — the
  // panel-side apply handler merges suggestions into the buffer for exactly this
  // reason ("unmentioned keys are preserved; suggestion values override matching
  // user edits intentionally"). Replacing wholesale would delete a sub-field the
  // user was half-way through typing merely because the suggestion did not
  // mention it. Incoming still wins on the keys it does mention, and the result
  // is re-filtered through `deriveDraft` so a key belonging to a PREVIOUS
  // field's schema cannot survive a schema change.
  //
  // KNOWN LIMIT of value-keyed reconciliation, shared with every other branch of
  // this component (codex round 2, PR #2510): a parent that re-applies EXACTLY
  // the value last synced is indistinguishable from an ordinary re-render, so a
  // local edit made in between wins. The scalar effect above has the same hole
  // for the same reason — a `value` prop that does not change cannot signal
  // "apply me again". Closing it needs an explicit revision counter from the
  // panels (`assistResponseKey` is declared on the props for this, but no caller
  // passes it today), which is panel plumbing, not a renderer fix.
  useEffect(() => {
    const incoming = deriveDraft(value);
    const key = valueIdentityKey(incoming);
    if (key === syncedValueKeyRef.current) return;
    syncedValueKeyRef.current = key;
    const merged = deriveDraft({ ...draftRef.current, ...incoming });
    draftRef.current = merged;
    setDraft(merged);
    // The markers were computed against the value the parent just replaced, so
    // they no longer describe what is on screen. Recomputed on the next
    // Continue/flush.
    clearErrorsRef.current();
  }, [value, deriveDraft]);

  useEffect(() => {
    if (!registerFlush) return;
    registerFlush(async () => {
      const assembled = await flushRef.current();
      if (omittableEmptyRef.current(assembled)) {
        clearErrorsRef.current();
        onChangeRef.current(undefined);
        return;
      }
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
    // A declared-optional field left entirely blank submits NOTHING for itself
    // rather than being validated — see `omittableEmpty`.
    const omitted = omittableEmpty(assembled);
    if (!omitted) {
      const { miss, bad, incomplete: inc } = validateRef.current(assembled);
      setMissing(miss);
      setInvalid(bad);
      setIncomplete(inc);
      const blocked = miss.length > 0 || bad.length > 0 || inc.length > 0;
      setShowErrors(blocked);
      if (blocked) return;
    } else {
      clearErrors();
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onChange(omitted ? undefined : assembled);
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
        <GateControlFloor>
          <Button className="gap-1.5" size="sm" disabled={disabled || submitting} onClick={() => void handleContinue()}>
            {submitting ? "Submitting…" : "Continue"}
            <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </GateControlFloor>
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
        // Declared-optional + empty pushes undefined so the key is simply absent;
        // anything else pushes "" (rejected by the object schema). Routed through
        // the same `isDeclaredOptional` decision as the visible Continue so the
        // two paths cannot drift.
        onChangeRef.current(isDeclaredOptional(requiredRef.current) ? undefined : "");
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
      // An empty box is not an object — but "not an object" is only a REJECTION
      // when the field has to carry one (cinatra#2484 review round). A field the
      // surface declared optional is OMITTED instead: Continue submits
      // `undefined`, the key is absent from the payload, and the user is not
      // trapped on an input they were never obliged to fill.
      //
      // Absence of a `required` prop is NOT such a declaration — see
      // `isDeclaredOptional`. The per-field Setup panels pass no `required` and
      // only ever prompt for REQUIRED fields, so an undeclared field keeps the
      // rejection rather than submitting `undefined` for an input the
      // setup-resume path cannot serialize.
      if (!isDeclaredOptional(required)) {
        setShowRequired(true);
        return;
      }
      setShowRequired(false);
      setSubmitting(true);
      setSubmitError(null);
      try {
        await onChange(undefined);
      } catch (err) {
        setSubmitError(err instanceof Error ? err.message : "Could not submit. Please try again.");
      } finally {
        setSubmitting(false);
      }
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
        <GateControlFloor>
          <Button className="gap-1.5"
            size="sm"
            disabled={disabled || submitting || !!shapeError}
            onClick={() => void handleContinue()}
          >
            {submitting ? "Submitting…" : "Continue"}
            <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </GateControlFloor>
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
