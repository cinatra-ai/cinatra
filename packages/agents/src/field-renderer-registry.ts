import type { ComponentType } from "react";

// ---------------------------------------------------------------------------
// Namespace validation
// ---------------------------------------------------------------------------

/**
 * Validates that a renderer ID is in `@scope/package:local-id` format.
 * Exported so DB migrations can reuse the namespace validator.
 */
export const RENDERER_NAMESPACE_RE = /^@[\w-]+\/[\w-]+:[\w-]+$/;

export type GmailSendAsAliasOption = {
  sendAsEmail: string;
  displayName?: string;
  isDefault?: boolean;
  isPrimary?: boolean;
};

export type FieldRendererContext = {
  connectedApps: string[];                    // e.g. ["gmail", "apollo"]. Empty array is the default.
  gmailAliases?: GmailSendAsAliasOption[];    // populated by server when Gmail is connected
  allFieldValues?: Record<string, unknown>;   // full current form state, for HITL renderers that need cross-field data
  runId?: string;                             // agent_run ID from /agents list — used by HITL renderers to look up the campaign without relying on ToolMessage extraction
  templateId?: string;
  // Agent template ID for HITL renderers POSTing to
  // /api/agents/builder/[templateId]/hitl-assist. Optional because non-HITL
  // renderers (gmail-sender, contact-source, etc.) do not need it.
  // HITL renderers do not subscribe to AI-assist structured actions;
  // suggestions flow through parent-provided props below.
  xRenderer?: string;                         // active x-renderer value; passed through context so renderers receive it even after the schema key is stripped to prevent recursion
};

/** Rendering mode for any field renderer or result renderer. */
export type RendererMode = "edit" | "view";

/**
 * Normalized props every field renderer receives. Built-in renderers AND
 * registry-registered renderers MUST accept this exact shape — no variations.
 */
export type FieldRendererProps = {
  fieldName: string;                          // JSON Schema property key
  schema: Record<string, unknown>;            // the JSON Schema property itself
  value: unknown;                             // current value from form state
  onChange: (next: unknown) => void;          // setter passed in from SetupWorkspace
  disabled?: boolean;                         // true when the step is locked
  required?: boolean;                         // true when fieldName is in schema.required[]
  error?: string | null;                      // caller-controlled validation error (null = no error)
  label?: string;                             // resolved display label (title ?? description ?? fieldName)
  description?: string;                       // resolved helper text
  context: FieldRendererContext;
  /**
   * Signal that this renderer is busy (e.g. a background job is running).
   * SetupWorkspace disables "Save & continue" while any field is busy.
   */
  onBusyChange?: (busy: boolean) => void;
  /**
   * Immediately persist the given value to the DB (bypasses the normal
   * "Save & continue" flow). Use for values that must survive a page reload,
   * e.g. a campaignId created by the renderer on mount.
   */
  saveNow?: (value: unknown) => Promise<void>;
  /**
   * Incremented by SetupWorkspace after every successful AI assist response.
   * Renderers that maintain server-fetched state (e.g. recipients list) can
   * watch this to re-fetch when the AI may have changed server-side data.
   */
  assistResponseKey?: number;
  /**
   * Rendering mode. `"edit"` (default) means the renderer may present edit
   * controls and stage mutations. `"view"` means the renderer is in a
   * fundamentally read-only context (e.g. the Results tab) — hide edit UI.
   * Defaults to `"edit"` when absent for backwards compatibility with
   * existing HITL-step renderers.
   */
  mode?: RendererMode;
  /**
   * Called once by the renderer on mount to register a flush function that
   * `SetupWorkspace` will invoke before `onSaveStep`. The flush function
   * should execute any staged server-side operations (e.g. batch removals)
   * and resolve once persistence is complete. Renderers that do not stage
   * ops can ignore this prop.
   */
  registerFlush?: (fn: () => Promise<void>) => void;
  /**
   * When `true`, sub-renderers that draw their own "Continue" button MUST
   * skip rendering it. Used by GroupedSetupFormRenderer so the grouped
   * form's single submit button is the only approval path. Other renderers
   * (no internal button) can safely ignore this prop.
   */
  hideSubmit?: boolean;
  onApply?: (suggestions: Record<string, unknown>) => void;
  // Parent-injected callback for hitl-assist suggestions.
  // When defined and mode === "edit", renderers should mount <HitlAssistField>.
  /**
   * Stable AI-suggestion payload from the parent's
   * sticky-bottom PromptField. Renderers use `useEffect([aiSuggestions])` to
   * sync local state (edits, recipient list, sender email, etc.).
   *
   * Unlike `value` (a fresh inline-literal object on every render tick from
   * polling), `aiSuggestions` only changes when the user actually submits a
   * prompt — so an effect keyed on it fires exactly once per Suggest click and
   * does not wipe in-progress user edits between polls.
   */
  aiSuggestions?: Record<string, unknown>;
  /**
   * Called by the renderer whenever its local data changes, so the parent
   * panel can include it as supplemental currentValue in hitl-assist requests.
   * Renderers that manage array state (recipients, drafts) should implement this.
   * The parent merges the supplied object into currentValue before the fetch.
   */
  onHitlContextChange?: (ctx: Record<string, unknown>) => void;
};

export type FieldRendererCondition = (
  fieldName: string,
  schema: Record<string, unknown>,
  context: FieldRendererContext,
) => boolean;

export type FieldRendererEntry = {
  id: string;                                 // unique, e.g. "gmail-sender"
  priority: number;                           // higher priority wins on ties
  condition: FieldRendererCondition;
  renderer: ComponentType<FieldRendererProps>;
};

class FieldRendererRegistryImpl {
  private entries: FieldRendererEntry[] = [];

  register(entry: FieldRendererEntry): void {
    // Warn in development when the ID is not in @scope/package:local-id format.
    if (process.env.NODE_ENV !== "production" && !RENDERER_NAMESPACE_RE.test(entry.id)) {
      console.warn(
        `Field renderer ID '${entry.id}' is not namespaced. Use '@scope/package:local-id' format.`,
      );
    }
    // Idempotent: replace-by-id so ensureDefaultFieldRenderersRegistered()
    // can be called multiple times safely (hot reload, multiple entry points).
    this.entries = this.entries.filter((e) => e.id !== entry.id);
    this.entries.push(entry);
    this.entries.sort((a, b) => b.priority - a.priority);
  }

  resolve(
    fieldName: string,
    schema: Record<string, unknown>,
    context: FieldRendererContext,
  ): FieldRendererEntry | null {
    for (const entry of this.entries) {
      if (entry.condition(fieldName, schema, context)) return entry;
    }
    return null;
  }

  list(): readonly FieldRendererEntry[] {
    return this.entries;
  }

  clear(): void {
    this.entries = [];
  }
}

export const fieldRendererRegistry = new FieldRendererRegistryImpl();
