import { describe, it, expect } from "vitest";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MATERIALIZATION_PLAN_FORMAT,
  MAX_PLAN_NODES,
  MAX_PLAN_CANONICAL_BYTES,
  CLOSURE_HASH_RE,
  MaterializationPlanError,
  parseMaterializationPlan,
  parsePlacementPath,
  canonicalMaterializationPlanBytes,
  computeClosureHash,
  planExecutionOrder,
  planRootDependencyNames,
  type MaterializationPlan,
} from "@/lib/extension-materialization-plan-core";
import { sriForBytes } from "@/lib/extension-package-store-core";
import {
  buildSignaturePayload,
  buildSignaturePayloadV2,
  signExtension,
  signExtensionV2,
  generateExtensionSigningKeyPair,
} from "@/lib/extension-signature";

// The materialization-plan PURE core (cinatra#181): strict parse refusals,
// canonicalization, closureHash, execution order, gate projection — and the
// CROSS-SIDE BYTE CONTRACT: the committed fixtures under
// `fixtures/materialization-plan/` are NORMATIVE for the publish-time signer.
// This suite both golden-asserts them and (re)generates them under
// CINATRA_REGENERATE_PLAN_FIXTURES=1 (the committed keypair is reused, never
// regenerated — fixture identity is stable).

const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "materialization-plan",
);

// ---------------------------------------------------------------------------
// The fixture plan — roots + 9 nodes covering BOTH duplicate classes:
//   - same NAME at two VERSIONS (lib-c@1.0.0 / lib-c@2.0.0, nested apart);
//   - same NAME@VERSION at two PLACEMENT PATHS (lib-d@1.0.0 hoisted at the
//     root AND nested under lib-b);
// plus a HOISTED legal edge (lib-a → node_modules/lib-d) and SCOPED coverage
// (scoped root @scope/lib-e, unscoped child nested under the scoped parent,
// hoisted scoped child @scope/lib-g — review r0 finding 4).
// ---------------------------------------------------------------------------

const fixtureIntegrity = (id: string): string => sriForBytes(Buffer.from(`fixture-tarball:${id}`), "sha512");

export function buildFixturePlan(): MaterializationPlan {
  return {
    format: MATERIALIZATION_PLAN_FORMAT,
    package: { name: "@cinatra-test/closure-fixture", version: "1.0.0" },
    rootDependencies: [
      { name: "lib-a", placementPath: "node_modules/lib-a" },
      { name: "lib-b", placementPath: "node_modules/lib-b" },
      { name: "@scope/lib-e", placementPath: "node_modules/@scope/lib-e" },
    ],
    nodes: [
      {
        name: "@scope/lib-e",
        version: "1.0.0",
        integrity: fixtureIntegrity("@scope/lib-e@1.0.0"),
        placementPath: "node_modules/@scope/lib-e",
        dependencies: [
          { name: "lib-f", placementPath: "node_modules/@scope/lib-e/node_modules/lib-f" },
          { name: "@scope/lib-g", placementPath: "node_modules/@scope/lib-g" }, // hoisted scoped
        ],
      },
      {
        name: "lib-f",
        version: "1.0.0",
        integrity: fixtureIntegrity("lib-f@1.0.0"),
        placementPath: "node_modules/@scope/lib-e/node_modules/lib-f",
        dependencies: [],
      },
      {
        name: "@scope/lib-g",
        version: "1.0.0",
        integrity: fixtureIntegrity("@scope/lib-g@1.0.0"),
        placementPath: "node_modules/@scope/lib-g",
        dependencies: [],
      },
      {
        name: "lib-a",
        version: "1.0.0",
        integrity: fixtureIntegrity("lib-a@1.0.0"),
        placementPath: "node_modules/lib-a",
        dependencies: [
          { name: "lib-c", placementPath: "node_modules/lib-a/node_modules/lib-c" },
          { name: "lib-d", placementPath: "node_modules/lib-d" }, // hoisted — legal
        ],
      },
      {
        name: "lib-b",
        version: "2.3.4",
        integrity: fixtureIntegrity("lib-b@2.3.4"),
        placementPath: "node_modules/lib-b",
        dependencies: [
          { name: "lib-c", placementPath: "node_modules/lib-b/node_modules/lib-c" },
          { name: "lib-d", placementPath: "node_modules/lib-b/node_modules/lib-d" },
        ],
      },
      {
        name: "lib-c",
        version: "1.0.0",
        integrity: fixtureIntegrity("lib-c@1.0.0"),
        placementPath: "node_modules/lib-a/node_modules/lib-c",
        dependencies: [],
      },
      {
        name: "lib-c",
        version: "2.0.0",
        integrity: fixtureIntegrity("lib-c@2.0.0"),
        placementPath: "node_modules/lib-b/node_modules/lib-c",
        dependencies: [],
      },
      {
        name: "lib-d",
        version: "1.0.0",
        integrity: fixtureIntegrity("lib-d@1.0.0"),
        placementPath: "node_modules/lib-d",
        dependencies: [],
      },
      {
        name: "lib-d",
        version: "1.0.0",
        integrity: fixtureIntegrity("lib-d@1.0.0"),
        placementPath: "node_modules/lib-b/node_modules/lib-d",
        dependencies: [],
      },
    ],
  };
}

/** The extension-tarball identity the payload fixtures bind. */
export const FIXTURE_SIGNED_FIELDS = {
  packageName: "@cinatra-test/closure-fixture",
  version: "1.0.0",
  integrity: fixtureIntegrity("extension-tarball"),
};

/**
 * The SHUFFLED transport rendering: key order scrambled, arrays out of
 * canonical order, pretty-printed — proving the host re-canonicalizes parsed
 * transport JSON (transport-encoding agnostic).
 */
function buildShuffledTransportJson(plan: MaterializationPlan): string {
  const shuffledNodes = [...plan.nodes].reverse().map((n) => ({
    placementPath: n.placementPath,
    dependencies: [...n.dependencies].reverse().map((d) => ({ placementPath: d.placementPath, name: d.name })),
    version: n.version,
    name: n.name,
    integrity: n.integrity,
  }));
  const shuffled = {
    nodes: shuffledNodes,
    rootDependencies: [...plan.rootDependencies].reverse().map((d) => ({ placementPath: d.placementPath, name: d.name })),
    package: { version: plan.package.version, name: plan.package.name },
    format: plan.format,
  };
  return `${JSON.stringify(shuffled, null, 2)}\n`;
}

function fixturePath(name: string): string {
  return path.join(FIXTURE_DIR, name);
}

type KeyPairFixture = { publicKeyDerB64: string; privateKeyPkcs8DerB64: string; keyId: string };

function loadOrCreateKeypair(regenerate: boolean): KeyPairFixture {
  const p = fixturePath("signing-keypair.json");
  if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8")) as KeyPairFixture;
  if (!regenerate) throw new Error(`missing committed fixture ${p}`);
  const kp = generateExtensionSigningKeyPair();
  writeFileSync(p, `${JSON.stringify(kp, null, 2)}\n`);
  return kp;
}

describe("materialization-plan fixtures — the cross-side byte contract", () => {
  const regenerate = process.env.CINATRA_REGENERATE_PLAN_FIXTURES === "1";

  it("committed fixture bytes match regeneration exactly (NORMATIVE for the signer side)", () => {
    mkdirSync(FIXTURE_DIR, { recursive: true });
    const plan = buildFixturePlan();
    const canonical = Buffer.from(canonicalMaterializationPlanBytes(plan));
    const closureHash = computeClosureHash(plan);
    const keypair = loadOrCreateKeypair(regenerate);
    const expected: Record<string, Buffer> = {
      "plan.transport.json": Buffer.from(buildShuffledTransportJson(plan), "utf8"),
      "plan.canonical.bytes": canonical,
      "closure-hash.txt": Buffer.from(closureHash, "utf8"),
      "fixture.json": Buffer.from(`${JSON.stringify(FIXTURE_SIGNED_FIELDS, null, 2)}\n`, "utf8"),
      "payload-v1.bytes": Buffer.from(buildSignaturePayload(FIXTURE_SIGNED_FIELDS), "utf8"),
      "payload-v2.bytes": Buffer.from(buildSignaturePayloadV2({ ...FIXTURE_SIGNED_FIELDS, closureHash }), "utf8"),
      "signature.v1.txt": Buffer.from(signExtension(FIXTURE_SIGNED_FIELDS, keypair.privateKeyPkcs8DerB64), "utf8"),
      "signature.v2.txt": Buffer.from(
        signExtensionV2({ ...FIXTURE_SIGNED_FIELDS, closureHash }, keypair.privateKeyPkcs8DerB64),
        "utf8",
      ),
    };
    for (const [name, bytes] of Object.entries(expected)) {
      const p = fixturePath(name);
      if (regenerate) writeFileSync(p, bytes);
      expect(existsSync(p), `${name} must be committed`).toBe(true);
      expect(Buffer.compare(readFileSync(p), bytes), `${name} bytes must match regeneration`).toBe(0);
    }
  });

  it("the committed transport fixture parses + re-canonicalizes to the committed canonical bytes + hash", () => {
    const transport = JSON.parse(readFileSync(fixturePath("plan.transport.json"), "utf8")) as unknown;
    const plan = parseMaterializationPlan(transport);
    expect(Buffer.compare(Buffer.from(canonicalMaterializationPlanBytes(plan)), readFileSync(fixturePath("plan.canonical.bytes")))).toBe(0);
    const closureHash = computeClosureHash(plan);
    expect(closureHash).toBe(readFileSync(fixturePath("closure-hash.txt"), "utf8"));
    expect(closureHash).toMatch(CLOSURE_HASH_RE);
  });

  it("canonical bytes are zero-whitespace JSON with sorted keys + sorted arrays", () => {
    const canonical = readFileSync(fixturePath("plan.canonical.bytes"), "utf8");
    expect(canonical).not.toMatch(/[\n\t]| /);
    const parsed = JSON.parse(canonical) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["format", "nodes", "package", "rootDependencies"]);
    const nodes = parsed.nodes as Array<Record<string, unknown>>;
    expect(Object.keys(nodes[0])).toEqual(["dependencies", "integrity", "name", "placementPath", "version"]);
    const paths = nodes.map((n) => n.placementPath as string);
    expect(paths).toEqual([...paths].sort());
  });
});

// ---------------------------------------------------------------------------
// Parse/validation refusal battery (every refusal class test-pinned)
// ---------------------------------------------------------------------------

type Mutator = (plan: ReturnType<typeof asTransport>) => void;
function asTransport(plan: MaterializationPlan): {
  format: string;
  package: { name: string; version: string };
  rootDependencies: Array<{ name: string; placementPath: string }>;
  nodes: Array<{
    name: string;
    version: string;
    integrity: string;
    placementPath: string;
    dependencies: Array<{ name: string; placementPath: string }>;
  }>;
} {
  return JSON.parse(JSON.stringify(plan));
}

function expectRefusal(mutate: Mutator, pattern: RegExp): void {
  const transport = asTransport(buildFixturePlan());
  mutate(transport);
  expect(() => parseMaterializationPlan(transport)).toThrow(MaterializationPlanError);
  expect(() => parseMaterializationPlan(transport)).toThrow(pattern);
}

describe("parseMaterializationPlan — refusal battery", () => {
  it("accepts the fixture plan and is idempotent over its own output", () => {
    const plan = parseMaterializationPlan(asTransport(buildFixturePlan()));
    expect(computeClosureHash(plan)).toBe(computeClosureHash(parseMaterializationPlan(asTransport(plan))));
  });

  it("refuses non-objects and wrong/missing format", () => {
    expect(() => parseMaterializationPlan(null)).toThrow(/must be a JSON object/);
    expect(() => parseMaterializationPlan([])).toThrow(/must be a JSON object/);
    expect(() => parseMaterializationPlan("plan")).toThrow(/must be a JSON object/);
    expectRefusal((t) => void ((t as { format: string }).format = "cinatra-materialization-plan/v2"), /unsupported format/);
  });

  it("refuses missing AND extra fields at every level (all fields required)", () => {
    expectRefusal((t) => delete (t as Partial<ReturnType<typeof asTransport>>).nodes, /exactly the fields/);
    expectRefusal((t) => void ((t as Record<string, unknown>).extra = 1), /exactly the fields/);
    expectRefusal((t) => delete (t.package as Partial<{ name: string }>).name, /exactly the fields/);
    expectRefusal((t) => void ((t.package as Record<string, unknown>).extra = 1), /exactly the fields/);
    expectRefusal((t) => delete (t.nodes[3] as Partial<{ integrity: string }>).integrity, /exactly the fields/);
    expectRefusal((t) => void ((t.nodes[3] as Record<string, unknown>).scripts = {}), /exactly the fields/);
    expectRefusal((t) => void ((t.nodes[3].dependencies[0] as Record<string, unknown>).version = "1.0.0"), /exactly the fields/);
  });

  it("refuses invalid names, non-exact versions, and non-sha512 integrity", () => {
    expectRefusal((t) => void (t.nodes[5].name = "Bad Name"), /not a valid npm package name/);
    expectRefusal((t) => void (t.package.version = "^1.0.0"), /not an exact version/);
    expectRefusal((t) => void (t.nodes[5].version = "latest"), /not an exact version/);
    expectRefusal((t) => void (t.nodes[5].integrity = "sha256-AAAA"), /single sha512 SRI/);
    expectRefusal((t) => void (t.nodes[5].integrity = `${t.nodes[5].integrity} sha256-AAAA`), /single sha512 SRI/);
    expectRefusal((t) => void (t.nodes[5].integrity = `${t.nodes[5].integrity}\tsha256-AAAA`), /single sha512 SRI/);
    expectRefusal((t) => void (t.nodes[5].integrity = `\n${t.nodes[5].integrity}`), /single sha512 SRI/);
    expectRefusal((t) => void (t.nodes[5].integrity = "sha512-AAAA"), /single sha512 SRI/);
    expectRefusal((t) => void (t.nodes[5].integrity = "garbage"), /single sha512 SRI/);
  });

  it("refuses placementPath grammar violations (traversal, separators, non-chain shapes)", () => {
    expect(() => parsePlacementPath("node_modules/../etc", "t")).toThrow(/invalid package segment|not a node_modules chain/);
    expect(() => parsePlacementPath("lib-x", "t")).toThrow(/not a node_modules chain/);
    expect(() => parsePlacementPath("/node_modules/lib-x", "t")).toThrow(/not a node_modules chain/);
    expect(() => parsePlacementPath("node_modules/lib-x/dist", "t")).toThrow(/not a node_modules chain/);
    expect(() => parsePlacementPath("node_modules/lib-x/node_modules", "t")).toThrow(/bare node_modules segment/);
    expect(() => parsePlacementPath("node_modules/LIB-X", "t")).toThrow(/invalid package segment/);
    expect(() => parsePlacementPath("node_modules\\lib-x", "t")).toThrow(/not a node_modules chain/);
    expect(() => parsePlacementPath("node_modules/lib%2fx", "t")).toThrow(/invalid package segment/);
    expect(() => parsePlacementPath("node_modules/", "t")).toThrow(/bare node_modules segment|invalid package segment/);
    expect(() => parsePlacementPath("node_modules/@scope", "t")).toThrow(/scope segment .* without a name/);
    // scoped chains parse correctly
    expect(parsePlacementPath("node_modules/@s/a/node_modules/b", "t")).toEqual(["@s/a", "b"]);
  });

  it("refuses a placementPath whose name-tail differs from the node/ref name", () => {
    expectRefusal((t) => void (t.nodes[5].placementPath = "node_modules/lib-a/node_modules/lib-x"), /does not end in the package name/);
    expectRefusal((t) => void (t.rootDependencies[0].placementPath = "node_modules/lib-x"), /does not end in the package name/);
  });

  it("refuses duplicate node identity (same placementPath twice)", () => {
    expectRefusal((t) => void (t.nodes[6].placementPath = t.nodes[5].placementPath, (t.nodes[6].name = t.nodes[5].name)), /duplicate node placementPath/);
  });

  it("refuses duplicate dependency NAMES within one dependency set", () => {
    expectRefusal(
      (t) => void t.nodes[3].dependencies.push({ name: "lib-c", placementPath: "node_modules/lib-a/node_modules/lib-c" }),
      /duplicate dependency name/,
    );
    expectRefusal(
      (t) => void t.rootDependencies.push({ name: "lib-a", placementPath: "node_modules/lib-a" }),
      /duplicate dependency name/,
    );
  });

  it("refuses an edge to a non-existent node (a ref-vs-node NAME mismatch is structurally unreachable — both tails are name-checked — and stays as defense in depth)", () => {
    expectRefusal((t) => void (t.nodes[3].dependencies[0].placementPath = "node_modules/lib-c"), /names no node|not Node-resolution-valid/);
  });

  it("refuses an edge that is NOT Node-resolution-valid (cross-tree reference)", () => {
    // lib-a referencing the lib-c nested under lib-b: NOT reachable by walk-up.
    expectRefusal(
      (t) => void (t.nodes[3].dependencies[0] = { name: "lib-c", placementPath: "node_modules/lib-b/node_modules/lib-c" }),
      /not Node-resolution-valid/,
    );
    // SCOPED cross-tree: lib-a referencing the lib-f nested under @scope/lib-e
    expectRefusal(
      (t) => void (t.nodes[3].dependencies[0] = { name: "lib-f", placementPath: "node_modules/@scope/lib-e/node_modules/lib-f" }),
      /not Node-resolution-valid/,
    );
    // a root dependency must live at exactly node_modules/<name>
    expectRefusal(
      (t) => void (t.rootDependencies[0] = { name: "lib-c", placementPath: "node_modules/lib-a/node_modules/lib-c" }),
      /not Node-resolution-valid/,
    );
  });

  it("refuses unreachable (orphan) nodes", () => {
    expectRefusal((t) => {
      t.nodes.push({
        name: "lib-orphan",
        version: "1.0.0",
        integrity: t.nodes[3].integrity,
        placementPath: "node_modules/lib-orphan",
        dependencies: [],
      });
    }, /not reachable from rootDependencies/);
  });

  it("refuses HOST-PROVIDED peers as plan nodes", () => {
    expectRefusal((t) => {
      t.nodes[7].name = "@cinatra-ai/sdk-extensions";
      t.nodes[7].placementPath = "node_modules/@cinatra-ai/sdk-extensions";
      t.nodes[3].dependencies[1] = { name: "@cinatra-ai/sdk-extensions", placementPath: "node_modules/@cinatra-ai/sdk-extensions" };
    }, /HOST-PROVIDED peer/);
  });

  it("refuses plans beyond the node cap (fail-closed, never truncated)", () => {
    const transport = asTransport(buildFixturePlan());
    for (let i = 0; i < MAX_PLAN_NODES; i += 1) {
      const name = `pad-${i}`;
      transport.nodes.push({
        name,
        version: "1.0.0",
        integrity: transport.nodes[3].integrity,
        placementPath: `node_modules/${name}`,
        dependencies: [],
      });
      transport.rootDependencies.push({ name, placementPath: `node_modules/${name}` });
    }
    expect(() => parseMaterializationPlan(transport)).toThrow(/cap is 500/);
    expect(MAX_PLAN_CANONICAL_BYTES).toBe(1024 * 1024);
  });
});

// ---------------------------------------------------------------------------
// Canonicalization invariance + projections
// ---------------------------------------------------------------------------

describe("canonicalization + projections", () => {
  it("transport shuffle invariance: reordered/whitespaced transport ⇒ identical canonical bytes + hash", () => {
    const plan = buildFixturePlan();
    const shuffled = parseMaterializationPlan(JSON.parse(buildShuffledTransportJson(plan)) as unknown);
    expect(Buffer.compare(Buffer.from(canonicalMaterializationPlanBytes(shuffled)), Buffer.from(canonicalMaterializationPlanBytes(plan)))).toBe(0);
    expect(computeClosureHash(shuffled)).toBe(computeClosureHash(plan));
  });

  it("ANY field mutation changes the closureHash (tamper-evidence basis)", () => {
    const base = computeClosureHash(buildFixturePlan());
    const mutations: Array<(p: MaterializationPlan) => void> = [
      (p) => void (p.nodes[3].version = "1.0.1"),
      (p) => void (p.nodes[3].integrity = sriForBytes(Buffer.from("tampered"), "sha512")),
      (p) => void (p.nodes[5].placementPath = "node_modules/lib-c"),
      (p) => void (p.package.version = "1.0.1"),
      (p) => void p.nodes.splice(8, 1),
    ];
    for (const mutate of mutations) {
      const plan = buildFixturePlan();
      mutate(plan);
      expect(computeClosureHash(plan)).not.toBe(base);
    }
  });

  it("planExecutionOrder is parents-before-children and deterministic", () => {
    const order = planExecutionOrder(parseMaterializationPlan(asTransport(buildFixturePlan())));
    const paths = order.map((n) => n.placementPath);
    expect(paths).toEqual([
      "node_modules/@scope/lib-e",
      "node_modules/@scope/lib-g",
      "node_modules/lib-a",
      "node_modules/lib-b",
      "node_modules/lib-d",
      "node_modules/@scope/lib-e/node_modules/lib-f",
      "node_modules/lib-a/node_modules/lib-c",
      "node_modules/lib-b/node_modules/lib-c",
      "node_modules/lib-b/node_modules/lib-d",
    ]);
    // every nested node comes after the node whose placement contains it
    for (const node of order) {
      const containerIdx = paths.findIndex((p) => node.placementPath !== p && node.placementPath.startsWith(`${p}/`));
      if (containerIdx !== -1) expect(containerIdx).toBeLessThan(paths.indexOf(node.placementPath));
    }
  });

  it("planRootDependencyNames projects the gate input", () => {
    expect([...planRootDependencyNames(buildFixturePlan())].sort()).toEqual(["@scope/lib-e", "lib-a", "lib-b"]);
  });
});
