import * as React from "react";
import { cn } from "./lib/utils";

// ---------------------------------------------------------------------------
// ConnectorSetupColumns — the two-column setup body shared by the single- and
// multi-connection setup pages (design/specs/app-connectors.html §II).
//
// A `minmax(0,1fr) 236px` grid: the WIDER left column holds the configuration
// fields, the NARROWER right column holds the connection(s) status card. It is
// the body BENEATH the ConnectorSetupPage header (single connection) or beneath
// the Setup tab's TabsContent (multi connection), so the same layout drives
// both shapes and the header↔content alignment stays structural.
//
// It emits the conformance id (`connector-setup` for a single connection,
// `connector-multi-setup` for the Setup tab of a multi-connection connector)
// and the current data-state, so the design functional-acceptance suite can
// drive the loading / error variants.
//
// Presentational + server-safe: the fields and the status card are passed as
// slots. On a narrow viewport the 236px status column drops below the fields
// (the grid collapses to one column), keeping the body responsive.
// ---------------------------------------------------------------------------

export type ConnectorSetupConformanceId =
  | "connector-setup"
  | "connector-multi-setup";

export type ConnectorSetupState = "ready" | "loading" | "error";

export interface ConnectorSetupColumnsProps
  extends Omit<React.ComponentProps<"div">, "children"> {
  /** Left column — the configuration fields (wider, `minmax(0,1fr)`). */
  fields: React.ReactNode;
  /** Right column — the connection(s) status card (narrower, 236px). */
  aside: React.ReactNode;
  /**
   * Conformance surface id: `connector-setup` (one connection) or
   * `connector-multi-setup` (the Setup tab of a multi-connection connector).
   */
  conformanceId?: ConnectorSetupConformanceId;
  /** Current surface state; drives `data-state` for functional-acceptance. */
  state?: ConnectorSetupState;
  /** Copy shown while the setup surface is still resolving. */
  loadingLabel?: string;
  /** Copy shown when the setup surface could not be resolved. */
  errorLabel?: string;
}

export function ConnectorSetupColumns({
  fields,
  aside,
  conformanceId = "connector-setup",
  state = "ready",
  loadingLabel = "Loading connector setup…",
  errorLabel = "This connector's setup could not be loaded.",
  className,
  ...props
}: ConnectorSetupColumnsProps) {
  // The two non-ready variants the spec declares on this surface
  // (`data-state="loading error"`). They replace the two-column body IN PLACE —
  // the surface itself stays mounted and keeps its conformance id + state, so
  // the variant is a state OF the surface, never its absence. Same shape and
  // token vocabulary as ConnectionsList's empty/loading treatments.
  if (state === "loading" || state === "error") {
    return (
      <div
        data-conformance-id={conformanceId}
        data-state={state}
        className={cn("mt-0", className)}
        {...props}
      >
        {state === "loading" ? (
          <p
            data-slot="connector-setup-loading"
            aria-busy="true"
            className="text-sm text-muted-foreground"
          >
            {loadingLabel}
          </p>
        ) : (
          <p
            data-slot="connector-setup-error"
            role="alert"
            className="text-sm text-destructive"
          >
            {errorLabel}
          </p>
        )}
      </div>
    );
  }

  return (
    <div
      data-conformance-id={conformanceId}
      data-state={state}
      className={cn(
        // minmax(0,1fr) 236px, gap 30, align-items:start — collapses to a
        // single column below `sm` so the 236px status card stacks under the
        // fields (responsive, spec §II + §VII widths).
        "grid grid-cols-1 items-start gap-[30px] sm:grid-cols-[minmax(0,1fr)_236px]",
        className,
      )}
      {...props}
    >
      <div className="min-w-0">{fields}</div>
      <div>{aside}</div>
    </div>
  );
}
