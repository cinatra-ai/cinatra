import type { ReactNode } from "react";
import { Bot, FileText, Package, Plug, Sparkles, Workflow } from "lucide-react";

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
      return <Plug className={className} />;
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
