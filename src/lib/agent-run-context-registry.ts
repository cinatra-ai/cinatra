/**
 * In-process agent run-context registry.
 *
 * Lives in src/lib/ so it is compiled as part of the Next.js app bundle,
 * guaranteeing a single module instance shared by every route handler in
 * the same Node.js process (the mcp-server package would be a separate
 * Turbopack chunk and would NOT share state).
 *
 * Writer: /api/llm-bridge (bridge route) — calls
 *   setRunContext before each LLM step and clearRunContext in finally.
 * Reader: /api/mcp transport handler — looks up context by registryKey
 *   (clientId decoded from Bearer JWT, or the raw sentinel for dev-bypass).
 *
 * TTL: 300 s — generous upper bound for any single LLM API call.
 */

export type AgentRunCtx = {
  runId?: string;
  agentId?: string;
  packageVersion?: string;
  agentSpecVersion?: string;
};

const _registry = new Map<string, { ctx: AgentRunCtx; expires: number }>();

export function setRunContext(key: string, ctx: AgentRunCtx): void {
  _registry.set(key, { ctx, expires: Date.now() + 300_000 });
}

export function clearRunContext(key: string): void {
  _registry.delete(key);
}

export function getRunContext(key: string): AgentRunCtx | undefined {
  const entry = _registry.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expires) {
    _registry.delete(key);
    return undefined;
  }
  return entry.ctx;
}
