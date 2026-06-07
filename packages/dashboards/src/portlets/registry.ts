// Typed portlet registry. METADATA ONLY — no React components
// here: the server-side install validator imports this, and a
// `"use client"` PortletHost owns the kind→component map +
// selection state separately. Each kind declares a mandatory scopePolicy
// (documents that scope derives from session; the server loader ENFORCES it),
// the input/output keys the install validator validates bindings against, and
// an optional per-kind `validateConfig` for install-time structured config
// rejects.

export type PortletScopePolicy = {
  /** Scope is ALWAYS session-derived — declared to force every kind to
   *  acknowledge it; the server data-loader is the actual enforcement point. */
  readonly scopeFrom: "session";
  /** Resource family this portlet reads/writes (drives enforceResourceAccess). */
  readonly resource: "object" | "artifact" | "workflow" | "dashboard" | "none";
  /** The op checked at the server loader (e.g. "object.read"). Omitted for
   *  launcher portlets that delegate authz to the wrapped primitive. */
  readonly op?: string;
};

export type PortletConfigError = { code: string; message: string };

/** The portlet instance shape a per-kind validator inspects at install time —
 *  config + the wiring (inputs/outputs), so e.g. workflow-status can require at
 *  least one of its workflowId/projectId input bindings. */
export type PortletInstanceForValidation = {
  readonly config: Record<string, unknown>;
  readonly inputs?: Record<string, unknown>;
  readonly outputs?: readonly string[];
};

export type PortletKindEntry = {
  readonly kind: string;
  readonly version: string;
  readonly scopePolicy: PortletScopePolicy;
  readonly inputKeys: readonly string[];
  readonly outputKeys: readonly string[];
  /** Launcher portlets prefill arbitrary template-placeholder / agent-input keys,
   *  so the install validator skips the input-key-in-inputKeys check for them. */
  readonly allowsArbitraryInputs?: boolean;
  /** Install-time per-kind validation over the portlet instance. Returns [] when ok. */
  readonly validateConfig?: (portlet: PortletInstanceForValidation) => PortletConfigError[];
};

/** The descriptor shape `validateDashboardConfigV12({ getPortletKind })`
 *  consumes (kind/version existence + input/output key declarations). */
export type PortletKindDescriptor = {
  readonly kind: string;
  readonly version: string;
  readonly inputKeys: readonly string[];
  readonly outputKeys: readonly string[];
  readonly allowsArbitraryInputs?: boolean;
};

const registry = new Map<string, PortletKindEntry>();
const keyOf = (kind: string, version: string) => `${kind}@${version}`;

/** Register a portlet kind. scopePolicy is mandatory — throws without it
 *  (defends the JS/dynamic path; TS already requires it on the type). */
export function registerPortletKind(entry: PortletKindEntry): void {
  if (!entry.scopePolicy || entry.scopePolicy.scopeFrom !== "session") {
    throw new Error(`portlet kind "${entry.kind}@${entry.version}" must declare a session scopePolicy`);
  }
  registry.set(keyOf(entry.kind, entry.version), entry);
}

export function getPortletKind(kind: string, version: string): PortletKindEntry | undefined {
  return registry.get(keyOf(kind, version));
}

/** Descriptor lookup (used as the injected `getPortletKind`). */
export function getPortletKindDescriptor(kind: string, version: string): PortletKindDescriptor | undefined {
  const e = getPortletKind(kind, version);
  return e
    ? { kind: e.kind, version: e.version, inputKeys: e.inputKeys, outputKeys: e.outputKeys, allowsArbitraryInputs: e.allowsArbitraryInputs }
    : undefined;
}

/** Run a kind's per-kind validation (install-time) over a portlet instance.
 *  Unknown kind → a single structured error so the materializer fails closed. */
export function validatePortletConfig(
  kind: string,
  version: string,
  portlet: PortletInstanceForValidation,
): PortletConfigError[] {
  const e = getPortletKind(kind, version);
  if (!e) return [{ code: "portlet_kind_unknown", message: `unknown portlet kind "${kind}@${version}"` }];
  return e.validateConfig ? e.validateConfig(portlet) : [];
}

export function listPortletKinds(): PortletKindEntry[] {
  return [...registry.values()];
}

/** Test-only: clear the registry (kinds re-register at import time). */
export function __resetPortletRegistryForTests(): void {
  registry.clear();
}
