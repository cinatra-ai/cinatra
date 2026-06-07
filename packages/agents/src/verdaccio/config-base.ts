// DEPRECATED — re-export shim. Direct importers should use
// @cinatra-ai/registries instead.
//
// This module remains as a CLI-safe entry point for callers that cannot import
// the server-side `config.ts` module because it has a `server-only` guard.
// Keeping this file as a thin re-export shim prevents the CLI-safe duplicate
// implementation from drifting away from the canonical implementation in
// `@cinatra-ai/registries`. The CLI sub-entry at
// `packages/agents/src/cli/extract-agent-package-cli.ts` continues to import
// `requireVerdaccioConfig` and `VerdaccioConfig` from here unchanged — sync
// env-only loader (loadVerdaccioConfig) remains the correct CLI semantics.

export {
  loadVerdaccioConfig,
  requireVerdaccioConfig,
  requireVerdaccioToken,
} from "@cinatra-ai/registries";
export type { VerdaccioConfig } from "@cinatra-ai/registries";
