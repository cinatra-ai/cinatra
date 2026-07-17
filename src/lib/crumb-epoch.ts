// The crumb-contributions session/org fence value (cinatra#1737), computed
// identically by the root layout (for the AppShell consumer) and by every
// publishing route (for its island). Pure — usable from server and client.

export function crumbEpoch(
  userId: string | null | undefined,
  activeOrgId: string | null | undefined,
): string {
  return userId ? `${userId}:${activeOrgId ?? "none"}` : "anon";
}
