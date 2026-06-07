# @cinatra-ai/extensions

Host-side extension lifecycle layer for the Cinatra platform. It owns the kind-agnostic
install / update / uninstall / archive / restore / force-delete dispatcher, the canonical
`installed_extension` manifest (the single source of truth for what is installed and active),
runtime capability discovery, and the dependency-closure and locked-row safety gates that
protect destructive operations.

## Public API

- `extensionRegistry` — central dispatcher; registers per-kind handlers and runs the
  install/update/uninstall/archive/restore/forceDelete sequence.
- `extensionHasBeenUsed` / `extensionHasBeenUsedBatch` — whether an extension's agent has run history.
- `assertNoLockedCanonicalRow` — refuses destructive ops on locked extensions.
- `ActiveDependentError` — thrown when an active dependent blocks a hard delete.
- `buildCrossKindGraph`, `resolveInstall`, `decideUninstall`, `detectCycles`,
  `checkAuthoringRecursionBudget` — cross-kind dependency resolution.
- `setExtensionActivateHook` / `fireExtensionActivate` — host-injected in-process activation seam.
- `setExtensionCapabilityTeardownHook` / `fireExtensionCapabilityTeardown` — in-memory deregistration seam.
- `setExtensionDataTeardownHook` / `fireExtensionDataTeardown` — durable settings/secrets teardown seam.
- `setExtensionInstallOpPhaseReader` / `readExtensionInstallOpPhase` — install-op journal phase reader seam.
- `readEffectiveStatusByPackageNames` — resolves effective lifecycle status per package.

Named sub-entry points (see `package.json` `exports`):

- `./runtime-discovery`, `./runtime-discovery-host` — active-manifest capability dispatcher.
- `./canonical-types`, `./canonical-store`, `./canonical-gate` — manifest schema, CRUD, and write gate.
- `./lifecycle-primitive` — the only permitted writer of `installed_extension.status`.
- `./dependency-closure`, `./purge`, `./purge-deps` — closure checks and removal flows.
- `./required-in-prod`, `./registry-immutability`, `./system-extension-inventory` — protection policies.
- `./license-detection`, `./destination-resolver`, `./publish-authority` — publish routing helpers.
- `./actions`, `./screens`, `./lifecycle-ui`, `./components/*`, `./mcp-module` — UI, server actions, and MCP wiring.

## Usage

```ts
import { extensionRegistry } from "@cinatra-ai/extensions";

await extensionRegistry.install("connector", ref, actor, { destination: "private" });
await extensionRegistry.uninstall("agent", ref, actor);
```

## Docs

See https://docs.cinatra.ai
