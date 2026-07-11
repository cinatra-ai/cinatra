import { describe, it, expect } from "vitest";
import {
  parseSchemaConfig,
  collectActionIds,
  collectHydrationKeySets,
  type SchemaConfigSurface,
} from "@/lib/extension-schema-config";
import { CONFIG_HYDRATION_SCHEMA_KEY } from "@cinatra-ai/sdk-extensions/config-hydration";

// The hydrateAction vocabulary (the opt-in hydration read-action contract,
// cinatra#1082 item 3; owner-ratified): DECLARATION validation is fail-closed
// like the rest of the vocabulary (malformed declaration fails the parse);
// runtime ACTION failures map to a blank `{}` pre-fill in the host resolver
// (see extension-config-hydration.test.ts).

function ok(raw: unknown): SchemaConfigSurface {
  const r = parseSchemaConfig(raw);
  if (!r.ok) throw new Error(`expected ok, got: ${r.errors.join("; ")}`);
  return r.surface;
}

const baseFields = [{ kind: "text", key: "model", label: "Model" }];

describe("parseSchemaConfig — hydrateAction declaration", () => {
  // NO-DRIFT PIN: the host vocabulary spells the root key as a literal (the
  // route-graph ratchet forbids the SDK module edge on hot route graphs), so
  // this suite is the functional coupling — the declaration below is built
  // FROM the SDK constant, and the parsed surface must carry it. If either
  // side ever diverges from "hydrateAction", these go red.
  it("the SDK contract constant IS the accepted root key (no drift)", () => {
    expect(CONFIG_HYDRATION_SCHEMA_KEY).toBe("hydrateAction");
    const s = ok({ fields: baseFields, [CONFIG_HYDRATION_SCHEMA_KEY]: "readConfig" });
    expect(s.hydrateAction).toBe("readConfig");
  });

  it("accepts a valid opt-in declaration and threads it onto the surface", () => {
    const s = ok({ fields: baseFields, hydrateAction: "readConfig" });
    expect(s.hydrateAction).toBe("readConfig");
  });

  it("absent declaration → surface carries NO hydrateAction (opt-out default)", () => {
    const s = ok({ fields: baseFields });
    expect(s.hydrateAction).toBeUndefined();
    expect("hydrateAction" in s).toBe(false);
  });

  it.each([
    ["a number", 42],
    ["an empty string", ""],
    ["a bad id shape", "1-starts-with-digit"],
    ["an object", { actionId: "readConfig" }],
    ["null", null],
  ])("rejects a malformed declaration (%s) fail-closed", (_name, bad) => {
    const r = parseSchemaConfig({ fields: baseFields, hydrateAction: bad });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toContain("hydrateAction");
  });
});

describe("collectActionIds — hydrateAction is a referenced action", () => {
  it("includes the declared hydration read-action", () => {
    const s = ok({
      fields: [
        ...baseFields,
        { kind: "status-probe", label: "Status", actionId: "connectionStatus" },
      ],
      hydrateAction: "readConfig",
    });
    expect(collectActionIds(s).sort()).toEqual(["connectionStatus", "readConfig"]);
  });
});

describe("collectHydrationKeySets", () => {
  it("hydratable = exactly the non-secret value-carrying kinds, across flat fields AND tabs", () => {
    const s = ok({
      fields: [
        { kind: "text", key: "baseUrl", label: "Base URL" },
        { kind: "secret", key: "apiKey", label: "API key" },
        { kind: "select", key: "region", label: "Region", options: [{ value: "eu", label: "EU" }] },
        { kind: "dynamic-select-options", key: "model", label: "Model", optionsAction: "listModels" },
        { kind: "boolean", key: "streaming", label: "Streaming" },
        { kind: "number", key: "maxTokens", label: "Max tokens" },
        { kind: "free-list", key: "hosts", label: "Hosts" },
        { kind: "copyable-credential", key: "webhookUrl", label: "Webhook URL" },
        { kind: "named-action", label: "Save", actionId: "saveConnection" },
        { kind: "nango-connect", label: "Connect", providerConfigKey: "pk" },
      ],
      tabs: [
        {
          id: "advanced",
          label: "Advanced",
          fields: [
            { kind: "text", key: "orgId", label: "Org id" },
            { kind: "secret", key: "orgSecret", label: "Org secret" },
          ],
        },
      ],
      hydrateAction: "readConfig",
    });
    const { hydratableKeys, secretKeys } = collectHydrationKeySets(s);
    expect([...hydratableKeys].sort()).toEqual([
      "baseUrl",
      "hosts",
      "maxTokens",
      "model",
      "orgId",
      "region",
      "streaming",
      "webhookUrl",
    ]);
    expect([...secretKeys].sort()).toEqual(["apiKey", "orgSecret"]);
  });

  it("a repeatable-list key is NOT hydratable; its secret item keys ARE refused", () => {
    // Item keys live in a separate declared namespace, so a secret item key MAY
    // collide with a flat hydratable key — the colliding key must end up
    // secret-only (secret wins; the sanitizer then refuses it entirely).
    const s = ok({
      fields: [
        { kind: "text", key: "token", label: "Not actually a secret… allegedly" },
        {
          kind: "repeatable-list",
          key: "servers",
          label: "Servers",
          itemFields: [
            { kind: "text", key: "url", label: "URL" },
            { kind: "secret", key: "token", label: "Token" },
          ],
        },
      ],
    });
    const { hydratableKeys, secretKeys } = collectHydrationKeySets(s);
    expect(hydratableKeys.has("servers")).toBe(false);
    expect(hydratableKeys.has("token")).toBe(false); // secret-wins collision
    expect(secretKeys.has("token")).toBe(true);
  });
});
