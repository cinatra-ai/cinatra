// The schema-config FIXTURE connector's BUILT `register(ctx)` server entry.
//
// Hand-written ESM mirror of `register.ts` (the register is trivial; no build
// step needed) so the fixture conforms to the runtime store's
// built-artifacts-only contract (cinatra#161): `cinatra.serverEntry` must
// resolve to a concrete Node-importable artifact (.mjs/.cjs/.js). The TS
// source stays alongside (and stays referenced by the `exports` map) for the
// unit tests that read it; the prod-container hot-install proof packs this
// same dir and now ships a materializable, activatable entry.
//
// MODEL B: no host-peer value import — the value this entry needs (`ctx`) is
// injected, never imported.

export function register(ctx) {
  // The setup surface mirrors `cinatra.configSchema` (host renders from the
  // manifest data; registering it here keeps the surface registry consistent).
  ctx.ui.registerSetupSurface({
    title: "Schema-Config Fixture",
    description: "A minimal API-key-only connector that ships no React.",
    fields: [
      { kind: "secret", key: "apiKey", label: "API key", required: true },
      { kind: "status-probe", label: "Connection", actionId: "probe" },
      { kind: "named-action", label: "Refresh", actionId: "refresh" },
    ],
  });

  // The status-probe handler: reports whether an API key has been stored.
  ctx.ui.registerAction({
    id: "probe",
    handler: async () => {
      const apiKey = await ctx.secrets.get("apiKey");
      return { status: apiKey ? "ok" : "error" };
    },
  });

  // The named-action handler: a no-op "refresh" the fixture exposes to exercise
  // the named-action dispatch path end to end.
  ctx.ui.registerAction({
    id: "refresh",
    handler: async () => ({ refreshed: true }),
  });
}
