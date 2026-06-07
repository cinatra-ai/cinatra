// Registry URL resolution for the setup wizard's Verdaccio user provisioning.
//
// An explicit CINATRA_AGENT_REGISTRY_URL always wins. Otherwise the default
// depends on the runtime mode: a development install targets the local
// Verdaccio shipped in docker-compose.yml (port 4873), which permits anonymous
// self-registration so the wizard's createNpmUser() succeeds out of the box —
// without it, a fresh `make setup` dead-ends because the hosted registry has
// self-registration disabled. Production defaults to the hosted Cinatra
// registry. Mirrors DEFAULT_REGISTRY_URL / PROD_DEFAULT_REGISTRY_URL in
// packages/registries/src/verdaccio/config.ts.
//
// Runtime mode is resolved via the canonical `isAppDevelopmentMode()` helper
// (an unset CINATRA_RUNTIME_MODE is treated as development, matching the rest
// of the app and `/configuration/environment`) rather than a bare
// `=== "development"` check, so the wizard and the app agree on the mode.
//
// Extracted from actions.ts — a "use server" module may only export async
// functions, so this synchronous resolver lives here to stay exportable and
// unit-testable. Callers invoke it at request time, so the value reflects the
// live process env rather than a module-load snapshot.
import { isAppDevelopmentMode } from "@/lib/runtime-mode";

export const LOCAL_REGISTRY_URL = "http://127.0.0.1:4873";
export const PROD_REGISTRY_URL = "https://registry.cinatra.ai";

export function resolveRegistryUrl(): string {
  return (
    process.env.CINATRA_AGENT_REGISTRY_URL?.trim() ||
    (isAppDevelopmentMode() ? LOCAL_REGISTRY_URL : PROD_REGISTRY_URL)
  );
}

export function shouldSelfRegisterRegistryUser(): boolean {
  return !!process.env.CINATRA_AGENT_REGISTRY_URL?.trim() || isAppDevelopmentMode();
}
