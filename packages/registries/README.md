# @cinatra-ai/registries

Registry and package-installation toolkit for Cinatra extension packages (agents, skills, connectors). It resolves scoped dependency trees from npm-compatible packuments, materializes them via a caller-supplied install side-effect, reads and writes a deterministic lockfile, and provides a registry client for listing, extracting, and integrity-verifying published packages. The package has no Next.js coupling and runs in plain Node contexts (CLI, scripts, tests).

## Public API

Dependency resolution
- `resolveDependencyTree` — resolve a scoped dependency tree from packuments
- `PluginDependencyCycleError`, `PluginDependencyConflictError`, `PluginDependencyResolutionError`, `PluginDependencyLimitError`, `PluginDependencyScopeError` — typed resolution failures
- `FIRST_PARTY_PACKAGE_SCOPE`, `vendorScopeOfPackage`, `dependencyScopePrefixesFor` — vendor-scope helpers: the dependency-scope allowlist is keyed on the root package's own scope plus the first-party scope, never on the installing instance's namespace

Install
- `installResolvedTree` — run an install side-effect per resolved node
- `installPackageWithDependencies` — resolve then install in one call

Lockfile
- `readLockfile`, `writeLockfile` — load/persist a lockfile
- `lockfileFromTree` — build a lockfile from a resolved tree
- `stableStringifyLockfile` — deterministic serialization
- `LOCKFILE_VERSION`, `lockfileShapeSchema` — lockfile version and Zod schema

Version comparison
- `comparePluginVersions` — compare two package versions

Registry client
- `listAgentPackages`, `getAgentPackage`, `listExtensionPackages` — catalog listing
- `extractAgentPackage`, `extractExtensionPackage`, `cleanupExtractedAgentPackage`, `cleanupExtractedPackage` — extract/clean tarballs
- `getPublishedExtensionKind`, `getPublishedExtensionSummary` — packument summaries
- `getPackageReadme`, `readReadmeFromExtractedPackage`, `DEFAULT_README_SIZE_CAP_BYTES` — README extraction
- `fetchExtensionTarballBytes`, `resolveExtensionDistIntegrity` — exact tarball bytes and SRI integrity
- `ensureConfig` — fail-fast dependency-injection guard

Registry config and provisioning
- `loadVerdaccioConfig`, `loadVerdaccioConfigAsync`, `requireVerdaccioConfig`, `requireVerdaccioToken` — config loaders
- `InstanceNamespaceNotConfiguredError`, `VerdaccioUnexpectedResponseError` — typed config errors
- `createNpmUser`, `VerdaccioUserAlreadyRegisteredError`, `VerdaccioRegistrationDisabledError` — npm user provisioning

Types
- `PluginType`, `PluginTypeConfig`, `ResolvedNode`, `DependencyTree`, `Packument`, `PackumentVersionEntry`, `FetchPackument`, `InstallSideEffect`, `VerdaccioConfig`, `LockfileShape`, `InstanceIdentitySnapshot`, and related package summary/detail types

## Usage

```ts
import { installPackageWithDependencies } from "@cinatra-ai/registries";

const { tree, installedCount } = await installPackageWithDependencies({
  packageName: "@acme/example-agent",
  packageRange: "^1.0.0",
  typeConfig: {
    type: "agent",
    // Root's own vendor scope + the first-party base scope — see
    // dependencyScopePrefixesFor(packageName).
    scopePrefixes: ["@acme/", "@cinatra-ai/"],
    packumentDepKey: "agentDependencies",
  },
  config,
  install: async (node) => materialize(node),
});
```

## Docs

See https://docs.cinatra.ai
