// Hot-install canary dashboard/cube extension. Contributes one runtime cube; the
// CG-5 serve-gate (decideRuntimeCubeServe) refuses serving on BOTH transports
// (HTTP cubejs + MCP cube tools) with cube_not_active once archived — no rebuild.
export function register(ctx) {
  ctx.logger.info("cube-canary registered");
}
