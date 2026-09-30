// connector-artifact-road-gate tests (cinatra#3821).
//
// Class 6: a road from a module that faces connectors (the connector handler, a
// capability the application publishes to connectors) to a module that creates
// an artifact. Written red first:
//   T-B1 acceptance case two, the application side: a connector sends an
//        artifact's content with its staged change and the application's
//        capability creates the artifact from it;
//   T-B2 a capability that reaches its work through a globalThis slot;
//   T-B3 the declaration of every published capability;
//   T-B4 the floor mechanics and the edge rule;
//   T-B5 the test of record over the real tree — this file runs in the root
//        suite on every pull request, so the floor is held there.
//
// Fixture trees live under a temporary directory and use an owner outside the
// organisation's shape (`@example-org/...`); they are removed after the suite.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MAX_EDGES,
  CONNECTOR_HANDLER_MODULE,
  SDK_ROADS_MODULE,
  scanConnectorArtifactRoads,
  declarationProblems,
  removedByProblems,
  roadCounts,
  diffGrown,
  diffShrunk,
  readSdkCreatingRoads,
  sdkRoadsProblems,
  readHostProviderIdentities,
  baseRefProblem,
  baseRoadGrowth,
  RoadScannerError,
} from "../connector-artifact-road-gate.mjs";
import { discoverExtensionDirs } from "../extension-produces-deps-gate.mjs";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const BASELINE_PATH = join(import.meta.dirname, "..", "connector-artifact-road-gate.baseline.json");

const HOST = "@example-org/host";
const REVIEW = "@example-org/host:example-review";
const VOCABULARY = {
  ids: new Map([["@example-org/widget:card", "@example-org/widget-artifacts"]]),
  namespaces: new Map([["@example-org/widget", ["@example-org/widget-artifacts"]]]),
};

const roots = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const WITNESS = {
  "src/lib/artifacts/artifact-writer-witness.ts":
    "export function buildWitnessOp(schema: string) { return { schema }; }\nexport function witnessExistsSql() { return ''; }\n",
};

function makeTree(files) {
  const root = mkdtempSync(join(tmpdir(), "connector-artifact-road-gate-"));
  roots.push(root);
  for (const [rel, text] of Object.entries({ ...WITNESS, ...files })) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

function scan(files, capabilities = {}) {
  return scanConnectorArtifactRoads(makeTree(files), { hostIdentities: [HOST], vocabulary: VOCABULARY, capabilities });
}

// The application publishes a review capability; its member takes the content a
// connector sent with its staged change and writes an artifact-typed row from it.
const CASE_TWO = {
  "src/lib/register-example-review.ts": [
    `import { registerCapabilityProvider } from "@/lib/extension-capabilities-registry";`,
    `import { captureStagedWrite } from "@/lib/example-review-capture";`,
    `const HOST_PROVIDER = "${HOST}";`,
    `registerCapabilityProvider("${REVIEW}", { packageName: HOST_PROVIDER, impl: { captureStagedWrite } });`,
    "",
  ].join("\n"),
  "src/lib/example-review-capture.ts": [
    `import { saveObject } from "@/lib/example-objects";`,
    `export async function captureStagedWrite(input: { content: unknown }) {`,
    `  return saveObject({ typeHint: "@example-org/widget:card", rawData: input.content });`,
    `}`,
    "",
  ].join("\n"),
  "src/lib/example-objects.ts": `export async function saveObject(row: unknown) { return row; }\n`,
  "src/lib/extension-capabilities-registry.ts": `export function registerCapabilityProvider(id: string, p: unknown) { return [id, p]; }\n`,
};
const CASE_TWO_ROAD = `${REVIEW} :: src/lib/example-review-capture.ts`;

describe("T-B1 class 6 — a connector's staged change makes the application create an artifact (acceptance case two)", () => {
  it("the reach finds the road; declared false, the check refuses it", () => {
    const live = scan(CASE_TWO, { [REVIEW]: { createsArtifact: false } });
    expect(Object.keys(live.roads)).toEqual([CASE_TWO_ROAD]);
    expect(diffGrown({}, roadCounts(live))).toEqual([`${CASE_TWO_ROAD} (0 -> 1)`]);
    expect(declarationProblems(live, { [REVIEW]: { createsArtifact: false } }).join("\n")).toMatch(
      /createsArtifact false disagrees with the reach/,
    );
  });

  it("declared true with the road on the floor, the check passes", () => {
    const capabilities = { [REVIEW]: { createsArtifact: true } };
    const live = scan(CASE_TWO, capabilities);
    expect(declarationProblems(live, capabilities)).toEqual([]);
    expect(diffGrown({ [CASE_TWO_ROAD]: 1 }, roadCounts(live))).toEqual([]);
    expect(diffShrunk({ [CASE_TWO_ROAD]: 1 }, roadCounts(live))).toEqual([]);
  });

  it("a capability published under another provider identity is not the application's", () => {
    const files = {
      ...CASE_TWO,
      "src/lib/register-example-review.ts": CASE_TWO["src/lib/register-example-review.ts"].replace(
        "packageName: HOST_PROVIDER",
        `packageName: "@example-org/some-connector"`,
      ),
    };
    const live = scan(files);
    expect(live.published.size).toBe(0);
    expect(live.roads).toEqual({});
  });

  it("a builder of the writer witness is the other creating form", () => {
    const files = {
      ...CASE_TWO,
      "src/lib/example-review-capture.ts": [
        `import { buildWitnessOp } from "./artifacts/artifact-writer-witness";`,
        `export async function captureStagedWrite(input: { content: unknown }) { return [buildWitnessOp("s"), input]; }`,
        "",
      ].join("\n"),
    };
    const live = scan(files, { [REVIEW]: { createsArtifact: true } });
    expect(Object.keys(live.roads)).toEqual([CASE_TWO_ROAD]);
    expect(live.creatingModules).toContain("src/lib/example-review-capture.ts");
  });

  it("a builder re-exported through another module is still a builder", () => {
    const files = {
      ...CASE_TWO,
      "src/lib/example-witness-reexport.ts": `export { buildWitnessOp as buildOp } from "./artifacts/artifact-writer-witness";\n`,
      "src/lib/example-review-capture.ts": [
        `import { buildOp } from "./example-witness-reexport";`,
        `export async function captureStagedWrite(input: { content: unknown }) { return [buildOp("s"), input]; }`,
        "",
      ].join("\n"),
    };
    const live = scan(files, { [REVIEW]: { createsArtifact: true } });
    expect(Object.keys(live.roads)).toEqual([CASE_TWO_ROAD]);
    expect(live.creatingModules).toContain("src/lib/example-review-capture.ts");
    expect(live.creatingModules).not.toContain("src/lib/example-witness-reexport.ts");
  });
});

describe("T-B2 the slot — a capability that reaches its work through a globalThis slot", () => {
  const files = {
    "src/lib/register-example-slot.ts": [
      `import { registerCapabilityProvider } from "@/lib/extension-capabilities-registry";`,
      `const requireSeam = () => {`,
      `  const seam = (globalThis as { __exampleSeam?: { run(i: unknown): unknown } }).__exampleSeam;`,
      `  if (!seam) throw new Error("seam not bound");`,
      `  return seam;`,
      `};`,
      `registerCapabilityProvider("${REVIEW}", { packageName: "${HOST}", impl: { run: (i: unknown) => requireSeam().run(i) } });`,
      "",
    ].join("\n"),
    "src/lib/example-slot-binder.ts": [
      `(globalThis as { __exampleSeam?: unknown }).__exampleSeam = {`,
      `  run: async (i: { content: unknown }) => (await import("@/lib/example-review-capture")).captureStagedWrite(i),`,
      `};`,
      "",
    ].join("\n"),
    "src/lib/example-review-capture.ts": CASE_TWO["src/lib/example-review-capture.ts"],
    "src/lib/example-objects.ts": CASE_TWO["src/lib/example-objects.ts"],
  };

  it("an impl that reads a globalThis slot with no declared entries is refused", () => {
    const capabilities = { [REVIEW]: { createsArtifact: false } };
    const live = scan(files, capabilities);
    expect(live.roads).toEqual({});
    expect(declarationProblems(live, capabilities).join("\n")).toMatch(/reads a globalThis slot/);
  });

  it("with entries naming the binding module, the reach runs from it", () => {
    const capabilities = { [REVIEW]: { createsArtifact: true, entries: ["src/lib/example-slot-binder.ts"] } };
    const live = scan(files, capabilities);
    expect(Object.keys(live.roads)).toEqual([CASE_TWO_ROAD]);
    expect(declarationProblems(live, capabilities)).toEqual([]);
  });

  it("a declared entry that does not exist is a scanner error", () => {
    const capabilities = { [REVIEW]: { createsArtifact: true, entries: ["src/lib/example-missing.ts"] } };
    expect(() => scan(files, capabilities)).toThrow(RoadScannerError);
  });
});

describe("T-B3 the declaration of every published capability", () => {
  it("an undeclared published id fails", () => {
    const live = scan(CASE_TWO, {});
    expect(declarationProblems(live, {}).join("\n")).toMatch(/published but not declared/);
  });

  it("a declared id no longer published fails", () => {
    const capabilities = { [REVIEW]: { createsArtifact: true }, [`${HOST}:retired`]: { createsArtifact: false } };
    const live = scan(CASE_TWO, capabilities);
    expect(declarationProblems(live, capabilities).join("\n")).toMatch(/declared but no longer published/);
  });

  it("a capability id the gate cannot resolve is a scanner error naming file and line", () => {
    const files = {
      "src/lib/register-example-dynamic.ts": [
        `import { registerCapabilityProvider } from "@/lib/extension-capabilities-registry";`,
        `const pick = (n: string) => n;`,
        `registerCapabilityProvider(pick("x"), { packageName: "${HOST}", impl: {} });`,
        "",
      ].join("\n"),
    };
    expect(() => scan(files)).toThrow(/register-example-dynamic\.ts:3/);
  });

  it("options bound to a constant are read; options the gate cannot read are a scanner error naming file and line", () => {
    const viaConst = {
      ...CASE_TWO,
      "src/lib/register-example-review.ts": [
        `import { registerCapabilityProvider } from "@/lib/extension-capabilities-registry";`,
        `import { captureStagedWrite } from "@/lib/example-review-capture";`,
        `const OPTIONS = { packageName: "${HOST}", impl: { captureStagedWrite } };`,
        `registerCapabilityProvider("${REVIEW}", OPTIONS);`,
        "",
      ].join("\n"),
    };
    const live = scan(viaConst, { [REVIEW]: { createsArtifact: true } });
    expect([...live.published.keys()]).toEqual([REVIEW]);
    expect(Object.keys(live.roads)).toEqual([CASE_TWO_ROAD]);
    const unread = {
      ...CASE_TWO,
      "src/lib/register-example-review.ts": [
        `import { registerCapabilityProvider } from "@/lib/extension-capabilities-registry";`,
        `const makeOptions = () => ({ packageName: "${HOST}", impl: {} });`,
        `registerCapabilityProvider("${REVIEW}", makeOptions());`,
        "",
      ].join("\n"),
    };
    expect(() => scan(unread)).toThrow(/register-example-review\.ts:3: cannot read the options/);
  });

  it("ids resolve through a local wrapper, a same-module constant and an imported contract object", () => {
    const files = {
      "packages/example-sdk/package.json": JSON.stringify({
        name: "@example-org/example-sdk",
        exports: { ".": "./src/index.ts", "./internal": "./src/internal.ts" },
      }),
      "packages/example-sdk/src/internal.ts": `export { SERVICES } from "./services-contract";\n`,
      "packages/example-sdk/src/services-contract.ts": `export const SERVICES = { config: "${HOST}:config", other: "${HOST}:other" } as const;\n`,
      "src/lib/register-example-services.ts": [
        `import { registerCapabilityProvider } from "@/lib/extension-capabilities-registry";`,
        `import { SERVICES } from "@example-org/example-sdk/internal";`,
        `const HOST_PROVIDER = "${HOST}";`,
        `export function registerAll() {`,
        `  const svc = SERVICES;`,
        `  const register = (capability: string, impl: unknown) => registerCapabilityProvider(capability, { packageName: HOST_PROVIDER, impl });`,
        `  const LOCAL = "${HOST}:local";`,
        `  register(svc.config, { read: () => 1 });`,
        `  register(LOCAL, { read: () => 2 });`,
        `}`,
        "",
      ].join("\n"),
    };
    const live = scan(files);
    expect([...live.published.keys()].sort()).toEqual([`${HOST}:config`, `${HOST}:local`]);
  });
});

describe("T-B4 the floor mechanics and the edge rule", () => {
  // A chain root -> m1 -> ... -> mN where mN writes an artifact-typed row.
  function chain(n, { typeOnlyAt = -1, barrelAt = -1 } = {}) {
    const files = {
      "src/lib/register-example-chain.ts": [
        `import { registerCapabilityProvider } from "@/lib/extension-capabilities-registry";`,
        `import { step } from "@/lib/chain/m0";`,
        `registerCapabilityProvider("${REVIEW}", { packageName: "${HOST}", impl: { step } });`,
        "",
      ].join("\n"),
    };
    for (let i = 0; i < n; i += 1) {
      const next = i + 1 < n ? `@/lib/chain/m${i + 1}` : "@/lib/chain/creator";
      if (i === barrelAt) {
        files["packages/example-barrel/package.json"] = JSON.stringify({ name: "@example-org/example-barrel", exports: { ".": "./src/index.ts" } });
        files["packages/example-barrel/src/index.ts"] = `export { step as next } from "@/lib/chain/creator";\n`;
        files[`src/lib/chain/m${i}.ts`] = `import { next } from "@example-org/example-barrel";\nexport const step = () => next;\n`;
      } else if (i === typeOnlyAt) {
        files[`src/lib/chain/m${i}.ts`] = `import type { Next } from "${next}";\nexport const step = (n?: Next) => n;\n`;
      } else {
        files[`src/lib/chain/m${i}.ts`] = `import { step as next } from "${next}";\nexport const step = () => next;\n`;
      }
    }
    files["src/lib/chain/creator.ts"] =
      `export type Next = unknown;\nexport const step = (content: unknown) => ({ typeHint: "@example-org/widget:card", rawData: content });\n`;
    return files;
  }
  const ROAD = `${REVIEW} :: src/lib/chain/creator.ts`;

  it("the bound is six edges from a root: a road of six edges is seen, a road of seven is not", () => {
    expect(MAX_EDGES).toBe(6);
    // root module m0 is the member's module (edge 0); creator sits at n edges.
    expect(Object.keys(scan(chain(6)).roads)).toEqual([ROAD]);
    expect(Object.keys(scan(chain(7)).roads)).toEqual([]);
  });

  it("an `import type` edge is not traversed", () => {
    expect(Object.keys(scan(chain(2)).roads)).toEqual([ROAD]);
    expect(Object.keys(scan(chain(2, { typeOnlyAt: 1 })).roads)).toEqual([]);
  });

  it("a package root barrel is not traversed", () => {
    expect(Object.keys(scan(chain(2, { barrelAt: 1 })).roads)).toEqual([]);
  });

  it("the connector handler is its own root", () => {
    const files = {
      [CONNECTOR_HANDLER_MODULE]: `import { saveCard } from "./card-writer";\nexport const handle = saveCard;\n`,
      "packages/extensions/src/card-writer.ts": `export const saveCard = (c: unknown) => ({ typeHint: "@example-org/widget:card", rawData: c });\n`,
    };
    expect(Object.keys(scan(files).roads)).toEqual([`${CONNECTOR_HANDLER_MODULE} :: packages/extensions/src/card-writer.ts`]);
  });

  it("a stale road fails and a grown floor is refused", () => {
    expect(diffShrunk({ [ROAD]: 1 }, {})).toEqual([`${ROAD} (1 -> 0)`]);
    expect(diffGrown({}, { [ROAD]: 1 })).toEqual([`${ROAD} (0 -> 1)`]);
  });

  it("the base guard refuses a flag-like and an unresolvable reference and a floor grown against the base", () => {
    expect(baseRefProblem("-x", REPO_ROOT, "CONNECTOR_ARTIFACT_ROAD_BASE")).toMatch(/flag-like/);
    expect(baseRefProblem("refs/heads/example-org-no-such-ref", REPO_ROOT, "CONNECTOR_ARTIFACT_ROAD_BASE")).toMatch(/did not resolve/);
    expect(baseRoadGrowth({ roads: {} }, { roads: { [ROAD]: { removedBy: "x" } } })).toEqual([`${ROAD} (0 -> 1)`]);
    expect(baseRoadGrowth({ roads: { [ROAD]: { removedBy: "x" } } }, { roads: {} })).toEqual([]);
  });

  it("every road names the item that removes it (UNASSIGNED or empty fails)", () => {
    expect(removedByProblems({ roads: { [ROAD]: { removedBy: "UNASSIGNED" } } })).toHaveLength(1);
    expect(removedByProblems({ roads: { [ROAD]: { removedBy: "" } } })).toHaveLength(1);
    expect(removedByProblems({ roads: { [ROAD]: { removedBy: "an item" } } })).toEqual([]);
  });

  it("the SDK roads list, when declared, must name exactly the ids declared true", () => {
    const capabilities = { [REVIEW]: { createsArtifact: true }, [`${HOST}:config`]: { createsArtifact: false } };
    expect(sdkRoadsProblems([REVIEW, "example_tool"], capabilities, [HOST])).toEqual([]);
    expect(sdkRoadsProblems(["example_tool"], capabilities, [HOST]).join("\n")).toMatch(/example-review/);
    expect(sdkRoadsProblems(null, capabilities, [HOST])).toEqual([]);
  });
});

describe("test of record: the connector artifact roads over the real tree", () => {
  let committed;
  let live;

  beforeAll(() => {
    // Fail closed on an absent tree: never skip, never a vacuous pass.
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
    const expected = Object.keys(pkg.cinatra?.devExtensions ?? {}).length;
    const found = discoverExtensionDirs(join(REPO_ROOT, "extensions")).length;
    expect(
      found,
      "extension tree must be cloned back (scripts/ci/sync-dev-extensions.mjs) before this suite",
    ).toBeGreaterThanOrEqual(expected);
    committed = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
    const started = Date.now();
    live = scanConnectorArtifactRoads(REPO_ROOT, { capabilities: committed.capabilities });
    console.log(`[connector-artifact-road-gate test of record] scan took ${Date.now() - started} ms`);
  }, 120_000);

  it("no road that is not on the committed floor (a new road fails, naming it)", () => {
    expect(diffGrown(roadCounts(committed), roadCounts(live))).toEqual([]);
  });

  it("no stale road (a removed road fails until the floor is ratcheted down)", () => {
    expect(diffShrunk(roadCounts(committed), roadCounts(live))).toEqual([]);
  });

  it("every published id is declared, every declared id is published, and each createsArtifact agrees with the reach", () => {
    expect(declarationProblems(live, committed.capabilities)).toEqual([]);
  });

  it("every road names the item that removes it", () => {
    expect(removedByProblems(committed)).toEqual([]);
  });

  it("exactly the four roads of today", () => {
    expect(Object.keys(live.roads)).toHaveLength(4);
  });

  it("the connector handler reaches no creating module", () => {
    expect(Object.keys(live.roads).filter((k) => k.startsWith(`${CONNECTOR_HANDLER_MODULE} :: `))).toEqual([]);
  });

  it("cross-checks ARTIFACT_CREATING_ROADS only when the SDK declares it", () => {
    expect(existsSync(join(REPO_ROOT, SDK_ROADS_MODULE))).toBe(true);
    const sdkRoads = readSdkCreatingRoads(REPO_ROOT);
    if (sdkRoads === null) {
      expect(live.sdkRoads, "the cross-check runs only when the constant is present (the two legs merge in either order)").toBeNull();
      expect(live.sdkRoadsNote).toBe("SDK roads list absent");
      return;
    }
    const hostPrefixes = readHostProviderIdentities(REPO_ROOT).map((h) => `${h}:`);
    const sdkHost = sdkRoads.filter((id) => hostPrefixes.some((p) => id.startsWith(p))).sort();
    const declaredTrue = Object.entries(committed.capabilities)
      .filter(([, d]) => d.createsArtifact === true)
      .map(([id]) => id)
      .sort();
    expect(sdkHost).toEqual(declaredTrue);
  });
});
