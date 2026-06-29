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
  /**
   * For a RUNTIME-registered kind (cinatra#660): the EXISTING kind whose client
   * component renders this kind. A runtime kind is ALIAS-only — it NEVER ships a
   * new React component (the no-unsigned-code invariant), so it MUST render as
   * an existing kind whose component the host already bundles. Undefined for
   * bundled (core) kinds. */
  readonly rendersAs?: string;
  /**
   * The source package that contributed a runtime kind (used to unregister on
   * teardown). Undefined for bundled (core) kinds. */
  readonly sourcePackageName?: string;
  /** Process activation generation at registration time (runtime kinds only). */
  readonly activationGeneration?: number;
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

export type RuntimePortletKindRegistration = {
  readonly kind: string;
  readonly version: string;
  /** The existing kind whose component + validation this runtime kind reuses. */
  readonly rendersAs: string;
  readonly sourcePackageName: string;
  readonly activationGeneration: number;
};

export type RuntimePortletKindResult =
  | { ok: true }
  | { ok: false; code: string; reason: string };

/**
 * Register a RUNTIME portlet kind (cinatra#660). ALIAS-ONLY: the kind renders
 * via an EXISTING bundled kind's component (`rendersAs`) and INHERITS that
 * kind's scopePolicy + input/output keys + per-kind config validation. It ships
 * NO new component and NO new SQL/schema — preserving the no-unsigned-code
 * invariant. Fail-closed:
 *   - `rendersAs` must resolve to an existing registered kind whose component
 *     the host bundles (checked by the injected `hasComponentFor`) — a kind that
 *     maps to no component is REJECTED (no placeholder-only kinds in prod);
 *   - the new kind id may NOT shadow an existing bundled/runtime kind id;
 *   - the kind id + version must be non-empty.
 * Re-registering the SAME (kind,version) from the SAME source package is
 * idempotent (replaces). A collision with a DIFFERENT source is rejected.
 */
export function registerRuntimePortletKind(
  reg: RuntimePortletKindRegistration,
  opts: {
    /** Whether the host bundles a client component for `rendersAs`. */
    readonly hasComponentFor: (kind: string) => boolean;
  },
): RuntimePortletKindResult {
  if (!reg.kind || reg.kind.length === 0 || !reg.version || reg.version.length === 0) {
    return { ok: false, code: "portlet_kind_invalid", reason: "kind and version are required" };
  }
  if (!reg.rendersAs || reg.rendersAs.length === 0) {
    return { ok: false, code: "portlet_renders_as_required", reason: "runtime portlet kind must declare rendersAs" };
  }
  // The render target must be an EXISTING kind WITH a bundled component.
  const target = getPortletKind(reg.rendersAs, reg.version) ?? findAnyVersion(reg.rendersAs);
  if (!target) {
    return {
      ok: false,
      code: "portlet_renders_as_unknown",
      reason: `rendersAs "${reg.rendersAs}" is not a registered portlet kind`,
    };
  }
  if (!opts.hasComponentFor(reg.rendersAs)) {
    return {
      ok: false,
      code: "portlet_renders_as_no_component",
      reason: `rendersAs "${reg.rendersAs}" has no bundled client component — runtime kinds may not be placeholder-only`,
    };
  }
  const key = keyOf(reg.kind, reg.version);
  const existing = registry.get(key);
  if (existing) {
    // A collision with a BUNDLED kind (no sourcePackageName) or a DIFFERENT
    // runtime source is rejected; same-source re-register replaces.
    if (existing.sourcePackageName !== reg.sourcePackageName) {
      return {
        ok: false,
        code: "portlet_kind_collision",
        reason: `portlet kind "${reg.kind}@${reg.version}" already registered${existing.sourcePackageName ? ` by "${existing.sourcePackageName}"` : " as a bundled kind"}`,
      };
    }
  }
  // Inherit the render target's scopePolicy / keys / validation verbatim — the
  // alias kind is the target kind under a new name.
  registry.set(key, {
    kind: reg.kind,
    version: reg.version,
    scopePolicy: target.scopePolicy,
    inputKeys: target.inputKeys,
    outputKeys: target.outputKeys,
    allowsArbitraryInputs: target.allowsArbitraryInputs,
    validateConfig: target.validateConfig,
    rendersAs: reg.rendersAs,
    sourcePackageName: reg.sourcePackageName,
    activationGeneration: reg.activationGeneration,
  });
  return { ok: true };
}

/** Find any registered version of a kind (for rendersAs resolution). */
function findAnyVersion(kind: string): PortletKindEntry | undefined {
  for (const e of registry.values()) {
    if (e.kind === kind) return e;
  }
  return undefined;
}

/** Unregister a single runtime portlet kind (must be runtime + source-owned). */
export function unregisterRuntimePortletKind(kind: string, version: string, sourcePackageName: string): boolean {
  const e = registry.get(keyOf(kind, version));
  if (!e || e.sourcePackageName !== sourcePackageName) return false;
  return registry.delete(keyOf(kind, version));
}

/** Unregister every runtime portlet kind contributed by `sourcePackageName`. */
export function unregisterRuntimePortletKindsForPackage(sourcePackageName: string): string[] {
  const removed: string[] = [];
  for (const [key, e] of registry) {
    if (e.sourcePackageName === sourcePackageName) {
      registry.delete(key);
      removed.push(e.kind);
    }
  }
  return removed;
}

/** True when a kind is RUNTIME-contributed (has a source package). */
export function isRuntimePortletKind(kind: string, version: string): boolean {
  return getPortletKind(kind, version)?.sourcePackageName !== undefined;
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

/** Descriptor lookup by kind, ANY version (the first registered). Used when a
 *  runtime kind's `rendersAs` target may be registered under a different
 *  version than the runtime kind itself. */
export function getPortletKindDescriptorAnyVersion(kind: string): PortletKindDescriptor | undefined {
  const e = findAnyVersion(kind);
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
