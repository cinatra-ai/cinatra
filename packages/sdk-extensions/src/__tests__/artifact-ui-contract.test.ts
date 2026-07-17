// cinatra.artifact.ui v1 leaf schema + tolerant parse (cinatra#1621, epic #1620).
//
// This pins the CANONICAL v1 shape the two byte-mirrored strict manifest
// schemas import: valid v1, unknown/reserved-slot tolerance, port-request
// rejection, generated sdkAbiRange, entry containment, and the sanitized
// tolerant-parse degradation contract.
import { describe, it, expect } from "vitest";
import {
  ARTIFACT_UI_ABI_VERSION,
  ARTIFACT_UI_SLOTS,
  ARTIFACT_UI_RESERVED_SLOTS,
  ARTIFACT_UI_SDK_ABI_RANGE,
  generateArtifactUiSdkAbiRange,
  isContainedEntryPath,
  parseArtifactUi,
} from "../artifact-contract";
import { SDK_EXTENSIONS_ABI_VERSION } from "../register";

const validRenderer = (entry: string) => ({ entry, propsApiVersion: 1 });
const validUi = (renderers: Record<string, unknown>) => ({
  abiVersion: ARTIFACT_UI_ABI_VERSION,
  sdkAbiRange: ARTIFACT_UI_SDK_ABI_RANGE,
  renderers,
});

describe("artifact-ui v1 — constants", () => {
  it("the closed v1 slot enum is exactly {detail, preview, listRow}", () => {
    expect([...ARTIFACT_UI_SLOTS].sort()).toEqual(["detail", "listRow", "preview"]);
  });
  it("reserves card/inline for later waves (listRow activated by S7/M2)", () => {
    expect([...ARTIFACT_UI_RESERVED_SLOTS]).toEqual(["card", "inline"]);
    for (const reserved of ARTIFACT_UI_RESERVED_SLOTS) {
      expect((ARTIFACT_UI_SLOTS as readonly string[]).includes(reserved)).toBe(false);
    }
  });
  it("the ui ABI version is 1", () => {
    expect(ARTIFACT_UI_ABI_VERSION).toBe(1);
  });
});

describe("artifact-ui v1 — generated sdkAbiRange", () => {
  it("is a caret over the canonical SDK ABI (never hand-written)", () => {
    expect(generateArtifactUiSdkAbiRange("2.4.0")).toBe("^2.4.0");
    expect(generateArtifactUiSdkAbiRange("3.1.5")).toBe("^3.1.5");
  });
  it("ARTIFACT_UI_SDK_ABI_RANGE tracks the current canonical ABI", () => {
    expect(ARTIFACT_UI_SDK_ABI_RANGE).toBe(`^${SDK_EXTENSIONS_ABI_VERSION}`);
  });
  it("throws on an unparseable canonical version", () => {
    expect(() => generateArtifactUiSdkAbiRange("not-a-version")).toThrow();
  });
});

describe("artifact-ui v1 — entry containment", () => {
  it("accepts package-relative contained subpaths", () => {
    for (const ok of ["./src/renderers/detail.tsx", "./dist/preview.js", "./a-b/c.d.tsx"]) {
      expect(isContainedEntryPath(ok)).toBe(true);
    }
  });
  it("rejects traversal / absolute / URL / non-relative entries", () => {
    for (const bad of [
      "../evil.tsx",
      "./../evil.tsx",
      "./a/../b.tsx",
      "/abs/path.tsx",
      "src/no-dot-slash.tsx",
      "https://cdn.example.com/x.js",
      "file:./x.tsx",
      ".\\win\\path.tsx",
      "./",
      "",
    ]) {
      expect(isContainedEntryPath(bad), `should reject ${bad}`).toBe(false);
    }
  });
});

describe("parseArtifactUi — valid v1", () => {
  it("accepts detail + preview", () => {
    const r = parseArtifactUi(
      validUi({ detail: validRenderer("./src/detail.tsx"), preview: validRenderer("./src/preview.tsx") }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.keys(r.ui.renderers ?? {}).sort()).toEqual(["detail", "preview"]);
      expect(r.ui.abiVersion).toBe(1);
    }
  });
  it("accepts a non-empty PARTIAL map (detail only)", () => {
    const r = parseArtifactUi(validUi({ detail: validRenderer("./src/detail.tsx") }));
    expect(r.ok).toBe(true);
  });
  it("accepts an optional representations array", () => {
    const r = parseArtifactUi(
      validUi({ preview: { entry: "./src/preview.tsx", propsApiVersion: 2, representations: ["application/pdf", "image/*"] } }),
    );
    expect(r.ok).toBe(true);
  });
  it("ACCEPTS a well-formed, host-SATISFIABLE but non-canonical range (runtime tolerance; the exact generated pin is a publish-gate concern)", () => {
    // host ABI is 2.4.0; `^2.0.0` admits [2.0.0, 3.0.0) so the host satisfies it.
    // The extension-repo conformance gate is what pins it to the generated value;
    // this HOST-side verdict must stay forward-compatible.
    const r = parseArtifactUi({
      abiVersion: 1,
      sdkAbiRange: "^2.0.0",
      renderers: { detail: validRenderer("./src/detail.tsx") },
    });
    expect(r.ok).toBe(true);
  });
});

describe("parseArtifactUi — rejections (fail-closed verdict; degrades at boot)", () => {
  it("rejects an empty renderers map", () => {
    expect(parseArtifactUi(validUi({})).ok).toBe(false);
  });
  it("accepts the activated listRow slot (S7/M2)", () => {
    expect(parseArtifactUi(validUi({ listRow: validRenderer("./src/row.tsx") })).ok).toBe(true);
  });
  it("rejects a RESERVED slot (card) in v1", () => {
    expect(parseArtifactUi(validUi({ card: validRenderer("./src/card.tsx") })).ok).toBe(false);
  });
  it("rejects an unknown slot", () => {
    expect(parseArtifactUi(validUi({ sidebar: validRenderer("./src/x.tsx") })).ok).toBe(false);
  });
  it("REJECTS a renderer requesting host ports (v1 declares none)", () => {
    const r = parseArtifactUi(
      validUi({ detail: { entry: "./src/detail.tsx", propsApiVersion: 1, ports: ["settings"] } }),
    );
    expect(r.ok).toBe(false);
  });
  it("rejects a renderer with any extraneous field", () => {
    expect(
      parseArtifactUi(validUi({ detail: { entry: "./src/detail.tsx", propsApiVersion: 1, requestedHostPorts: [] } })).ok,
    ).toBe(false);
  });
  it("rejects the wrong ui abiVersion", () => {
    expect(parseArtifactUi({ ...validUi({ detail: validRenderer("./src/d.tsx") }), abiVersion: 2 }).ok).toBe(false);
  });
  it("rejects an uncontained entry", () => {
    expect(parseArtifactUi(validUi({ detail: validRenderer("../escape.tsx") })).ok).toBe(false);
  });
  it("rejects a non-integer / < 1 propsApiVersion", () => {
    expect(parseArtifactUi(validUi({ detail: { entry: "./src/d.tsx", propsApiVersion: 0 } })).ok).toBe(false);
    expect(parseArtifactUi(validUi({ detail: { entry: "./src/d.tsx", propsApiVersion: 1.5 } })).ok).toBe(false);
  });
  it("rejects an extra TOP-LEVEL ui key", () => {
    expect(
      parseArtifactUi({ ...validUi({ detail: validRenderer("./src/d.tsx") }), extra: true }).ok,
    ).toBe(false);
  });
  it("degrades a renderer built for an SDK ABI the host does not satisfy", () => {
    const r = parseArtifactUi({
      abiVersion: 1,
      sdkAbiRange: "^99.0.0",
      renderers: { detail: validRenderer("./src/d.tsx") },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostic).toMatch(/does not satisfy/);
  });
});

describe("parseArtifactUi — registryItems (cinatra#1623, S5)", () => {
  const item = (over: Record<string, unknown> = {}) => ({
    name: "stat-tile",
    entry: "./src/registry/stat-tile.tsx",
    type: "registry:ui",
    description: "A presentational KPI stat tile.",
    ...over,
  });
  const uiWith = (extra: Record<string, unknown>) => ({
    abiVersion: ARTIFACT_UI_ABI_VERSION,
    sdkAbiRange: ARTIFACT_UI_SDK_ABI_RANGE,
    ...extra,
  });

  it("accepts renderers + registryItems together", () => {
    const r = parseArtifactUi(
      uiWith({ renderers: { detail: validRenderer("./src/detail.tsx") }, registryItems: [item()] }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ui.registryItems?.[0]?.name).toBe("stat-tile");
      expect(r.ui.registryItems?.[0]?.type).toBe("registry:ui");
    }
  });

  it("accepts registryItems ONLY — no renderers (the optional-coupling relaxation)", () => {
    const r = parseArtifactUi(uiWith({ registryItems: [item(), item({ name: "meter", type: "registry:lib" })] }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ui.renderers).toBeUndefined();
  });

  it("REJECTS a ui block with NEITHER renderers nor registryItems", () => {
    expect(parseArtifactUi(uiWith({})).ok).toBe(false);
  });

  it("rejects an empty registryItems array", () => {
    expect(parseArtifactUi(uiWith({ registryItems: [] })).ok).toBe(false);
  });

  it("rejects a non-strict-lowercase component name", () => {
    expect(parseArtifactUi(uiWith({ registryItems: [item({ name: "StatTile" })] })).ok).toBe(false);
    expect(parseArtifactUi(uiWith({ registryItems: [item({ name: "-bad" })] })).ok).toBe(false);
  });

  it("rejects an unknown registry item type", () => {
    expect(parseArtifactUi(uiWith({ registryItems: [item({ type: "registry:page" })] })).ok).toBe(false);
  });

  it("rejects an uncontained item entry", () => {
    expect(parseArtifactUi(uiWith({ registryItems: [item({ entry: "../escape.tsx" })] })).ok).toBe(false);
  });

  it("rejects an empty description", () => {
    expect(parseArtifactUi(uiWith({ registryItems: [item({ description: "" })] })).ok).toBe(false);
  });

  it("rejects an extraneous item field (presentational-only DECLARATION surface)", () => {
    expect(parseArtifactUi(uiWith({ registryItems: [item({ dependencies: ["radix-ui"] })] })).ok).toBe(false);
  });

  it("rejects duplicate item names within a manifest", () => {
    expect(parseArtifactUi(uiWith({ registryItems: [item(), item()] })).ok).toBe(false);
  });
});

describe("parseArtifactUi — sanitized diagnostics", () => {
  it("never echoes a received value (only path + zod code)", () => {
    const secret = "SUPER-SECRET-SMUGGLED-STRING";
    const r = parseArtifactUi({
      abiVersion: 1,
      sdkAbiRange: ARTIFACT_UI_SDK_ABI_RANGE,
      renderers: { detail: { entry: secret, propsApiVersion: 1 } },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.diagnostic).not.toContain(secret);
      expect(r.diagnostic).toMatch(/cinatra\.artifact\.ui is invalid/);
    }
  });
  it("never throws on arbitrary garbage input", () => {
    for (const garbage of [null, undefined, 42, "str", [], { renderers: 1 }]) {
      expect(() => parseArtifactUi(garbage)).not.toThrow();
      expect(parseArtifactUi(garbage).ok).toBe(false);
    }
  });
});
