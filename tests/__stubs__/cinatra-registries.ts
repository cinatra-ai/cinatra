// Stub for @cinatra-ai/registries used by vitest's root
// resolver. The real package's index.ts imports pacote / semver chains that
// pull heavy native deps not needed for the wizard-action unit tests. We
// re-export only the slice the saveInstanceIdentityAction module touches:
//   - createNpmUser (from user-provisioning.ts) — a pure fetch helper
//   - VerdaccioUserAlreadyRegisteredError (from user-provisioning.ts)
//   - VerdaccioRegistrationDisabledError (from user-provisioning.ts)
//   - VerdaccioUnexpectedResponseError (from errors.ts)
//
// Tests vi.mock("@/lib/...") for the rest of the wizard-action's dependency
// graph; this stub keeps the @cinatra-ai/registries entry resolvable without
// dragging the entire registries barrel into the vitest sandbox.

export {
  createNpmUser,
  VerdaccioUserAlreadyRegisteredError,
  VerdaccioRegistrationDisabledError,
} from "../../packages/registries/src/verdaccio/user-provisioning";
export type { CreateNpmUserOptions } from "../../packages/registries/src/verdaccio/user-provisioning";

export { VerdaccioUnexpectedResponseError } from "../../packages/registries/src/verdaccio/errors";

// Async config loader + listAgentPackages used by the
// host-app verdaccio-config wrapper and the settings/instance reconciliation
// path. The real listAgentPackages pulls in pacote / install transitive
// chains; tests vi.mock("@cinatra-ai/registries", ...) at the call site, so the
// stub just needs symbols to exist for module resolution.
export {
  loadVerdaccioConfigAsync,
  InstanceNamespaceNotConfiguredError,
} from "../../packages/registries/src/verdaccio/config";
export type { VerdaccioConfig } from "../../packages/registries/src/types";

// Lightweight no-op fallback — unit tests mock this at the call site via
// vi.mock("@cinatra-ai/registries", ...). Real production code uses the real
// listAgentPackages from the registries barrel via Next.js's transpilePackages.
export async function listAgentPackages(
  _options?: { query?: string; limit?: number; offset?: number },
): Promise<Array<{ packageName: string; packageVersion: string }>> {
  return [];
}

// Vendor-scope helpers for the install-time dependency-confusion gate
// (issue #103). Pure and dependency-free, so the stub re-exports the real
// implementations — host modules (gatekept-install, actions) call these at
// runtime and must get real parsing behavior, not a missing symbol.
export {
  FIRST_PARTY_PACKAGE_SCOPE,
  vendorScopeOfPackage,
  dependencyScopePrefixesFor,
  // Canonical @vendor/name splitter + shared safe-path-segment guard
  // (cinatra#537) — pure, re-export the real impls so host modules that route
  // vendor/name derivation + path-segment validation through them get the real
  // behavior, not a missing symbol.
  parsePackageId,
  isSafePathSegment,
  assertSafePathSegment,
} from "../../packages/registries/src/scope";
export type { PackageId } from "../../packages/registries/src/scope";

// Version primitives for the dependency planner (#180). Pure semver wrappers
// — re-export the real implementations (no pacote/native chain).
export {
  comparePluginVersions,
  satisfiesVersionRange,
  isExactVersion,
  isValidVersionRange,
} from "../../packages/registries/src/version-compare";

// Range resolution for the dependency planner (#180) — tests mock at call
// sites; the stub only needs the symbol resolvable.
export async function resolveMaxSatisfyingVersion(
  _input: { packageName: string; range: string },
): Promise<string | null> {
  return null;
}
