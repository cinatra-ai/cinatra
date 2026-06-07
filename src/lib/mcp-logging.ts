import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { readConnectorConfigFromDatabase, writeConnectorConfigToDatabase } from "@/lib/database";

type McpLoggingSettings = {
  serverLoggingEnabled?: boolean;
  clientLoggingEnabled?: boolean;
};

const MCP_LOGGING_CONNECTOR_ID = "mcp_logging";

export const MCP_SERVER_LOG_DIRECTORY = path.join(process.cwd(), "data", "logs", "mcp-server");
export const MCP_CLIENT_LOG_DIRECTORY = path.join(process.cwd(), "data", "logs", "mcp-client");

declare global {
  var __cinatraMcpLogDeduplicationCache: Map<string, string> | undefined;
}

function readSettings() {
  return readConnectorConfigFromDatabase<McpLoggingSettings>(MCP_LOGGING_CONNECTOR_ID, {});
}

function writeSettings(value: McpLoggingSettings) {
  writeConnectorConfigToDatabase(MCP_LOGGING_CONNECTOR_ID, value);
}

function sanitizeLogLabel(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "mcp"
  );
}

function buildLogTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function getMcpLogDeduplicationCache() {
  if (!globalThis.__cinatraMcpLogDeduplicationCache) {
    globalThis.__cinatraMcpLogDeduplicationCache = new Map<string, string>();
  }

  return globalThis.__cinatraMcpLogDeduplicationCache;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeJsonValue(entry));
  }

  if (!isPlainObject(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, normalizeJsonValue(value[key])]),
  );
}

function stableStringify(value: unknown) {
  return JSON.stringify(normalizeJsonValue(value));
}

function isStatusLabel(label: string) {
  return label.endsWith(".status") || sanitizeLogLabel(label).endsWith("-status");
}

function buildStatusLogFingerprint(input: {
  kind: "request" | "response" | "event";
  body: unknown;
}) {
  if (input.kind === "request") {
    return null;
  }

  if (!isPlainObject(input.body)) {
    return stableStringify(input.body);
  }

  if (input.kind === "response") {
    return stableStringify({
      primitiveName: input.body.primitiveName ?? null,
      mode: input.body.mode ?? null,
      ok: input.body.ok ?? null,
      output: input.body.output ?? null,
      error: input.body.error ?? null,
    });
  }

  if (input.body.status === "started") {
    return null;
  }

  return stableStringify({
    scope: input.body.scope ?? null,
    primitiveName: input.body.primitiveName ?? null,
    mode: input.body.mode ?? null,
    status: input.body.status ?? null,
    output: input.body.output ?? null,
    error: input.body.error ?? null,
  });
}

function shouldWriteMcpLogFile(input: {
  directory: string;
  label: string;
  kind: "request" | "response" | "event";
  body: unknown;
}) {
  if (!isStatusLabel(input.label)) {
    return true;
  }

  const fingerprint = buildStatusLogFingerprint({
    kind: input.kind,
    body: input.body,
  });

  if (!fingerprint) {
    return false;
  }

  const cache = getMcpLogDeduplicationCache();
  const cacheKey = `${input.directory}:${input.kind}:${sanitizeLogLabel(input.label)}`;
  if (cache.get(cacheKey) === fingerprint) {
    return false;
  }

  cache.set(cacheKey, fingerprint);
  return true;
}

export function getMcpLoggingSettings() {
  const settings = readSettings();
  return {
    serverEnabled: settings.serverLoggingEnabled === true,
    clientEnabled: settings.clientLoggingEnabled === true,
    serverDirectory: MCP_SERVER_LOG_DIRECTORY,
    clientDirectory: MCP_CLIENT_LOG_DIRECTORY,
  };
}

export async function saveMcpLoggingSettings(input: {
  serverEnabled: boolean;
  clientEnabled: boolean;
}) {
  writeSettings({
    serverLoggingEnabled: input.serverEnabled,
    clientLoggingEnabled: input.clientEnabled,
  });
}

export function isMcpServerLoggingEnabled() {
  return readSettings().serverLoggingEnabled === true;
}

export function isMcpClientLoggingEnabled() {
  return readSettings().clientLoggingEnabled === true;
}

async function writeMcpLogFile(input: {
  directory: string;
  enabled: boolean;
  label: string;
  kind: "request" | "response" | "event";
  body: unknown;
}) {
  if (!input.enabled) {
    return;
  }

  if (
    !shouldWriteMcpLogFile({
      directory: input.directory,
      label: input.label,
      kind: input.kind,
      body: input.body,
    })
  ) {
    return;
  }

  await mkdir(input.directory, { recursive: true });
  const filename = `${buildLogTimestamp()}__${sanitizeLogLabel(input.label)}__${input.kind}.json`;
  // Redact auth-bearing headers (including the short-lived chat-delegated OBO
  // token relayed by OpenAI). Without this, an enabled MCP server log would
  // persist a replayable bearer to disk.
  await writeFile(
    path.join(input.directory, filename),
    JSON.stringify(redactMcpLogValue(input.body), null, 2),
    "utf8",
  );
}

const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-cinatra-a2a-token",
  "x-cinatra-bridge-token",
]);

function redactMcpLogValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactMcpLogValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      SENSITIVE_HEADER_NAMES.has(key.toLowerCase())
        ? "[REDACTED]"
        : redactMcpLogValue(entry),
    ]),
  );
}

export async function writeMcpServerLogFile(input: {
  label: string;
  kind: "request" | "response" | "event";
  body: unknown;
}) {
  return writeMcpLogFile({
    directory: MCP_SERVER_LOG_DIRECTORY,
    enabled: isMcpServerLoggingEnabled(),
    ...input,
  });
}

export async function writeMcpClientLogFile(input: {
  label: string;
  kind: "request" | "response" | "event";
  body: unknown;
}) {
  return writeMcpLogFile({
    directory: MCP_CLIENT_LOG_DIRECTORY,
    enabled: isMcpClientLoggingEnabled(),
    ...input,
  });
}
