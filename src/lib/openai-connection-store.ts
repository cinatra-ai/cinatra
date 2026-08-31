// OpenAI connection store.
//
// This module owns the `openai_connection` metadata row in `cinatra.metadata`.
// The row is also read by `readCampaignStoreFromDatabase` in campaign-store.ts.
// While both consumers coexist, every write invalidates the in-process campaign
// store cache so either read path stays coherent.
//
// AT REST (cinatra#2581): the `apiKey` is SEALED before it is persisted and
// unsealed on read — see `@/lib/connector-config-secret-fields` for the codec, the
// AAD binding, the fail-closed posture and the migration shape. The same module
// owns the body-logging default, which mirrors the openai-connector policy
// (explicit operator preference, else OFF — "dev-off" ruling, cinatra#2581)
// instead of the hard `true` that put prompt/completion bodies on local disk
// in production.

import { revalidatePath } from "next/cache";
import { DEFAULT_OPENAI_MODEL_ID } from "@cinatra-ai/agents/llm-provider-policy";
import {
  resolveOpenAIBodyLoggingDefault,
  type StoredOpenAIConnectionRow,
} from "@/lib/connector-config-secret-fields";
import {
  readUnsealedOpenAIConnectionRow,
  writeSealedOpenAIConnectionRow,
} from "@/lib/database-metadata";
import { isAppDevelopmentMode } from "@/lib/runtime-mode";
import type { OpenAIServiceTier } from "@/lib/types";

// -----------------------------------------------------------------------------
// Public type
// -----------------------------------------------------------------------------

export type OpenAIConnection = {
  apiKey?: string;
  projectId?: string;
  organizationId?: string;
  defaultModel?: string;
  serviceTier?: OpenAIServiceTier;
  loggingEnabled?: boolean;
  promptCachingEnabled?: boolean;
  lastValidatedAt?: string;
  availableModels?: string[];
};

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function getDefaultOpenAIServiceTier(): OpenAIServiceTier {
  return (isAppDevelopmentMode() ? "flex" : "default") as OpenAIServiceTier;
}

function defaultConnection(): OpenAIConnection {
  return {
    defaultModel: DEFAULT_OPENAI_MODEL_ID,
    serviceTier: getDefaultOpenAIServiceTier(),
    availableModels: [],
    // `loggingEnabled` is deliberately left UNSET (cinatra#2581 — it used to be
    // a hard `true`). A factory-reset row must not freeze a body-logging
    // preference the operator never expressed, and the hard `true` destroyed the
    // "never chosen" signal the openai-connector's own policy depends on, which
    // is what put prompt/completion bodies on local disk in production. Reads
    // materialize the OFF default via `resolveOpenAIBodyLoggingDefault`
    // ("dev-off" ruling — unset is OFF regardless of runtime mode); only an
    // explicit operator choice (updateOpenAILoggingEnabled, or an explicit
    // `input.loggingEnabled`) is ever persisted.
  };
}

function nowIso() {
  return new Date().toISOString();
}

/** The route entries that render this row. */
const CONNECTION_ROUTES = [
  "/agents",
  "/configuration/llm",
  "/configuration/llm/initial-setup",
  "/configuration/apps",
  "/configuration/apps/openai",
];

/**
 * Drop the router-cache entries that mirror the row this write just changed.
 *
 * `revalidatePath` REQUIRES a request/work store and throws without one, so a
 * caller that runs OUTSIDE a request (the boot-time provider bootstrap) passes
 * `revalidateRoutes: false` rather than having this module guess. The request
 * path keeps its ERROR SEMANTICS EXACTLY: a revalidation failure inside a
 * request still propagates, because it is a real failure there.
 */
function revalidateConnectionRoutes(routes: string[]): void {
  for (const route of routes) revalidatePath(route);
}

/**
 * Invalidate any in-process caches that mirror the `openai_connection` row.
 *
 * `src/lib/database.ts#readCampaignStoreFromDatabase` stores the connection
 * inside a versioned globalThis cache. That cache's version counter is
 * module-scoped, so the safest cross-module invalidator is to clear the cache
 * object itself. If the campaign-store cache is absent, clearing it remains a
 * harmless no-op.
 */
function invalidateCampaignStoreCache() {
  try {
    (globalThis as Record<string, unknown>).__cinatraCampaignStoreCache = undefined;
  } catch {
    // best-effort; globalThis is always writable under Node
  }
}

// -----------------------------------------------------------------------------
// Read / write primitives
// -----------------------------------------------------------------------------

/**
 * Read the persisted OpenAI connection, or `null` if it has never been saved.
 *
 * Unlike `readCampaignStoreFromDatabase().openAIConnection`, this returns
 * `null` instead of a default-populated object so callers can easily
 * distinguish between "never configured" and "configured with defaults".
 */
export function readOpenAIConnection(): OpenAIConnection | null {
  // The shared accessor unseals the `apiKey` and upgrades a legacy plaintext row.
  const raw = readUnsealedOpenAIConnectionRow() as OpenAIConnection | null;
  if (!raw) {
    return null;
  }
  // Normalize with defaults so callers never need to re-check every optional field.
  return {
    defaultModel: raw.defaultModel ?? DEFAULT_OPENAI_MODEL_ID,
    apiKey: raw.apiKey,
    projectId: raw.projectId,
    organizationId: raw.organizationId,
    serviceTier: raw.serviceTier ?? getDefaultOpenAIServiceTier(),
    loggingEnabled: resolveOpenAIBodyLoggingDefault(raw.loggingEnabled),
    promptCachingEnabled: raw.promptCachingEnabled ?? isAppDevelopmentMode(),
    lastValidatedAt: raw.lastValidatedAt,
    availableModels: raw.availableModels ?? [],
  };
}

/**
 * The NON-SECRET fields of a raw stored row, for the mutations that rebuild it.
 *
 * Takes the row rather than reading it, because every mutation runs this INSIDE
 * the write's merge-and-swap attempt (see `writeSealedOpenAIConnectionRow`): a
 * mutation that derived its payload from a snapshot taken earlier would clobber
 * whatever changed in between — including an explicit `loggingEnabled: false`
 * opt-out, the very setting this work exists to protect.
 *
 * It also never decrypts, so no mutation carries a decrypted `apiKey` in its
 * write payload. If one did, a save that raced an operator disconnecting or
 * rotating the key would re-seal that stale plaintext and RESURRECT the removed
 * credential.
 *
 * `loggingEnabled` is returned UNMATERIALIZED (`undefined` when the operator has
 * never chosen). `readOpenAIConnection` materializes the OFF default
 * ("dev-off" ruling — unset is OFF regardless of runtime mode) for its
 * callers; persisting that materialized boolean from an unrelated save would
 * freeze a preference nobody expressed.
 */
function nonSecretFieldsOf(
  raw: StoredOpenAIConnectionRow | null,
): Omit<OpenAIConnection, "apiKey"> {
  return {
    defaultModel: raw?.defaultModel ?? DEFAULT_OPENAI_MODEL_ID,
    projectId: raw?.projectId,
    organizationId: raw?.organizationId,
    serviceTier:
      (raw?.serviceTier as OpenAIServiceTier | undefined) ?? getDefaultOpenAIServiceTier(),
    loggingEnabled: raw?.loggingEnabled,
    promptCachingEnabled: raw?.promptCachingEnabled ?? isAppDevelopmentMode(),
    lastValidatedAt: raw?.lastValidatedAt,
    availableModels: raw?.availableModels ?? [],
  };
}

/**
 * Overwrite the persisted OpenAI connection. Passing `null` resets to the
 * default shape (equivalent to a factory-reset).
 *
 * The `apiKey` is SEALED before it is persisted. A write that carries NO key
 * preserves the blob stored at WRITE time (never a caller's stale snapshot), so
 * an unrelated settings save cannot resurrect a key that was disconnected or
 * rotated in between. Throws FAIL-CLOSED (never persisting plaintext) if
 * `CINATRA_ENCRYPTION_KEY` is missing or invalid — a booted instance always has
 * it (required-env preflight; auto-generated in dev).
 */
export function writeOpenAIConnection(
  connection: OpenAIConnection | null,
  options?: { clearSecret?: boolean },
): void {
  // A factory-reset (null) ALWAYS drops the stored key — `clearSecret: false`
  // must not be able to turn a reset into a preserve.
  const preserveExistingSecret = connection !== null && options?.clearSecret !== true;
  writeSealedOpenAIConnectionRow(connection ?? defaultConnection(), {
    preserveExistingSecret,
  });
  invalidateCampaignStoreCache();
}

/**
 * ATOMIC read-modify-write of the row.
 *
 * `apply` is re-run against the CURRENT stored row on every merge-and-swap
 * attempt, so a concurrent change to ANY field is re-read and carried forward
 * rather than clobbered by a stale snapshot. Every mutation below goes through
 * here — a plain read-then-write would let an unrelated toggle silently undo an
 * explicit body-logging opt-out.
 */
function mutateOpenAIConnection(
  apply: (current: Omit<OpenAIConnection, "apiKey">) => OpenAIConnection,
  options?: { clearSecret?: boolean },
): void {
  writeSealedOpenAIConnectionRow((raw) => apply(nonSecretFieldsOf(raw)), {
    preserveExistingSecret: options?.clearSecret !== true,
  });
  invalidateCampaignStoreCache();
}

// -----------------------------------------------------------------------------
// High-level mutations
// -----------------------------------------------------------------------------

export async function updateOpenAIConnection(input: {
  apiKey?: string;
  projectId?: string;
  organizationId?: string;
  defaultModel?: string;
  serviceTier?: OpenAIServiceTier;
  loggingEnabled?: boolean;
  promptCachingEnabled?: boolean;
  availableModels?: string[];
}, options?: {
  /**
   * Drop the router-cache entries for the routes that render this row.
   * Defaults to TRUE — every request-time caller, the wizard included, is
   * byte-unchanged. Only a caller with NO request (the boot-time bootstrap)
   * passes false: there is no rendered route cache before the first request,
   * and `revalidatePath` throws rather than no-opping outside one.
   */
  revalidateRoutes?: boolean;
}): Promise<void> {
  mutateOpenAIConnection((current) => ({
    ...current,
    // ONLY an explicitly supplied key is written. When this save carries none the
    // write path preserves the blob stored AT WRITE TIME, so a settings save can
    // never resurrect a key that was disconnected or rotated in the meantime.
    apiKey: input.apiKey,
    projectId: input.projectId ?? current.projectId,
    organizationId: input.organizationId ?? current.organizationId,
    defaultModel: input.defaultModel ?? current.defaultModel ?? DEFAULT_OPENAI_MODEL_ID,
    serviceTier: input.serviceTier ?? current.serviceTier ?? getDefaultOpenAIServiceTier(),
    // Only an EXPLICIT choice is persisted (see nonSecretFieldsOf).
    loggingEnabled: input.loggingEnabled ?? current.loggingEnabled,
    promptCachingEnabled:
      input.promptCachingEnabled ?? current.promptCachingEnabled ?? isAppDevelopmentMode(),
    availableModels: input.availableModels ?? current.availableModels ?? [],
    lastValidatedAt: nowIso(),
  }));
  if (options?.revalidateRoutes !== false) revalidateConnectionRoutes(CONNECTION_ROUTES);
}

export async function clearOpenAIConnection(): Promise<void> {
  // `clearSecret` is REQUIRED here: this is the disconnect path, so the stored
  // sealed key must be dropped rather than preserved by the absent-field merge.
  mutateOpenAIConnection(
    (current) => ({
      defaultModel: current.defaultModel ?? DEFAULT_OPENAI_MODEL_ID,
      serviceTier: current.serviceTier ?? getDefaultOpenAIServiceTier(),
      loggingEnabled: current.loggingEnabled,
      promptCachingEnabled: current.promptCachingEnabled ?? isAppDevelopmentMode(),
      availableModels: [],
    }),
    { clearSecret: true },
  );
  revalidateConnectionRoutes(CONNECTION_ROUTES);
}

/**
 * Persist the operator's EXPLICIT body-logging choice.
 *
 * Turning this ON makes `@cinatra-ai/openai-connector` write full OpenAI request
 * and response bodies — prompts and completions, including whatever the operator
 * pasted into them — to a local server log file. That is a deliberate debugging
 * affordance, so enabling it emits a loud warning; the API key itself travels in
 * headers and is never part of a logged body.
 */
export async function updateOpenAILoggingEnabled(loggingEnabled: boolean): Promise<void> {
  if (loggingEnabled) {
    console.warn(
      "[openai-connection] FULL request/response body logging ENABLED — OpenAI " +
        "prompts and completions will be written to a local server log file. " +
        "Leave this off unless you are actively debugging.",
    );
  }
  mutateOpenAIConnection((current) => ({
    ...current,
    defaultModel: current.defaultModel ?? DEFAULT_OPENAI_MODEL_ID,
    serviceTier: current.serviceTier ?? getDefaultOpenAIServiceTier(),
    loggingEnabled,
    promptCachingEnabled: current.promptCachingEnabled ?? isAppDevelopmentMode(),
    availableModels: current.availableModels ?? [],
    lastValidatedAt: current.lastValidatedAt,
  }));
  revalidateConnectionRoutes(["/configuration", "/configuration/development"]);
}

export async function updateOpenAIPromptCaching(enabled: boolean): Promise<void> {
  mutateOpenAIConnection((current) => ({
    ...current,
    defaultModel: current.defaultModel ?? DEFAULT_OPENAI_MODEL_ID,
    serviceTier: current.serviceTier ?? getDefaultOpenAIServiceTier(),
    // Unrelated toggle — carries the CURRENT body-logging preference forward
    // (never freezing an unexpressed one, never undoing an explicit opt-out).
    loggingEnabled: current.loggingEnabled,
    promptCachingEnabled: enabled,
    availableModels: current.availableModels ?? [],
    lastValidatedAt: current.lastValidatedAt,
  }));
  revalidateConnectionRoutes(["/configuration/llm"]);
}
