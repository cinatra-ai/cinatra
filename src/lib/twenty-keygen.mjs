// Shared, dependency-free helpers for provisioning the local dev Twenty CRM:
// building the `command:prod` docker-exec argv, parsing the minted API-key JWT,
// and probing whether a bearer actually authenticates. Node built-ins only
// (no app/DB/Nango imports) so it is safe to import from BOTH the Next.js dev
// runtime (src/lib/dev-auto-setup.ts) AND the plain-node bootstrap proof
// (scripts/twenty-bootstrap/twenty-bootstrap-proof.mjs) — single source of truth for the
// brittle Twenty CLI command + JWT shape, per the convergence decision.

// Reuse contract for callers: a probe of "ok"/"unreachable" means keep the
// existing key; only a definite "unauthorized" (401/403) — or a missing
// credential on first setup — should trigger minting a fresh key. This keeps
// the local Twenty from accumulating keys across dev boots.

// The single Apple dev workspace seeded by `workspace:seed:dev` (Twenty has no
// IS_MULTIWORKSPACE_ENABLED env var; this id is stable across Twenty versions).
export const SEED_APPLE_WORKSPACE_ID = "20202020-1c25-4d02-bf25-6aeccf7ea419";

// `command:prod` is the production-build CLI entry inside the Twenty image.
const COMMAND_PROD = ["yarn", "command:prod"];

/** Args for the idempotent Apple-workspace seed (`workspace:seed:dev --light`). */
export function buildSeedDevArgs() {
  return [...COMMAND_PROD, "workspace:seed:dev", "--light"];
}

/**
 * Args for minting a workspace API key. `expireDays` (Twenty's `-e`) is optional
 * — omit for a non-expiring local key, pass a small number in CI for a short TTL.
 *
 * @param {{ workspaceId?: string, keyName: string, expireDays?: number | null }} opts
 * @returns {string[]}
 */
export function buildGenerateApiKeyArgs({ workspaceId = SEED_APPLE_WORKSPACE_ID, keyName, expireDays } = {}) {
  if (!keyName) throw new Error("buildGenerateApiKeyArgs: keyName is required");
  const args = [...COMMAND_PROD, "workspace:generate-api-key", "-w", workspaceId, "-n", keyName];
  if (expireDays !== undefined && expireDays !== null) {
    args.push("-e", String(expireDays));
  }
  return args;
}

// Twenty's CLI prints the key as a JWT (a.b.c) surrounded by log decoration;
// the JWT shape is robust against that decoration.
const JWT_RE = /\b(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/;

/** Extract the first JWT-shaped token from command output, or null. */
export function parseTwentyApiKey(text) {
  const m = String(text ?? "").match(JWT_RE);
  return m ? m[1] : null;
}

/**
 * Probe whether a bearer authenticates against Twenty via an AUTHENTICATED REST
 * read (`GET /rest/companies?limit=1`). The same workspace API key authenticates
 * both REST and MCP, so a successful REST read is a sound, cheap proxy for "the
 * connector's MCP calls will authenticate" — and avoids replicating the MCP
 * initialize/SSE handshake.
 *
 * TRI-STATE so callers distinguish a DEFINITE auth failure (rotate the key) from
 * an INDETERMINATE service failure (Twenty still warming / 5xx / network — keep
 * the existing key, do NOT mint a new one):
 *   "ok"           — HTTP 2xx; the bearer authenticates.
 *   "unauthorized" — HTTP 401/403; the bearer is invalid or expired.
 *   "unreachable"  — any other status, a network error, a timeout, or missing
 *                    inputs; indeterminate, never a reason to mint.
 * `healthz` is unauthenticated and therefore NOT sufficient.
 *
 * @param {{ baseUrl: string, apiKey: string | null | undefined, timeoutMs?: number, fetchImpl?: typeof fetch }} opts
 * @returns {Promise<"ok" | "unauthorized" | "unreachable">}
 */
export async function probeTwentyBearer({ baseUrl, apiKey, timeoutMs = 8000, fetchImpl = fetch } = {}) {
  if (!apiKey || !baseUrl) return "unreachable";
  const url = `${String(baseUrl).replace(/\/+$/, "")}/rest/companies?limit=1`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: controller.signal,
    });
    if (res.ok) return "ok";
    if (res.status === 401 || res.status === 403) return "unauthorized";
    return "unreachable";
  } catch {
    return "unreachable";
  } finally {
    clearTimeout(timer);
  }
}
