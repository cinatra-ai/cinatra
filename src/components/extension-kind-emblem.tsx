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
 *
 * The "connector" arm renders the lower-half-plug mark (`PlugConnectorKind`,
 * cinatra#2364, epic #2360) instead of the generic lucide `Plug` — so the
 * kind emblem and the sibling status glyph read as one visual family without
 * sharing a component: this file's vocabulary stays kinds, never states.
 * The glyph lives in the shared sdk-ui glyph registry (single module owner,
 * per #2364) as a distinct export beside the status mark — imported from the
 * same `@cinatra-ai/sdk-ui/icons` entrypoint, never as the status export
 * itself. Every other kind arm is byte-unchanged.
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
