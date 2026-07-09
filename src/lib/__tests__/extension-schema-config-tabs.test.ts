import { describe, it, expect } from "vitest";
import {
  parseSchemaConfig,
  collectActionIds,
  HELP_TAB_ID,
  type SchemaConfigSurface,
} from "@/lib/extension-schema-config";

// The generic, connector-agnostic tab/section grouping primitive for the
// schema-config setup surface (design spec: app-connectors §II — tabbed setup
// page, reserved Help tab always last). PURE DATA + fail-closed, so the parser
// is the security boundary: unknown keys are rejected before the renderer sees
// the surface, and a reserved Help tab is normalized to LAST.

function ok(raw: unknown): SchemaConfigSurface {
  const r = parseSchemaConfig(raw);
  if (!r.ok) throw new Error(`expected ok, got errors: ${r.errors.join("; ")}`);
  return r.surface;
}
function errs(raw: unknown): string[] {
  const r = parseSchemaConfig(raw);
  if (r.ok) throw new Error("expected parse to fail");
  return r.errors;
}

const baseFields = [{ kind: "secret", key: "apiKey", label: "API key", required: true }];

describe("schema-config tabs vocabulary — back-compat", () => {
  it("no `tabs` key → flat surface (tabs undefined)", () => {
    const s = ok({ fields: baseFields });
    expect(s.tabs).toBeUndefined();
    expect(s.fields).toHaveLength(1);
  });

  it("empty `tabs: []` → treated as absent (flat)", () => {
    const s = ok({ fields: baseFields, tabs: [] });
    expect(s.tabs).toBeUndefined();
  });
});

describe("schema-config tabs vocabulary — accept + normalize", () => {
  it("accepts declared tabs and keeps the base fields as the Setup content", () => {
    const s = ok({
      fields: baseFields,
      tabs: [
        {
          id: "shell",
          label: "Local shell",
          fields: [{ kind: "boolean", key: "shellEnabled", label: "Enable sandboxed shell" }],
        },
      ],
    });
    expect(s.fields).toHaveLength(1);
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs![0]).toMatchObject({ id: "shell", label: "Local shell" });
    expect(s.tabs![0].fields[0]).toMatchObject({ kind: "boolean", key: "shellEnabled" });
  });

  it("orders the reserved Help tab LAST regardless of declared position", () => {
    const s = ok({
      fields: baseFields,
      tabs: [
        { id: HELP_TAB_ID, label: "Help", fields: [{ kind: "advisory", label: "How-to", tone: "info", probeActionId: "ready", whenReady: "y", whenNotReady: "n" }] },
        { id: "shell", label: "Local shell", fields: [{ kind: "boolean", key: "shellEnabled", label: "Enable" }] },
        { id: "webhooks", label: "Webhooks", fields: [{ kind: "text", key: "hookUrl", label: "URL" }] },
      ],
    });
    expect(s.tabs!.map((t) => t.id)).toEqual(["shell", "webhooks", HELP_TAB_ID]);
  });

  it("preserves non-Help declared order (stable sort)", () => {
    const s = ok({
      fields: baseFields,
      tabs: [
        { id: "b", label: "B", fields: [{ kind: "text", key: "kb", label: "B" }] },
        { id: "a", label: "A", fields: [{ kind: "text", key: "ka", label: "A" }] },
      ],
    });
    expect(s.tabs!.map((t) => t.id)).toEqual(["b", "a"]);
  });
});

describe("schema-config tabs vocabulary — fail-closed", () => {
  it("rejects a non-array `tabs`", () => {
    expect(errs({ fields: baseFields, tabs: {} }).join(" ")).toMatch(/tabs must be an array/);
  });

  it("rejects an unknown key on a tab (no executable/HTML carrier)", () => {
    expect(
      errs({
        fields: baseFields,
        tabs: [{ id: "x", label: "X", fields: [{ kind: "text", key: "k", label: "L" }], onClick: "alert(1)" }],
      }).join(" "),
    ).toMatch(/unexpected key "onClick"/);
  });

  it("rejects duplicate tab ids", () => {
    expect(
      errs({
        fields: baseFields,
        tabs: [
          { id: "dup", label: "One", fields: [{ kind: "text", key: "k1", label: "L" }] },
          { id: "dup", label: "Two", fields: [{ kind: "text", key: "k2", label: "L" }] },
        ],
      }).join(" "),
    ).toMatch(/duplicate tab id "dup"/);
  });

  it("rejects a field key duplicated across the base fields and a tab", () => {
    expect(
      errs({
        fields: [{ kind: "text", key: "shared", label: "Base" }],
        tabs: [{ id: "t", label: "T", fields: [{ kind: "text", key: "shared", label: "Tab" }] }],
      }).join(" "),
    ).toMatch(/duplicate key "shared"/);
  });

  it("rejects an invalid tab id, a missing label, and an empty fields array", () => {
    expect(errs({ fields: baseFields, tabs: [{ id: "1bad", label: "X", fields: [{ kind: "text", key: "k", label: "L" }] }] }).join(" ")).toMatch(/invalid or missing "id"/);
    expect(errs({ fields: baseFields, tabs: [{ id: "t", fields: [{ kind: "text", key: "k", label: "L" }] }] }).join(" ")).toMatch(/missing "label"/);
    expect(errs({ fields: baseFields, tabs: [{ id: "t", label: "T", fields: [] }] }).join(" ")).toMatch(/non-empty "fields"/);
  });

  it("a connector tab id can never be the reserved internal `__setup` value", () => {
    // KEY_RE requires a leading letter, so `__setup` fails id validation — the
    // Setup tab value can never collide with a declared tab.
    expect(errs({ fields: baseFields, tabs: [{ id: "__setup", label: "X", fields: [{ kind: "text", key: "k", label: "L" }] }] }).join(" ")).toMatch(/invalid or missing "id"/);
  });

  it("fails closed on an unknown field kind / carrier key INSIDE a tab", () => {
    expect(errs({ fields: baseFields, tabs: [{ id: "t", label: "T", fields: [{ kind: "iframe", key: "k", label: "L" }] }] }).join(" ")).toMatch(/unknown field kind/);
    expect(errs({ fields: baseFields, tabs: [{ id: "t", label: "T", fields: [{ kind: "text", key: "k", label: "L", html: "<b>" }] }] }).join(" ")).toMatch(/unexpected key "html"/);
  });
});

describe("schema-config tabs vocabulary — action-id collection", () => {
  it("collectActionIds walks tab fields too (else the host endpoint rejects tab actions)", () => {
    const s = ok({
      fields: [{ kind: "named-action", label: "Save", actionId: "saveBase" }],
      tabs: [
        {
          id: "shell",
          label: "Local shell",
          fields: [
            { kind: "status-probe", label: "Ready", actionId: "probeShell" },
            { kind: "record-list", label: "Rows", listActionId: "listRows", deleteActionId: "deleteRow", emptyState: "none", itemTitleKey: "name", itemBadges: [] },
          ],
        },
      ],
    });
    const ids = collectActionIds(s).sort();
    expect(ids).toEqual(["deleteRow", "listRows", "probeShell", "saveBase"].sort());
  });
});
