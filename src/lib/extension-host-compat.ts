import "server-only";

// Extension → host/SDK compatibility — the install/update half of the contract.
//
// An extension declares the host/SDK ABI range it was built against in its
// manifest (`cinatra.sdkAbiRange`, see the frozen contract in
// `@cinatra-ai/sdk-extensions` manifest.ts). BOTH loaders already gate
// ACTIVATION on that declaration (`abiCompatible` in runtime-loader /
// static-bundle-loader) — but gating only at activation means an incompatible
// package can still INSTALL or UPDATE fine, finalize durable state (journal,
// grant, provenance, store dir), and then silently refuse to load at boot.
//
// This module gives the install + update paths the SAME verdict the loaders
// use, so a mismatch is refused BEFORE any durable state mutates, with an
// actionable error: which range the extension requires vs. which ABI this host
// provides. The verdict function is the SDK's own `isSdkAbiRangeSatisfied`
// (absent/"*" → unpinned/compatible; malformed or unsatisfied → fail closed),
// imported — never re-implemented — so the install gate can NEVER drift from
// the loaders' activation gate.
//
// Dependency direction stays extension → host/SDK (true IoC): the host only
// CONSUMES the SDK's frozen checker + ABI version constant and reads the
// MATERIALIZED package's own manifest. No extension package is imported.

import {
  isSdkAbiRangeSatisfied,
  SDK_EXTENSIONS_ABI_VERSION,
} from "@cinatra-ai/sdk-extensions";

export type DeclaredHostCompat = {
  /** `cinatra.sdkAbiRange` from the package manifest, or null when undeclared. */
  sdkAbiRange: string | null;
};

/**
 * Read the declared host/SDK compatibility range from a MATERIALIZED package
 * dir (the SRI-verified bytes — the same trust basis the pipeline's
 * `readRequestedPorts` uses). A missing/unparseable package.json reads as
 * undeclared (the loaders treat the package as unpinned; install matches).
 */
export async function readDeclaredHostCompatFromStore(storeDir: string): Promise<DeclaredHostCompat> {
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  let raw: string;
  try {
    raw = await readFile(path.join(storeDir, "package.json"), "utf8");
  } catch {
    return { sdkAbiRange: null };
  }
  let manifest: { cinatra?: { sdkAbiRange?: unknown } };
  try {
    manifest = JSON.parse(raw) as typeof manifest;
  } catch {
    return { sdkAbiRange: null };
  }
  const range = manifest.cinatra?.sdkAbiRange;
  return { sdkAbiRange: typeof range === "string" ? range : null };
}

/**
 * The loaders' ABI verdict, surfaced for the install/update gates: does this
 * host's frozen `@cinatra-ai/sdk-extensions` ABI satisfy the extension's
 * declared range? `compatible:true` for an undeclared/"*" range (unpinned);
 * fail closed (`compatible:false`) for a malformed range or a host outside the
 * declared bounds.
 */
export function evaluateHostSdkCompat(sdkAbiRange: string | null | undefined): {
  compatible: boolean;
  hostAbiVersion: string;
} {
  return {
    compatible: isSdkAbiRangeSatisfied(SDK_EXTENSIONS_ABI_VERSION, sdkAbiRange),
    hostAbiVersion: SDK_EXTENSIONS_ABI_VERSION,
  };
}

/**
 * One actionable refusal message for every install/update surface (pipeline +
 * workflow saga), so the operator always learns: WHAT was refused, WHICH range
 * the extension requires, WHAT this host provides, and HOW to fix it.
 */
export function formatHostSdkCompatRefusal(input: {
  op: "install" | "update";
  packageName: string;
  version: string;
  sdkAbiRange: string | null;
}): string {
  const declared = input.sdkAbiRange === null ? "(undeclared)" : `"${input.sdkAbiRange}"`;
  return (
    `${input.op} of ${input.packageName}@${input.version} refused: the extension declares ` +
    `cinatra.sdkAbiRange ${declared} — the host/SDK ABI range it was built against — but this ` +
    `host provides @cinatra-ai/sdk-extensions ABI ${SDK_EXTENSIONS_ABI_VERSION}, which does not ` +
    `satisfy that range (a malformed range fails closed). Install a release of ` +
    `${input.packageName} whose sdkAbiRange admits ABI ${SDK_EXTENSIONS_ABI_VERSION}, or upgrade ` +
    `the host. Nothing was installed; the previously installed version (if any) is untouched.`
  );
}
