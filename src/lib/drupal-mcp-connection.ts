import "server-only";

import { getDrupalAPISettings } from "@/lib/drupal-api";
import { isPrivateUrl } from "@/lib/wordpress-mcp-connection";
import { buildBearerAuthHeaderFromNango, isNangoConfigured } from "@cinatra-ai/nango-connector";
import type { LlmMcpServerTool, LlmProvider } from "@cinatra-ai/llm";

const MCP_TOOLS_PATH = "/_mcp_tools";

export type DrupalMcpStatus = "registered" | "not_installed" | "auth_error" | "unreachable";

const PROBE_TTL_MS = 2 * 60 * 1000;
const probeCache = new Map<string, { status: DrupalMcpStatus; expiresAt: number }>();

async function headProbe(endpoint: string, authHeader: string): Promise<number> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      const res = await fetch(endpoint, {
        method: "HEAD",
        headers: { Authorization: authHeader },
        signal: controller.signal,
      });
      return res.status;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return 0;
  }
}

function classifyStatus(code: number): DrupalMcpStatus {
  if (code === 200 || code === 405) return "registered"; // 405 = HEAD-not-supported (treat as reachable)
  if (code === 401 || code === 403) return "auth_error";
  if (code === 404) return "not_installed";
  return "unreachable";
}

export async function probeDrupalMcp(
  siteUrl: string,
  authHeader: string,
): Promise<DrupalMcpStatus> {
  const endpoint = siteUrl.replace(/\/+$/, "") + MCP_TOOLS_PATH;
  const cacheKey = endpoint;
  const cached = probeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.status;

  const code = await headProbe(endpoint, authHeader);
  const status = classifyStatus(code);
  probeCache.set(cacheKey, { status, expiresAt: Date.now() + PROBE_TTL_MS });
  return status;
}

export type DrupalMcpInstanceStatus = {
  id: string;
  name: string;
  siteUrl: string;
  status: DrupalMcpStatus;
  isPrivate: boolean;
};

export async function getDrupalMcpInstanceStatuses(): Promise<DrupalMcpInstanceStatus[]> {
  const { instances } = getDrupalAPISettings();
  const out: DrupalMcpInstanceStatus[] = [];
  for (const instance of instances) {
    const isPrivate = isPrivateUrl(instance.siteUrl);
    if (isPrivate) {
      out.push({ id: instance.id, name: instance.name, siteUrl: instance.siteUrl, status: "registered", isPrivate: true });
      continue;
    }
    // Resolve the Bearer token from Nango per instance.
    const authHeader = await buildBearerAuthHeaderFromNango({
      providerConfigKey: instance.providerConfigKey,
      connectionId: instance.nangoConnectionId,
      label: `drupal-${instance.id}`,
    });
    if (!authHeader) {
      // Helper already warned with the label. Surface as 'unreachable' so
      // the UI status badge clearly distinguishes "no Nango cred" from
      // "Drupal site is down" — both are operator-actionable, but neither
      // reveals the token.
      out.push({ id: instance.id, name: instance.name, siteUrl: instance.siteUrl, status: "unreachable", isPrivate: false });
      continue;
    }
    const status = await probeDrupalMcp(instance.siteUrl, authHeader.Authorization);
    out.push({ id: instance.id, name: instance.name, siteUrl: instance.siteUrl, status, isPrivate: false });
  }
  return out;
}

export async function buildDrupalMcpServerTools(_provider: LlmProvider): Promise<LlmMcpServerTool[]> {
  try {
    const { instances } = getDrupalAPISettings();
    if (!instances || instances.length === 0) return [];
    // Short-circuit when Nango isn't available to avoid per-instance lookups
    // that would all log warnings.
    if (!isNangoConfigured()) {
      if (instances.length > 0) {
        console.warn(
          `[drupal-mcp-connection] Nango not configured — skipping ${instances.length} Drupal instance(s)`,
        );
      }
      return [];
    }
    const tools: LlmMcpServerTool[] = [];
    for (const instance of instances) {
      if (isPrivateUrl(instance.siteUrl)) {
        console.log(
          `[drupal-mcp-connection] ${instance.siteUrl} is private — skipping (LLM providers cannot reach localhost)`,
        );
        continue;
      }
      // Resolve the Bearer header from Nango via the first-party helper
      // so the token never touches this file.
      const headers = await buildBearerAuthHeaderFromNango({
        providerConfigKey: instance.providerConfigKey,
        connectionId: instance.nangoConnectionId,
        label: `drupal-${instance.id}`,
      });
      if (!headers) {
        // Helper already warned with the label.
        continue;
      }
      const status = await probeDrupalMcp(instance.siteUrl, headers.Authorization);
      if (status !== "registered") {
        console.log(`[drupal-mcp-connection] ${instance.siteUrl} status=${status} — skipping`);
        continue;
      }
      tools.push({
        type: "mcp",
        serverLabel: `drupal-${instance.id}`,
        serverUrl: instance.siteUrl.replace(/\/+$/, "") + MCP_TOOLS_PATH,
        headers,
        serverDescription: `Drupal site ${instance.name} (${instance.siteUrl}) — drupal/mcp_tools`,
        allowedTools: null,
        requireApproval: "never",
      });
    }
    return tools;
  } catch (err) {
    console.warn(
      "[drupal-mcp-connection] buildDrupalMcpServerTools failed",
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}
