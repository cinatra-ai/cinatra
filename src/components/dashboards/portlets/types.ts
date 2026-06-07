// Shared prop contract for client portlet components. The PortletHost resolves
// input bindings to concrete values + supplies an onOutput callback that writes
// to the dashboard's selection state. Scope is NEVER passed from the client to
// the server loaders — the loaders derive it from session.
export type PortletComponentProps = {
  readonly instanceId: string;
  readonly config: Record<string, unknown>;
  /** Resolved input values (binding → selection-state value or dashboard-row field). */
  readonly inputs: Record<string, unknown>;
  /** The input keys that have a declared binding (so a portlet can distinguish
   *  "no binding" from "binding present but unresolved" — the latter must NOT
   *  broaden a child list). */
  readonly boundInputs: readonly string[];
  /** The dashboard row context (projectId, organizationId, ownerLevel, …). */
  readonly rowContext: Record<string, unknown>;
  /** Emit output key/values into the dashboard selection state for downstream
   *  portlets. A `null` value CLEARS that output (e.g. when a parent selection
   *  changes, invalidating a stale child selection). */
  readonly onOutput: (out: Record<string, string | null>) => void;
};
