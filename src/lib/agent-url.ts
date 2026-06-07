// Parses a scoped npm package name (@scope/name or name) into the
// /agents/[vendor]/[packageName]/[instanceId] URL structure.

export function buildAgentInstancePath(agentPackageName: string, instanceId: string): string {
  const match = agentPackageName.match(/^@([^/]+)\/(.+)$/);
  if (match) return `/agents/${match[1]}/${match[2]}/${instanceId}`;
  return `/agents/${agentPackageName}/${instanceId}`;
}

export function buildAgentWorkspacePath(agentPackageName: string): string {
  return buildAgentInstancePath(agentPackageName, "new");
}

export function buildAgentPackageBasePath(agentPackageName: string): string {
  const match = agentPackageName.match(/^@([^/]+)\/(.+)$/);
  if (match) return `/agents/${match[1]}/${match[2]}`;
  return `/agents/${agentPackageName}`;
}
