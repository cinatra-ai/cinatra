import { Check, CircleHelp, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  deriveExtensionCompatState,
  HOST_SDK_ABI_VERSION,
  type ExtensionCompatState,
} from "@/lib/extension-compat-badge";

// ---------------------------------------------------------------------------
// ExtensionCompatBadge — the 3-state in-instance ABI compatibility badge for
// the marketplace browse cards + the detail header.
//
// The verdict is computed IN the instance (never by the marketplace) from the
// extension's DECLARED `cinatra.sdkAbiRange` vs this host's frozen SDK-extensions
// ABI, via `deriveExtensionCompatState`. The three states map to semantic Badge
// variants — and crucially the UNKNOWN (undeclared) state is NEUTRAL, never the
// green "success" variant, so the badge never over-promises "Compatible" for an
// extension that simply declared no range.
// ---------------------------------------------------------------------------

const COPY: Record<
  ExtensionCompatState,
  {
    label: string;
    variant: "success" | "destructive" | "outline";
    tooltip: (range: string | null) => string;
  }
> = {
  compatible: {
    label: "Compatible",
    variant: "success",
    tooltip: (range) =>
      `This extension declares SDK ABI ${range ?? "(any)"}, which this instance (ABI ${HOST_SDK_ABI_VERSION}) satisfies.`,
  },
  incompatible: {
    label: "Incompatible",
    variant: "destructive",
    tooltip: (range) =>
      `This extension declares SDK ABI ${range ?? "(unknown)"}, which this instance (ABI ${HOST_SDK_ABI_VERSION}) does not satisfy — installing it would be refused.`,
  },
  unknown: {
    label: "Unknown",
    variant: "outline",
    tooltip: () =>
      `This extension declares no SDK ABI range, so its compatibility with this instance (ABI ${HOST_SDK_ABI_VERSION}) cannot be determined.`,
  },
};

const ICON: Record<ExtensionCompatState, typeof Check> = {
  compatible: Check,
  incompatible: TriangleAlert,
  unknown: CircleHelp,
};

/**
 * The 3-state ABI compatibility badge. Pass the extension's declared
 * `sdkAbiRange` (null/absent → the neutral "Unknown" state). The verdict is
 * derived locally — never green for an undeclared range.
 */
export function ExtensionCompatBadge({
  sdkAbiRange,
  className,
}: {
  sdkAbiRange: string | null | undefined;
  className?: string;
}) {
  const state = deriveExtensionCompatState(sdkAbiRange);
  const { label, variant, tooltip } = COPY[state];
  const Icon = ICON[state];
  const declared =
    typeof sdkAbiRange === "string" && sdkAbiRange.trim() !== ""
      ? sdkAbiRange.trim()
      : null;

  return (
    // Self-contained provider so the badge renders correctly wherever it is
    // composed (the marketplace cards are handed to a client list, the detail
    // header renders server-side) without depending on an ancestor provider.
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant={variant}
            data-slot="extension-compat-badge"
            data-compat-state={state}
            className={className}
          >
            <Icon aria-hidden="true" />
            {label}
          </Badge>
        </TooltipTrigger>
        <TooltipContent>{tooltip(declared)}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
