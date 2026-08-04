import type { ReactNode } from "react";
import { Bot, FileText, Package, Sparkles, Workflow } from "lucide-react";

import { PlugConnectorKind } from "@cinatra-ai/sdk-ui/icons/plug-connector-kind";

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
 *
 * The "connector" arm renders the lower-half-plug mark (`PlugConnectorKind`,
 * cinatra#2364, epic #2360) instead of the generic lucide `Plug` — so "what
 * kind of extension is this" and "is it connected" read as one icon family.
 * Every other kind arm is byte-unchanged.
 */
export function extensionKindEmblem(
  kind: ExtensionEmblemKind,
  className = "size-5",
): ReactNode {
  switch (kind) {
    case "skill":
      return <Sparkles className={className} />;
    case "connector":
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
