// Hot-install canary connector (schema-config / model B — NOT bundled-react,
// which is not hot-installable by design). Minimal server entry: it only logs so
// the real install pipeline can materialize + activate it without side effects.
export function register(ctx) {
  ctx.logger.info("connector-canary registered");
}
