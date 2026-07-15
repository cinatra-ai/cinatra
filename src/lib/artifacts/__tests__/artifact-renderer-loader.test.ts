/**
 * Failure-isolated renderer loader (cinatra#1629, epic #1620 S2, AC-4 pre-render
 * half). Every pre-render failure class degrades deterministically; a present-
 * but-broken module rethrows (route-segment boundary); repeat failures quarantine.
 * Only the resolved key's loader executes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// A branded degraded-load result the real `isDegradedExtensionLoad` recognizes
// (Symbol.for brand — survives across module instances).
const DEGRADED_BRAND = Symbol.for("cinatra.extension-load-guard.degraded");
const degradedResult = Object.freeze({
  [DEGRADED_BRAND]: true,
  status: "absent",
  specifier: "@fixture/absent/detail",
  packageName: "@fixture/absent",
  reason: "module not found",
});

// Track which loaders were INVOKED — proves "only the resolved module executes".
const invoked: string[] = [];
function trackedLoad(key: string, impl: () => Promise<unknown>) {
  return async () => {
    invoked.push(key);
    return impl();
  };
}

const OkComponent = () => null;

vi.mock("@/lib/generated/artifact-renderers", () => ({
  GENERATED_ARTIFACT_RENDERERS: {
    "@fixture/ok::detail": {
      resolution: "guardedOptional",
      packageName: "@fixture/ok",
      slot: "detail",
      representations: [],
      propsApiVersion: 1,
      load: trackedLoad("@fixture/ok::detail", async () => ({ default: OkComponent })),
    },
    "@fixture/absent::detail": {
      resolution: "guardedOptional",
      packageName: "@fixture/absent",
      slot: "detail",
      representations: [],
      propsApiVersion: 1,
      load: trackedLoad("@fixture/absent::detail", async () => degradedResult),
    },
    "@fixture/no-export::detail": {
      resolution: "guardedOptional",
      packageName: "@fixture/no-export",
      slot: "detail",
      representations: [],
      propsApiVersion: 1,
      load: trackedLoad("@fixture/no-export::detail", async () => ({ notDefault: 1 })),
    },
    "@fixture/abi::detail": {
      resolution: "guardedOptional",
      packageName: "@fixture/abi",
      slot: "detail",
      representations: [],
      propsApiVersion: 2,
      load: trackedLoad("@fixture/abi::detail", async () => ({ default: OkComponent })),
    },
    "@fixture/broken::detail": {
      resolution: "guardedOptional",
      packageName: "@fixture/broken",
      slot: "detail",
      representations: [],
      propsApiVersion: 1,
      load: trackedLoad("@fixture/broken::detail", async () => {
        throw new Error("top-level boom");
      }),
    },
  },
}));

import {
  loadArtifactRenderer,
  isArtifactRendererQuarantined,
  _resetArtifactRendererQuarantineForTests,
  artifactRendererDiagnostic,
  ARTIFACT_RENDERER_QUARANTINE_THRESHOLD,
} from "@/lib/artifacts/artifact-renderer-loader";

afterEach(() => {
  _resetArtifactRendererQuarantineForTests();
  invoked.length = 0;
  vi.restoreAllMocks();
});

const base = { slot: "detail" as const, expectedPropsApiVersion: 1 };

describe("loadArtifactRenderer — success", () => {
  it("returns the component for a valid built renderer, invoking ONLY that loader", async () => {
    const r = await loadArtifactRenderer({ generatedKey: "@fixture/ok::detail", packageName: "@fixture/ok", ...base });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.Component).toBe(OkComponent);
    expect(invoked).toEqual(["@fixture/ok::detail"]);
  });
});

describe("loadArtifactRenderer — deterministic pre-render degrades", () => {
  it("not-built when the key is absent from the build", async () => {
    const r = await loadArtifactRenderer({ generatedKey: "@fixture/missing::detail", packageName: "@fixture/missing", ...base });
    expect(r).toEqual({ ok: false, failureClass: "not-built" });
    expect(invoked).toEqual([]); // no loader executed
  });

  it("absent when the guarded loader resolved the degraded result", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await loadArtifactRenderer({ generatedKey: "@fixture/absent::detail", packageName: "@fixture/absent", ...base });
    expect(r).toEqual({ ok: false, failureClass: "absent" });
  });

  it("invalid-export when the module ships no component default", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await loadArtifactRenderer({ generatedKey: "@fixture/no-export::detail", packageName: "@fixture/no-export", ...base });
    expect(r).toEqual({ ok: false, failureClass: "invalid-export" });
  });

  it("abi-incompatible when the build entry's propsApiVersion differs — WITHOUT executing the loader", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await loadArtifactRenderer({ generatedKey: "@fixture/abi::detail", packageName: "@fixture/abi", ...base });
    expect(r).toEqual({ ok: false, failureClass: "abi-incompatible" });
    expect(invoked).toEqual([]); // deterministic, no module executed
  });
});

describe("loadArtifactRenderer — present-but-broken rethrows (route-segment boundary)", () => {
  it("rethrows a top-level module throw rather than degrading", async () => {
    await expect(
      loadArtifactRenderer({ generatedKey: "@fixture/broken::detail", packageName: "@fixture/broken", ...base }),
    ).rejects.toThrow(/top-level boom/);
  });
});

describe("loadArtifactRenderer — quarantine on repeat failure", () => {
  it("quarantines a persistently-throwing renderer after the threshold, then degrades instead of throwing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const key = "@fixture/broken::detail";
    for (let i = 0; i < ARTIFACT_RENDERER_QUARANTINE_THRESHOLD; i++) {
      await expect(
        loadArtifactRenderer({ generatedKey: key, packageName: "@fixture/broken", ...base }),
      ).rejects.toThrow();
    }
    expect(isArtifactRendererQuarantined(key)).toBe(true);
    // Now the loader returns quarantined WITHOUT invoking the throwing module.
    invoked.length = 0;
    const r = await loadArtifactRenderer({ generatedKey: key, packageName: "@fixture/broken", ...base });
    expect(r).toEqual({ ok: false, failureClass: "quarantined" });
    expect(invoked).toEqual([]);
  });
});

describe("artifactRendererDiagnostic", () => {
  it("is sanitized — package + slot + failure class only, no raw error", () => {
    const d = artifactRendererDiagnostic("@fixture/x", "detail", "absent");
    expect(d).toContain("@fixture/x");
    expect(d).toContain("detail");
    expect(d).toContain("absent");
    expect(d).not.toContain("boom");
  });
});
