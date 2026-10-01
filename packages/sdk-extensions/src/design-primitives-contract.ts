// The TYPED CONTRACT EXPORT for the HOST-SHARED DESIGN PRIMITIVES
// (cinatra#3471 slice 2, epic #2926 — decision 407 of 2026-09-13: "the host
// shares its primitives with extension bundles at run time like React does").
//
// WHAT A PACKAGE IMPORTS: a self-rendering connector/artifact package imports
// the PRIMITIVES from the host-neutral module id at run time
// (`import { Button } from "@cinatra-ai/design-primitives"`) and imports THIS
// module for the contract itself — the id, the served contract version, the
// frozen export list, and the load-time compatibility rule. The bundle road
// (`scripts/extensions/build-client-renderer-bundle.mjs`, reached through the
// SDK) leaves the id EXTERNAL; the host module-registry shim
// (`src/lib/artifacts/host-module-registry.ts`) resolves it to the host's ONE
// instance, exactly the road React and the host design-token module already
// take.
//
// SCHEMA-ONLY / BROWSER-SAFE and React-FREE: the contract names the exports and
// the version; it does not import React or any component, so importing it never
// pulls a second copy of anything into a bundle. The IMPLEMENTATION is host-side
// (`src/lib/artifacts/host-shared-primitives.ts`), built from the product's own
// components under `src/components/ui/` — the same files
// `scripts/extensions/vendor-extension-primitives.mjs` copies from.
//
// The constants live in the SDK leaf next to the React externals allowlist
// (`./artifact-client-bundle`) because the allowlist gate, the publish-time
// builder's inlined mirror and the host shim all read them; this module is the
// author-facing door onto them plus the typed module shape.

import {
  DESIGN_PRIMITIVES_CONTRACT_MISMATCH,
  HOST_DESIGN_PRIMITIVES_CONTRACT_MAJOR,
  HOST_DESIGN_PRIMITIVES_CONTRACT_VERSION,
  HOST_DESIGN_PRIMITIVES_EXPORTS,
  HOST_DESIGN_PRIMITIVES_MODULE,
  checkDesignPrimitivesContract,
  designPrimitivesContractMajorOf,
  type HostDesignPrimitiveExportName,
} from "./artifact-client-bundle";

export {
  DESIGN_PRIMITIVES_CONTRACT_MISMATCH,
  HOST_DESIGN_PRIMITIVES_CONTRACT_MAJOR,
  HOST_DESIGN_PRIMITIVES_CONTRACT_VERSION,
  HOST_DESIGN_PRIMITIVES_EXPORTS,
  HOST_DESIGN_PRIMITIVES_MODULE,
  checkDesignPrimitivesContract,
  designPrimitivesContractMajorOf,
};
export type { HostDesignPrimitiveExportName };

/**
 * The SHAPE of the shared primitives module at the current contract major:
 * EXACTLY the frozen export list, nothing else. The host's implementation
 * barrel `satisfies` this, so removing or renaming an export breaks the host
 * build instead of breaking a package at run time.
 *
 * Deliberately `unknown`-valued: the contract is React-free (see the header), so
 * it pins the export NAMES and leaves each value's component type to the
 * importing package's own React types.
 */
export type HostDesignPrimitivesModule = {
  readonly [K in HostDesignPrimitiveExportName]: unknown;
};

/**
 * The export names the candidate module is MISSING against the frozen list, in
 * frozen-list order. Empty means the candidate serves the whole contract. Used
 * by the host to prove its barrel is complete, and available to a package that
 * wants to fail loudly rather than read `undefined` off the shared module.
 */
export function missingDesignPrimitiveExports(candidate: unknown): string[] {
  if (candidate === null || typeof candidate !== "object") {
    return [...HOST_DESIGN_PRIMITIVES_EXPORTS];
  }
  const mod = candidate as Record<string, unknown>;
  return HOST_DESIGN_PRIMITIVES_EXPORTS.filter((name) => mod[name] === undefined);
}

/** True iff the candidate carries every export of the frozen list. */
export function isHostDesignPrimitivesModule(
  candidate: unknown,
): candidate is HostDesignPrimitivesModule {
  return missingDesignPrimitiveExports(candidate).length === 0;
}
