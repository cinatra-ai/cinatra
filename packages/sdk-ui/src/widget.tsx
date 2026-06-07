"use client";

import { useCallback, useEffect, useState } from "react";
import { LoadingSpinner } from "./loading-spinner";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WidgetProps<TData = Record<string, unknown>> = {
  /** The resource ID (e.g., campaignId, projectId). */
  resourceId: string;
  /** Called after a successful save. */
  onSave?: (data: TData) => void;
  /** Ref callback to expose an imperative submit handle. */
  submitRef?: React.RefObject<WidgetSubmitHandle | null>;
};

export type WidgetSubmitHandle = {
  submit: () => Promise<boolean>;
};

export type WidgetDefinition = {
  /** Unique widget ID (e.g., "campaign-email-outreach.audience"). */
  id: string;
  /** Human-readable label shown in the chat embed header. */
  label: string;
  /** The React component to render. */
  component: React.ComponentType<WidgetProps<Record<string, unknown>>>;
};

// ---------------------------------------------------------------------------
// Manifest types — declarative metadata for the chat widget system
// ---------------------------------------------------------------------------

/**
 * Declares how a set of widgets participates in the chat wizard system.
 * Exported by each package alongside its WidgetDefinition[].
 * Metadata only — no React components, no functions.
 */
export type WidgetManifest = {
  /** Unique package-level ID, e.g. "campaign-email-outreach". */
  id: string;

  /**
   * LLM-facing description — tells the model WHEN to use this widget group.
   * Mirrors the `description` field in SKILL.md frontmatter.
   * Injected into the system prompt so the LLM can decide which widgets
   * to embed based on user intent.
   */
  description: string;

  /** If present, widgets form an ordered step-by-step wizard flow. */
  wizard?: WizardDeclaration;

  /** Patterns for detecting widget embeds in assistant message content. */
  detectors?: WidgetDetector[];

  /** Tool name substrings that trigger a widget data refresh when completed. */
  refreshToolPatterns?: string[];
};

export type WizardDeclaration = {
  /** Ordered steps with LLM descriptions. */
  steps: WizardStep[];

  /** Widget ID → transition message shown to the user after each step. */
  stepLabels: Record<string, string>;

  /** Which tools support staging and how to identify the resource. */
  staging: StagingDeclaration;

  /** Confirmation flow after the last wizard step. */
  confirmation: ConfirmationDeclaration;
};

export type WizardStep = {
  /** Widget ID, e.g. "campaign-email-outreach.audience". */
  widgetId: string;

  /**
   * LLM-facing description — tells the model what this step handles,
   * so it can map user prompts to the right widget.
   */
  description: string;

  /**
   * Data bindings between tool results and staged config fields.
   * When a tool in `triggerTools` completes, the system:
   * 1. Refreshes this widget (re-fetches data)
   * 2. Auto-populates a staged config field from the result
   */
  dataBindings?: DataBinding[];
};

export type DataBinding = {
  /** MCP tool name(s) that trigger this binding. */
  triggerTools: string[];

  /**
   * Path to extract a value from the tool result.
   * Supports: "field", "field.nested", "field[-1]" (last element).
   */
  resultPath: string;

  /** Field name in the staged config to set. */
  targetField: string;

  /** Optional template — `{value}` is replaced with the extracted value. */
  template?: string;
};

export type StagingDeclaration = {
  /** Resource type key, e.g. "campaign". */
  resourceType: string;

  /**
   * MCP tool names that CAN create this resource type.
   * Staging happens only when the LLM adds `_stage: true` to the call.
   */
  createTools: string[];

  /**
   * MCP tool names that CAN update this resource type.
   * Updates to staged resources are automatically kept in memory.
   */
  updateTools: string[];

  /** The argument key that holds the resource ID, e.g. "campaignId". */
  resourceIdArg: string;
};

export type ConfirmationDeclaration = {
  /** Resource type slug for the confirm tag: [confirm-{type}:{id}]. */
  resourceType: string;

  /** Button label, e.g. "Create campaign". */
  buttonLabel: string;

  /** API endpoint pattern — `{resourceId}` replaced at runtime. */
  activateEndpoint: string;

  /** Message shown after successful activation. */
  successMessage: string;
};

export type WidgetDetector = {
  /** Regex pattern as string (serializable, compiled at runtime). */
  pattern: string;
  patternFlags?: string;

  /**
   * Widget ID to activate. Either a static string, or a Record mapping
   * a captured group value to a widget ID (for URL slug routing).
   */
  widgetId: string | Record<string, string>;

  /**
   * Which capture group(s) hold the resource ID.
   * Number for a single group index, or "$1:$2" to join groups.
   */
  resourceIdGroups: number | string;
};

// ---------------------------------------------------------------------------
// Widget shell (wrapper with loading state and header)
// ---------------------------------------------------------------------------

export function WidgetShell({
  label,
  loading,
  error,
  children,
}: {
  label: string;
  loading?: boolean;
  error?: string | null;
  children: React.ReactNode;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <LoadingSpinner className="h-5 w-5 text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3">
        <p className="text-sm font-medium text-destructive">{label}</p>
        <p className="mt-1 text-sm text-destructive/80">{error}</p>
      </div>
    );
  }

  return <>{children}</>;
}

// ---------------------------------------------------------------------------
// Hook: fetch + save widget data via API
// ---------------------------------------------------------------------------

export function useWidgetData<TData>(input: {
  url: string;
  resourceId: string;
}) {
  const [data, setData] = useState<TData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(input.url)
      .then((r) => {
        if (!r.ok) throw new Error("Failed to load.");
        return r.json();
      })
      .then((d) => setData(d as TData))
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load."))
      .finally(() => setLoading(false));
  }, [input.url, input.resourceId]);

  const save = useCallback(
    async (updates: Partial<TData>): Promise<boolean> => {
      setSaving(true);
      setError(null);
      try {
        const response = await fetch(input.url, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(updates),
        });
        if (!response.ok) {
          const body = await response.json().catch(() => null) as { error?: string } | null;
          throw new Error(body?.error ?? "Save failed.");
        }
        const updated = (await response.json()) as TData;
        setData(updated);
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Save failed.");
        return false;
      } finally {
        setSaving(false);
      }
    },
    [input.url],
  );

  return { data, loading, error, saving, save, setData };
}
