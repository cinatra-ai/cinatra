# @cinatra-ai/extension-types

Dependency-free leaf types and shared visibility helpers for the extension dependency-inversion boundary. Extension packages depend on these lightweight types rather than the full extension runtime, keeping cross-package imports minimal.

## Public API

Types:

- `PackageRef` — registry URL, package name, optional version
- `ValidationResult` — `valid` flag plus optional error messages
- `Actor` — alias for the actor/audit context
- `ActiveExtensionManifest` — minimal projection of an installed-extension manifest row
- `ExtensionDiscoveryScope` — resolved visibility scope for a reader facet
- `ExtensionTypeHandler` — install/update/uninstall/archive/restore plus optional reader facet (`listActive`, `readActive`, `validate`)

Functions:

- `manifestVisibleToScope(manifest, scope)` — owner-scope visibility check, fails closed
- `visibleManifestPackageNames(manifests, scope)` — package names visible to a scope

## Usage

```ts
import {
  manifestVisibleToScope,
  type ActiveExtensionManifest,
  type ExtensionDiscoveryScope,
} from "@cinatra-ai/extension-types";

function canSee(
  manifest: ActiveExtensionManifest,
  scope: ExtensionDiscoveryScope,
): boolean {
  return manifestVisibleToScope(manifest, scope);
}
```

## Docs

See https://docs.cinatra.ai for the full platform documentation.
