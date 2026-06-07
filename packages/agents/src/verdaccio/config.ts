import "server-only";

// Verdaccio config is implemented by @cinatra-ai/registries.
// This thin re-export keeps server-only-gated in-package imports working
// (agent-builder files import loadVerdaccioConfig / requireVerdaccioConfig
// from "./verdaccio/config"). @cinatra-ai/registries owns the implementation.
//
// Note: VerdaccioConfig is the registry-owned 4-field struct
// (registryUrl, packageScope, token, uiUrl). Callers should use this
// simplified shape instead of legacy enabled/disabledReason/registryUiUrl
// fields.

export {
  loadVerdaccioConfig,
  requireVerdaccioConfig,
  requireVerdaccioToken,
} from "@cinatra-ai/registries";
export type { VerdaccioConfig } from "@cinatra-ai/registries";
