import type { ReactNode } from "react";
import { Bot, FileText, Package, Sparkles, Workflow } from "lucide-react";
import { PlugConnectorKind } from "@cinatra-ai/sdk-ui/icons";

/**
 * Kind slugs that carry a dedicated emblem. "unknown" covers
 * contexts/dashboards/unmapped kinds coming off the marketplace wire.
 */
export type ExtensionEmblemKind =
  | "agent"
  | "skill"
  | "connector"
  | "artifact"
  | "workflow"
  | "unknown";

/**
 * Emblem icon per extension kind — single source of truth for the
 * marketplace browse cards and the marketplace detail hero, mirroring the
 * storefront's kind emblem (the white pill on the coloured ground).
 */
export function extensionKindEmblem(
  kind: ExtensionEmblemKind,
  className = "size-5",
): ReactNode {
  switch (kind) {
    case "skill":
      return <Sparkles className={className} />;
    case "connector":
      // The first-party lower-half-plug mark (design/specs/app-extensions.html
      // version 0.11.0) — a KIND emblem, not a connection-state one. See
      // packages/sdk-ui/src/icons.tsx.
      return <PlugConnectorKind className={className} />;
    case "artifact":
      return <FileText className={className} />;
    case "workflow":
      return <Workflow className={className} />;
    case "agent":
      return <Bot className={className} />;
    case "unknown":
    default:
      return <Package className={className} />;
  }
}
