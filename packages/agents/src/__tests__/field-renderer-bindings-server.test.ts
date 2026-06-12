// Installed-package binding collector (cinatra#151 Stage 5 — SOURCE B) pins.
//
// The collector enumerates <agentInstallDir>/<scope>/<name>/package.json,
// applies the SHARED validator skip-warn, merges with first-declarer-wins,
// and feeds: the runtime server action, the A2UI translator resolver, and
// kind-based ID lookups. Fixture-driven — no real DB (agent-install-path is
// mocked to a temp tree).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let FIXTURE_DIR = "";

vi.mock("../agent-install-path", () => ({
  resolveAgentInstallDir: () => {
    if (!FIXTURE_DIR) throw new Error("fixture dir unset");
    return FIXTURE_DIR;
  },
}));

import {
  collectInstalledFieldRendererBindings,
  getMergedFieldRendererBindings,
  resolveRendererIdForKind,
  buildA2UiMidRunTranslatorResolver,
  __clearInstalledFieldRendererBindingsCache,
} from "../field-renderer-bindings.server";
import { GENERATED_FIELD_RENDERER_BINDINGS } from "@/lib/generated/agent-bindings";
import { A2UI_MID_RUN_TRANSLATOR_KINDS } from "@cinatra-ai/agent-ui-protocol/server";

function writePkg(scope: string, name: string, pkg: Record<string, unknown>) {
  const dir = join(FIXTURE_DIR, scope, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
}

beforeEach(() => {
  FIXTURE_DIR = mkdtempSync(join(tmpdir(), "frb-fixture-"));
  __clearInstalledFieldRendererBindingsCache();
});

afterEach(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
  FIXTURE_DIR = "";
  __clearInstalledFieldRendererBindingsCache();
});

describe("collectInstalledFieldRendererBindings", () => {
  it("collects validated declarations from materialized packages", () => {
    writePkg("custom-scope", "future-agent", {
      name: "@custom-scope/future-agent",
      cinatra: {
        fieldRenderers: [
          { id: "@custom-scope/future-agent:gate", kind: "cta", priority: 70 },
        ],
      },
    });
    const entries = collectInstalledFieldRendererBindings();
    expect(entries).toEqual([
      {
        id: "@custom-scope/future-agent:gate",
        kind: "cta",
        priority: 70,
        declaredBy: "@custom-scope/future-agent",
      },
    ]);
  });

  it("SKIP-WARNs invalid runtime declarations (hostile data cannot break the host)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writePkg("s", "bad-agent", {
      name: "@s/bad-agent",
      cinatra: {
        fieldRenderers: [
          { id: "not-namespaced", kind: "cta", priority: 70 },
          { id: "@s/bad-agent:ok", kind: "no-such-kind", priority: 70 },
          { id: "@s/bad-agent:fine", kind: "cta", priority: 70 },
        ],
      },
    });
    const entries = collectInstalledFieldRendererBindings();
    expect(entries.map((e) => e.id)).toEqual(["@s/bad-agent:fine"]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns [] when the install dir is unreadable (normal degraded state)", () => {
    rmSync(FIXTURE_DIR, { recursive: true, force: true });
    expect(collectInstalledFieldRendererBindings()).toEqual([]);
  });

  it("first-declarer-wins among DIVERGENT runtime duplicates is ALPHABETICAL (sorted traversal), never filesystem-order", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Write the alphabetically-LATER package first so insertion order would
    // pick the wrong winner if traversal were unsorted.
    writePkg("s", "zz-agent", {
      name: "@s/zz-agent",
      cinatra: { fieldRenderers: [{ id: "@s/shared:gate", kind: "cta", priority: 10 }] },
    });
    writePkg("s", "aa-agent", {
      name: "@s/aa-agent",
      cinatra: { fieldRenderers: [{ id: "@s/shared:gate", kind: "cta", priority: 90 }] },
    });
    const entries = collectInstalledFieldRendererBindings();
    const hit = entries.filter((e) => e.id === "@s/shared:gate");
    expect(hit).toHaveLength(1);
    expect(hit[0].declaredBy).toBe("@s/aa-agent");
    expect(hit[0].priority).toBe(90);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("conflicting declarations"),
    );
    warn.mockRestore();
  });

  it("caches within the TTL and refreshes after the cache is cleared", () => {
    expect(collectInstalledFieldRendererBindings()).toEqual([]);
    writePkg("s", "late-agent", {
      name: "@s/late-agent",
      cinatra: { fieldRenderers: [{ id: "@s/late-agent:g", kind: "cta", priority: 70 }] },
    });
    expect(collectInstalledFieldRendererBindings()).toEqual([]); // cached
    __clearInstalledFieldRendererBindingsCache();
    expect(collectInstalledFieldRendererBindings()).toHaveLength(1);
  });
});

describe("getMergedFieldRendererBindings — generated precedence", () => {
  it("a runtime duplicate of a generated id never shadows the generated entry, and a DIVERGENT one is warned naming both declarers", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const generated = GENERATED_FIELD_RENDERER_BINDINGS[0];
    writePkg("s", "shadow-agent", {
      name: "@s/shadow-agent",
      cinatra: {
        fieldRenderers: [{ id: generated.id, kind: "cta", priority: 1 }],
      },
    });
    const merged = getMergedFieldRendererBindings();
    const hit = merged.filter((b) => b.id === generated.id);
    expect(hit).toHaveLength(1);
    expect(hit[0].kind).toBe(generated.kind);
    expect(hit[0].priority).toBe(generated.priority);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("@s/shadow-agent"),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(generated.declaredBy),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("the generated binding wins"),
    );
    warn.mockRestore();
  });
});

describe("resolveRendererIdForKind", () => {
  it("resolves the reviewer-output gate id from the generated bindings", () => {
    expect(resolveRendererIdForKind("reviewer-output")).toBe("@cinatra-ai/reviewer-agent:output");
  });

  it("returns undefined for a kind no present/installed package binds", () => {
    expect(resolveRendererIdForKind("kind-nobody-binds")).toBeUndefined();
  });
});

describe("buildA2UiMidRunTranslatorResolver", () => {
  it("maps the four email :output gates to their translator kinds", () => {
    const resolve = buildA2UiMidRunTranslatorResolver();
    expect(resolve("@cinatra-ai/email-recipient-selection-agent:output")).toBe(
      A2UI_MID_RUN_TRANSLATOR_KINDS["recipients-output"],
    );
    expect(resolve("@cinatra-ai/email-drafting-agent:output")).toBe(
      A2UI_MID_RUN_TRANSLATOR_KINDS["drafts-output"],
    );
    expect(resolve("@cinatra-ai/email-follow-up-agent:output")).toBe(
      A2UI_MID_RUN_TRANSLATOR_KINDS["followups-output"],
    );
    expect(resolve("@cinatra-ai/email-delivery-agent:output")).toBe(
      A2UI_MID_RUN_TRANSLATOR_KINDS["send-output"],
    );
  });

  it("returns undefined for ids without an a2uiTranslator binding", () => {
    const resolve = buildA2UiMidRunTranslatorResolver();
    expect(resolve("@cinatra-ai/reviewer-agent:output")).toBeUndefined();
    expect(resolve("@cinatra-ai/agent-builder:grouped-setup-form")).toBeUndefined();
  });
});
