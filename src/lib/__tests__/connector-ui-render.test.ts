import { describe, it, expect } from "vitest";
import { chooseConnectorUiRender } from "@/lib/connector-ui-render";

const VALID_SCHEMA = {
  title: "Test",
  fields: [{ kind: "text", key: "host", label: "Host" }],
};

describe("chooseConnectorUiRender", () => {
  it("renders schema-config from a valid declared configSchema (no React import)", () => {
    const d = chooseConnectorUiRender({ uiSurface: "schema-config", configSchema: VALID_SCHEMA });
    expect(d.kind).toBe("schema-config");
    if (d.kind === "schema-config") {
      expect(d.surface.fields).toHaveLength(1);
      expect(d.surface.fields[0]).toMatchObject({ kind: "text", key: "host" });
    }
  });

  it("fails closed (invalid-schema-config) when configSchema is missing — never falls back to bundled-react", () => {
    const d = chooseConnectorUiRender({ uiSurface: "schema-config", configSchema: null });
    expect(d.kind).toBe("invalid-schema-config");
    if (d.kind === "invalid-schema-config") expect(d.errors.length).toBeGreaterThan(0);
  });

  it("fails closed (invalid-schema-config) when configSchema is malformed", () => {
    const d = chooseConnectorUiRender({ uiSurface: "schema-config", configSchema: { fields: [] } });
    expect(d.kind).toBe("invalid-schema-config");
    if (d.kind === "invalid-schema-config") expect(d.errors.length).toBeGreaterThan(0);
  });

  it("keeps the legacy bundled-react dispatch path for declared bundled-react", () => {
    expect(chooseConnectorUiRender({ uiSurface: "bundled-react" }).kind).toBe("bundled-react");
  });

  it("keeps bundled-react for a legacy null/absent uiSurface", () => {
    expect(chooseConnectorUiRender({ uiSurface: null }).kind).toBe("bundled-react");
    expect(chooseConnectorUiRender(null).kind).toBe("bundled-react");
    expect(chooseConnectorUiRender(undefined).kind).toBe("bundled-react");
    expect(chooseConnectorUiRender({}).kind).toBe("bundled-react");
  });
});
