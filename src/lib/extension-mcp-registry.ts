import "server-only";

// Host-owned registry of MCP tools an extension registers via `ctx.mcp.registerTool`
// (the `mcp` host port). EMPTY by default — no extension registers a tool unless
// it opts in (grants "mcp" + calls registerTool in register(ctx)). The MCP server
// build (`registerAllCapabilities`) replays this registry AFTER the static
// modules, skipping any tool name a static module already claimed. So with an
// empty registry the replay is a no-op and the existing chat/agent MCP tool set
// is byte-for-byte unchanged.
//
// CROSS-COMPILATION SINGLETON: Next.js 16 builds separate bundler compilations
// (instrumentation / route / RSC), each with its own module cache. The loader
// registers tools at boot (instrumentation compilation); the MCP route reads them
// at request time (route compilation) — so the registry MUST be a true
// per-process singleton, anchored on a namespaced+versioned `Symbol.for(...)` key
// (same pattern as the email/social connector registries).

import { z } from "zod";
import type { HostMcpToolRegistration, DelegatedChatToolClass } from "@cinatra-ai/sdk-extensions";
import type { McpRuntimeToolServer } from "@cinatra-ai/mcp-server";
import { normalizeDelegatedChatToolClass } from "@cinatra-ai/mcp-server/delegated-chat-tool-policy";
import {
  CapabilityPlanRecorder,
  HOST_PRIMITIVE_OWNER_PACKAGE,
  HOST_PRIMITIVE_RELEASE_VERSION,
  primitiveProvenanceStamp,
  type CapabilityPlan,
  type HostPrimitiveIdentity,
  type PlannedPrimitive,
  type PrimitiveDispatchTarget,
} from "@cinatra-ai/mcp-server/capability-plan";

export type RegisteredExtensionMcpTool = HostMcpToolRegistration & {
  packageName: string;
  /**
   * The EXACT version of the record whose `register(ctx)` produced this
   * registration (cinatra#2817 slice 1), or `null` for a legacy/dev context
   * that carries no record version.
   *
   * `null` is NOT a neutral value downstream: version-bound admission cannot
   * match an unversioned identity, so an unversioned registration is refused on
   * the delegated-chat perimeter. That is the correct fail-closed reading — a
   * primitive whose version the host cannot state is a primitive the host
   * cannot have reviewed.
   */
  resolvedVersion: string | null;
};

class ExtensionMcpRegistryImpl {
  private entries: Map<string, RegisteredExtensionMcpTool> = new Map();

  register(
    packageName: string,
    tool: HostMcpToolRegistration,
    options?: { resolvedVersion?: string | null },
  ): void {
    const name = tool?.name;
    if (!name || typeof name !== "string") {
      throw new Error(`[extensionMcpRegistry] ${packageName} registered an MCP tool with no name`);
    }
    if (typeof tool.handler !== "function") {
      throw new Error(`[extensionMcpRegistry] ${packageName} MCP tool "${name}" has no handler`);
    }
    const existing = this.entries.get(name);
    if (existing && existing.packageName !== packageName) {
      console.warn(
        `[extensionMcpRegistry] tool "${name}" re-registered by ${packageName} (was ${existing.packageName})`,
      );
    }
    // STRUCTURAL VALIDATION of the delegated-chat declaration (cinatra#2771)
    // at the registry boundary, so a malformed value can never propagate into
    // versioned discovery, the replay, or a call-time lookup. Normalizing here
    // rather than at each reader means every consumer sees either a valid
    // class or `undefined` (undeclared). A present-but-unreadable value
    // normalizes to `"none"` — fail-closed in the NARROWING direction; it is
    // never re-read as "undeclared", which is neutral and would widen.
    //
    // Note this is validation ONLY. The declaration is not authorization: what
    // an extension declares here still cannot admit a name the delegated-chat
    // policy refuses.
    this.entries.set(name, {
      ...tool,
      packageName,
      resolvedVersion: options?.resolvedVersion ?? null,
      delegatedChat: normalizeDelegatedChatToolClass(tool.delegatedChat),
    });
  }

  listAll(): readonly RegisteredExtensionMcpTool[] {
    return Array.from(this.entries.values());
  }

  /**
   * Remove every tool a package registered (uninstall/teardown). Returns the
   * removed tool names. Without this, an uninstalled extension's MCP tools
   * persisted in this memory-only registry until process restart — a split-brain
   * hole: the tool stayed listable + invocable and kept shadow-allowing in the
   * authz effective-set after the extension was gone.
   */
  removeByPackage(packageName: string): string[] {
    const removed: string[] = [];
    for (const [name, tool] of this.entries) {
      if (tool.packageName === packageName) {
        this.entries.delete(name);
        removed.push(name);
      }
    }
    return removed;
  }

  size(): number {
    return this.entries.size;
  }

  /** @internal Only for tests. */
  _clearForTests(): void {
    this.entries.clear();
  }
}

const EXTENSION_MCP_REGISTRY_KEY = Symbol.for("@cinatra-ai/host:extension-mcp-registry/v1");
type RegistryHolder = { [k: symbol]: ExtensionMcpRegistryImpl | undefined };
const _holder = globalThis as unknown as RegistryHolder;
export const extensionMcpRegistry: ExtensionMcpRegistryImpl =
  _holder[EXTENSION_MCP_REGISTRY_KEY] ??
  (_holder[EXTENSION_MCP_REGISTRY_KEY] = new ExtensionMcpRegistryImpl());

export function registerExtensionMcpTool(
  packageName: string,
  tool: HostMcpToolRegistration,
  options?: { resolvedVersion?: string | null },
): void {
  extensionMcpRegistry.register(packageName, tool, options);
}

export function listExtensionMcpTools(): readonly RegisteredExtensionMcpTool[] {
  return extensionMcpRegistry.listAll();
}

/**
 * A REDACTED diagnostic snapshot of the registered extension MCP tools — tool name
 * + owning packageName ONLY, never the handler. For the operator control-plane
 * endpoint, so the aggregator never has to carry handler-bearing registry entries.
 */
export function snapshotExtensionMcpTools(): { name: string; packageName: string }[] {
  return extensionMcpRegistry.listAll().map((t) => ({ name: t.name, packageName: t.packageName }));
}

/**
 * Teardown an uninstalled extension's MCP tools: drop them from the registry AND
 * from the authz effective-set, so the tool is no longer listable, invocable, or
 * shadow-allowed the moment the extension is gone (no restart needed). Returns
 * the removed tool names. Safe no-op for a package that registered nothing.
 */
export function removeExtensionMcpToolsForPackage(packageName: string): string[] {
  const removed = extensionMcpRegistry.removeByPackage(packageName);
  const eff = _effHolder[EFFECTIVE_KEY];
  if (eff) {
    for (const [name, pkg] of eff) {
      if (pkg === packageName) eff.delete(name);
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// EFFECTIVE set — the tool names the MCP-server build (`registerAllCapabilities`)
// ACTUALLY replayed into the server, EXCLUDING names skipped due to a static or
// reserved host-tool collision. The authz boundary consults THIS (not raw
// registry membership) so an extension cannot unlock a host tool (e.g. an
// unclassified built-in like `system_screen_lookup`) by registering its name —
// such a registration is skipped by the replay and never becomes "effective".
// globalThis-anchored (same cross-compilation reason as the registry).
//
// MERGE semantics (cinatra#1392 S8): server builds are per-request AND now
// per-CALLER (the discovery union registers a retained versioned-only name only
// for its edge-bound dependent), so a replace-on-build would let two concurrent
// builds erase each other's entries between a tool's registration and its
// boundary check. `markEffectiveExtensionMcpTools` therefore UPSERTS the
// build's names; removal stays lifecycle-driven (`removeExtensionMcpToolsFor-
// Package` at the capability-teardown chokepoint, which also clears the
// version-keyed retention in lockstep — so a retired package's names leave
// the effective set exactly when they stop being servable).
const EFFECTIVE_KEY = Symbol.for("@cinatra-ai/host:extension-mcp-effective/v1");
type EffectiveHolder = { [k: symbol]: Map<string, string> | undefined };
const _effHolder = globalThis as unknown as EffectiveHolder;

/** Record (upsert) the extension tools a server build effectively registered. */
export function markEffectiveExtensionMcpTools(tools: ReadonlyArray<{ name: string; packageName: string }>): void {
  const m = _effHolder[EFFECTIVE_KEY] ?? (_effHolder[EFFECTIVE_KEY] = new Map<string, string>());
  for (const t of tools) m.set(t.name, t.packageName);
}

/**
 * Remove effective entries for extension tools a server build SKIPPED because
 * their name is claimed by a host/platform registration (codex S8 round-0 #4:
 * with merge semantics a stale entry would otherwise outlive the collision and
 * let the boundary synthesize authorization for the HOST handler now serving
 * that name — the exact escalation the effective set exists to prevent).
 * Collisions are caller-INDEPENDENT (the platform/reserved name set does not
 * vary per caller), so deleting here cannot erase a concurrent build's
 * legitimately-registered entry. Scoped by package: the entry is dropped only
 * while it still attributes the name to the SKIPPED tool's package.
 */
export function unmarkEffectiveExtensionMcpToolCollisions(
  skipped: ReadonlyArray<{ name: string; packageName: string }>,
): void {
  const m = _effHolder[EFFECTIVE_KEY];
  if (!m) return;
  for (const t of skipped) {
    if (m.get(t.name) === t.packageName) m.delete(t.name);
  }
}

/** The owning package if `name` is an EFFECTIVELY-registered extension tool, else undefined. */
export function getEffectiveExtensionMcpTool(name: string): { packageName: string } | undefined {
  const pkg = _effHolder[EFFECTIVE_KEY]?.get(name);
  return pkg ? { packageName: pkg } : undefined;
}

/** @internal Tests only — clear both the registry and the effective set. */
export function _resetExtensionMcpForTests(): void {
  extensionMcpRegistry._clearForTests();
  _effHolder[EFFECTIVE_KEY] = new Map();
}

// ---------------------------------------------------------------------------
// THE TWO REPLAY HOPS the typed delegated-chat declaration travels through
// (cinatra#2771).
//
// WHY THEY LIVE HERE. Both were inline in `@/lib/mcp-server`
// (`registerAllCapabilities` / `buildHostSelfPrimitiveHandlers`), which imports
// the entire connector/module graph and a database — so anything inline there
// is unreachable from a unit test and could only be pinned as a SOURCE STRING,
// which proves a line exists and nothing about what it does. These two hops are
// exactly where a new field on a registration gets silently dropped, so "it
// exists" is the wrong assurance to settle for.
//
// They are here rather than in a new module for two reasons. This file is
// already the host-owned registry the replay REPLAYS, so the config it puts on
// the wire is the same concern; and it is already on the MCP registry route
// graph, so no locked route gains a module (a new file would have cost +1 on
// /api/mcp, /chat, /api/a2a and /api/llm-bridge, raising four ratchet ceilings
// to buy a test).
//
// Nothing here decides authorization. The narrow-only SEMANTICS live in
// `delegated-chat-tool-policy.ts` and are enforced at the choke point; this
// section only makes sure the value the registration wrote is still there when
// the choke point looks.
// ---------------------------------------------------------------------------

export type CapturedMcpToolHandler = (...args: unknown[]) => unknown | Promise<unknown>;

/**
 * One entry in the host's in-process primitive map: the raw MCP-SDK callback
 * PLUS the PLANNED PRIMITIVE its registration produced (cinatra#2817 slice 1).
 *
 * The map used to carry only the handler, then (cinatra#2771) the handler plus
 * the declaration. Neither was enough for version-bound admission: the
 * in-process self-invoker could name a primitive but not say WHICH package at
 * WHICH version was about to serve it, so it could not consult an admission
 * record bound to that exact tuple. Carrying the whole planned entry is what
 * lets `@/lib/extension-self-mcp` apply the SAME evaluator, against the SAME
 * primitive identity, that the live transport applies at registration.
 */
export type CapturedHostPrimitive = {
  handler: CapturedMcpToolHandler;
  /** The planned identity this capture was recorded under. */
  planned: PlannedPrimitive;
};

/** The minimal shape the replay reads off a registered extension tool. */
export type ReplayedExtensionRegistration = {
  description?: string;
  inputSchema?: unknown;
  delegatedChat?: DelegatedChatToolClass;
};

/**
 * Build the `registerTool` config the extension REPLAY puts on the wire.
 *
 * This config is constructed FROM SCRATCH — only title/description/schema used
 * to be rebuilt — so a field on the original registration is dropped here by
 * DEFAULT, and silently: the declaration would read as present in the registry
 * and absent in the decision. Carrying `delegatedChat` is what makes the
 * registration choke point see the SAME declaration for a `ctx.mcp.registerTool`
 * extension that it sees for a manifest-discovered connector that passes it in
 * `config` directly.
 *
 * cinatra#2817 slice 1 adds the PROVENANCE STAMP on the same terms and for the
 * same reason: the choke point must be able to state the owning package and the
 * exact resolved version of the registration it is deciding about. The stamp is
 * written by HOST code from the discovery plan's resolution — never copied from
 * anything the extension supplied — which is why a connector writing the key
 * onto its own config buys nothing: a self-asserted owner/version matches no
 * reviewed admission record and therefore denies.
 *
 * Narrow-only: what rides here can only remove this name from a delegated-chat
 * build, never add it to one.
 */
export function buildReplayedExtensionToolConfig(
  name: string,
  registration: ReplayedExtensionRegistration,
  provenance?: {
    ownerPackage: string;
    resolvedVersion: string | null;
    dispatchTarget?: PrimitiveDispatchTarget;
  },
): Record<string, unknown> {
  return {
    title: name,
    description: registration.description ?? name,
    // Standard Schema (zod) — the MCP SDK validates against `~standard`.
    inputSchema: (registration.inputSchema as z.ZodTypeAny) ?? z.object({}).passthrough(),
    delegatedChat: registration.delegatedChat,
    // An UNVERSIONED registration is stamped with the sentinel below rather
    // than left unstamped. Leaving it unstamped would make it read as a
    // core/bundled host registration and inherit the HOST's identity — and with
    // it the host's migrated admission records. The sentinel is a real,
    // never-admitted version string, so the lookup misses and the primitive is
    // refused, which is the honest outcome for a version the host cannot state.
    ...(provenance
      ? primitiveProvenanceStamp({
          ownerPackage: provenance.ownerPackage,
          resolvedVersion: provenance.resolvedVersion ?? UNRESOLVED_EXTENSION_VERSION,
          ...(provenance.dispatchTarget ? { dispatchTarget: provenance.dispatchTarget } : {}),
        })
      : {}),
  };
}

/**
 * The version stamped on a registration whose record version the host cannot
 * state. Deliberately not a valid semver: no admission record can be written
 * against it, so it denies wherever version-bound admission applies.
 */
export const UNRESOLVED_EXTENSION_VERSION = "0.0.0-unresolved";

/**
 * The pure RECORDING server the self-primitive capture pass runs against: it
 * touches no live transport and only writes into `handlers`.
 *
 * cinatra#2817 slice 1: the capture runs through a `CapabilityPlanRecorder`, so
 * each captured entry carries the SAME planned identity shape the live server's
 * choke point produces, read off the SAME `config` with the SAME total readers.
 * The recorder is returned alongside so the caller can read the finished plan.
 *
 * The non-`registerTool` surface is stubbed as no-ops — module registrations
 * only call `registerTool`, but the stubs keep an errant call from throwing.
 */
export function createSelfPrimitiveRecordingServer(
  handlers: Map<string, CapturedHostPrimitive>,
  options?: {
    host?: HostPrimitiveIdentity;
    resolveCapabilityKey?: (name: string) => string | null | undefined;
  },
): McpRuntimeToolServer & { capabilityPlan: () => CapabilityPlan } {
  const recorder = new CapabilityPlanRecorder({
    host: options?.host ?? HOST_SELF_PRIMITIVE_IDENTITY,
    resolveCapabilityKey: options?.resolveCapabilityKey,
  });
  const server = {
    registerTool: (name: string, config: unknown, handler: CapturedMcpToolHandler) => {
      // Mirror the live server: the MCP SDK rejects a duplicate tool name, so a
      // silent overwrite here would let the self-call surface diverge from the
      // live transport. Fail loudly instead.
      if (handlers.has(name)) {
        throw new Error(
          `[mcp] duplicate tool registration "${name}" during self-primitive capture (the live server would reject it)`,
        );
      }
      // Plan the registration off the SAME `config` the live server's choke
      // point plans from, with the same total readers, so the recording pass
      // and the live pass cannot disagree about what a module declared or about
      // which package at which version owns it.
      const planned = recorder.record(name, config);
      recorder.markRegistered(planned);
      handlers.set(name, { handler, planned });
      return undefined as never;
    },
    registerResource: () => undefined as never,
    registerPrompt: () => undefined as never,
    registerScreen: () => undefined,
    capabilityPlan: () => recorder.plan(),
  };
  return server as unknown as McpRuntimeToolServer & { capabilityPlan: () => CapabilityPlan };
}

/** The host identity the self-primitive capture plans core/bundled entries under. */
export const HOST_SELF_PRIMITIVE_IDENTITY: HostPrimitiveIdentity = {
  packageName: HOST_PRIMITIVE_OWNER_PACKAGE,
  version: HOST_PRIMITIVE_RELEASE_VERSION,
};
