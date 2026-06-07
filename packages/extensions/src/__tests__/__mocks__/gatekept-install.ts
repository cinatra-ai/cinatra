// Lightweight stand-in for `@/lib/gatekept-install` in the extensions vitest
// sandbox. The real module imports `@cinatra-ai/marketplace-mcp-client/http-client`
// (server-only + the MCP SDK), which is out of reach for this package's vitest
// config. Tests that exercise the gatekept branch inject the resolver + flag via
// the `options` seam on `resolveInstallEnvironment` / `resolveExtensionTypeId` /
// `resolveExtensionPackageForLifecycle`, so the production dynamic-import of this
// module is only ever hit by the flag-OFF default path — which needs nothing more
// than an env-reading `isGatekeptInstallEnabled`.

import type { VerdaccioConfig } from "@cinatra-ai/registries";

export function isGatekeptInstallEnabled(): boolean {
  return process.env.CINATRA_GATEKEPT_INSTALL === "true";
}

export interface GatekeptInstallAuthorizeMetadata {
  kind: "agent" | "skill" | "connector" | "artifact" | "workflow";
  resolvedVersion: string;
  closure: { name: string; version: string }[];
  expiresAt: string;
}

export interface GatekeptInstallResolution {
  config: VerdaccioConfig;
  authorize: GatekeptInstallAuthorizeMetadata;
}

export async function resolveGatekeptInstallConfig(): Promise<GatekeptInstallResolution> {
  throw new Error(
    "[test-mock] resolveGatekeptInstallConfig must be injected via the options seam in extensions tests",
  );
}
