"use server";

import { requireAdminSession } from "@/lib/auth-session";
import {
  loadVerdaccioConfigForReads,
  loadVerdaccioConfigForServer,
} from "@/lib/verdaccio-config";
import { setRegistryDistTag } from "./verdaccio/client";
import {
  getAgentPackage,
  InstanceNamespaceNotConfiguredError,
  type VerdaccioConfig,
} from "@cinatra-ai/registries";
import { diffSnapshots } from "./store";
import type { AgentTemplateVersionSnapshot } from "./store";
import type { AgentPackagePayload } from "./verdaccio/package-contract";

const INSTANCE_NAMESPACE_FAILURE_MESSAGE =
  "Instance vendor name is not configured. Visit /setup/name to provision a registry identity before managing the registry.";

// Split read vs write resolvers. getRegistryVersionDiff reads packument
// metadata (consumer-safe); setRegistryDistTag writes (vendor-only).
async function resolveConfigOrFriendlyError(): Promise<VerdaccioConfig> {
  try {
    return await loadVerdaccioConfigForReads();
  } catch (e) {
    if (e instanceof InstanceNamespaceNotConfiguredError) {
      throw new Error(INSTANCE_NAMESPACE_FAILURE_MESSAGE);
    }
    throw e;
  }
}

async function resolveWriteConfigOrFriendlyError(): Promise<VerdaccioConfig> {
  try {
    return await loadVerdaccioConfigForServer();
  } catch (e) {
    if (e instanceof InstanceNamespaceNotConfiguredError) {
      throw new Error(INSTANCE_NAMESPACE_FAILURE_MESSAGE);
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// getRegistryVersionDiff
// Fetches two adjacent versions from Verdaccio and returns a unified diff of
// their AgentPackagePayload. Returns null diff for the oldest version (no prior).
// Called client-side on "Diff" button click - lazy, not pre-fetched at page load.
// ---------------------------------------------------------------------------

export async function getRegistryVersionDiff(input: {
  packageName: string;
  version: string;
  orderedVersions: string[]; // all versions in descending semver order (newest first)
}): Promise<{ ok: true; diff: string | null } | { ok: false; error: string }> {
  try {
    await requireAdminSession();

    const idx = input.orderedVersions.indexOf(input.version);
    if (idx === -1) {
      return { ok: false, error: "Version not found in orderedVersions list." };
    }

    // The version before this one in descending order is at idx + 1
    const priorVersion = input.orderedVersions[idx + 1] ?? null;
    if (!priorVersion) {
      // This is the oldest known version - no prior to diff against
      return { ok: true, diff: null };
    }

    // getAgentPackage requires explicit VerdaccioConfig.
    const config = await resolveConfigOrFriendlyError();
    const [current, prior] = await Promise.all([
      getAgentPackage({ packageName: input.packageName, packageVersion: input.version }, config),
      getAgentPackage({ packageName: input.packageName, packageVersion: priorVersion }, config),
    ]);

    const diff = diffSnapshots(
      payloadToSnapshot(prior.payload),
      payloadToSnapshot(current.payload),
    );
    return { ok: true, diff: diff || null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// setRegistryLatestVersion
// Updates the `latest` dist-tag for a package to point to the given version.
// Admin-only.
// ---------------------------------------------------------------------------

export async function setRegistryLatestVersion(input: {
  packageName: string;
  version: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await requireAdminSession();
    // setRegistryDistTag requires explicit VerdaccioConfig. Write path —
    // must use the vendor token (the read-only consumer token cannot
    // mutate dist-tags).
    const config = await resolveWriteConfigOrFriendlyError();
    await setRegistryDistTag(
      {
        packageName: input.packageName,
        tag: "latest",
        version: input.version,
      },
      config,
    );
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// payloadToSnapshot - strips non-diffable fields before diffing
// AgentPackagePayload is already a Record<string, unknown>-compatible object.
// Cast via unknown to satisfy diffSnapshots's AgentTemplateVersionSnapshot param.
// ---------------------------------------------------------------------------

function payloadToSnapshot(payload: unknown): AgentTemplateVersionSnapshot {
  return payload as unknown as AgentTemplateVersionSnapshot;
}
