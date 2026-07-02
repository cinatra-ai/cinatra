import "server-only";

// The host `ExtensionHostContext` factory.
//
// Builds the privileged port surface the host passes to an extension's
// `register(ctx)` (via the StaticBundleLoader / activateExtensionModule). It is
// GRANT-AWARE: a privileged port is the real wired impl ONLY when the extension
// declared it in `requestedHostPorts`; otherwise it is FAIL-LOUD (throws on
// access) — distinguishing "not granted" (least-privilege denial) from
// "not implemented" (a granted `reserved`-tier port the host factory has not
// wired; driven by the canonical HOST_PORT_TIER table). Ambient ports
// (logger/runtime) are always available.
//
// The prototype is now the REAL host. Every privileged port
// connectors consume is wired to its host service through trusted, org-scoped
// resolution — `settings`/`secrets`/`nango`/`objects`/`mcp`/`jobs`/`notifications`/
// `telemetry` derive the actor + organization from the request/run context
// (`@/lib/extension-host-actor`), NOT from caller input, under any invocation
// path (cookie / MCP / worker / A2A). `capabilities` is a GENERIC, host-owned
// provider registry (`@/lib/extension-capabilities-registry`) that imports no
// connector — replacing the prototype that hardcoded `email-send` and imported
// `@cinatra-ai/email-connector` (the host itself used to violate the boundary).

import type {
  ExtensionHostContext,
  HostLoggerPort,
  HostRuntimePort,
  HostPortName,
  HostUsageEvent,
} from "@cinatra-ai/sdk-extensions";
// The per-port ABI tier table — the canonical source for the fail-loud
// "not-implemented" branch below (a granted `reserved`-tier port is
// wired-but-unavailable until a future MINOR flips its tier to `stable`).
import { HOST_PORT_TIER } from "@cinatra-ai/sdk-extensions";
import { getAppRuntimeMode } from "@/lib/runtime-mode";
import { registerExtensionMcpTool } from "@/lib/extension-mcp-registry";
import { deleteConnectorConfig, readConnectorConfigFromDatabase, writeConnectorConfigToDatabase } from "@/lib/database";
import { devFixtureProvenanceKey } from "@/lib/extension-fixture-provenance";
import {
  registerCapabilityProvider,
  resolveCapabilityProviders,
} from "@/lib/extension-capabilities-registry";
import {
  registerExtensionSetupSurface,
  registerExtensionSettingsSurface,
  registerExtensionUiAction,
} from "@/lib/extension-ui-registry";
import {
  resolveExtensionActorContext,
  resolveExtensionActorSummary,
  requireExtensionOrganizationId,
} from "@/lib/extension-host-actor";
// Imported from the NARROW registry entry point (`@cinatra-ai/objects/registry` —
// zero React / DB / server-only imports per its module header) so object-type
// registration is SYNCHRONOUS. A dynamic `import().then(register)` returns a
// Promise the loader does NOT await (the `HostObjectsPort.registerType` SDK
// contract is `void`, so `register(ctx){ ctx.objects.registerType(...) }` never
// awaits it) — the registration could float past activation. A synchronous
// register completes (and surfaces a failure as a thrown `register-threw`)
// BEFORE `await server.register(ctx)` resolves.
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";

const ABI_VERSION = "2.2.0";

function makeLogger(packageName: string): HostLoggerPort {
  const tag = `[ext:${packageName}]`;
  return {
    debug: (msg, fields) => console.debug(tag, msg, fields ?? ""),
    info: (msg, fields) => console.info(tag, msg, fields ?? ""),
    warn: (msg, fields) => console.warn(tag, msg, fields ?? ""),
    error: (msg, fields) => console.error(tag, msg, fields ?? ""),
  };
}

function makeRuntime(): HostRuntimePort {
  return {
    mode: getAppRuntimeMode(),
    flag: (name) => {
      if (/SECRET|KEY|TOKEN|PASSWORD|CREDENTIAL|PRIVATE/i.test(name)) return false;
      return process.env[name] === "true" || process.env[name] === "1";
    },
    publicBaseUrl: () =>
      process.env.NEXT_PUBLIC_APP_URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? process.env.BETTER_AUTH_URL ?? null,
  };
}

// ---------------------------------------------------------------------------
// capabilities — generic, host-owned provider registry (no connector import).
// ---------------------------------------------------------------------------

// The reserved provider-identity namespace for HOST-published services. Only
// host-trusted DIRECT callers of `registerCapabilityProvider`
// (`register-host-connector-services` / `register-email-providers` /
// `register-blog-providers`) may claim it — never an extension via the
// `ctx.capabilities` port. The exact `@cinatra-ai/host` package and any
// `@cinatra-ai/host:<service>` id are both reserved.
const HOST_RESERVED_PROVIDER_NAMESPACE = "@cinatra-ai/host";

function isReservedHostProviderIdentity(packageName: string): boolean {
  return (
    packageName === HOST_RESERVED_PROVIDER_NAMESPACE ||
    packageName.startsWith(`${HOST_RESERVED_PROVIDER_NAMESPACE}:`)
  );
}

/**
 * Bind a capability registration to the HOST-INJECTED `packageName` — the only
 * authoritative provider identity (cinatra#150). Any caller-supplied
 * `provider.packageName` is UNTRUSTED extension input and is OVERRIDDEN, never
 * trusted: without this, an extension could register a provider claiming
 * ANOTHER package's identity (impersonation) or shadow a host
 * `@cinatra-ai/host:*` service. The `impl` is preserved; only the identity is
 * forced. Registering under the reserved host namespace from the extension port
 * is REJECTED (a real extension's `packageName` can never be the host namespace,
 * so this is defense-in-depth). Scope: provider-IDENTITY forgery only —
 * capability-ID squatting (same id, different provider) is out (cinatra#155).
 */
function bindProviderIdentity(
  packageName: string,
  provider: { packageName: string; impl: unknown },
): { packageName: string; impl: unknown } {
  if (isReservedHostProviderIdentity(packageName)) {
    throw new Error(
      `[capabilities] "${packageName}" may not register a capability provider via the extension port: the "${HOST_RESERVED_PROVIDER_NAMESPACE}" namespace is reserved for host-published services`,
    );
  }
  // Authoritative identity is the host-injected packageName — caller-supplied
  // provider.packageName is ignored (override, not merge of identity).
  return { ...provider, packageName };
}

function makeCapabilities(packageName: string): ExtensionHostContext["capabilities"] {
  return {
    registerProvider: (capability, provider) =>
      registerCapabilityProvider(capability, bindProviderIdentity(packageName, provider)),
    resolveProviders: (capability) => resolveCapabilityProviders(capability),
  };
}

// ---------------------------------------------------------------------------
// mcp — registerTool (host extension-MCP registry) + callPrimitive (host self
// invoker) + listExternalServers (global external MCP registry).
// ---------------------------------------------------------------------------

function makeMcp(packageName: string): ExtensionHostContext["mcp"] {
  return {
    registerTool: (tool) => registerExtensionMcpTool(packageName, tool),
    callPrimitive: async (primitiveName, input) => {
      const [{ callHostPrimitive }, actor] = await Promise.all([
        import("@/lib/extension-self-mcp"),
        resolveExtensionActorContext(),
      ]);
      return callHostPrimitive(primitiveName, input, { actor });
    },
    listExternalServers: async () => {
      const { listEnabledGlobalExternalMcpServers } = await import("@/lib/external-mcp-registry");
      return listEnabledGlobalExternalMcpServers();
    },
    getPublicBaseUrl: async () => {
      const { getMcpPublicBaseUrl } = await import("@cinatra-ai/mcp-server/credentials");
      const { publicBaseUrl } = getMcpPublicBaseUrl();
      return { publicBaseUrl };
    },
  };
}

// ---------------------------------------------------------------------------
// nango — the @/lib/nango surface, inverted. Arg order differs from the host
// helper (port: connectionId, providerConfigKey; host: providerConfigKey,
// connectionId).
// ---------------------------------------------------------------------------

function makeNango(): ExtensionHostContext["nango"] {
  return {
    isConfigured: async () => {
      const { isNangoConfigured } = await import("@/lib/nango-system");
      return isNangoConfigured();
    },
    getConnection: async (connectionId, providerConfigKey) => {
      const { getNangoConnection } = await import("@/lib/nango-system");
      return getNangoConnection(providerConfigKey, connectionId);
    },
    ensureConnectSession: async (input) => {
      const { createNangoConnectSession } = await import("@/lib/nango-system");
      return createNangoConnectSession(input as Parameters<typeof createNangoConnectSession>[0]);
    },
    // Render-time getters for connector setup/settings pages (ABI 2.2.0). The
    // SDK takes `connectorKey: string`; we narrow to the host roster union at the
    // boundary. `@/lib/nango` is `export * from "@cinatra-ai/nango-connector"`.
    getStatus: async () => {
      const { getNangoStatus } = await import("@/lib/nango-system");
      return getNangoStatus();
    },
    getFrontendConfig: async () => {
      const { getNangoFrontendConfig } = await import("@/lib/nango-system");
      return getNangoFrontendConfig();
    },
    getPrimarySavedConnection: async (connectorKey, opts) => {
      const { getPrimarySavedNangoConnection } = await import("@/lib/nango-system");
      return getPrimarySavedNangoConnection(
        connectorKey as Parameters<typeof getPrimarySavedNangoConnection>[0],
        opts,
      );
    },
    getPrimarySavedConnections: async (opts) => {
      const { getPrimarySavedNangoConnections } = await import("@/lib/nango-system");
      return getPrimarySavedNangoConnections(opts);
    },
    listConnectionRecords: async (connectorKey) => {
      const { listSavedNangoConnections } = await import("@/lib/nango-system");
      return listSavedNangoConnections(
        connectorKey as Parameters<typeof listSavedNangoConnections>[0],
      );
    },
    // Canonical OAuth callback URL (post-2.2.0 additive, optional on the port).
    // Delegates to the single canonical host helper so connector setup pages echo
    // the exact `redirect_uri` Nango sends — no connector-side normalization.
    getNangoOAuthCallbackUrl: async () => {
      const { getNangoOAuthCallbackUrl } = await import("@/lib/nango-system");
      return getNangoOAuthCallbackUrl();
    },
  };
}

// ---------------------------------------------------------------------------
// settings — non-secret, ORG + package-scoped config. Keys namespaced
// `ext:<packageName>:<orgId>:<key>` so one extension can't read another's config
// and one org can't read another's. The organization is REQUIRED from the
// trusted context: there is deliberately NO shared package-global fallback for
// extension config (a stale/absent actor must fail loud, never silently read or
// write a cross-tenant namespace). Workspace-global extension config, if ever
// needed, would be an explicit, separately-authorised host path — not an
// automatic default here.
// ---------------------------------------------------------------------------

async function settingsKey(packageName: string, key: string): Promise<string> {
  const orgId = await requireExtensionOrganizationId(packageName);
  return `ext:${packageName}:${orgId}:${key}`;
}

function makeSettings(packageName: string): ExtensionHostContext["settings"] {
  return {
    get: async <T = unknown>(key: string) =>
      readConnectorConfigFromDatabase<T | null>(await settingsKey(packageName, key), null),
    set: async <T = unknown>(key: string, value: T) => {
      const orgId = await requireExtensionOrganizationId(packageName);
      writeConnectorConfigToDatabase(`ext:${packageName}:${orgId}:${key}`, value);
      // A direct write makes this row USER-owned: drop any dev-fixture
      // provenance sidecar so the dev seeder never re-seeds/clobbers it.
      deleteConnectorConfig(devFixtureProvenanceKey(packageName, orgId, key));
    },
    delete: async (key: string) => {
      const orgId = await requireExtensionOrganizationId(packageName);
      // True row delete (not a write of JSON "null"), so an extension's config
      // surface is genuinely cleared and the lifecycle teardown leaves no residue.
      deleteConnectorConfig(`ext:${packageName}:${orgId}:${key}`);
      deleteConnectorConfig(devFixtureProvenanceKey(packageName, orgId, key));
    },
  };
}

// ---------------------------------------------------------------------------
// secrets — encrypted at rest (AES-256-GCM via @/lib/instance-secrets), ORG +
// package-scoped (org REQUIRED — no global fallback, same as settings),
// deliberately separate from non-secret settings. Stored under
// `ext-secret:<packageName>:<orgId>:<key>`; the FULL store key is bound as GCM
// additional-authenticated-data so a ciphertext row cannot be replayed under a
// different org / package / key and still decrypt.
// ---------------------------------------------------------------------------

async function secretMeta(packageName: string, key: string): Promise<{ storeKey: string; aad: string }> {
  const orgId = await requireExtensionOrganizationId(packageName);
  const storeKey = `ext-secret:${packageName}:${orgId}:${key}`;
  return { storeKey, aad: storeKey };
}

function makeSecrets(packageName: string): ExtensionHostContext["secrets"] {
  return {
    get: async (key: string) => {
      const { storeKey, aad } = await secretMeta(packageName, key);
      const stored = readConnectorConfigFromDatabase<{ ciphertext: string; iv: string } | null>(storeKey, null);
      if (!stored) return null;
      const { decryptSecret } = await import("@/lib/instance-secrets");
      return decryptSecret(stored, aad);
    },
    set: async (key: string, value: string) => {
      const { storeKey, aad } = await secretMeta(packageName, key);
      const { encryptSecret } = await import("@/lib/instance-secrets");
      writeConnectorConfigToDatabase(storeKey, encryptSecret(value, aad));
    },
    delete: async (key: string) => {
      const { storeKey } = await secretMeta(packageName, key);
      // True row delete — never leave a decryptable-shaped residue behind.
      deleteConnectorConfig(storeKey);
    },
  };
}

// ---------------------------------------------------------------------------
// objects — object-type registration + org-scoped object store + history.
// ---------------------------------------------------------------------------

function makeObjects(packageName: string): ExtensionHostContext["objects"] {
  const requireClient = async () => {
    const actor = await resolveExtensionActorContext();
    if (!actor) {
      throw new Error(
        `[ExtensionHostContext] ${packageName}: ctx.objects used with no resolvable actor — ` +
          `the object store is organization-scoped and needs a trusted request/run context.`,
      );
    }
    const { createSessionObjectsClient } = await import("@cinatra-ai/objects");
    return createSessionObjectsClient(actor);
  };
  return {
    registerType: (descriptor) => {
      // Object-type registration is process-global (replace-by-id), not
      // org-scoped. Register SYNCHRONOUSLY against the eagerly-imported registry
      // (see the narrow `@cinatra-ai/objects/registry` import at the top of this
      // file) so the type is guaranteed registered — and any registration failure
      // surfaces (it is NOT swallowed) — BEFORE `register(ctx)` returns and the
      // loader's `await server.register(ctx)` resolves. The previous
      // dynamic-import-then-register returned a Promise the loader could not await
      // (the SDK `HostObjectsPort.registerType` contract is `void`), so the
      // registration floated past activation completion.
      //
      // The SDK keeps the descriptor opaque (`{ typeId, ioSpec?, [k]: unknown }`)
      // so it never depends on `@cinatra-ai/objects`; the concrete
      // `ObjectTypeDefinition` shape is validated host-side at registration. Pass
      // `packageName` as provenance so the teardown hook can deregister exactly
      // this package's types on archive/uninstall.
      objectTypeRegistry.register(
        descriptor as unknown as Parameters<typeof objectTypeRegistry.register>[0],
        packageName,
      );
    },
    read: async <T = unknown>(typeId: string, id: string) => {
      const client = await requireClient();
      // `objects_get` returns a `{ object: StoredObject | null }` envelope —
      // unwrap it (returning the envelope would be wrong) and REFUSE a type
      // mismatch so a caller can't request one typeId and receive a different
      // object by id (no type confusion across the shared id space).
      const raw = (await client.get(id)) as { object?: { type?: string } | null } | null;
      const obj = raw?.object ?? null;
      if (!obj) return null;
      if (typeId && obj.type != null && obj.type !== typeId) return null;
      return obj as T;
    },
    write: async <T = unknown>(typeId: string, value: T) => {
      const client = await requireClient();
      const saved = await client.save({ rawData: value as Record<string, unknown>, typeHint: typeId });
      return { id: saved.objectId };
    },
    history: async (_typeId: string, id: string) => {
      const [{ callHostPrimitive }, actor] = await Promise.all([
        import("@/lib/extension-self-mcp"),
        resolveExtensionActorContext(),
      ]);
      const result = (await callHostPrimitive("object_history_list", { objectId: id }, { actor })) as
        | { items?: unknown[] }
        | unknown[]
        | null;
      if (Array.isArray(result)) return result;
      return result?.items ?? [];
    },
  };
}

// ---------------------------------------------------------------------------
// jobs — background job enqueue (the BullMQ queue). `registerWorker` is NOT
// supported: the host dispatcher is a static switch keyed by `BACKGROUND_JOB_NAMES`,
// not a dynamic registry, and no in-scope extension registers a worker. Fail
// loud rather than silently no-op.
// ---------------------------------------------------------------------------

function makeJobs(packageName: string): ExtensionHostContext["jobs"] {
  return {
    enqueue: async (jobName, payload, opts) => {
      const { enqueueBackgroundJob } = await import("@/lib/background-jobs");
      const id = await enqueueBackgroundJob(
        jobName as Parameters<typeof enqueueBackgroundJob>[0],
        (payload ?? {}) as Record<string, unknown>,
        opts as Parameters<typeof enqueueBackgroundJob>[2],
      );
      return { id };
    },
    registerWorker: () => {
      throw new Error(
        `[ExtensionHostContext] ${packageName}: ctx.jobs.registerWorker is not supported — the host ` +
          `runs a static background-job dispatcher (BACKGROUND_JOB_NAMES). Use ctx.jobs.enqueue against ` +
          `a host-recognised job name.`,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// notifications — host notification emission, addressed to the resolved actor
// (user → org → admins fallback). SDK `level` (info|warn|error) maps to the
// host `NotificationKind` (info|warning|error).
// ---------------------------------------------------------------------------

function makeNotifications(packageName: string): ExtensionHostContext["notifications"] {
  return {
    emit: async ({ level, title, body }) => {
      const summary = await resolveExtensionActorSummary();
      const recipient = summary?.userId
        ? ({ kind: "user", userId: summary.userId } as const)
        : summary?.organizationId
          ? ({ kind: "organization", organizationId: summary.organizationId } as const)
          : ({ kind: "admins" } as const);
      const kind = level === "warn" ? "warning" : level;
      const { createNotificationForRecipient } = await import("@cinatra-ai/notifications/server");
      await createNotificationForRecipient(recipient, {
        title,
        ...(body !== undefined ? { body } : {}),
        kind,
        metadata: { source: "extension", packageName },
      });
    },
  };
}

// ---------------------------------------------------------------------------
// ui — registration channel (setup/settings surfaces + named actions). Records
// into the host UI registry; the schema-driven runtime installer reads
// it. NOT a host-component bag.
// ---------------------------------------------------------------------------

function makeUi(packageName: string): ExtensionHostContext["ui"] {
  return {
    registerSetupSurface: (surface) => registerExtensionSetupSurface(packageName, surface),
    registerSettingsSurface: (surface) => registerExtensionSettingsSurface(packageName, surface),
    registerAction: (action) => registerExtensionUiAction({ packageName, id: action.id, handler: action.handler }),
  };
}

// ---------------------------------------------------------------------------
// telemetry — usage/cost emission (the @cinatra-ai/metric-usage-api surface,
// inverted). Fire-and-forget by contract: never throws, never blocks.
// ---------------------------------------------------------------------------

function makeTelemetry(packageName: string, logger: HostLoggerPort): ExtensionHostContext["telemetry"] {
  return {
    emitUsage: (event: HostUsageEvent) => {
      void import("@cinatra-ai/metric-usage-api")
        .then(({ emitUsageEvent }) => emitUsageEvent(event as Parameters<typeof emitUsageEvent>[0]))
        .catch((err) =>
          logger.warn(`telemetry.emitUsage failed (swallowed)`, {
            error: err instanceof Error ? err.message : String(err),
          }),
        );
    },
  };
}

// ---------------------------------------------------------------------------
// authSession — resolve the actor across cookie / MCP / worker / A2A contexts
// (NOT cookie-only). The summary is `{ userId, organizationId, orgRole }`.
// ---------------------------------------------------------------------------

function makeAuthSession(packageName: string): ExtensionHostContext["authSession"] {
  return {
    getActor: async () => resolveExtensionActorSummary(),
    requireOrganizationId: async () => {
      const summary = await resolveExtensionActorSummary();
      const orgId = summary?.organizationId;
      if (!orgId) {
        throw new Error(
          `[ExtensionHostContext] ${packageName}: ctx.authSession.requireOrganizationId() — ` +
            `no organizationId on the current actor (cookie / MCP / worker context).`,
        );
      }
      return orgId;
    },
  };
}

// ---------------------------------------------------------------------------

const AMBIENT_PORTS: readonly HostPortName[] = ["logger", "runtime"];

// Well-known hooks that serialization / inspection infrastructure probes on
// EVERY value it touches — React's RSC Flight serializer (`toJSON`, the
// thenable check, the `$$typeof` element check), `JSON.stringify`, and
// console/inspect. Reading one of these is NOT an extension using the port, so
// the fail-loud proxy must answer them inertly (undefined) instead of throwing;
// otherwise a host route that merely passes `ctx` as a prop to a server
// component crashes when the framework serializes the element tree (the setup
// page renders 200, then the browser's Flight client throws on
// `ctx.<ungranted-port>.toJSON`). Real port methods (query/get/registerTool/…)
// are never in this set and still fail loud below.
const SERIALIZATION_PROBE_PROPS: ReadonlySet<string> = new Set([
  "toJSON",
  "then",
  "catch",
  "finally",
  "$$typeof",
]);

/**
 * Fail-loud placeholder for a privileged port the extension cannot use. Any
 * property access throws. Two distinct reasons:
 *  - "not-granted": the port is not in the extension's `requestedHostPorts`.
 *  - "not-implemented": granted, but its ABI tier is `reserved` — declared in the
 *    frozen surface yet not wired (driven by HOST_PORT_TIER; today only `db`, the
 *    scoped escape hatch, which stays unwired until a real consumer needs it).
 */
function unavailablePort(
  packageName: string,
  port: HostPortName,
  reason: "not-granted" | "not-implemented",
): unknown {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        // Answer serialization/inspection probes inertly so a passed-but-unused
        // ungranted/unwired port survives framework serialization (RSC Flight,
        // JSON, console) instead of hard-crashing the page. All symbol-keyed
        // access (Symbol.toPrimitive / toStringTag / iterator / inspect.custom,
        // the React element symbols) is infrastructure, never a port method.
        if (typeof prop === "symbol" || SERIALIZATION_PROBE_PROPS.has(prop)) {
          return undefined;
        }
        if (reason === "not-granted") {
          throw new Error(
            `[ExtensionHostContext] ${packageName}: host port "${port}".${String(prop)} accessed but NOT GRANTED — ` +
              `add "${port}" to the extension manifest's cinatra.requestedHostPorts (least-privilege).`,
          );
        }
        throw new Error(
          `[ExtensionHostContext] ${packageName}: host port "${port}".${String(prop)} is not implemented in the host factory.`,
        );
      },
    },
  );
}

/**
 * Build the host ctx for one extension, GRANT-AWARE: a privileged port is the
 * real wired impl only when the extension granted it via `requestedHostPorts`;
 * ungranted privileged ports are fail-loud. Ambient ports (`logger`/`runtime`)
 * are always real. Org/actor-scoped ports resolve the trusted context PER CALL.
 */
export function createExtensionHostContext(
  packageName: string,
  grantedPorts: readonly HostPortName[] = [],
): ExtensionHostContext {
  const granted = new Set<HostPortName>([...grantedPorts, ...AMBIENT_PORTS]);
  const logger = makeLogger(packageName);

  // A privileged port is the real wired impl only when GRANTED and its ABI tier
  // is `stable`. Three states (see the ABI-evolution port-tiering policy):
  //   - not granted                  → fail-loud "not-granted" (least-privilege).
  //   - granted + `reserved` tier     → fail-loud "not-implemented" (declared in
  //                                     the frozen surface but not wired yet).
  //   - granted + `stable` tier       → the real impl.
  // Today only `db` is `reserved`, so this is behavior-preserving; wiring it later
  // is a one-line tier flip in HOST_PORT_TIER (no host-factory edit needed).
  const gated = <K extends HostPortName>(port: K, build: () => ExtensionHostContext[K]): ExtensionHostContext[K] => {
    if (!granted.has(port)) return unavailablePort(packageName, port, "not-granted") as ExtensionHostContext[K];
    if (HOST_PORT_TIER[port] === "reserved")
      return unavailablePort(packageName, port, "not-implemented") as ExtensionHostContext[K];
    return build() as ExtensionHostContext[K];
  };

  return {
    abiVersion: ABI_VERSION,
    packageName,
    logger,
    runtime: makeRuntime(),
    // `db` is the deliberate scoped escape hatch — a `reserved`-tier port, unwired
    // until a real consumer needs it. The tier-aware `gated` helper fail-louds it
    // ("not-implemented" when granted, "not-granted" otherwise); the `build()`
    // throws so a future wiring never silently activates an un-flipped reserved port.
    db: gated("db", () => {
      throw new Error(
        `[ExtensionHostContext] ${packageName}: reserved port "db" has no wired impl — flip HOST_PORT_TIER.db to "stable" when wiring it.`,
      );
    }),
    settings: gated("settings", () => makeSettings(packageName)),
    secrets: gated("secrets", () => makeSecrets(packageName)),
    nango: gated("nango", () => makeNango()),
    authSession: gated("authSession", () => makeAuthSession(packageName)),
    mcp: gated("mcp", () => makeMcp(packageName)),
    objects: gated("objects", () => makeObjects(packageName)),
    jobs: gated("jobs", () => makeJobs(packageName)),
    notifications: gated("notifications", () => makeNotifications(packageName)),
    ui: gated("ui", () => makeUi(packageName)),
    capabilities: gated("capabilities", () => makeCapabilities(packageName)),
    telemetry: gated("telemetry", () => makeTelemetry(packageName, logger)),
  };
}

/**
 * Build a PROBE host ctx for the hot-UPDATE pre-verify (`verifyNewDigest-
 * Activatable`). It is identical to `createExtensionHostContext` EXCEPT the four
 * register-CHANNEL ports (`mcp` / `capabilities` / `objects` / `ui`) are replaced
 * by INERT recorders that touch NO live host registry. Running the new digest's
 * `register(ctx)` against this probe PROVES it does not throw — the invariant
 * "verify the new digest ACTIVATES (register succeeds) BEFORE teardown+GC of the
 * old" — without mutating any in-memory registration (the live state stays the OLD
 * digest's until the real activation pass runs after teardown).
 *
 * GRANT-AWARE + FAIL-CLOSED PRESERVED: every OTHER port (settings / secrets / nango
 * / authSession / jobs / notifications / telemetry / db) is the REAL grant-gated
 * impl — so a register that reads settings sees real values, and a register that
 * accesses an UNGRANTED privileged port still fails loud exactly as it would during
 * the real activation. Only the four registration sinks are inert (a probe must not
 * register into the live process). The recorder is returned so a caller can inspect
 * what the probe register WOULD have registered.
 */
export function createExtensionProbeHostContext(
  packageName: string,
  grantedPorts: readonly HostPortName[] = [],
): {
  ctx: ExtensionHostContext;
  recorder: {
    mcpTools: unknown[];
    capabilityProviders: Array<{ capability: string; provider: unknown }>;
    objectTypes: unknown[];
    uiSetupSurfaces: unknown[];
    uiSettingsSurfaces: unknown[];
    uiActions: unknown[];
  };
} {
  const real = createExtensionHostContext(packageName, grantedPorts);
  const granted = new Set<HostPortName>([...grantedPorts, ...AMBIENT_PORTS]);

  const recorder = {
    mcpTools: [] as unknown[],
    capabilityProviders: [] as Array<{ capability: string; provider: unknown }>,
    objectTypes: [] as unknown[],
    uiSetupSurfaces: [] as unknown[],
    uiSettingsSurfaces: [] as unknown[],
    uiActions: [] as unknown[],
  };

  // Inert register-channel ports — built ONLY when GRANTED (else keep the real
  // fail-loud `unavailablePort` so an ungranted access throws during the probe
  // exactly as it would during real activation). Constructing them lazily matters:
  // referencing a method off the ungranted `real.<port>` fail-loud Proxy (e.g.
  // `real.jobs.registerWorker`) would itself THROW at ctx-build time, so each probe
  // port is self-contained and never reads off the ungranted real port.
  const probeMcp: ExtensionHostContext["mcp"] = {
    registerTool: (tool) => {
      recorder.mcpTools.push(tool);
    },
    callPrimitive: async () => {
      throw new Error(`[probe] ${packageName}: ctx.mcp.callPrimitive is not available during a register probe`);
    },
    listExternalServers: async () => [],
    getPublicBaseUrl: async () => ({ publicBaseUrl: null }),
  };
  const probeCapabilities: ExtensionHostContext["capabilities"] = {
    registerProvider: (capability, provider) => {
      // Identity enforcement (cinatra#150) applies to the probe too: a malicious
      // digest must not pass the hot-update pre-verify by claiming another
      // package's identity or the reserved host namespace, and the recorder must
      // reflect the FORCED (authoritative) identity the real activation would
      // register — so apply the same bind+reservation as the live port.
      recorder.capabilityProviders.push({
        capability,
        provider: bindProviderIdentity(packageName, provider),
      });
    },
    // READS stay REAL (matching the probe contract: read ports are real, only
    // registration sinks are inert). A register(ctx) that resolves a host
    // service capability at activation — e.g. the email/blog facades fail loud
    // when their `@cinatra-ai/host:*` routing service is absent — must see the
    // same live providers the real activation would, or the hot-update
    // pre-verify would falsely reject a valid digest with `register-threw`.
    resolveProviders: (capability) => resolveCapabilityProviders(capability),
  };
  const probeObjects: ExtensionHostContext["objects"] = granted.has("objects")
    ? {
        ...createExtensionHostContext(packageName, grantedPorts).objects,
        registerType: (descriptor) => {
          // Minimal shape validation mirrors the host registry's keying field so a
          // structurally-broken descriptor (the same input the real registry
          // throws on) still surfaces as a register-threw during the probe.
          if (descriptor == null || typeof descriptor !== "object") {
            throw new Error(
              `[probe] ${packageName}: ctx.objects.registerType received a non-object descriptor`,
            );
          }
          recorder.objectTypes.push(descriptor);
        },
      }
    : real.objects;
  const probeUi: ExtensionHostContext["ui"] = {
    registerSetupSurface: (surface) => {
      recorder.uiSetupSurfaces.push(surface);
    },
    registerSettingsSurface: (surface) => {
      recorder.uiSettingsSurfaces.push(surface);
    },
    registerAction: (action) => {
      recorder.uiActions.push(action);
    },
  };

  // Suppress WORLD-MUTATING action ports during the probe so a `register` that
  // (against contract) enqueues a job / emits a notification / emits telemetry
  // does NOT double-fire when the REAL activation re-runs `register` after
  // teardown. READS (settings/secrets/nango/authSession) stay the real impl so a
  // register that reads config to decide what to register still sees real values.
  const probeJobs: ExtensionHostContext["jobs"] = {
    enqueue: async () => ({ id: "probe-noop" }),
    registerWorker: () => {
      throw new Error(`[probe] ${packageName}: ctx.jobs.registerWorker is not supported`);
    },
  };
  const probeNotifications: ExtensionHostContext["notifications"] = {
    emit: async () => {},
  };
  const probeTelemetry: ExtensionHostContext["telemetry"] = {
    emitUsage: () => {},
  };

  const ctx: ExtensionHostContext = {
    ...real,
    mcp: granted.has("mcp") ? probeMcp : real.mcp,
    capabilities: granted.has("capabilities") ? probeCapabilities : real.capabilities,
    objects: probeObjects,
    ui: granted.has("ui") ? probeUi : real.ui,
    jobs: granted.has("jobs") ? probeJobs : real.jobs,
    notifications: granted.has("notifications") ? probeNotifications : real.notifications,
    telemetry: granted.has("telemetry") ? probeTelemetry : real.telemetry,
  };

  return { ctx, recorder };
}
