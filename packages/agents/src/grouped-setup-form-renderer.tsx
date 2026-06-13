"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useForm, useWatch, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { ZodType } from "zod";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Form } from "@/components/ui/form";
import {
  fieldRendererRegistry,
  type FieldRendererCondition,
  type FieldRendererContext,
  type FieldRendererProps,
} from "./field-renderer-registry";
import { jsonSchemaToZod } from "./json-schema-to-zod";
import { SchemaFieldRenderer } from "./schema-field-renderer";
import { GROUPED_SETUP_FORM_RENDERER_ID } from "./agent-builder-ids";

// ---------------------------------------------------------------------------
// Registry condition — strict equality so mid-run HITL xRenderers never match.
// Keep grouped setup renderer matching isolated from regular field renderers.
// The id authority is ./agent-builder-ids (a pure, environment-neutral module);
// re-export it here so existing importers of this renderer keep resolving it.
// ---------------------------------------------------------------------------

export { GROUPED_SETUP_FORM_RENDERER_ID };

export const isGroupedSetupFormField: FieldRendererCondition = (_fieldName, schema) => {
  const xRenderer = (schema as { "x-renderer"?: string })["x-renderer"];
  return xRenderer === GROUPED_SETUP_FORM_RENDERER_ID;
};

// ---------------------------------------------------------------------------
// GroupedSetupFormRenderer — composes per-field sub-renderers into a single
// shadcn Form with ONE submit button.
// Sub-renderer onChange is buffered into form state via <Controller>, NOT
// forwarded to the outer onChange prop.
//
// Layout contract: AgenticRunPanel already wraps the renderer in a bubble
// card (soft-panel rounded-panel p-4 bg-surface-muted — agentic-run-panel.tsx
// ~line 302). DO NOT add an additional `soft-panel` / `bg-surface-muted`
// class to the outermost node here or the UI will show a double-nested card.
// The <Card> wrapper below is semantic (header + content) — it uses the
// default Card background and rounding only.
//
// State-sync contract:
// useForm only reads defaultValues on first mount. useEffect + form.reset is
// the documented way to keep the form in sync with an upstream prop-driven
// value source. Without this, the form silently drifts after mount when the
// parent supplies a new `value` prop.
//
// Re-render contract:
// Use useWatch({ control: form.control }) — NOT form.watch() inline — to
// expose allFieldValues via subContext. form.watch() inline causes the whole
// grouped form to re-render on every keystroke in any field.
// ---------------------------------------------------------------------------

export function GroupedSetupFormRenderer(props: FieldRendererProps) {
  const { schema, value, onChange, disabled, context, aiSuggestions } = props;

  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = ((schema.required ?? []) as string[]);

  // Render order: required first (declared order), then optional visible.
  // Filter out x-hidden fields entirely.
  const visibleFieldNames = Object.keys(properties).filter(
    (name) => !(properties[name] as { "x-hidden"?: boolean })["x-hidden"],
  );
  const ordered = [
    ...required.filter((n) => visibleFieldNames.includes(n)),
    ...visibleFieldNames.filter((n) => !required.includes(n)),
  ];

  const zodSchema = useMemo(() => jsonSchemaToZod(schema), [schema]);
  // jsonSchemaToZod returns ZodTypeAny (the schema shape is only known at
  // runtime); react-hook-form's zodResolver wants the schema typed to the
  // form's FieldValues — a record of string→unknown, which is exactly the
  // shape our grouped form state has (the top-level call always passes an
  // object schema). Cast once, precisely, at the resolver boundary so the
  // rest of the types flow through cleanly.
  const form = useForm({
    resolver: zodResolver(
      zodSchema as ZodType<Record<string, unknown>, Record<string, unknown>>,
    ),
    defaultValues: ((value ?? {}) as Record<string, unknown>),
  });

  // react-hook-form caches defaultValues at first mount. When the parent passes
  // a new `value` prop later, reset() pushes that new value into the form state
  // so the UI reflects upstream changes.
  //
  // Merge with current form values rather than replacing — child components
  // (e.g. FollowUpCadenceFieldRenderer) seed their own defaults via onChange
  // on mount. A plain form.reset(value) would wipe those seeds because they
  // run as child effects before this parent effect fires.
  useEffect(() => {
    const current = form.getValues();
    form.reset({ ...current, ...((value ?? {}) as Record<string, unknown>) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]); // form is stable across renders; including it would reset on every re-render

  // AI suggestions from the bottom PromptField overlay. When the parent receives
  // a new suggestion payload, apply matching fields into the form so the user
  // sees pre-filled values they can review before submitting.
  useEffect(() => {
    if (!aiSuggestions) return;
    for (const [key, val] of Object.entries(aiSuggestions)) {
      // Apply if field is in schema properties OR if schema is empty (backend
      // already filters to editable fields, so all keys here are safe).
      if (val !== undefined && val !== null && (Object.keys(properties).length === 0 || key in properties)) {
        form.setValue(key, val, { shouldDirty: true });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiSuggestions]); // form and properties are stable

  // useWatch subscribes narrowly and returns a memoized snapshot. form.watch()
  // inline would re-render the whole form on every keystroke anywhere in the
  // form.
  const allFieldValues = useWatch({ control: form.control }) as Record<string, unknown>;

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Flush registry: sub-renderers register a callback that pushes their
  // buffered local state into the parent form (via field.onChange) before
  // Zod validation runs. react-hook-form stores values in a ref so the
  // flush is synchronous; trigger() reads the updated ref immediately after.
  const flushRegistry = useRef<Map<string, () => Promise<void>>>(new Map());
  const makeRegisterFlush = useCallback(
    (name: string) => (fn: () => Promise<void>) => {
      flushRegistry.current.set(name, fn);
    },
    [],
  );

  const handleFormSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    // Guard early — prevents two rapid clicks from racing past the async validation.
    if (submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    let succeeded = false;
    try {
      // 1. Flush buffered values from every sub-renderer into form state
      await Promise.all([...flushRegistry.current.values()].map((fn) => fn()));
      // 2. Trigger Zod validation (now reads flushed values)
      const isValid = await form.trigger();
      if (!isValid) {
        setSubmitting(false);
        return;
      }
      // 3. Submit
      const values = form.getValues();
      await onChange(values);
      succeeded = true;
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Could not submit. Please try again.");
    } finally {
      // Keep button disabled after success — run is now queued; re-enabling
      // would let a second click send a duplicate approval.
      if (!succeeded) setSubmitting(false);
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={(e) => { void handleFormSubmit(e); }}>
        <div className="flex flex-col gap-5">
            {ordered.map((fieldName, idx) => {
              const fieldSchema = properties[fieldName] ?? {};
              const isRequired = required.includes(fieldName);
              const label =
                (fieldSchema as { title?: string }).title ?? fieldName;
              const description = (fieldSchema as { description?: string })
                .description;

              // Resolve the sub-renderer from the registry (gmail-sender, cta, etc.)
              // or fall back to SchemaFieldRenderer. Pass the field's OWN sub-schema,
              // NOT the grouped wrapper schema to prevent recursive matching.
              //
              // Strip x-renderer === GROUPED_SETUP_FORM_RENDERER_ID from the field
              // schema before resolving. The marker field (offeringCompanyWebsite) carries
              // this annotation to trigger grouped mode, but inside the grouped form it
              // must resolve to its underlying type renderer — never back to itself.
              const subFieldSchema =
                (fieldSchema as { "x-renderer"?: string })["x-renderer"] === GROUPED_SETUP_FORM_RENDERER_ID
                  ? (({ "x-renderer": _r, ...rest }) => rest)(fieldSchema as { "x-renderer"?: string } & Record<string, unknown>)
                  : fieldSchema;
              const subContext: FieldRendererContext = {
                ...context,
                allFieldValues,   // read once per render via useWatch, not form.watch()
              };
              const matched = fieldRendererRegistry.resolve(
                fieldName,
                subFieldSchema,
                subContext,
              );
              const SubRenderer = matched?.renderer ?? SchemaFieldRenderer;

              return (
                <div key={fieldName}>
                  {idx > 0 && <Separator className="mb-4" />}
                  <Controller
                    name={fieldName}
                    control={form.control}
                    render={({ field, fieldState }) => (
                      <SubRenderer
                        fieldName={fieldName}
                        schema={subFieldSchema}
                        value={field.value}
                        onChange={(next: unknown) => field.onChange(next)}
                        disabled={disabled || submitting}
                        required={isRequired}
                        label={label}
                        description={description}
                        context={subContext}
                        error={
                          (fieldState.error?.message as string | undefined) ??
                          null
                        }
                        mode="edit"
                        hideSubmit={true}
                        registerFlush={makeRegisterFlush(fieldName)}
                      />
                    )}
                  />
                </div>
              );
            })}

            {submitError && (
              <p className="text-xs text-destructive">{submitError}</p>
            )}
            <Separator />
            <div className="flex justify-end">
              <Button type="submit" disabled={disabled || submitting} className="gap-1.5">
                {submitting ? "Starting…" : "Save & start run"}
                <ArrowRight className="h-3.5 w-3.5" />
              </Button>
            </div>
        </div>
      </form>
    </Form>
  );
}
