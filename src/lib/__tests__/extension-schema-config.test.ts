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

// cinatra#658 (PR-4): the EXTENDED DSL vocabulary (select / record-list / banner
// / advisory) + the fail-closed exact-key allowlist (no executable/HTML carrier).
describe("parseSchemaConfig — extended DSL (#658)", () => {
  it("parses select with admin-only options + a valid defaultValue", () => {
    const r = parseSchemaConfig({
      fields: [
        {
          kind: "select",
          key: "scope",
          label: "Scope",
          defaultValue: "user",
          options: [
            { value: "global", label: "Global", adminOnly: true },
            { value: "user", label: "Personal" },
          ],
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const f = r.surface.fields[0];
      expect(f.kind).toBe("select");
      if (f.kind === "select") {
        expect(f.options.find((o) => o.value === "global")?.adminOnly).toBe(true);
        expect(f.defaultValue).toBe("user");
      }
    }
  });

  it("rejects a select defaultValue not among its options + empty options", () => {
    expect(
      parseSchemaConfig({
        fields: [{ kind: "select", key: "s", label: "S", defaultValue: "nope", options: [{ value: "a", label: "A" }] }],
      }).ok,
    ).toBe(false);
    expect(parseSchemaConfig({ fields: [{ kind: "select", key: "s", label: "S", options: [] }] }).ok).toBe(false);
  });

  it("parses record-list with badges + list/delete action ids", () => {
    const r = parseSchemaConfig({
      fields: [
        {
          kind: "record-list",
          label: "Servers",
          listActionId: "listServers",
          deleteActionId: "deleteServer",
          emptyState: "None yet.",
          itemTitleKey: "label",
          itemSubtitleKey: "serverUrl",
          itemBadges: [
            { key: "privateUrl", label: "Private", variant: "destructive" },
            { key: "disabled", label: "Disabled", variant: "secondary" },
          ],
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(collectActionIds(r.surface).sort()).toEqual(["deleteServer", "listServers"]);
  });

  it("rejects an unknown badge variant", () => {
    expect(
      parseSchemaConfig({
        fields: [
          {
            kind: "record-list",
            label: "L",
            listActionId: "list",
            emptyState: "e",
            itemTitleKey: "t",
            itemBadges: [{ key: "k", label: "L", variant: "rainbow" }],
          },
        ],
      }).ok,
    ).toBe(false);
  });

  it("parses banner (result-driven variants) + advisory (probe) and collects the probe action", () => {
    const r = parseSchemaConfig({
      fields: [
        {
          kind: "banner",
          label: "Result",
          variants: [
            { name: "saved", tone: "success", message: "Saved." },
            { name: "error", tone: "destructive", message: "Failed." },
          ],
        },
        {
          kind: "advisory",
          label: "API key storage",
          tone: "info",
          probeActionId: "connectionServiceReady",
          whenReady: "Ready.",
          whenNotReady: "Not ready.",
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(collectActionIds(r.surface)).toContain("connectionServiceReady");
  });

  it("rejects an invalid banner tone + an advisory missing copy", () => {
    expect(
      parseSchemaConfig({
        fields: [{ kind: "banner", label: "B", variants: [{ name: "x", tone: "neon", message: "m" }] }],
      }).ok,
    ).toBe(false);
    expect(
      parseSchemaConfig({
        fields: [{ kind: "advisory", label: "A", tone: "info", probeActionId: "p", whenReady: "y" }],
      }).ok,
    ).toBe(false);
  });

  it("FAIL-CLOSED: rejects an unexpected/executable carrier key at a field", () => {
    // A smuggled onClick/html/script carrier on an otherwise-valid field MUST be
    // rejected (pure-data invariant 1) — not silently ignored.
    for (const evil of ["onClick", "html", "dangerouslySetInnerHTML", "script", "render"]) {
      const r = parseSchemaConfig({
        fields: [{ kind: "text", key: "t", label: "T", [evil]: "x = 1" }],
      });
      expect(r.ok, `key ${evil} must be rejected`).toBe(false);
    }
  });

  it("FAIL-CLOSED: rejects an unexpected key at the configSchema ROOT", () => {
    expect(parseSchemaConfig({ fields: [{ kind: "text", key: "t", label: "T" }], onLoad: "x" }).ok).toBe(false);
  });

  it("FAIL-CLOSED: rejects an unexpected key on a select option / record-list badge", () => {
    expect(
      parseSchemaConfig({
        fields: [{ kind: "select", key: "s", label: "S", options: [{ value: "a", label: "A", html: "<b>" }] }],
      }).ok,
    ).toBe(false);
    expect(
      parseSchemaConfig({
        fields: [
          {
            kind: "record-list",
            label: "L",
            listActionId: "list",
            emptyState: "e",
            itemTitleKey: "t",
            itemBadges: [{ key: "k", label: "L", variant: "outline", onClick: "x" }],
          },
        ],
      }).ok,
    ).toBe(false);
  });
});

// cinatra#782: the openai-blocking field-kind expansion — dynamic-select-options
// (action-sourced select), boolean (toggle), number (min/max/step), free-list
// (free-form string list). Fail-closed per kind.
describe("parseSchemaConfig — field-kind vocabulary expansion (#782)", () => {
  it("parses each new well-formed kind", () => {
    const r = parseSchemaConfig({
      fields: [
        { kind: "dynamic-select-options", key: "model", label: "Model", optionsAction: "listModels", defaultValue: "gpt-5.5" },
        { kind: "boolean", key: "allowNetwork", label: "Allow network", defaultValue: true },
        { kind: "number", key: "pids", label: "PID limit", min: 1, max: 4096, step: 1, defaultValue: 512 },
        { kind: "free-list", key: "hosts", label: "Egress hosts", itemLabel: "host" },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.surface.fields.map((f) => f.kind)).toEqual([
      "dynamic-select-options",
      "boolean",
      "number",
      "free-list",
    ]);
  });

  it("collectActionIds includes a dynamic-select-options optionsAction", () => {
    const r = parseSchemaConfig({
      fields: [{ kind: "dynamic-select-options", key: "m", label: "M", optionsAction: "listModels" }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(collectActionIds(r.surface)).toContain("listModels");
  });

  it("dynamic-select-options: rejects a missing / invalid optionsAction", () => {
    expect(parseSchemaConfig({ fields: [{ kind: "dynamic-select-options", key: "m", label: "M" }] }).ok).toBe(false);
    expect(
      parseSchemaConfig({ fields: [{ kind: "dynamic-select-options", key: "m", label: "M", optionsAction: "../etc" }] }).ok,
    ).toBe(false);
  });

  it("boolean: rejects a non-boolean defaultValue", () => {
    expect(parseSchemaConfig({ fields: [{ kind: "boolean", key: "b", label: "B", defaultValue: "yes" }] }).ok).toBe(false);
    // omitted defaultValue is fine
    expect(parseSchemaConfig({ fields: [{ kind: "boolean", key: "b", label: "B" }] }).ok).toBe(true);
  });

  it("number: rejects non-finite bounds, min>max, out-of-range default, step<=0", () => {
    expect(parseSchemaConfig({ fields: [{ kind: "number", key: "n", label: "N", min: "1" }] }).ok).toBe(false);
    expect(parseSchemaConfig({ fields: [{ kind: "number", key: "n", label: "N", max: Number.NaN }] }).ok).toBe(false);
    expect(parseSchemaConfig({ fields: [{ kind: "number", key: "n", label: "N", min: 10, max: 1 }] }).ok).toBe(false);
    expect(parseSchemaConfig({ fields: [{ kind: "number", key: "n", label: "N", min: 0, max: 5, defaultValue: 9 }] }).ok).toBe(false);
    expect(parseSchemaConfig({ fields: [{ kind: "number", key: "n", label: "N", step: 0 }] }).ok).toBe(false);
    expect(parseSchemaConfig({ fields: [{ kind: "number", key: "n", label: "N", step: -2 }] }).ok).toBe(false);
    // a well-formed number with all bounds passes
    expect(parseSchemaConfig({ fields: [{ kind: "number", key: "n", label: "N", min: 0, max: 10, step: 1, defaultValue: 5 }] }).ok).toBe(true);
  });

  it("free-list: requires key + label", () => {
    expect(parseSchemaConfig({ fields: [{ kind: "free-list", label: "L" }] }).ok).toBe(false);
    expect(parseSchemaConfig({ fields: [{ kind: "free-list", key: "l" }] }).ok).toBe(false);
    expect(parseSchemaConfig({ fields: [{ kind: "free-list", key: "l", label: "L" }] }).ok).toBe(true);
  });

  it("FAIL-CLOSED: rejects a smuggled carrier key on each new kind", () => {
    const evil = "onClick";
    for (const field of [
      { kind: "dynamic-select-options", key: "m", label: "M", optionsAction: "listModels", [evil]: "x" },
      { kind: "boolean", key: "b", label: "B", [evil]: "x" },
      { kind: "number", key: "n", label: "N", [evil]: "x" },
      { kind: "free-list", key: "l", label: "L", [evil]: "x" },
    ]) {
      expect(parseSchemaConfig({ fields: [field] }).ok, `${field.kind} must reject ${evil}`).toBe(false);
    }
  });
});
