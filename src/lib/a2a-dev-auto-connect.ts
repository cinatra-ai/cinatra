import "server-only";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  listSavedNangoConnections,
  saveNangoConnectionRecord,
  CINATRA_NANGO_PROVIDER_CONFIG_KEYS,
} from "@cinatra-ai/nango-connector";
import { upsertExternalAgentTemplate, renameExternalAgentTemplateRemoteId, readAgentTemplateByConnectorAndRemoteId } from "@cinatra-ai/agents";
// The Gemini key read resolves through the `llm-provider-surface` capability
// (lazy/guarded host-access cutover). Connector absent → the
// gemini auto-connect step is skipped (dev-only surface).
import { getLlmProviderSurface } from "@/lib/llm-provider-surfaces";

/**
 * Normalize a base URL to its canonical form for idempotency key generation.
 * Lowercase scheme + host + port; strip trailing slash for stable matching.
 * Returns null when the input is not a valid http:// or https:// URL.
 */
function normalizeBaseUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const host = u.host.toLowerCase();
    const scheme = u.protocol.toLowerCase();
    return `${scheme}//${host}`.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/**
 * Derive a deterministic Nango connectionId from a normalized base URL.
 * Format: `a2a-dev-<slug>` where slug is alphanumeric-dashes, max 64 chars.
 */
function connectionIdFromNormalized(normalized: string): string {
  const slug = normalized
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9]/gi, "-")
    .toLowerCase()
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return `a2a-dev-${slug}`;
}

/**
 * Derive a stable URL-safe slug from an agent card name.
 * Used as remoteAgentId so the URL reads /agents/<connector>/<slug>/...
 * Falls back to "agent" when the name produces an empty string.
 */
function slugifyAgentName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "agent";
}

/**
 * Deferred card fetch for a peer that re-upserts the template.
 *
 * Two strategies in priority order:
 *   1. Direct HTTP fetch: works when the peer runs directly on the host (the recommended
 *      dev mode that avoids Docker Desktop macOS ECONNRESET for streaming clients).
 *   2. docker exec fallback: works when the peer runs in Docker. Docker Desktop macOS
 *      proxies cause ECONNRESET for Node.js streaming HTTP but agent-card fetches
 *      (non-streaming, tiny payload) succeed via docker exec.
 */
async function fetchAndUpsertRealCard(normalized: string, connectionId: string): Promise<void> {
  function run(cmd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { timeout: 8000 }, (err, stdout) => {
        if (err) reject(err); else resolve(stdout);
      });
    });
  }

  // Strategy 1: direct HTTP fetch (peer running on host — preferred dev mode).
  // Agent-card fetches are short non-streaming GETs; ECONNRESET only affects streaming
  // responses from Docker Desktop, so this succeeds for host-run peers.
  let body: string | null = null;
  for (const cardPath of ["/.well-known/agent.json", "/.well-known/agent-card.json"]) {
    try {
      const res = await fetch(`${normalized}${cardPath}`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const text = (await res.text()).trim();
        if (text) { body = text; break; }
      }
    } catch {
      // ECONNRESET or timeout — peer is not on host, try docker exec next
    }
  }

  if (body !== null) {
    // Direct fetch succeeded — parse and upsert immediately, skip docker exec.
    let name: string;
    let description: string | null = null;
    let version: string | null = null;
    try {
      const card = JSON.parse(body) as { name?: unknown; description?: unknown; version?: unknown };
      name = typeof card.name === "string" && card.name ? card.name : connectionId;
      description = typeof card.description === "string" ? card.description : null;
      version = typeof card.version === "string" ? card.version : null;
    } catch {
      console.warn(`[a2a-dev-auto-connect] card JSON parse failed for ${normalized} (direct fetch)`);
      return;
    }
    const remoteAgentId = slugifyAgentName(name);
    // If the synthetic placeholder row exists and the real slug differs,
    // rename it in-place so the URL reflects the agent's actual name.
    if (remoteAgentId !== "agent") {
      const placeholder = await readAgentTemplateByConnectorAndRemoteId(connectionId, "agent");
      if (placeholder) {
        await renameExternalAgentTemplateRemoteId(placeholder.id, remoteAgentId, connectionId);
      }
    }
    await upsertExternalAgentTemplate({
      connectorSlug: connectionId,
      remoteAgentId,
      name,
      description,
      agentUrl: normalized,
      version,
    });
    console.log(`[a2a-dev-auto-connect] real card upserted for ${name} (${connectionId}/${remoteAgentId}) via direct fetch`);
    return;
  }

  // Strategy 2: docker exec (peer running in Docker container).
  // Step 1: extract host port
  let hostPort: string;
  try {
    const u = new URL(normalized);
    hostPort = u.port || (u.protocol === "https:" ? "443" : "80");
  } catch {
    console.warn(`[a2a-dev-auto-connect] cannot parse host port from ${normalized}`);
    return;
  }

  // Step 2: find container + internal port via `docker ps`
  let containerName: string | null = null;
  let internalPort: string | null = null;
  try {
    const lines = (await run("docker", ["ps", "--format", "{{.Names}}\t{{.Ports}}"])).trim().split("\n");
    for (const line of lines) {
      const tab = line.indexOf("\t");
      if (tab === -1) continue;
      const name = line.slice(0, tab);
      const ports = line.slice(tab + 1);
      // Match patterns like "0.0.0.0:10001->9999/tcp" or "[::]:10001->9999/tcp"
      const match = ports.match(new RegExp(`(?:0\\.0\\.0\\.0|\\[::])\\:${hostPort}->([0-9]+)/tcp`));
      if (match) { containerName = name; internalPort = match[1]; break; }
    }
  } catch (err) {
    console.warn(`[a2a-dev-auto-connect] docker ps failed for ${normalized}:`, err instanceof Error ? err.message : err);
    return;
  }

  if (!containerName || !internalPort) {
    console.warn(`[a2a-dev-auto-connect] no container found for host port ${hostPort} and direct fetch failed (${normalized})`);
    return;
  }

  // Step 3: fetch card from inside the container
  for (const cardPath of ["/.well-known/agent.json", "/.well-known/agent-card.json"]) {
    try {
      const script = `import urllib.request,sys; r=urllib.request.urlopen('http://localhost:${internalPort}${cardPath}',timeout=5); sys.stdout.write(r.read().decode())`;
      const result = (await run("docker", ["exec", containerName, "python3", "-c", script])).trim();
      if (result) { body = result; break; }
    } catch (fetchErr) {
      console.warn(
        `[a2a-dev-auto-connect] docker exec card path ${cardPath} failed for ${normalized} (${containerName}):`,
        fetchErr instanceof Error ? fetchErr.message : fetchErr,
      );
    }
  }

  if (body === null) {
    console.warn(`[a2a-dev-auto-connect] card fetch failed for ${normalized}: synthetic template remains`);
    return;
  }

  let name: string;
  let description: string | null = null;
  let version: string | null = null;

  try {
    const card = JSON.parse(body) as { name?: unknown; description?: unknown; version?: unknown };
    name = typeof card.name === "string" && card.name ? card.name : connectionId;
    description = typeof card.description === "string" ? card.description : null;
    version = typeof card.version === "string" ? card.version : null;
  } catch {
    console.warn(`[a2a-dev-auto-connect] card JSON parse failed for ${normalized}`);
    return;
  }

  const remoteAgentId = slugifyAgentName(name);
  if (remoteAgentId !== "agent") {
    const placeholder = await readAgentTemplateByConnectorAndRemoteId(connectionId, "agent");
    if (placeholder) {
      await renameExternalAgentTemplateRemoteId(placeholder.id, remoteAgentId, connectionId);
    }
  }
  await upsertExternalAgentTemplate({
    connectorSlug: connectionId,
    remoteAgentId,
    name,
    description,
    agentUrl: normalized,
    version,
  });
  console.log(`[a2a-dev-auto-connect] real card upserted for ${name} (${connectionId}/${remoteAgentId})`);
}

/**
 * Dev-only startup hook that imports every URL in
 * CINATRA_A2A_DEV_PEER_URLS as a Nango connection under the a2aServer provider.
 *
 * Two-step design (Docker Desktop ECONNRESET workaround):
 *   Synchronous boot step: save connection records + synthetic templates.
 *     Returns immediately so server startup is never blocked.
 *   Deferred fire-and-forget step: fetch real agent cards and re-upsert
 *     templates with real name/description/version. By 3s the Docker Desktop
 *     macOS VM port proxy is stable and node:http connections succeed.
 *
 * Gating:
 *   - MUST return immediately when `process.env.NODE_ENV !== "development"`
 *     OR `CINATRA_A2A_DEV_PEER_URLS` is empty/unset. First statement, no work before gate.
 *   - Entire body wrapped in try/catch; all failures log via console.warn.
 *     Startup NEVER crashes because of this hook.
 */
export async function ensureA2ADevPeerConnections(): Promise<void> {
  // Gating — FIRST statement; startup hooks must do no work before the dev/env gate.
  if (
    process.env.NODE_ENV !== "development" ||
    !process.env.CINATRA_A2A_DEV_PEER_URLS
  ) {
    return;
  }

  try {
    const raw = process.env.CINATRA_A2A_DEV_PEER_URLS;
    const rawUrls = raw.split(",").map((s) => s.trim()).filter(Boolean);

    // Defensive parsing: validate + dedupe via normalized key.
    const keyed = new Map<string, string>(); // normalized → original
    for (const url of rawUrls) {
      const normalized = normalizeBaseUrl(url);
      if (!normalized) {
        console.warn(
          `[a2a-dev-auto-connect] skipping invalid CINATRA_A2A_DEV_PEER_URLS entry: ${JSON.stringify(url)}`,
        );
        continue;
      }
      if (!keyed.has(normalized)) {
        keyed.set(normalized, url);
      }
    }

    if (keyed.size === 0) {
      return; // nothing to import
    }

    const providerConfigKey = CINATRA_NANGO_PROVIDER_CONFIG_KEYS.a2aServer;

    // Read existing connections once for idempotency check.
    const existing = listSavedNangoConnections("a2aServer");
    const existingIds = new Set(existing.map((c) => c.connectionId));

    // ── Synchronous boot step: save connection records + synthetic templates (fast, no network) ─────────
    const deferredFetches: Array<{ normalized: string; connectionId: string }> = [];

    for (const [normalized] of keyed) {
      const connectionId = connectionIdFromNormalized(normalized);
      try {
        const isNew = !existingIds.has(connectionId);
        if (isNew) {
          await saveNangoConnectionRecord(
            "a2aServer",
            {
              providerConfigKey,
              connectionId,
              metadata: { baseUrl: normalized },
            },
            { multiple: true },
          );
          console.log(`[a2a-dev-auto-connect] imported ${normalized} as ${connectionId}`);
        }

        // Deferred card fetch uses rename-in-place (renameExternalAgentTemplateRemoteId) rather than
        // insert, so there is always at most one row per connectionId — no cleanup needed.

        // Only upsert synthetic placeholder for brand-new connections.
        // Existing connections already have real names from an earlier deferred fetch;
        // overwriting them with the synthetic slug on every restart was causing the
        // "a2a-dev-localhost-XXXX" name regression visible in /agents/run.
        // The deferred fetch always re-fetches the real card for ALL connections (new + existing).
        if (isNew) {
          await upsertExternalAgentTemplate({
            connectorSlug: connectionId,
            remoteAgentId: "agent",
            name: connectionId,
            description: null,
            agentUrl: normalized,
            version: null,
          });
        }

        deferredFetches.push({ normalized, connectionId });
      } catch (err) {
        console.warn(
          `[a2a-dev-auto-connect] initial import failed for :`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    // ── Sync Gemini API key from Nango → .env (for docker-compose) ───────────────────────
    // So docker-compose --profile a2a-peers can pick up GOOGLE_API_KEY without needing it
    // in .env.local. Runs async/fire-and-forget; failures are non-fatal.
    void (async () => {
      try {
        const geminiKey = (await getLlmProviderSurface("gemini")?.getConfiguredAPIKey?.()) ?? null;
        if (geminiKey) {
          const envPath = path.join(process.cwd(), ".env");
          let content = "";
          try { content = await readFile(envPath, "utf-8"); } catch { /* file may not exist */ }
          const lines = content.split("\n").filter((l) => !l.startsWith("GOOGLE_API_KEY=") && l !== "");
          lines.push(`GOOGLE_API_KEY=${geminiKey}`);
          await writeFile(envPath, lines.join("\n") + "\n", "utf-8");
          console.log("[a2a-dev-auto-connect] synced GOOGLE_API_KEY from Nango to .env");
        }
      } catch (err) {
        console.warn("[a2a-dev-auto-connect] Gemini key sync to .env failed:", err instanceof Error ? err.message : err);
      }
    })();

    // ── Deferred card fetch (fire-and-forget, 3s delay) ─────────────────────────
    // By the time this fires the Docker Desktop macOS VM port proxy is stable.
    if (deferredFetches.length > 0) {
      setTimeout(() => { // 10s: server fully ready + Docker Desktop port proxy stable
        void (async () => {
          for (const { normalized, connectionId } of deferredFetches) {
            try {
              await fetchAndUpsertRealCard(normalized, connectionId);
            } catch (err) {
              console.warn(
                `[a2a-dev-auto-connect] deferred card fetch failed for :`,
                err instanceof Error ? err.message : err,
              );
            }
          }
        })();
      }, 10000);
    }
  } catch (err) {
    // Top-level catch — defense-in-depth. Startup boot MUST NOT fail.
    console.warn(
      "[a2a-dev-auto-connect] unexpected top-level failure; continuing boot:",
      err instanceof Error ? err.message : err,
    );
  }
}
