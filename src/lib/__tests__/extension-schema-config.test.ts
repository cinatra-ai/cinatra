import { describe, it, expect } from "vitest";
import { parseSchemaConfig, collectActionIds, requiresRebuildState } from "@/lib/extension-schema-config";

describe("parseSchemaConfig (the schema-config vocabulary)", () => {
  it("parses the full primitive vocabulary", () => {
    const r = parseSchemaConfig({
      title: "Setup",
      fields: [
        { kind: "text", key: "site", label: "Site URL", required: true },
        { kind: "secret", key: "token", label: "API token" },
        { kind: "nango-connect", label: "Connect", providerConfigKey: "wordpress" },
        { kind: "status-probe", label: "Connection", actionId: "probe" },
        { kind: "copyable-credential", key: "widgetKey", label: "Widget key" },
        { kind: "named-action", label: "Refresh", actionId: "refresh", confirm: "Sure?" },
        { kind: "repeatable-list", key: "feeds", label: "Feeds", itemFields: [{ kind: "text", key: "url", label: "URL" }] },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.surface.fields).toHaveLength(7);
  });

  it("fails closed on a non-object / empty fields", () => {
    expect(parseSchemaConfig(null).ok).toBe(false);
    expect(parseSchemaConfig({ fields: [] }).ok).toBe(false);
    expect(parseSchemaConfig({}).ok).toBe(false);
  });

  it("rejects an unknown field kind", () => {
    const r = parseSchemaConfig({ fields: [{ kind: "wysiwyg", key: "x", label: "X" }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/unknown field kind/);
  });

  it("rejects duplicate + invalid keys", () => {
    const dup = parseSchemaConfig({ fields: [{ kind: "text", key: "a", label: "A" }, { kind: "text", key: "a", label: "A2" }] });
    expect(dup.ok).toBe(false);
    const bad = parseSchemaConfig({ fields: [{ kind: "text", key: "1bad", label: "B" }] });
    expect(bad.ok).toBe(false);
  });

  it("requires providerConfigKey / actionId", () => {
    expect(parseSchemaConfig({ fields: [{ kind: "nango-connect", label: "C" }] }).ok).toBe(false);
    expect(parseSchemaConfig({ fields: [{ kind: "status-probe", label: "S" }] }).ok).toBe(false);
    expect(parseSchemaConfig({ fields: [{ kind: "named-action", label: "A", actionId: "bad id!" }] }).ok).toBe(false);
  });

  it("validates repeatable-list item fields (flat text/secret only)", () => {
    const nested = parseSchemaConfig({
      fields: [{ kind: "repeatable-list", key: "l", label: "L", itemFields: [{ kind: "repeatable-list", key: "n", label: "N", itemFields: [] }] }],
    });
    expect(nested.ok).toBe(false);
  });

  it("collectActionIds returns referenced action ids", () => {
    const r = parseSchemaConfig({
      fields: [
        { kind: "status-probe", label: "S", actionId: "probe" },
        { kind: "named-action", label: "A", actionId: "refresh" },
        { kind: "text", key: "t", label: "T" },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(collectActionIds(r.surface).sort()).toEqual(["probe", "refresh"]);
  });
});

describe("requiresRebuildState", () => {
  it("produces a clear bundled-react requires-rebuild state", () => {
    const s = requiresRebuildState("@cinatra-ai/foo");
    expect(s.requiresRebuild).toBe(true);
    expect(s.uiSurface).toBe("bundled-react");
    expect(s.message).toMatch(/rebuild/i);
  });
});
