import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { InstanceIdentitySnapshot, VerdaccioConfig } from "../types";
// Re-export typed errors so consumers can import them directly from
// `@cinatra-ai/registries/.../config` for symmetry with the async loader.
import {
  InstanceNamespaceNotConfiguredError,
  VerdaccioUnexpectedResponseError,
} from "./errors";

export { InstanceNamespaceNotConfiguredError, VerdaccioUnexpectedResponseError };

const DEFAULT_REGISTRY_URL = "http://127.0.0.1:4873";
const DEFAULT_REGISTRY_UI_URL = "http://127.0.0.1:4873";
const DEFAULT_PACKAGE_SCOPE = "@cinatra-ai";

/**
 * Read the Verdaccio _authToken for `registryUrl` from ~/.npmrc.
 * Returns null on any error (missing file, no matching line, parse error)
 * so callers get a graceful no-op fallback.
 *
 * Matches both quoted and unquoted token forms that npm writes:
 *   //127.0.0.1:4873/:_authToken="abc..."
 *   //127.0.0.1:4873/:_authToken=abc...
 */
function readNpmrcToken(registryUrl: string): string | null {
  try {
    const host = new URL(registryUrl).host; // e.g. "127.0.0.1:4873"
    const prefix = `//${host}/:_authToken=`;
    const npmrcPath = join(homedir(), ".npmrc");
    const contents = readFileSync(npmrcPath, "utf8");
    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith(prefix)) continue;
      let value = trimmed.slice(prefix.length).trim();
      // Strip surrounding double or single quotes if present.
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      return value.length > 0 ? value : null;
    }
    return null;
  } catch {
    return null;
  }
}

function normalizeUrl(rawValue: string, fieldName: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawValue);
  } catch {
    throw new Error(`${fieldName} must be an absolute http(s) URL.`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${fieldName} must use http: or https:.`);
  }

  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}

function normalizeScope(rawValue: string): string {
  const scope = rawValue.trim();
  if (!scope.startsWith("@")) {
    throw new Error("CINATRA_AGENT_REGISTRY_SCOPE must start with '@'.");
  }
  if (scope.includes("/")) {
    throw new Error("CINATRA_AGENT_REGISTRY_SCOPE must not contain a slash.");
  }
  if (scope.length < 2) {
    throw new Error("CINATRA_AGENT_REGISTRY_SCOPE must include a scope name.");
  }
  return scope;
}

/**
 * Read the Verdaccio config from env vars. Throws synchronously when any
 * value fails validation — callers can catch and handle (the packages/agents
 * copy returns a disabled-reason struct instead; @cinatra-ai/registries keeps the
 * simpler throw-on-invalid contract).
 */
export function loadVerdaccioConfig(): VerdaccioConfig {
  const rawRegistryUrl = process.env.CINATRA_AGENT_REGISTRY_URL?.trim() || DEFAULT_REGISTRY_URL;
  const rawRegistryUiUrl = process.env.CINATRA_AGENT_REGISTRY_UI_URL?.trim() || DEFAULT_REGISTRY_UI_URL;
  const rawPackageScope = process.env.CINATRA_AGENT_REGISTRY_SCOPE?.trim() || DEFAULT_PACKAGE_SCOPE;
  const token =
    process.env.CINATRA_AGENT_REGISTRY_TOKEN?.trim() ||
    readNpmrcToken(rawRegistryUrl) ||
    null;

  return {
    registryUrl: normalizeUrl(rawRegistryUrl, "CINATRA_AGENT_REGISTRY_URL"),
    packageScope: normalizeScope(rawPackageScope),
    token,
    uiUrl: normalizeUrl(rawRegistryUiUrl, "CINATRA_AGENT_REGISTRY_UI_URL"),
  };
}

export function requireVerdaccioConfig(): VerdaccioConfig {
  // loadVerdaccioConfig already throws on invalid values; re-exporting under
  // the `require*` name for caller-clarity symmetry with the packages/agents API.
  return loadVerdaccioConfig();
}

export function requireVerdaccioToken(config: VerdaccioConfig = requireVerdaccioConfig()): string {
  if (!config.token) {
    throw new Error(
      "CINATRA_AGENT_REGISTRY_TOKEN is required for authenticated Verdaccio operations.",
    );
  }
  return config.token;
}

// ---------------------------------------------------------------------------
// Async metadata-driven Verdaccio loader.
//
// Architectural commitment: this loader uses only the 2-arg explicit-DI form.
// `readIdentity` and `decryptToken` are passed by the caller; no module-level
// reader-registry or global-state facility is introduced. Host-app composition
// happens outside this package, and `config: VerdaccioConfig` is threaded
// explicitly down to server-context callsites. The `@cinatra-ai/registries`
// workspace package therefore stays free of host-app coupling and global state.
// ---------------------------------------------------------------------------

const PROD_DEFAULT_REGISTRY_URL = "https://registry.cinatra.ai";

/**
 * Async metadata-aware Verdaccio config loader. Returns a `VerdaccioConfig`
 * with `packageScope = "@" + identity.instanceNamespace` derived from the host-app's
 * `instance_identity` row.
 *
 * Resolution order:
 *   1. If `CINATRA_AGENT_REGISTRY_URL` or `CINATRA_AGENT_REGISTRY_TOKEN` is
 *      set, fall back to the existing sync env-only `loadVerdaccioConfig()` —
 *      this preserves the branch-worktree dev override.
 *   2. Else `readIdentity()` is invoked. `null` → throw
 *      `InstanceNamespaceNotConfiguredError`.
 *   3. Else build the config:
 *        - `registryUrl` ← `identity.registryUrl?.trim()` || PROD_DEFAULT_REGISTRY_URL
 *        - `token` ← `decryptToken({ ciphertext, iv })` — plaintext
 *        - `packageScope` ← `"@" + identity.instanceNamespace`
 *        - `uiUrl` mirrors `registryUrl`
 *
 * SECURITY: the returned `token` is plaintext. Callers MUST NOT log it.
 *
 * The injected `decryptToken` is expected to throw on key/IV/auth-tag failure;
 * such errors propagate up so callers see a real crypto failure rather than
 * a silent fallback.
 */
export async function loadVerdaccioConfigAsync(
  readIdentity: () => InstanceIdentitySnapshot | null,
  decryptToken: (input: { ciphertext: string; iv: string }) => string,
): Promise<VerdaccioConfig> {
  const envRegistryUrl = process.env.CINATRA_AGENT_REGISTRY_URL?.trim();
  const envToken = process.env.CINATRA_AGENT_REGISTRY_TOKEN?.trim();

  if (envRegistryUrl || envToken) {
    // Re-tag the env-override path so malformed env vars surface with a clear
    // source hint instead of a confusing stack trace pointing at the sync loader.
    try {
      return loadVerdaccioConfig();
    } catch (e) {
      throw new Error(
        `loadVerdaccioConfigAsync env-override path failed: ${e instanceof Error ? e.message : String(e)} ` +
          "(set or unset CINATRA_AGENT_REGISTRY_URL / CINATRA_AGENT_REGISTRY_TOKEN to fall back to identity-row source)",
      );
    }
  }

  const identity = readIdentity();
  if (!identity) {
    throw new InstanceNamespaceNotConfiguredError();
  }

  const registryUrl = identity.registryUrl?.trim() || PROD_DEFAULT_REGISTRY_URL;
  const token = decryptToken({ ciphertext: identity.tokenCiphertext, iv: identity.tokenIv });

  return {
    registryUrl,
    packageScope: "@" + identity.instanceNamespace,
    token,
    uiUrl: registryUrl,
  };
}
