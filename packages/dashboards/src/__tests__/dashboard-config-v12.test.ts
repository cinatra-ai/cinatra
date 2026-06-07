import { describe, it, expect } from "vitest";
import {
  validateDashboardConfigV12,
  type PortletKindLookup,
} from "../extension/dashboard-config-v12";

function cfg(portlets: unknown[]): unknown {
  return { apiVersion: "v1.2", scopeLevel: "project", portlets };
}

const fixedList = { instanceId: "list", kind: "object-list", version: "1.0.0", slot: "fixed", config: {}, outputs: ["selectedId"] };
const detail = {
  instanceId: "detail",
  kind: "object-detail",
  version: "1.0.0",
  slot: "fixed",
  config: {},
  inputs: { objectId: { fromInstanceId: "list", key: "selectedId" } },
};

describe("validateDashboardConfigV12 (DASH-02) — structural", () => {
  it("accepts a valid v1.2 config", () => {
    const r = validateDashboardConfigV12(cfg([fixedList, detail]));
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  it("rejects an unknown apiVersion", () => {
    const r = validateDashboardConfigV12({ apiVersion: "v1.1", scopeLevel: "project", portlets: [] });
    expect(r.ok).toBe(false);
  });

  it("rejects duplicate instanceIds", () => {
    const r = validateDashboardConfigV12(cfg([fixedList, { ...fixedList, kind: "object-detail" }]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => /duplicate portlet instanceId/.test(e))).toBe(true);
  });

  it("rejects an input bound to an unknown fromInstanceId", () => {
    const bad = { ...detail, inputs: { objectId: { fromInstanceId: "ghost", key: "selectedId" } } };
    const r = validateDashboardConfigV12(cfg([fixedList, bad]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => /unknown source instanceId/.test(e))).toBe(true);
  });

  it("rejects a fromDashboard field outside the enum", () => {
    const bad = { ...detail, inputs: { objectId: { fromDashboard: "bogusField" } } };
    const r = validateDashboardConfigV12(cfg([fixedList, bad]));
    expect(r.ok).toBe(false);
  });

  it("accepts a fromDashboard binding in the enum", () => {
    const ok = { ...detail, inputs: { objectId: { fromDashboard: "projectId" } } };
    const r = validateDashboardConfigV12(cfg([fixedList, ok]));
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  it("rejects ANY binding whose SOURCE portlet is optional-slot (fixed consumer too)", () => {
    const optionalSource = { ...fixedList, slot: "optional" };
    const fixedConsumer = { ...detail }; // fixed, consumes from the optional source
    const r = validateDashboardConfigV12(cfg([optionalSource, fixedConsumer]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => /binds an OPTIONAL source portlet/.test(e))).toBe(true);
  });
});

describe("validateDashboardConfigV12 (DASH-02) — with injected portlet registry", () => {
  const registry: PortletKindLookup = (kind, version) => {
    const table: Record<string, { inputKeys: string[]; outputKeys: string[] }> = {
      "object-list@1.0.0": { inputKeys: ["parentId"], outputKeys: ["selectedId"] },
      "object-detail@1.0.0": { inputKeys: ["objectId"], outputKeys: [] },
    };
    const hit = table[`${kind}@${version}`];
    return hit ? { kind, version, inputKeys: hit.inputKeys, outputKeys: hit.outputKeys } : undefined;
  };

  it("rejects an unknown kind/version", () => {
    const r = validateDashboardConfigV12(cfg([{ ...fixedList, version: "9.9.9" }]), { getPortletKind: registry });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => /unknown kind\/version/.test(e))).toBe(true);
  });

  it("rejects an undeclared input key", () => {
    const bad = { ...detail, inputs: { notAnInput: { fromInstanceId: "list", key: "selectedId" } } };
    const r = validateDashboardConfigV12(cfg([fixedList, bad]), { getPortletKind: registry });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => /binds undeclared input/.test(e))).toBe(true);
  });

  it("rejects an undeclared output key", () => {
    const bad = { ...fixedList, outputs: ["selectedId", "phantom"] };
    const r = validateDashboardConfigV12(cfg([bad, detail]), { getPortletKind: registry });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => /not emitted by kind/.test(e))).toBe(true);
  });

  it("accepts a fully-declared valid config against the registry", () => {
    const r = validateDashboardConfigV12(cfg([fixedList, detail]), { getPortletKind: registry });
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });
});
