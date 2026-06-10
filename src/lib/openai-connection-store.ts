// OpenAI connection store.
//
// This module owns the `openai_connection` metadata row in `cinatra.metadata`.
// The row is also read by `readCampaignStoreFromDatabase` in campaign-store.ts.
// While both consumers coexist, every write invalidates the in-process campaign
// store cache so either read path stays coherent.

import { revalidatePath } from "next/cache";
import { DEFAULT_OPENAI_MODEL_ID } from "@cinatra-ai/agents/llm-provider-policy";
import {
  readMetadataValueFromDatabase,
  writeMetadataValueToDatabase,
} from "@/lib/database";
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

const METADATA_KEY = "openai_connection";

function getDefaultOpenAIServiceTier(): OpenAIServiceTier {
  return (isAppDevelopmentMode() ? "flex" : "default") as OpenAIServiceTier;
}

function defaultConnection(): OpenAIConnection {
  return {
    defaultModel: DEFAULT_OPENAI_MODEL_ID,
    serviceTier: getDefaultOpenAIServiceTier(),
    availableModels: [],
    loggingEnabled: true,
  };
}

function nowIso() {
  return new Date().toISOString();
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
  const raw = readMetadataValueFromDatabase<OpenAIConnection | null>(METADATA_KEY, null);
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
    loggingEnabled: raw.loggingEnabled ?? true,
    promptCachingEnabled: raw.promptCachingEnabled ?? isAppDevelopmentMode(),
    lastValidatedAt: raw.lastValidatedAt,
    availableModels: raw.availableModels ?? [],
  };
}

/**
 * Overwrite the persisted OpenAI connection. Passing `null` resets to the
 * default shape (equivalent to a factory-reset).
 */
export function writeOpenAIConnection(connection: OpenAIConnection | null): void {
  writeMetadataValueToDatabase(METADATA_KEY, connection ?? defaultConnection());
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
}): Promise<void> {
  const current = readOpenAIConnection() ?? defaultConnection();
  const next: OpenAIConnection = {
    ...current,
    apiKey: input.apiKey ?? current.apiKey,
    projectId: input.projectId ?? current.projectId,
    organizationId: input.organizationId ?? current.organizationId,
    defaultModel: input.defaultModel ?? current.defaultModel ?? DEFAULT_OPENAI_MODEL_ID,
    serviceTier: input.serviceTier ?? current.serviceTier ?? getDefaultOpenAIServiceTier(),
    loggingEnabled: input.loggingEnabled ?? current.loggingEnabled ?? true,
    promptCachingEnabled:
      input.promptCachingEnabled ?? current.promptCachingEnabled ?? isAppDevelopmentMode(),
    availableModels: input.availableModels ?? current.availableModels ?? [],
    lastValidatedAt: nowIso(),
  };
  writeOpenAIConnection(next);
  revalidatePath("/agents");
  revalidatePath("/configuration/llm");
  revalidatePath("/configuration/llm/initial-setup");
  revalidatePath("/configuration/apps");
  revalidatePath("/configuration/apps/openai");
}

export async function clearOpenAIConnection(): Promise<void> {
  const current = readOpenAIConnection() ?? defaultConnection();
  const next: OpenAIConnection = {
    defaultModel: current.defaultModel ?? DEFAULT_OPENAI_MODEL_ID,
    serviceTier: current.serviceTier ?? getDefaultOpenAIServiceTier(),
    loggingEnabled: current.loggingEnabled ?? true,
    promptCachingEnabled: current.promptCachingEnabled ?? isAppDevelopmentMode(),
    availableModels: [],
  };
  writeOpenAIConnection(next);
  revalidatePath("/agents");
  revalidatePath("/configuration/llm");
  revalidatePath("/configuration/llm/initial-setup");
  revalidatePath("/configuration/apps");
  revalidatePath("/configuration/apps/openai");
}

export async function updateOpenAILoggingEnabled(loggingEnabled: boolean): Promise<void> {
  const current = readOpenAIConnection() ?? defaultConnection();
  const next: OpenAIConnection = {
    ...current,
    defaultModel: current.defaultModel ?? DEFAULT_OPENAI_MODEL_ID,
    serviceTier: current.serviceTier ?? getDefaultOpenAIServiceTier(),
    loggingEnabled,
    promptCachingEnabled: current.promptCachingEnabled ?? isAppDevelopmentMode(),
    availableModels: current.availableModels ?? [],
    lastValidatedAt: current.lastValidatedAt,
  };
  writeOpenAIConnection(next);
  revalidatePath("/configuration");
  revalidatePath("/configuration/development");
}

export async function updateOpenAIPromptCaching(enabled: boolean): Promise<void> {
  const current = readOpenAIConnection() ?? defaultConnection();
  const next: OpenAIConnection = {
    ...current,
    defaultModel: current.defaultModel ?? DEFAULT_OPENAI_MODEL_ID,
    serviceTier: current.serviceTier ?? getDefaultOpenAIServiceTier(),
    loggingEnabled: current.loggingEnabled ?? true,
    promptCachingEnabled: enabled,
    availableModels: current.availableModels ?? [],
    lastValidatedAt: current.lastValidatedAt,
  };
  writeOpenAIConnection(next);
  revalidatePath("/configuration/llm");
}
