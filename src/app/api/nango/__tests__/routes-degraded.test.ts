// Degraded-resolution pins for the /api/nango/* routes (cinatra#151 Stage 1,
// risk R-D): a nango-system resolution miss yields a DEFINED 503 with the
// `nango-system-unavailable` marker — NEVER a silent success. In particular
// the unauthenticated webhook must never return its usual 200 `{ ok: true }`
// while the surface is unresolved. Unreachable in prod (nango is a
// systemExtension whose REQUIRED activation is boot-armed) — these pins guard
// build/degraded contexts and the failure mode itself.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: async () => null,
}));

import {
  registerCapabilityProvider,
  __resetCapabilityRegistry,
} from "@/lib/extension-capabilities-registry";
import { NANGO_SYSTEM_CAPABILITY } from "@cinatra-ai/sdk-extensions";
import { POST as sessionPOST } from "@/app/api/nango/connect/session/route";
import { POST as savePOST } from "@/app/api/nango/connections/save/route";
import { POST as webhookPOST } from "@/app/api/nango/webhook/route";

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/nango/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  __resetCapabilityRegistry();
});

describe("resolution miss => defined 503 with marker", () => {
  for (const [name, handler, body] of [
    ["connect/session", sessionPOST, { connectorKey: "github" }],
    ["connections/save", savePOST, { connectorKey: "github", providerConfigKey: "x", connectionId: "y" }],
    ["webhook", webhookPOST, { type: "auth", success: true }],
  ] as const) {
    it(`${name}: 503 + nango-system-unavailable (never a silent success)`, async () => {
      const response = await handler(jsonRequest(body));
      expect(response.status).toBe(503);
      const payload = (await response.json()) as { code?: string; ok?: unknown };
      expect(payload.code).toBe("nango-system-unavailable");
      expect(payload.ok).toBeUndefined();
    });
  }
});

describe("resolved surface => routes delegate to the capability members", () => {
  it("webhook delegates and returns the handler result", async () => {
    const handled: unknown[] = [];
    registerCapabilityProvider(NANGO_SYSTEM_CAPABILITY, {
      packageName: "@cinatra-ai/nango-connector",
      impl: {
        isNangoConfigured: () => true,
        getNangoStatus: () => ({ status: "connected", detail: "" }),
        getNangoSettings: () => ({}),
        providerConfigKeys: {},
        handleNangoWebhookRequest: async (request: Request) => {
          handled.push(await request.json());
          return { body: { ok: true } };
        },
      },
    });
    const response = await webhookPOST(jsonRequest({ type: "auth", success: true }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(handled).toHaveLength(1);
  });
});
