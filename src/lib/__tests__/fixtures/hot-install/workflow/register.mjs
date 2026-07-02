// Hot-install canary workflow. Its agent_task step resolves an agent whose package
// is gated by the SAME runtime-install rule (isAgentRuntimeRunnable); an archived
// install makes the agent_task dispatch refuse with AGENT_NOT_INSTALLED, no rebuild.
export function register(ctx) {
  ctx.logger.info("workflow-canary registered");
}
