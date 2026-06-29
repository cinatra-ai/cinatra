// Hot-install canary agent. The agent template is keyed on this package name; the
// runtime-install gate (assertAgentPackageRunnable / partitionRunnableAgentPackages)
// intersects it against the canonical installed_extension status.
export function register(ctx) {
  ctx.logger.info("agent-canary registered");
}
