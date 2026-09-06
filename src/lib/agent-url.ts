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

// cinatra#3080 — AND A PATH SEGMENT IS READ BACK THE WAY IT WAS WRITTEN.
// The router hands a dynamic segment to a page still percent-encoded, so the
// value a page reads out of `params` is the SEGMENT, not the id. Every ordinary
// run id is a uuid, which is byte-identical either way, so the difference was
// invisible until a repair run — whose id carries a colon — opened its own page
// and the run row was looked up under `lifecycle-repair-run%3A…`, which is no
// run at all. This is the inverse of `buildAgentInstancePath`: what that writes
// into a link, this reads back out of the route.
//
// A malformed sequence is NOT an error to raise from a page: it is simply not
// an id any run has, and the caller's own missing-run answer is the right one.
export function readAgentInstanceIdFromSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
