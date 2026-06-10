// Lightweight vitest stub for "@cinatra-ai/mcp-server/credentials".
//
// The real package's exports field omits the ./credentials subpath under
// node resolution conditions (it is mapped via tsconfig path alias in app
// builds), so vitest needs an explicit resolver — same situation as the
// skills-mcp-client stub. Inert by default; individual tests vi.mock() the
// specifier with their own factory when they need specific behavior.

export function getPublicMcpServerUrl(): string | null {
  return null;
}

export function getLlmMcpCredentials(): null {
  return null;
}

export function getLocalTokenEndpointUrl(_basePath?: string): string {
  return "http://localhost:3000/api/auth/token";
}

export function getLocalMcpServerUrl(_path?: string): string {
  return "http://localhost:3000/api/mcp";
}

export async function hasLlmMcpAccess(): Promise<boolean> {
  return false;
}

export async function getLlmMcpAccessStatus(): Promise<{ ok: boolean }> {
  return { ok: false };
}
