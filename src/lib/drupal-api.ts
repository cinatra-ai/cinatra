import "server-only";
import { randomUUID } from "node:crypto";

import {
  readConnectorConfigFromDatabase,
  writeConnectorConfigToDatabase,
} from "@/lib/database";
import {
  CINATRA_NANGO_PROVIDER_CONFIG_KEYS,
  deleteNangoConnection,
  ensureNangoConnectorIntegration,
  getNangoCredentials,
  importNangoConnection,
  isNangoConfigured,
  removeNangoConnectionRecord,
  saveNangoConnectionRecord,
} from "@/lib/nango-system";

export type DrupalInstanceSettings = {
  id: string;
  name: string;
  siteUrl: string;
  /**
   * Nango connectionId under the cinatra-drupal integration.
   * The Bearer token lives only in the Nango vault and is read via
   * getNangoCredentials at request time.
   */
  nangoConnectionId: string;
  /** Pinned providerConfigKey for forward compatibility. */
  providerConfigKey: string;
  lastValidatedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type DrupalAPISettings = {
  instances: DrupalInstanceSettings[];
};

const CONFIG_KEY = "drupal";

function readSettings(): DrupalAPISettings {
  return readConnectorConfigFromDatabase<DrupalAPISettings>(CONFIG_KEY, { instances: [] });
}

function writeSettings(value: DrupalAPISettings): void {
  writeConnectorConfigToDatabase(CONFIG_KEY, value);
}

function normalizeSiteUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function extractApiKey(credentials: unknown): string | null {
  if (credentials && typeof credentials === "object" && "apiKey" in credentials) {
    const candidate = (credentials as { apiKey: unknown }).apiKey;
    return typeof candidate === "string" ? candidate : null;
  }
  if (typeof credentials === "string") return credentials;
  return null;
}

export function getDrupalAPISettings(): DrupalAPISettings {
  const settings = readSettings();
  return {
    instances: Array.isArray(settings.instances)
      ? settings.instances
          .map((instance) => ({
            id: String(instance.id ?? ""),
            name: String(instance.name ?? "").trim(),
            siteUrl: normalizeSiteUrl(String(instance.siteUrl ?? "")),
            nangoConnectionId: String(instance.nangoConnectionId ?? "").trim(),
            providerConfigKey:
              String(instance.providerConfigKey ?? "").trim() ||
              CINATRA_NANGO_PROVIDER_CONFIG_KEYS.drupal,
            lastValidatedAt:
              typeof instance.lastValidatedAt === "string" ? instance.lastValidatedAt : undefined,
            createdAt:
              typeof instance.createdAt === "string"
                ? instance.createdAt
                : new Date().toISOString(),
            updatedAt:
              typeof instance.updatedAt === "string"
                ? instance.updatedAt
                : new Date().toISOString(),
          }))
          // Require `nangoConnectionId` so only Nango-backed instances are
          // returned. Rows without a Nango pointer cannot be used for
          // credential lookup.
          .filter((instance) => instance.id && instance.name && instance.siteUrl && instance.nangoConnectionId)
      : [],
  } satisfies DrupalAPISettings;
}

export type SaveDrupalInstanceInput = {
  id?: string;
  name: string;
  siteUrl: string;
  /**
   * Bearer token (from `drush mcp-tools:remote-key-create`).
   * - REQUIRED for new instances.
   * - OPTIONAL for edits; when blank, the existing Nango credential is
   *   preserved and only the name/URL changes.
   */
  mcpApiKey?: string;
};

/**
 * Save flow:
 *   1. Validate name + URL. Allow blank `mcpApiKey` only when editing.
 *   2. Throw if Nango is not configured.
 *   3. When `mcpApiKey` provided: ensure integration → import (NO
 *      connectorKey, deferring local pointer write) → getNangoCredentials
 *      with forceRefresh:true equality check → persist instance row WITHOUT
 *      mcpApiKey → saveNangoConnectionRecord separately.
 *   4. Edit-without-key path skips Nango calls and just rewrites name/URL.
 */
export async function saveDrupalInstance(input: SaveDrupalInstanceInput): Promise<DrupalInstanceSettings> {
  const trimmedName = input.name.trim();
  const normalizedUrl = normalizeSiteUrl(input.siteUrl);
  const trimmedKey = (input.mcpApiKey ?? "").trim();
  if (!trimmedName) throw new Error("Instance name is required.");
  if (!normalizedUrl) throw new Error("Site URL is required.");

  const current = getDrupalAPISettings();
  const existing = input.id ? current.instances.find((i) => i.id === input.id) : null;

  const isNewInstance = !existing;
  if (isNewInstance && (!trimmedKey || trimmedKey.length < 8)) {
    throw new Error("MCP API key is required (min 8 chars).");
  }
  if (!isNewInstance && trimmedKey && trimmedKey.length < 8) {
    throw new Error("MCP API key must be at least 8 chars when rotating.");
  }

  if (!isNangoConfigured()) {
    throw new Error(
      "Nango is not configured. Configure it at /configuration/llm/nango before saving Drupal credentials.",
    );
  }

  const id = existing?.id ?? randomUUID();
  const providerConfigKey = CINATRA_NANGO_PROVIDER_CONFIG_KEYS.drupal;
  const connectionId = id; // per-instance UUID

  const now = new Date().toISOString();

  // When a key is provided (new instance OR rotation), run the full
  // ensure → import → readback flow. Otherwise (edit without key),
  // skip Nango entirely — only name/URL are changing.
  if (trimmedKey) {
    await ensureNangoConnectorIntegration("drupal");
    await importNangoConnection({
      // NO connectorKey — defers saveNangoConnectionRecord.
      providerConfigKey,
      connectionId,
      credentials: { type: "API_KEY", apiKey: trimmedKey },
      metadata: { siteUrl: normalizedUrl },
    });
    const readback = await getNangoCredentials(providerConfigKey, connectionId, { forceRefresh: true });
    const readbackKey = extractApiKey(readback);
    if (readbackKey !== trimmedKey) {
      throw new Error(
        "Nango credential verification failed: the readback value did not match the saved credential.",
      );
    }
  }

  const next: DrupalInstanceSettings = existing
    ? {
        ...existing,
        name: trimmedName,
        siteUrl: normalizedUrl,
        nangoConnectionId: connectionId,
        providerConfigKey,
        updatedAt: now,
      }
    : {
        id,
        name: trimmedName,
        siteUrl: normalizedUrl,
        nangoConnectionId: connectionId,
        providerConfigKey,
        createdAt: now,
        updatedAt: now,
      };

  const remaining = current.instances.filter((i) => i.id !== next.id);
  writeSettings({ instances: [next, ...remaining] });

  // Local Nango pointer write happens AFTER cinatra DB persist + readback —
  // this keeps the pointer-before-readback gap closed.
  if (trimmedKey) {
    // `{ multiple: true }` is REQUIRED here. This path calls
    // importNangoConnection WITHOUT connectorKey, which bypasses the
    // schema-driven multiple inference inside
    // importNangoConnection. saveNangoConnectionRecord defaults to
    // multiple:false, so without this flag saving/rotating ONE Drupal
    // instance would replace ALL saved Drupal pointer records with just the
    // latest — breaking the multi-instance design.
    await saveNangoConnectionRecord(
      "drupal",
      {
        connectionId,
        providerConfigKey,
        displayName: trimmedName,
        metadata: { siteUrl: normalizedUrl },
      },
      { multiple: true },
    );
  }

  return next;
}

/**
 * Strip trailing slashes via a LINEAR char-index trim. The module-local
 * `normalizeSiteUrl` uses the anchored greedy `/\/+$/`, which is
 * polynomial-ReDoS on input with many trailing slashes (CodeQL
 * `js/polynomial-redos`). New code must use this linear form.
 */
function trimTrailingSlashesLinear(input: string): string {
  let end = input.length;
  while (end > 0 && input.charCodeAt(end - 1) === 47) end--; // 47 = "/"
  return input.slice(0, end);
}

/**
 * LOCAL-DEV-ONLY recovery persist for `dev-auto-setup`.
 *
 * `saveDrupalInstance` THROWS when Nango is not configured (it requires a
 * `drush mcp-tools:remote-key-create` Bearer to import + readback-verify into
 * the Nango vault). The UAT / a fresh dev box can run with NO Nango (only
 * placeholder LLM creds), so the FIRST Drupal wire never lands a configured
 * instance row, which in turn blocks `dev-auto-setup` from pushing the browser
 * widget config (`cinatra.settings cinatra_url`/`api_key`/`instance_id`).
 *
 * The browser→cinatra WIDGET direction (validated by `widget-stream-auth`
 * against `drupal_widget_auth.apiKey`) does NOT depend on the cinatra→Drupal
 * `mcp_tools_remote` Bearer being stored. So this helper lets `dev-auto-setup`
 * persist a COMPLETE local-dev instance row WITHOUT any Nango side effect, then
 * push the widget config. The MCP WRITE path stays unconfigured (writes 401)
 * until Nango is configured — at which point the next boot's reconcile /
 * local-dev transition mints + imports the remote-key Bearer.
 *
 * `lastValidatedAt` is intentionally left UNSET (the row was NOT
 * network/Nango validated — no false attribution). `nangoConnectionId` is set
 * to the per-instance id ONLY so `getDrupalAPISettings`' Nango-pointer filter
 * lists the row; no actual Nango connection exists yet (credential lookups
 * fail-to-resolve → 401 until the transition runs). There is deliberately NO
 * `saveNangoConnectionRecord` / `importNangoConnection` here — a Nango pointer
 * with no readback-verified Bearer would be a corrupt/dangling pointer.
 *
 * HARD-GATED to localhost: `server-only` is not a dev boundary, so this
 * NON-VALIDATING exported persist refuses any non-local site URL. It must never
 * become a general production affordance.
 *
 * SECRET BOUNDARY: writes no credential (none is involved) and logs nothing.
 */
export async function persistLocalDevDrupalInstanceUnvalidated(input: {
  id?: string;
  name: string;
  siteUrl: string;
}): Promise<DrupalInstanceSettings> {
  const siteUrl = trimTrailingSlashesLinear(input.siteUrl.trim());
  const host = (() => {
    try {
      // `new URL("http://[::1]:8082").hostname` returns "[::1]" (brackets kept).
      // Strip the brackets so the IPv6 loopback compares cleanly.
      const h = new URL(siteUrl).hostname.toLowerCase();
      return h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
    } catch {
      return "";
    }
  })();
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
    throw new Error("Unvalidated Drupal instance persistence is local-dev only.");
  }

  const trimmedName = input.name.trim();
  if (!trimmedName) {
    throw new Error("Instance name is required.");
  }

  const current = getDrupalAPISettings();
  const existing = input.id
    ? current.instances.find((i) => i.id === input.id)
    : current.instances.find((i) => i.siteUrl === siteUrl);

  const now = new Date().toISOString();
  const id = input.id?.trim() || existing?.id || randomUUID();
  const next: DrupalInstanceSettings = {
    id,
    name: trimmedName,
    siteUrl,
    // Set ONLY so getDrupalAPISettings lists the row; no real Nango connection
    // exists yet — the local-dev transition imports a Bearer once Nango is on.
    nangoConnectionId: id,
    providerConfigKey: existing?.providerConfigKey ?? CINATRA_NANGO_PROVIDER_CONFIG_KEYS.drupal,
    // lastValidatedAt intentionally omitted — this row was NOT validated.
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  const remaining = current.instances.filter((i) => i.id !== next.id && i.siteUrl !== next.siteUrl);
  writeSettings({ instances: [next, ...remaining] });

  return next;
}

/**
 * Delete instance + clean up Nango pointer + best-effort remote connection
 * delete. Errors during Nango cleanup are swallowed with a warning (Nango may
 * be unreachable or the connection may already be gone).
 */
export async function deleteDrupalInstance(id: string): Promise<void> {
  const current = getDrupalAPISettings();
  const target = current.instances.find((i) => i.id === id);
  writeSettings({ instances: current.instances.filter((i) => i.id !== id) });
  if (!target) return;
  try {
    await removeNangoConnectionRecord("drupal", target.nangoConnectionId);
  } catch (err) {
    console.warn(
      `[drupal-api] removeNangoConnectionRecord failed for ${target.id} (ignored): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (isNangoConfigured()) {
    try {
      await deleteNangoConnection(target.providerConfigKey, target.nangoConnectionId);
    } catch (err) {
      console.warn(
        `[drupal-api] deleteNangoConnection failed for ${target.id} (ignored): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export async function listDrupalInstances(): Promise<DrupalInstanceSettings[]> {
  return getDrupalAPISettings().instances.sort((l, r) => r.updatedAt.localeCompare(l.updatedAt));
}

export type DrupalAPIStatus = {
  instanceCount: number;
  instances: Array<{ id: string; name: string; siteUrl: string; lastValidatedAt?: string }>;
};

export async function getDrupalAPIStatus(): Promise<DrupalAPIStatus> {
  const instances = await listDrupalInstances();
  return {
    instanceCount: instances.length,
    instances: instances.map((i) => ({
      id: i.id,
      name: i.name,
      siteUrl: i.siteUrl,
      lastValidatedAt: i.lastValidatedAt,
    })),
  };
}
