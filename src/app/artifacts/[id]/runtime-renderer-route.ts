import "server-only";

// The ROUTE-side resolution of a main-realm dynamic renderer descriptor (epic
// #1620 M1 Slice A/B — cinatra#1630, plan §2.4–§2.7). This is the server half of
// MOUNTING the dynamic seam: it takes a `generatedKey` the dispatch leaf already
// resolved as `loadable` via the RUNTIME path (not the build map), serializes the
// admitted descriptor for the client loader, and — because the ROUTE holds the
// live signature/peer/ABI/lifecycle state (plan §2.6) — computes the PRE-IMPORT
// floor reason, so the host short-circuits to the never-blank floor WITHOUT ever
// importing a renderer it already knows is incompatible/archived/quarantined.
//
// The pure dispatch leaf (`pickArtifactRenderer`) stays byte-unchanged: the
// specific reason is attached here as descriptor SIDE DATA, never by widening the
// leaf's `requires-rebuild` vocabulary.

import { version as reactVersion } from "react";
import { version as reactDomVersion } from "react-dom";

import { SDK_EXTENSIONS_ABI_VERSION } from "@cinatra-ai/sdk-extensions/register";

import { runtimeAssetRegistry } from "@/lib/artifacts/runtime-renderer-registry";
import {
  preImportFloorReason,
  type SerializedRuntimeRendererDescriptor,
} from "@/lib/artifacts/runtime-renderer-descriptor";
import { isArtifactExtensionWriteAllowed } from "@/lib/artifacts/artifact-extension-access";

import { resolveRuntimeRendererDescriptor } from "./renderer-resolution";

/**
 * Resolve the serialized runtime descriptor for a dynamic-path `generatedKey`,
 * with any server-known PRE-IMPORT floor reason attached. Returns null when the
 * key has no live runtime binding (the caller floors as requires-rebuild — the
 * binding was retired between dispatch and here, e.g. an archive race).
 *
 * `expectedPropsApiVersion` is the host snapshot's props-contract version (from
 * the normalized renderer props), compared against the tuple's `propsApiVersion`.
 */
export async function resolveRuntimeRendererForRoute(
  generatedKey: string,
  expectedPropsApiVersion: number,
): Promise<SerializedRuntimeRendererDescriptor | null> {
  const base = resolveRuntimeRendererDescriptor(generatedKey);
  if (!base) return null;

  const { tuple } = base;
  const key = runtimeAssetRegistry.keyFor(tuple.packageName, tuple.slot);
  const active = runtimeAssetRegistry.resolveActive(key);
  const currentActiveDigest = active?.digest ?? null;
  const installedActive = await isArtifactExtensionWriteAllowed(tuple.packageName);

  const reason = preImportFloorReason({
    tuple,
    digestQuarantined: runtimeAssetRegistry.isDigestQuarantined(tuple.digest),
    installedActive,
    currentActiveDigest,
    // The active admitted binding had its signature verified at admission
    // (`admitAndActivate.verify`); an active-digest match witnesses that here.
    signatureVerified: currentActiveDigest === tuple.digest,
    host: {
      reactVersion,
      reactDomVersion,
      hostSdkAbi: SDK_EXTENSIONS_ABI_VERSION,
      expectedPropsApiVersion,
    },
  });

  return reason ? { ...base, reason } : base;
}
