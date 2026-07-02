// Hot-install canary artifact extension. Declares one semantic artifact type; the
// CG-4 write gate (isArtifactExtensionWriteAllowed) refuses writes to its type once
// the canonical install row is archived, in EVERY process (DB-status-driven).
export function register(ctx) {
  ctx.objects.registerType({ id: "artifact-canary:note", title: "Canary Note" });
}
