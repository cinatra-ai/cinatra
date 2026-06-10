// Chat widget runtime — the manifest-driven replacement for the module-level
// WIDGET_REGISTRY / ALL_MANIFESTS constants that chat-page.tsx used to build
// from STATIC named-extension imports (#34 / IOC-39..41). The widget set now
// arrives as ChatPage props (resolved server-side from the generated extension
// manifest + extension lifecycle by src/lib/chat-widget-catalog.server.ts),
// and this pure factory derives every detection/wizard/refresh structure from
// it. No extension package is named anywhere in this module.

import type { WidgetDefinition, WidgetManifest } from "@cinatra-ai/sdk-ui";

export type DetectedWidget = {
  widgetId: string;
  resourceId: string;
  label: string;
  href: string;
};

// Compiled detector patterns from manifests, as usable RegExp objects.
type CompiledDetector = {
  pattern: RegExp;
  widgetId: string | ((m: RegExpExecArray) => string | null);
  resourceId: (m: RegExpExecArray) => string;
  href: (m: RegExpExecArray) => string;
};

export type ChatWidgetRuntime = {
  /** All live widget definitions (lookup by id via findWidget). */
  widgets: WidgetDefinition[];
  /** All live widget manifests. */
  manifests: WidgetManifest[];
  findWidget(widgetId: string): WidgetDefinition | undefined;
  /** Scan assistant content for widget embeds + manifest-declared detectors. */
  detectWidgets(content: string): DetectedWidget[];
  /** Whether a tool name matches any manifest's refreshToolPatterns. */
  isWidgetRefreshTool(toolName: string): boolean;
  /** The widget id following `currentWidgetId` in its wizard sequence. */
  getNextWizardStep(currentWidgetId: string): string | null;
  /** The manifest whose wizard sequence contains `widgetId`. */
  getWizardManifest(widgetId: string): WidgetManifest | undefined;
  /** Whether `widgetId` is a step of any wizard sequence. */
  isWizardStep(widgetId: string): boolean;
  /** The wizard step label for `widgetId` (manifest stepLabels). */
  wizardStepLabel(widgetId: string): string | undefined;
  /** The manifest whose wizard confirmation stages `resourceType`. */
  findManifestByConfirmationResourceType(resourceType: string): WidgetManifest | undefined;
};

// Inline widget embeds emitted by the model: [widget:widgetId:resourceId]
const WIDGET_EMBED_PATTERN = /\[widget:([a-z0-9.-]+):([a-f0-9-]{36})\]/gi;

function compileDetectors(manifests: WidgetManifest[]): CompiledDetector[] {
  return manifests.flatMap((manifest) =>
    (manifest.detectors ?? []).map((d): CompiledDetector => {
      const pattern = new RegExp(d.pattern, d.patternFlags ?? "gi");
      const widgetIdValue = d.widgetId;

      return {
        pattern,
        widgetId: typeof widgetIdValue === "string"
          ? widgetIdValue
          : (m: RegExpExecArray) => {
              // Record<string, string> — look up captured group as key.
              const lastGroup = m[m.length - 1];
              return (widgetIdValue as Record<string, string>)[lastGroup] ?? null;
            },
        resourceId: (m: RegExpExecArray) => {
          if (typeof d.resourceIdGroups === "number") return m[d.resourceIdGroups];
          // "$1:$2" format — join groups.
          return d.resourceIdGroups.replace(/\$(\d+)/g, (_, n) => m[Number(n)] ?? "");
        },
        href: (m: RegExpExecArray) => m[0].replace(/^#/, ""),
      };
    }),
  );
}

export function createChatWidgetRuntime(
  widgets: WidgetDefinition[],
  manifests: WidgetManifest[],
): ChatWidgetRuntime {
  const byId = new Map(widgets.map((w) => [w.id, w]));

  // Derived from manifests — no hardcoded constants.
  const wizardSequences: string[][] = manifests
    .filter((m) => m.wizard)
    .map((m) => m.wizard!.steps.map((s) => s.widgetId));

  const wizardStepLabels: Record<string, string> = Object.assign(
    {},
    ...manifests.filter((m) => m.wizard).map((m) => m.wizard!.stepLabels),
  );

  const refreshToolPatterns: string[] = manifests.flatMap(
    (m) => m.refreshToolPatterns ?? [],
  );

  const detectors = compileDetectors(manifests);

  function findWidget(widgetId: string): WidgetDefinition | undefined {
    return byId.get(widgetId);
  }

  function detectWidgets(content: string): DetectedWidget[] {
    const detected: DetectedWidget[] = [];
    const seen = new Set<string>();

    WIDGET_EMBED_PATTERN.lastIndex = 0;
    let em: RegExpExecArray | null;
    while ((em = WIDGET_EMBED_PATTERN.exec(content)) !== null) {
      const widgetId = em[1];
      const resourceId = em[2];
      const key = widgetId + resourceId;
      if (seen.has(key)) continue;
      seen.add(key);
      const def = byId.get(widgetId);
      if (def) {
        detected.push({ widgetId, resourceId, label: def.label, href: "#" });
      }
    }

    for (const detector of detectors) {
      detector.pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = detector.pattern.exec(content)) !== null) {
        const widgetId = typeof detector.widgetId === "function" ? detector.widgetId(m) : detector.widgetId;
        if (!widgetId) continue;
        const resourceId = detector.resourceId(m);
        const key = widgetId + resourceId;
        if (seen.has(key)) continue;
        seen.add(key);
        const def = byId.get(widgetId);
        if (def) {
          detected.push({ widgetId, resourceId, label: def.label, href: detector.href(m) });
        }
      }
    }

    return detected;
  }

  return {
    widgets,
    manifests,
    findWidget,
    detectWidgets,
    isWidgetRefreshTool(toolName: string): boolean {
      const lower = toolName.toLowerCase();
      return refreshToolPatterns.some((p) => lower.includes(p));
    },
    getNextWizardStep(currentWidgetId: string): string | null {
      for (const seq of wizardSequences) {
        const idx = seq.indexOf(currentWidgetId);
        if (idx >= 0 && idx < seq.length - 1) {
          return seq[idx + 1];
        }
      }
      return null;
    },
    getWizardManifest(widgetId: string): WidgetManifest | undefined {
      return manifests.find(
        (m) => m.wizard?.steps.some((s) => s.widgetId === widgetId),
      );
    },
    isWizardStep(widgetId: string): boolean {
      return wizardSequences.some((seq) => seq.includes(widgetId));
    },
    wizardStepLabel(widgetId: string): string | undefined {
      return wizardStepLabels[widgetId];
    },
    findManifestByConfirmationResourceType(resourceType: string): WidgetManifest | undefined {
      return manifests.find(
        (m) => m.wizard?.confirmation.resourceType === resourceType,
      );
    },
  };
}

// Stable empty constants so a mount without a resolved catalog (tests, widget
// hosts that don't surface chat widgets) builds one runtime, not one per
// render. The production chat mount always passes the resolved catalog.
export const EMPTY_WIDGETS: WidgetDefinition[] = [];
export const EMPTY_WIDGET_MANIFESTS: WidgetManifest[] = [];
