import "server-only";

// Install GRANT CONTEXT (#180 PR-2, PLAN P2-4 grant seam).
//
// A dependency-batch install authorizes ONCE for the ROOT: the marketplace
// `extension_install_authorize` ability returns an opaque grant + the
// exact-pinned transitive closure. EVERY package read inside the batch — the
// root's own integrity/materialize reads AND every closure member's packument
// + tarball reads — must ride that ONE grant through the broker read-proxy.
// Re-authorizing a member as if it were a root is FORBIDDEN (it would bypass
// the entitlement model: a member is entitled BY the root's closure, not by
// its own listing).
//
// Mechanism: the batch enters this AsyncLocalStorage context around the whole
// planning + member-install sequence. `resolveGatekeptInstallConfig` (the
// single authorize seam in src/lib/gatekept-install.ts) checks the context
// FIRST and, when active, DERIVES the requested package's read config from
// the root resolution instead of calling authorize — so every downstream
// consumer (pipeline resolveIntegrity/materialize, typeId resolution, member
// manifest reads) is automatically per-member-authorize-free, with no
// parameter threading through the dispatcher's handler interfaces. The same
// ALS pattern the install locks use (re-entrant, async-context-scoped).

import { AsyncLocalStorage } from "node:async_hooks";
// ExtensionKind from the CANONICAL extension types (same union the
// marketplace mirrors) — the vendored marketplace-mcp-client is banned for
// new importers (the published contract package replaces it).
import type { ExtensionKind } from "@cinatra-ai/extensions/canonical-types";
import { vendorScopeOfPackage, type VerdaccioConfig } from "@cinatra-ai/registries";
import type { GatekeptInstallResolution } from "@/lib/gatekept-install";

export type InstallGrantContext = {
  /** The authorized ROOT package this grant was issued for. */
  rootPackageName: string;
  /** The root's authorize resolution: broker-pointed config + grant + closure. */
  resolution: GatekeptInstallResolution;
  /**
   * Member kinds the batch planner resolved (installed members from their
   * canonical rows; to-install members from their manifests, read under the
   * root grant). Lets the derived member resolution carry the member's TRUE
   * kind — never the root's — for any kind-driven dispatch inside the batch.
   * MUTABLE: a caller (e.g. the MCP install surface) may enter the context
   * BEFORE planning; the batch saga ADOPTS the active context and fills this
   * map when the plan resolves.
   */
  memberKinds: Map<string, ExtensionKind>;
};

const storage = new AsyncLocalStorage<InstallGrantContext>();

/** Run `fn` with the batch's root grant context active. */
export function withInstallGrantContext<T>(
  ctx: InstallGrantContext,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(ctx, fn);
}

/** The active batch grant context, or null outside a batch. */
export function getActiveInstallGrantContext(): InstallGrantContext | null {
  return storage.getStore() ?? null;
}

/**
 * Derive a closure MEMBER's broker read config from the ROOT resolution:
 * same broker base URL, same opaque root grant, the member's own scope.
 * Pure — no marketplace call.
 */
export function deriveMemberInstallConfig(
  resolution: GatekeptInstallResolution,
  memberPackageName: string,
): VerdaccioConfig {
  return {
    registryUrl: resolution.config.registryUrl,
    packageScope: vendorScopeOfPackage(memberPackageName) ?? "",
    token: resolution.config.token,
    uiUrl: null,
  };
}
