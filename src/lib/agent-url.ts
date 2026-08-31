// Parses a scoped npm package name (@scope/name or name) into the
// /agents/[vendor]/[packageName]/[instanceId] URL structure.

// cinatra#3080 — THE INSTANCE ID IS A PATH SEGMENT, SO IT IS ENCODED AS ONE.
// Every ordinary run id is a uuid, which encodes to itself, so every link the
// product has ever drawn is byte-identical. A repair run's id is not: it is
// derived from its repair (`lifecycle-repair-run:<repairId>`) and carries a
// character a path segment must escape, so the link the product built for it
// was not a URL for that run at all. A repair run is a run; the link to its
// page is built the same way as any other run's and is valid for any id.
export function buildAgentInstancePath(agentPackageName: string, instanceId: string): string {
  const segment = encodeURIComponent(instanceId);
  const match = agentPackageName.match(/^@([^/]+)\/(.+)$/);
  if (match) return `/agents/${match[1]}/${match[2]}/${segment}`;
  return `/agents/${agentPackageName}/${segment}`;
}

export function buildAgentWorkspacePath(agentPackageName: string): string {
  return buildAgentInstancePath(agentPackageName, "new");
}

export function buildAgentPackageBasePath(agentPackageName: string): string {
  const match = agentPackageName.match(/^@([^/]+)\/(.+)$/);
  if (match) return `/agents/${match[1]}/${match[2]}`;
  return `/agents/${agentPackageName}`;
}
