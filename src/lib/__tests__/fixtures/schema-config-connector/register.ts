// The schema-config FIXTURE connector's `register(ctx)` server entry.
//
// This is a minimal, API-key-only `schema-config` connector used by unit tests
// and the prod-container hot-install proof. It ships NO React: the
// setup surface is declared as DATA in `package.json` (`cinatra.configSchema`)
// and the host renders it from its single `sdk-ui` instance. `register(ctx)`
// only wires the host-side action handlers the declared status-probe + named
// action POST to via `/api/extensions/{installId}/actions/{actionId}`.
//
// MODEL B: the host SDK is imported TYPE-ONLY (erased at compile / stripped by
// the Node 24 runtime), so this passes the host-peer value-import scanner — the
// value it needs (`ctx`) is injected, never imported.

import type { ExtensionHostContext } from "@cinatra-ai/sdk-extensions";

export function register(ctx: ExtensionHostContext): void {
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
