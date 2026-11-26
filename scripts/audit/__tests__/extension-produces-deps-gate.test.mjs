// Produced-artifact dependency gate (cinatra#2537) — unit tests.
// Zero-dep (node:test) to match the gate (a .mjs gate can't import .ts deps).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  FINDING_CLASSES,
  collectProducesEdges,
  declaredDependencyMap,
  readArtifactClaimIds,
  classifyEdge,
  diffAgainstBaseline,
  isClassBootstrap,
  classGrowth,
  discoverExtensionDirs,
} from "../extension-produces-deps-gate.mjs";

const GATE_SCRIPT = fileURLToPath(new URL("../extension-produces-deps-gate.mjs", import.meta.url));
const REPO_ROOT_FOR_TESTS = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// collectProducesEdges
// ---------------------------------------------------------------------------

test("collectProducesEdges reads produces from BOTH package.json and the OAS metadata block", () => {
  const { edges, malformed } = collectProducesEdges({
    packageJson: { cinatra: { produces: [{ extension: "@cinatra-ai/blog-post-artifact" }] } },
    oasJson: {
      metadata: {
        cinatra: {
          produces: [{ extension: "@cinatra-ai/blog-post-artifact" }, { extension: "@cinatra-ai/other-artifact" }],
        },
      },
    },
  });
  assert.deepEqual(malformed, []);
  assert.deepEqual(
    edges.map((e) => `${e.source}:${e.field}:${e.extension}`),
    [
      "package.json:produces:@cinatra-ai/blog-post-artifact",
      "cinatra/oas.json:produces:@cinatra-ai/blog-post-artifact",
      "cinatra/oas.json:produces:@cinatra-ai/other-artifact",
    ],
  );
});

test("collectProducesEdges carries objectTypeId through and rejects a malformed one", () => {
  const ok = collectProducesEdges({
    packageJson: {
      cinatra: { produces: [{ extension: "@cinatra-ai/email-artifacts", objectTypeId: "@cinatra-ai/email:body" }] },
    },
    oasJson: null,
  });
  assert.deepEqual(ok.malformed, []);
  assert.equal(ok.edges[0].objectTypeId, "@cinatra-ai/email:body");

  const bad = collectProducesEdges({
    packageJson: { cinatra: { produces: [{ extension: "@cinatra-ai/x", objectTypeId: "not-a-namespaced-id" }] } },
    oasJson: null,
  });
  assert.equal(bad.edges.length, 0);
  assert.equal(bad.malformed.length, 1);
  assert.match(bad.malformed[0], /objectTypeId must be a namespaced object type id/);
});

test("collectProducesEdges skips the consumed-PRIMITIVE shape but reads a consumed-EXTENSION shape", () => {
  const { edges, malformed } = collectProducesEdges({
    packageJson: {
      cinatra: {
        consumes: [
          { primitive: "blog_post_publish_linkedin_start", requirement: "required" },
          { extension: "@cinatra-ai/some-artifact" },
        ],
      },
    },
    oasJson: null,
  });
  assert.deepEqual(malformed, []);
  assert.deepEqual(
    edges.map((e) => `${e.field}:${e.extension}`),
    ["consumes:@cinatra-ai/some-artifact"],
  );
});

test("collectProducesEdges reads a primitive consumes entry as a PRIMITIVE even with an incidental extension key", () => {
  // The SDK consumes parser TOLERATES extra keys, so a valid primitive entry
  // may carry one. It must not become a produced-artifact edge.
  const { edges, malformed } = collectProducesEdges({
    packageJson: {
      cinatra: {
        consumes: [{ primitive: "artifact_authoring_emit", requirement: "required", extension: "@cinatra-ai/x" }],
      },
    },
    oasJson: null,
  });
  assert.deepEqual(malformed, []);
  assert.deepEqual(edges, []);
});

test("collectProducesEdges has NO primitive shape in produces — an entry with no extension is malformed there", () => {
  const { edges, malformed } = collectProducesEdges({
    packageJson: { cinatra: { produces: [{ primitive: "artifact_authoring_emit" }] } },
    oasJson: null,
  });
  assert.deepEqual(edges, []);
  assert.equal(malformed.length, 1);
  assert.match(malformed[0], /cinatra\.produces\[0\] declares no `extension`/);
  // The "and no consumed `primitive`" clause is consumes-only — produces has no
  // primitive shape to offer as an alternative.
  assert.doesNotMatch(malformed[0], /and no consumed `primitive`/);
});

test("collectProducesEdges FAILS CLOSED on shapes it cannot read", () => {
  const notArray = collectProducesEdges({ packageJson: { cinatra: { produces: "nope" } }, oasJson: null });
  assert.equal(notArray.edges.length, 0);
  assert.match(notArray.malformed[0], /cinatra\.produces must be an array/);

  // An EXPLICIT null is malformed, not "none" — treating it as absent would let
  // a null-ed block hide every edge it used to carry.
  const explicitNull = collectProducesEdges({ packageJson: { cinatra: { produces: null } }, oasJson: null });
  assert.equal(explicitNull.edges.length, 0);
  assert.match(explicitNull.malformed[0], /cinatra\.produces must be an array — spell "none" as \[\] \(got null\)/);

  const notObject = collectProducesEdges({ packageJson: { cinatra: { produces: ["@cinatra-ai/x"] } }, oasJson: null });
  assert.match(notObject.malformed[0], /cinatra\.produces\[0\] must be an object/);

  const noExtension = collectProducesEdges({ packageJson: { cinatra: { consumes: [{ nope: 1 }] } }, oasJson: null });
  assert.match(noExtension.malformed[0], /declares no `extension` and no consumed `primitive`/);

  const emptyExtension = collectProducesEdges({ packageJson: { cinatra: { produces: [{ extension: "" }] } }, oasJson: null });
  assert.match(emptyExtension.malformed[0], /extension must be a non-empty string/);
});

test("collectProducesEdges is quiet on a manifest with no cinatra block at all", () => {
  assert.deepEqual(collectProducesEdges({ packageJson: { name: "x" }, oasJson: null }), { edges: [], malformed: [] });
  assert.deepEqual(collectProducesEdges({ packageJson: null, oasJson: null }), { edges: [], malformed: [] });
});

// ---------------------------------------------------------------------------
// declaredDependencyMap / readArtifactClaimIds
// ---------------------------------------------------------------------------

test("declaredDependencyMap keys valid entries and tolerates junk without throwing", () => {
  const map = declaredDependencyMap({
    cinatra: {
      dependencies: [
        { packageName: "@cinatra-ai/a", requirement: "required" },
        null,
        { noPackageName: true },
        { packageName: "@cinatra-ai/a", requirement: "optional" }, // duplicate: first wins
      ],
    },
  });
  assert.equal(map.size, 1);
  assert.equal(map.get("@cinatra-ai/a").requirement, "required");
});

test("declaredDependencyMap treats a malformed dependencies block as declaring nothing", () => {
  assert.equal(declaredDependencyMap({ cinatra: { dependencies: "nope" } }).size, 0);
  assert.equal(declaredDependencyMap({ cinatra: {} }).size, 0);
  assert.equal(declaredDependencyMap(undefined).size, 0);
});

test("readArtifactClaimIds collects only well-formed namespaced claim ids", () => {
  const ids = readArtifactClaimIds({
    cinatra: {
      artifact: {
        objectTypes: [
          { type: "@cinatra-ai/text-artifact:artifact" },
          { type: "garbage" },
          { type: 42 },
          null,
        ],
      },
    },
  });
  assert.deepEqual([...ids], ["@cinatra-ai/text-artifact:artifact"]);
  assert.equal(readArtifactClaimIds({ cinatra: { artifact: {} } }).size, 0);
});

// ---------------------------------------------------------------------------
// classifyEdge — the mirrored publish/install contract
// ---------------------------------------------------------------------------

const artifactCatalog = (name, claims = []) =>
  new Map([[name, { kind: "artifact", claimIds: new Set(claims) }]]);

const requiredDep = (name) =>
  new Map([[name, { packageName: name, edgeType: "runtime", requirement: "required", kind: "artifact" }]]);

test("classifyEdge is clean for a produced artifact declared as a required artifact dependency", () => {
  const verdict = classifyEdge({
    edge: { field: "produces", source: "package.json", extension: "@cinatra-ai/blog-post-artifact" },
    declared: requiredDep("@cinatra-ai/blog-post-artifact"),
    catalog: artifactCatalog("@cinatra-ai/blog-post-artifact"),
  });
  assert.equal(verdict.undeclared, null);
  assert.equal(verdict.unresolved, null);
});

test("classifyEdge flags a produced artifact absent from cinatra.dependencies (the #2537 class)", () => {
  const verdict = classifyEdge({
    edge: { field: "produces", source: "package.json", extension: "@cinatra-ai/blog-post-artifact" },
    declared: new Map(),
    catalog: artifactCatalog("@cinatra-ai/blog-post-artifact"),
  });
  assert.equal(verdict.unresolved, null);
  assert.equal(verdict.undeclared.key, "@cinatra-ai/blog-post-artifact");
  assert.match(verdict.undeclared.reason, /not declared in cinatra\.dependencies/);
});

// The three ways an edge can be DECLARED yet still not be an install-closure
// member — byte-mirroring the runtime `requiredArtifactDependencies` predicate
// (kind === "artifact" && requirement === "required" && edgeType !== "peer").
const notClosureMember = [
  ["a NON-required requirement", { edgeType: "runtime", requirement: "optional", kind: "artifact" }, /requirement:"optional"/],
  ["a peer edgeType", { edgeType: "peer", requirement: "required", kind: "artifact" }, /edgeType:"peer"/],
  ["a non-artifact kind", { edgeType: "runtime", requirement: "required", kind: "connector" }, /kind:"connector"/],
  // The one codex caught: `kind` is NOT optional to the runtime predicate — an
  // edge omitting it is not a closure member and BLOCKS at publish/install.
  ["an OMITTED kind", { edgeType: "runtime", requirement: "required" }, /kind:null.*OMITTED kind/s],
];

for (const [label, edgeFields, expected] of notClosureMember) {
  test(`classifyEdge flags a produced artifact declared with ${label}`, () => {
    const verdict = classifyEdge({
      edge: { field: "produces", source: "package.json", extension: "@cinatra-ai/a" },
      declared: new Map([["@cinatra-ai/a", { packageName: "@cinatra-ai/a", ...edgeFields }]]),
      catalog: artifactCatalog("@cinatra-ai/a"),
    });
    assert.ok(verdict.undeclared, `expected a finding for ${label}`);
    assert.match(verdict.undeclared.reason, expected);
    assert.equal(verdict.undeclared.key, "@cinatra-ai/a");
  });
}

test("classifyEdge accepts an install-time (non-peer) required artifact edge", () => {
  const verdict = classifyEdge({
    edge: { field: "produces", source: "package.json", extension: "@cinatra-ai/a" },
    declared: new Map([
      ["@cinatra-ai/a", { packageName: "@cinatra-ai/a", edgeType: "install-time", requirement: "required", kind: "artifact" }],
    ]),
    catalog: artifactCatalog("@cinatra-ai/a"),
  });
  assert.equal(verdict.undeclared, null);
});

test("classifyEdge flags a target absent from the catalog — the retired-extension trap", () => {
  // Declaring a RETIRED extension as a required dependency satisfies class 1
  // while shipping something that can never install: only class 2 sees it.
  const verdict = classifyEdge({
    edge: { field: "produces", source: "package.json", extension: "@cinatra-ai/default-artifact" },
    declared: requiredDep("@cinatra-ai/default-artifact"),
    catalog: artifactCatalog("@cinatra-ai/text-artifact"),
  });
  assert.equal(verdict.undeclared, null);
  assert.equal(verdict.unresolved.key, "@cinatra-ai/default-artifact");
  assert.match(verdict.unresolved.reason, /not in the synced extension catalog/);
});

test("classifyEdge flags a target that resolves to a non-artifact kind", () => {
  const verdict = classifyEdge({
    edge: { field: "produces", source: "package.json", extension: "@cinatra-ai/some-connector" },
    declared: requiredDep("@cinatra-ai/some-connector"),
    catalog: new Map([["@cinatra-ai/some-connector", { kind: "connector", claimIds: new Set() }]]),
  });
  assert.match(verdict.unresolved.reason, /kind:"connector".*only an artifact extension can claim/s);
});

test("classifyEdge flags an objectTypeId the target does not claim, keyed distinctly", () => {
  const verdict = classifyEdge({
    edge: {
      field: "produces",
      source: "package.json",
      extension: "@cinatra-ai/email-artifacts",
      objectTypeId: "@cinatra-ai/email:subject",
    },
    declared: requiredDep("@cinatra-ai/email-artifacts"),
    catalog: artifactCatalog("@cinatra-ai/email-artifacts", ["@cinatra-ai/email:body"]),
  });
  assert.equal(verdict.undeclared, null);
  assert.equal(verdict.unresolved.key, "@cinatra-ai/email-artifacts#@cinatra-ai/email:subject");
  assert.match(verdict.unresolved.reason, /declares no such cinatra\.artifact\.objectTypes claim \(declares: @cinatra-ai\/email:body\)/);
});

test("classifyEdge accepts an objectTypeId the target does claim", () => {
  const verdict = classifyEdge({
    edge: {
      field: "produces",
      source: "package.json",
      extension: "@cinatra-ai/email-artifacts",
      objectTypeId: "@cinatra-ai/email:body",
    },
    declared: requiredDep("@cinatra-ai/email-artifacts"),
    catalog: artifactCatalog("@cinatra-ai/email-artifacts", ["@cinatra-ai/email:body"]),
  });
  assert.equal(verdict.unresolved, null);
});

test("classifyEdge reports BOTH classes when an edge is undeclared AND unresolvable", () => {
  // The exact cinatra#2537 media-transcript-agent shape at the pinned sha.
  const verdict = classifyEdge({
    edge: { field: "produces", source: "package.json", extension: "@cinatra-ai/default-artifact" },
    declared: new Map(),
    catalog: artifactCatalog("@cinatra-ai/text-artifact"),
  });
  assert.ok(verdict.undeclared);
  assert.ok(verdict.unresolved);
});

// ---------------------------------------------------------------------------
// Baseline diff + growth guard
// ---------------------------------------------------------------------------

test("diffAgainstBaseline reports only NEW (pkg, target) pairs", () => {
  const findings = {
    "@cinatra-ai/a": ["@cinatra-ai/x", "@cinatra-ai/y"], // y is new
    "@cinatra-ai/b": ["@cinatra-ai/z"], // entirely new package
  };
  const baseline = { undeclaredProducesDeps: { "@cinatra-ai/a": ["@cinatra-ai/x"] } };
  const { newViolations } = diffAgainstBaseline(findings, baseline, "undeclaredProducesDeps");
  assert.deepEqual(newViolations, { "@cinatra-ai/a": ["@cinatra-ai/y"], "@cinatra-ai/b": ["@cinatra-ai/z"] });
});

test("diffAgainstBaseline is clean when every finding is baselined, and all-new with no baseline", () => {
  const findings = { "@cinatra-ai/a": ["@cinatra-ai/x"] };
  assert.deepEqual(
    diffAgainstBaseline(findings, { undeclaredProducesDeps: { "@cinatra-ai/a": ["@cinatra-ai/x"] } }, "undeclaredProducesDeps")
      .newViolations,
    {},
  );
  assert.deepEqual(diffAgainstBaseline(findings, {}, "undeclaredProducesDeps").newViolations, findings);
});

test("diffAgainstBaseline keys each class separately (a class-1 baseline never excuses class 2)", () => {
  const baseline = { undeclaredProducesDeps: { "@cinatra-ai/a": ["@cinatra-ai/x"] }, unresolvedProducesTargets: {} };
  const { newViolations } = diffAgainstBaseline(
    { "@cinatra-ai/a": ["@cinatra-ai/x"] },
    baseline,
    "unresolvedProducesTargets",
  );
  assert.deepEqual(newViolations, { "@cinatra-ai/a": ["@cinatra-ai/x"] });
});

test("classGrowth flags pairs ADDED to the committed baseline vs the base branch", () => {
  const base = { undeclaredProducesDeps: { "@cinatra-ai/a": ["@cinatra-ai/x"] } };
  const committed = {
    undeclaredProducesDeps: { "@cinatra-ai/a": ["@cinatra-ai/x", "@cinatra-ai/y"], "@cinatra-ai/b": ["@cinatra-ai/z"] },
  };
  assert.deepEqual(classGrowth(base, committed, "undeclaredProducesDeps").grew, [
    "@cinatra-ai/a :: @cinatra-ai/y",
    "@cinatra-ai/b :: @cinatra-ai/z",
  ]);
});

test("classGrowth is empty when the committed baseline only SHRINKS", () => {
  const base = { undeclaredProducesDeps: { "@cinatra-ai/a": ["@cinatra-ai/x", "@cinatra-ai/y"] } };
  const committed = { undeclaredProducesDeps: { "@cinatra-ai/a": ["@cinatra-ai/x"] } };
  assert.deepEqual(classGrowth(base, committed, "undeclaredProducesDeps").grew, []);
});

test("no shipped class is bootstrap-eligible — an absent class in a PRESENT base baseline fails closed", () => {
  // BOOTSTRAPPABLE_CLASSES is empty by design (both classes are born with the
  // baseline file; the file-absent case is the gate's own bootstrap). Deleting a
  // section on the base branch and re-adding it must therefore read as GROWTH,
  // not as a fresh bootstrap.
  for (const cls of FINDING_CLASSES) {
    assert.equal(isClassBootstrap({}, cls), false);
    const res = classGrowth({}, { [cls]: { "@cinatra-ai/a": ["@cinatra-ai/x"] } }, cls);
    assert.equal(res.bootstrap, null);
    assert.deepEqual(res.grew, ["@cinatra-ai/a :: @cinatra-ai/x"]);
  }
});

// ---------------------------------------------------------------------------
// Live subprocess runs against a fixture tree
// ---------------------------------------------------------------------------

function writeJson(path, value) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

/** The tool-owner classes (cinatra#4874), empty: a fixture baseline that
 *  names none of them gets these, so the produced-artifact tests stay about
 *  their own classes. */
const EMPTY_TOOL_CLASSES = { undeclaredToolOwnerDeps: {}, unownedTools: {}, dynamicToolNames: {}, undeclaredPortUses: {} };

/** A minimal repo root: extensions/<vendor>/<name> (+ optional code files),
 *  the authz inventory (empty unless given) and the baseline location. */
function makeFixtureRoot({ extensions, baseline, inventory = { primitives: [] } }) {
  const root = mkdtempSync(join(tmpdir(), "produces-deps-gate-"));
  for (const [name, { packageJson, oasJson, files }] of Object.entries(extensions)) {
    const dir = join(root, "extensions", "example-org", name);
    mkdirSync(dir, { recursive: true });
    if (typeof packageJson === "string") writeFileSync(join(dir, "package.json"), packageJson);
    else writeJson(join(dir, "package.json"), packageJson);
    if (typeof oasJson === "string") {
      mkdirSync(join(dir, "cinatra"), { recursive: true });
      writeFileSync(join(dir, "cinatra", "oas.json"), oasJson);
    } else if (oasJson) writeJson(join(dir, "cinatra", "oas.json"), oasJson);
    for (const [rel, text] of Object.entries(files ?? {})) {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), text);
    }
  }
  if (inventory !== null) writeJson(join(root, "src", "lib", "authz", "__generated__", "inventory.json"), inventory);
  mkdirSync(join(root, "scripts", "audit"), { recursive: true });
  if (baseline) {
    writeJson(join(root, "scripts", "audit", "extension-produces-deps-gate.baseline.json"), {
      ...EMPTY_TOOL_CLASSES,
      ...baseline,
    });
  }
  return root;
}

/** No base for the floor guard unless a test names one (a CI run's own
 *  GITHUB_BASE_REF must not reach a fixture repository). */
const NO_BASE_ENV = { EXTENSION_PRODUCES_DEPS_BASE: "", GITHUB_BASE_REF: "", GITHUB_EVENT_NAME: "", FLOOR_BASE_FETCH: "0" };

function runGate(root, args = [], baseEnv = NO_BASE_ENV) {
  try {
    const stdout = execFileSync(process.execPath, [GATE_SCRIPT, ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, ...baseEnv },
    });
    return { status: 0, out: stdout };
  } catch (err) {
    return { status: err.status ?? -1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

const producerPkg = (deps, produces) => ({
  name: "@cinatra-ai/producer-agent",
  version: "0.1.0",
  cinatra: { apiVersion: "cinatra.ai/v1", kind: "agent", dependencies: deps, produces },
});

const artifactPkg = {
  name: "@cinatra-ai/target-artifact",
  version: "0.1.0",
  cinatra: {
    apiVersion: "cinatra.ai/v1",
    kind: "artifact",
    dependencies: [],
    artifact: { objectTypes: [{ type: "@cinatra-ai/target-artifact:artifact" }] },
  },
};

const requiredEdge = {
  packageName: "@cinatra-ai/target-artifact",
  edgeType: "runtime",
  versionConstraint: { kind: "semver-range", range: "^0.1.0" },
  requirement: "required",
  kind: "artifact",
};

test("live: an UNDECLARED produced artifact fails with a NEW violation", () => {
  const root = makeFixtureRoot({
    extensions: {
      "producer-agent": { packageJson: producerPkg([], [{ extension: "@cinatra-ai/target-artifact" }]) },
      "target-artifact": { packageJson: artifactPkg },
    },
    baseline: { undeclaredProducesDeps: {}, unresolvedProducesTargets: {} },
  });
  try {
    const res = runGate(root);
    assert.equal(res.status, 1);
    assert.match(res.out, /1 NEW produced-artifact dependency violation/);
    assert.match(res.out, /@cinatra-ai\/producer-agent \[undeclaredProducesDeps\]/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live: declaring the produced artifact as a required dependency turns the gate green", () => {
  const root = makeFixtureRoot({
    extensions: {
      "producer-agent": { packageJson: producerPkg([requiredEdge], [{ extension: "@cinatra-ai/target-artifact" }]) },
      "target-artifact": { packageJson: artifactPkg },
    },
    baseline: { undeclaredProducesDeps: {}, unresolvedProducesTargets: {} },
  });
  try {
    const res = runGate(root);
    assert.equal(res.status, 0);
    assert.match(res.out, /OK — no new undeclared produced-artifact dependencies/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live: an OAS-only produces edge is caught even when package.json declares none", () => {
  const pkg = producerPkg([], undefined);
  delete pkg.cinatra.produces;
  const root = makeFixtureRoot({
    extensions: {
      "producer-agent": {
        packageJson: pkg,
        oasJson: { metadata: { cinatra: { produces: [{ extension: "@cinatra-ai/target-artifact" }] } } },
      },
      "target-artifact": { packageJson: artifactPkg },
    },
    baseline: { undeclaredProducesDeps: {}, unresolvedProducesTargets: {} },
  });
  try {
    const res = runGate(root);
    assert.equal(res.status, 1);
    assert.match(res.out, /cinatra\.produces \(cinatra\/oas\.json\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live: a baselined offender stays green, and a SECOND offender still fails", () => {
  const baseline = {
    undeclaredProducesDeps: { "@cinatra-ai/producer-agent": ["@cinatra-ai/target-artifact"] },
    unresolvedProducesTargets: {},
  };
  const clean = makeFixtureRoot({
    extensions: {
      "producer-agent": { packageJson: producerPkg([], [{ extension: "@cinatra-ai/target-artifact" }]) },
      "target-artifact": { packageJson: artifactPkg },
    },
    baseline,
  });
  try {
    assert.equal(runGate(clean).status, 0);
  } finally {
    rmSync(clean, { recursive: true, force: true });
  }

  const second = producerPkg([], [{ extension: "@cinatra-ai/target-artifact" }]);
  second.name = "@cinatra-ai/second-agent";
  const dirty = makeFixtureRoot({
    extensions: {
      "producer-agent": { packageJson: producerPkg([], [{ extension: "@cinatra-ai/target-artifact" }]) },
      "second-agent": { packageJson: second },
      "target-artifact": { packageJson: artifactPkg },
    },
    baseline,
  });
  try {
    const res = runGate(dirty);
    assert.equal(res.status, 1);
    assert.match(res.out, /@cinatra-ai\/second-agent/);
    assert.doesNotMatch(res.out, /NEW.*\n.*@cinatra-ai\/producer-agent/);
  } finally {
    rmSync(dirty, { recursive: true, force: true });
  }
});

test("live: a produced target absent from the catalog fails even when declared as a required dependency", () => {
  const root = makeFixtureRoot({
    extensions: {
      "producer-agent": {
        packageJson: producerPkg(
          [{ ...requiredEdge, packageName: "@cinatra-ai/retired-artifact" }],
          [{ extension: "@cinatra-ai/retired-artifact" }],
        ),
      },
      "target-artifact": { packageJson: artifactPkg },
    },
    baseline: { undeclaredProducesDeps: {}, unresolvedProducesTargets: {} },
  });
  try {
    const res = runGate(root);
    assert.equal(res.status, 1);
    assert.match(res.out, /\[unresolvedProducesTargets\]/);
    assert.match(res.out, /not in the synced extension catalog/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live: --write-baseline REFUSES to write over a malformed declaration", () => {
  const root = makeFixtureRoot({
    extensions: {
      "producer-agent": { packageJson: producerPkg([], "not-an-array") },
      "target-artifact": { packageJson: artifactPkg },
    },
  });
  try {
    const res = runGate(root, ["--write-baseline"]);
    assert.equal(res.status, 1);
    assert.match(res.out, /REFUSING --write-baseline/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live: a malformed produces declaration is a HARD fail, never baselineable", () => {
  const root = makeFixtureRoot({
    extensions: {
      "producer-agent": { packageJson: producerPkg([], "not-an-array") },
      "target-artifact": { packageJson: artifactPkg },
    },
    // Even a baseline naming the package cannot excuse an unreadable shape.
    baseline: { undeclaredProducesDeps: { "@cinatra-ai/producer-agent": ["@cinatra-ai/target-artifact"] }, unresolvedProducesTargets: {} },
  });
  try {
    const res = runGate(root);
    assert.equal(res.status, 1);
    assert.match(res.out, /malformed produces\/consumes declaration/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live: an EMPTY extensions tree fails closed (never a vacuous pass)", () => {
  const root = mkdtempSync(join(tmpdir(), "produces-deps-gate-empty-"));
  mkdirSync(join(root, "scripts", "audit"), { recursive: true });
  try {
    const res = runGate(root);
    assert.equal(res.status, 2);
    assert.match(res.out, /refusing to pass vacuously/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live: --report lists every offender and exits 0 (the reproducible audit mode)", () => {
  const root = makeFixtureRoot({
    extensions: {
      "producer-agent": { packageJson: producerPkg([], [{ extension: "@cinatra-ai/target-artifact" }]) },
      "target-artifact": { packageJson: artifactPkg },
    },
    baseline: { undeclaredProducesDeps: {}, unresolvedProducesTargets: {} },
  });
  try {
    const res = runGate(root, ["--report"]);
    assert.equal(res.status, 0);
    assert.match(res.out, /undeclaredProducesDeps:/);
    assert.match(res.out, /@cinatra-ai\/producer-agent/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live: the growth guard blocks regenerate-to-pass and reports the gate bootstrap", () => {
  const root = makeFixtureRoot({
    extensions: {
      "producer-agent": { packageJson: producerPkg([], [{ extension: "@cinatra-ai/target-artifact" }]) },
      "target-artifact": { packageJson: artifactPkg },
    },
    baseline: {
      undeclaredProducesDeps: { "@cinatra-ai/producer-agent": ["@cinatra-ai/target-artifact"] },
      unresolvedProducesTargets: {},
    },
  });
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  try {
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    git("add", "-A");
    git("commit", "-qm", "base");
    const baseSha = git("rev-parse", "HEAD").trim();

    // (a) base HAS the baseline file and the committed baseline is unchanged → clean.
    const same = execFileSync(process.execPath, [GATE_SCRIPT], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, EXTENSION_PRODUCES_DEPS_BASE: baseSha },
    });
    assert.match(same, /OK — no new undeclared/);

    // (b) the committed baseline GROWS vs the base → FAIL, even though the
    //     scan itself would be fully baselined.
    writeJson(join(root, "scripts", "audit", "extension-produces-deps-gate.baseline.json"), {
      undeclaredProducesDeps: {
        "@cinatra-ai/producer-agent": ["@cinatra-ai/target-artifact"],
        "@cinatra-ai/laundered-agent": ["@cinatra-ai/target-artifact"],
      },
      unresolvedProducesTargets: {},
    });
    let grewOut = "";
    let grewStatus = 0;
    try {
      execFileSync(process.execPath, [GATE_SCRIPT], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, EXTENSION_PRODUCES_DEPS_BASE: baseSha },
      });
    } catch (err) {
      grewStatus = err.status;
      grewOut = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    }
    assert.equal(grewStatus, 1);
    assert.match(grewOut, /committed baseline GREW/);
    assert.match(grewOut, /\[undeclaredProducesDeps\] @cinatra-ai\/laundered-agent/);

    // (c) an unresolvable base ref fails CLOSED rather than skipping the guard.
    let badRefStatus = 0;
    let badRefOut = "";
    try {
      execFileSync(process.execPath, [GATE_SCRIPT], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, EXTENSION_PRODUCES_DEPS_BASE: "0000000000000000000000000000000000000000" },
      });
    } catch (err) {
      badRefStatus = err.status;
      badRefOut = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    }
    assert.equal(badRefStatus, 1);
    assert.match(badRefOut, /did not resolve/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live: a base ref with NO baseline file reports the gate bootstrap instead of growth", () => {
  const root = makeFixtureRoot({
    extensions: {
      "producer-agent": { packageJson: producerPkg([], [{ extension: "@cinatra-ai/target-artifact" }]) },
      "target-artifact": { packageJson: artifactPkg },
    },
  });
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  try {
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    git("add", "-A");
    git("commit", "-qm", "base-without-baseline");
    const baseSha = git("rev-parse", "HEAD").trim();

    // The introducing PR writes the baseline with its grandfathered entries.
    writeJson(join(root, "scripts", "audit", "extension-produces-deps-gate.baseline.json"), {
      undeclaredProducesDeps: { "@cinatra-ai/producer-agent": ["@cinatra-ai/target-artifact"] },
      unresolvedProducesTargets: {},
      ...EMPTY_TOOL_CLASSES,
    });
    const out = execFileSync(process.execPath, [GATE_SCRIPT], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, EXTENSION_PRODUCES_DEPS_BASE: baseSha },
    });
    assert.match(out, /gate bootstrap: 1 grandfathered entries/);
    assert.match(out, /OK — no new undeclared/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discoverExtensionDirs finds vendor/name dirs with a manifest and skips the rest", () => {
  const root = makeFixtureRoot({
    extensions: {
      "producer-agent": { packageJson: producerPkg([], []) },
      "target-artifact": { packageJson: artifactPkg },
    },
  });
  try {
    mkdirSync(join(root, "extensions", "example-org", "no-manifest"), { recursive: true });
    mkdirSync(join(root, "extensions", "example-org", "node_modules"), { recursive: true });
    const dirs = discoverExtensionDirs(join(root, "extensions")).map((d) => d.split("/").pop());
    assert.deepEqual(dirs, ["producer-agent", "target-artifact"]);
    assert.deepEqual(discoverExtensionDirs(join(root, "does-not-exist")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The tool-owner rule (cinatra#4874): a pack's use of a tool that ANOTHER pack
// registers needs that pack in its cinatra.dependencies. Every test below runs
// the gate on a fixture tree; before the rule the gate passed each of them
// (exit 0, no tool-owner line), so each fails before by assertion.
// ---------------------------------------------------------------------------

const ownerPkg = {
  name: "@cinatra-ai/owner-connector",
  version: "0.1.0",
  cinatra: { apiVersion: "cinatra.ai/v1", kind: "connector", dependencies: [] },
};

const ownerEdge = {
  packageName: "@cinatra-ai/owner-connector",
  edgeType: "runtime",
  versionConstraint: { kind: "semver-range", range: "*" },
  requirement: "required",
  kind: "connector",
};

const consumerPkg = (deps, consumes = []) => ({
  name: "@cinatra-ai/consumer-agent",
  version: "0.1.0",
  cinatra: { apiVersion: "cinatra.ai/v1", kind: "agent", dependencies: deps, consumes },
});

/** The inventory: one tool of the owner pack, one core tool. */
const toolInventory = {
  primitives: [
    { primitiveName: "owner_tool", file: "extensions/example-org/owner-connector/src/mcp/module.ts", line: 1 },
    { primitiveName: "core_tool", file: "packages/core-thing/src/mcp/schemas.ts", line: 1 },
  ],
};

const consume = (primitive) => ({ primitive, requirement: "required" });
const NO_PRODUCES_FINDINGS = { undeclaredProducesDeps: {}, unresolvedProducesTargets: {} };

test("live: a pack that uses another pack's tool without declaring that pack fails", () => {
  const root = makeFixtureRoot({
    extensions: {
      "consumer-agent": { packageJson: consumerPkg([], [consume("owner_tool"), consume("core_tool")]) },
      "owner-connector": { packageJson: ownerPkg },
    },
    baseline: NO_PRODUCES_FINDINGS,
    inventory: toolInventory,
  });
  try {
    const res = runGate(root);
    assert.equal(res.status, 1, res.out);
    assert.match(res.out, /\[undeclaredToolOwnerDeps\] NEW @cinatra-ai\/consumer-agent :: owner_tool/);
    assert.match(res.out, /registered by @cinatra-ai\/owner-connector/);
    // The core tool is no finding: core owns it.
    assert.doesNotMatch(res.out, /core_tool/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live: declaring the owning pack in cinatra.dependencies turns the tool rule green", () => {
  const root = makeFixtureRoot({
    extensions: {
      "consumer-agent": { packageJson: consumerPkg([ownerEdge], [consume("owner_tool")]) },
      "owner-connector": { packageJson: ownerPkg },
    },
    baseline: NO_PRODUCES_FINDINGS,
    inventory: toolInventory,
  });
  try {
    const res = runGate(root);
    assert.equal(res.status, 0, res.out);
    assert.match(res.out, /tool-owner rule: 1 tool uses, 0 undeclaredToolOwnerDeps, 0 unownedTools, 0 dynamicToolNames/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live: a tool with no inventory entry is reported as owner unknown, never skipped", () => {
  const root = makeFixtureRoot({
    extensions: { "consumer-agent": { packageJson: consumerPkg([], [consume("nobody_registers_this")]) } },
    baseline: NO_PRODUCES_FINDINGS,
    inventory: toolInventory,
  });
  try {
    const res = runGate(root);
    assert.equal(res.status, 1, res.out);
    assert.match(res.out, /\[unownedTools\] NEW @cinatra-ai\/consumer-agent :: nobody_registers_this/);
    assert.match(res.out, /does not hold, so its owner cannot be decided/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live: an inventory file outside every pack of the tree is an unknown owner", () => {
  const root = makeFixtureRoot({
    extensions: { "consumer-agent": { packageJson: consumerPkg([], [consume("gone_tool")]) } },
    baseline: NO_PRODUCES_FINDINGS,
    inventory: { primitives: [{ primitiveName: "gone_tool", file: "extensions/example-org/retired-connector/src/x.ts" }] },
  });
  try {
    const res = runGate(root);
    assert.equal(res.status, 1, res.out);
    assert.match(res.out, /\[unownedTools\] NEW @cinatra-ai\/consumer-agent :: gone_tool/);
    assert.match(res.out, /in no pack of the synced extension tree/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("live: tools named in the flow (ApiNode data.tool, a step's metadata.cinatra.tools) are uses", () => {
  const oasJson = {
    component_type: "Flow",
    $referenced_components: {
      call_owner: {
        component_type: "ApiNode",
        url: "{{CINATRA_BASE_URL}}/api/agents/passthrough",
        data: JSON.stringify({ tool: "owner_tool", input: {} }),
      },
      sub: {
        component_type: "Flow",
        $referenced_components: {
          model_step: { component_type: "ApiNode", url: "x", metadata: { cinatra: { tools: ["second_owner_tool"] } } },
        },
      },
    },
  };
  const root = makeFixtureRoot({
    extensions: {
      "consumer-agent": { packageJson: consumerPkg([]), oasJson },
      "owner-connector": { packageJson: ownerPkg },
    },
    baseline: NO_PRODUCES_FINDINGS,
    inventory: {
      primitives: [
        ...toolInventory.primitives,
        { primitiveName: "second_owner_tool", file: "extensions/example-org/owner-connector/src/mcp/other.ts" },
      ],
    },
  });
  try {
    const res = runGate(root);
    assert.equal(res.status, 1, res.out);
    assert.match(res.out, /NEW @cinatra-ai\/consumer-agent :: owner_tool/);
    assert.match(res.out, /NEW @cinatra-ai\/consumer-agent :: second_owner_tool/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// red-first-expect: The input did not match the regular expression /\[undeclaredPortUses\] NEW @cinatra-ai\/consumer-agent :: src\/alias\.ts/
test("live: code that references the primitive-call port in any form needs a cinatra.consumes declaration; comments and tests are not read", () => {
  const files = {
    // An alias: no call through the method name at all.
    "src/alias.ts": "export function make(ctx: any) {\n  const invoke = ctx.mcp.callPrimitive;\n  return invoke;\n}\n",
    // A destructuring and a bracket access.
    "src/destructure.ts": 'export const f = ({ callPrimitive }: any) => callPrimitive;\nexport const g = (m: any) => m["callPrimitive"];\n',
    // A same-named method of another object: counted too (errs towards reporting).
    "src/other.ts": 'export const h = (client: any) => client.callPrimitive("x");\n',
    // Only a comment names the method here: the parser finds no reference.
    "src/notes.ts": "// ctx.mcp.callPrimitive(\"comment_only_tool\", {})\nexport const x = 1;\n",
    "src/__tests__/register.test.ts": 'ctx.mcp.callPrimitive("test_only_tool", {});\n',
  };
  const undeclared = makeFixtureRoot({
    extensions: { "consumer-agent": { packageJson: consumerPkg([]), files } },
    baseline: NO_PRODUCES_FINDINGS,
    inventory: toolInventory,
  });
  const declared = makeFixtureRoot({
    extensions: { "consumer-agent": { packageJson: consumerPkg([], [consume("core_tool")]), files } },
    baseline: NO_PRODUCES_FINDINGS,
    inventory: toolInventory,
  });
  try {
    const res = runGate(undeclared);
    assert.equal(res.status, 1, res.out);
    for (const f of ["alias", "destructure", "other"]) {
      assert.match(res.out, new RegExp(`\\[undeclaredPortUses\\] NEW @cinatra-ai\\/consumer-agent :: src\\/${f}\\.ts`));
    }
    assert.match(res.out, /declares no consumed primitive in package\.json cinatra\.consumes/);
    assert.doesNotMatch(res.out, /notes\.ts|register\.test\.ts/);
    // Code is not read for tool names any more.
    assert.doesNotMatch(res.out, /dynamicToolNames\] NEW|comment_only_tool|test_only_tool/);
    const ok = runGate(declared);
    assert.equal(ok.status, 0, ok.out);
    assert.match(ok.out, /0 undeclaredPortUses/);
  } finally {
    for (const root of [undeclared, declared]) rmSync(root, { recursive: true, force: true });
  }
});

// red-first-expect: required use + optional edge: [extension-produces-deps] OK — ... tool-owner rule: 1 tool uses, 0 undeclaredToolOwnerDeps, 0 unownedTools, 0 dynamicToolNames listed.
test("live: a declared owner backs a use exactly as the dependency validator accepts it", () => {
  const edge = (requirement, edgeType = "runtime") => ({ ...ownerEdge, requirement, edgeType });
  const cases = [
    { name: "required use + optional edge", use: "required", dep: edge("optional"), fails: true },
    { name: "required use + required peer edge", use: "required", dep: edge("required", "peer"), fails: true },
    { name: "required use + required runtime edge", use: "required", dep: edge("required"), fails: false },
    { name: "required use + required install-time edge", use: "required", dep: edge("required", "install-time"), fails: false },
    { name: "optional use + optional edge", use: "optional", dep: edge("optional"), fails: false },
    { name: "optional use + optional peer edge", use: "optional", dep: edge("optional", "peer"), fails: false },
  ];
  for (const c of cases) {
    const root = makeFixtureRoot({
      extensions: {
        "consumer-agent": { packageJson: consumerPkg([c.dep], [{ primitive: "owner_tool", requirement: c.use }]) },
        "owner-connector": { packageJson: ownerPkg },
      },
      baseline: NO_PRODUCES_FINDINGS,
      inventory: toolInventory,
    });
    try {
      const res = runGate(root);
      assert.equal(res.status, c.fails ? 1 : 0, `${c.name}: ${res.out}`);
      if (c.fails) {
        assert.match(res.out, /\[undeclaredToolOwnerDeps\] NEW @cinatra-ai\/consumer-agent :: owner_tool/, c.name);
        assert.match(res.out, /which is not install-blocking/, c.name);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

// red-first-expect: [extension-produces-deps] OK — ... tool-owner rule: 3 tool uses, 0 undeclaredToolOwnerDeps, 0 unownedTools, 0 dynamicToolNames listed.
test("live: tools named like Object.prototype keys are findings like any other", () => {
  const names = ["constructor", "__proto__", "toString"];
  const root = makeFixtureRoot({
    extensions: {
      "consumer-agent": { packageJson: consumerPkg([], names.map(consume)) },
      "owner-connector": { packageJson: ownerPkg },
    },
    baseline: NO_PRODUCES_FINDINGS,
    inventory: {
      primitives: names.map((n) => ({ primitiveName: n, file: "extensions/example-org/owner-connector/src/mcp/module.ts" })),
    },
  });
  try {
    const res = runGate(root);
    assert.equal(res.status, 1, res.out);
    for (const n of names) assert.match(res.out, new RegExp(`\\[undeclaredToolOwnerDeps\\] NEW @cinatra-ai\\/consumer-agent :: ${n}\\b`));
    // Written to the list, each is kept as its own entry and then tolerated.
    const written = runGate(root, ["--write-baseline"]);
    assert.equal(written.status, 0, written.out);
    const baseline = JSON.parse(readFileSync(join(root, "scripts", "audit", "extension-produces-deps-gate.baseline.json"), "utf8"));
    assert.deepEqual(Object.keys(baseline.undeclaredToolOwnerDeps["@cinatra-ai/consumer-agent"]).sort(), [...names].sort());
    const again = runGate(root);
    assert.equal(again.status, 0, again.out);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the install-blocking reading mirrors the dependency closure and the validator (drift guard)", () => {
  const predicate = 'return dep.requirement === "required" && dep.edgeType !== "peer";';
  const read = (rel) => readFileSync(join(REPO_ROOT_FOR_TESTS, rel), "utf8");
  const closure = read("packages/extensions/src/dependency-closure.ts");
  const validator = read("packages/extensions/src/dependency-declaration-validator.ts");
  const types = read("packages/extensions/src/canonical-types.ts");
  assert.ok(closure.includes(`export function isInstallBlockingEdge(dep: ExtensionDependency): boolean {\n  ${predicate}`));
  assert.ok(validator.includes(`function isInstallBlockingEdge(dep: ExtensionDependency): boolean {\n  ${predicate}`));
  // The validator's requirement rule the gate mirrors: only a REQUIRED use
  // needs an install-blocking edge; any declared edge backs an optional one.
  assert.ok(validator.includes('if (c.requirement === "required" && !isInstallBlockingEdge(declared)) {'));
  assert.ok(types.includes('export const DEPENDENCY_REQUIREMENTS = ["required", "optional"] as const;'));
  assert.ok(types.includes('export const DEPENDENCY_EDGE_TYPES = ["runtime", "install-time", "peer"] as const;'));
  assert.ok(readFileSync(GATE_SCRIPT, "utf8").includes(predicate));
});

test("live: an unreadable manifest, flow, step tool list, code file or inventory is reported, never skipped", () => {
  const cases = [
    {
      name: "manifest",
      ext: { packageJson: "{ not json" },
      expect: /unreadable JSON at extensions\/example-org\/consumer-agent\/package\.json/,
      status: 2,
    },
    {
      name: "flow",
      ext: { packageJson: consumerPkg([]), oasJson: "{ not json" },
      expect: /unreadable JSON at extensions\/example-org\/consumer-agent\/cinatra\/oas\.json/,
      status: 2,
    },
    {
      name: "step tools",
      ext: {
        packageJson: consumerPkg([]),
        oasJson: {
          component_type: "Flow",
          $referenced_components: { s: { component_type: "ApiNode", metadata: { cinatra: { tools: "owner_tool" } } } },
        },
      },
      expect: /metadata\.cinatra\.tools must be a list/,
      status: 1,
    },
    {
      name: "code",
      ext: { packageJson: consumerPkg([]), files: { "src/broken.ts": 'ctx.mcp.callPrimitive("owner_tool", {;\n' } },
      expect: /src\/broken\.ts: the TypeScript parser cannot read the file/,
      status: 1,
    },
  ];
  for (const c of cases) {
    const root = makeFixtureRoot({
      extensions: { "consumer-agent": c.ext },
      baseline: NO_PRODUCES_FINDINGS,
      inventory: toolInventory,
    });
    try {
      const res = runGate(root);
      assert.equal(res.status, c.status, `${c.name}: ${res.out}`);
      assert.match(res.out, c.expect, c.name);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  const noInventory = makeFixtureRoot({
    extensions: { "consumer-agent": { packageJson: consumerPkg([]) } },
    baseline: NO_PRODUCES_FINDINGS,
    inventory: null,
  });
  try {
    const res = runGate(noInventory);
    assert.equal(res.status, 2, res.out);
    assert.match(res.out, /the authz inventory src\/lib\/authz\/__generated__\/inventory\.json is missing/);
  } finally {
    rmSync(noInventory, { recursive: true, force: true });
  }
});

test("live: a listed entry is tolerated, a STALE one fails, and an entry without a reason fails", () => {
  const listed = { "@cinatra-ai/consumer-agent": { owner_tool: "tolerated: fixed in the pack, pin bump pending" } };
  const extensions = {
    "consumer-agent": { packageJson: consumerPkg([], [consume("owner_tool")]) },
    "owner-connector": { packageJson: ownerPkg },
  };
  const ok = makeFixtureRoot({ extensions, baseline: { undeclaredToolOwnerDeps: listed }, inventory: toolInventory });
  const stale = makeFixtureRoot({
    extensions: { ...extensions, "consumer-agent": { packageJson: consumerPkg([ownerEdge], [consume("owner_tool")]) } },
    baseline: { undeclaredToolOwnerDeps: listed },
    inventory: toolInventory,
  });
  const noReason = makeFixtureRoot({
    extensions,
    baseline: { undeclaredToolOwnerDeps: { "@cinatra-ai/consumer-agent": { owner_tool: "" } } },
    inventory: toolInventory,
  });
  try {
    const okRun = runGate(ok);
    assert.equal(okRun.status, 0, okRun.out);
    assert.match(okRun.out, /tool-owner rule: 1 tool uses, 1 undeclaredToolOwnerDeps/);
    const s = runGate(stale);
    assert.equal(s.status, 1, s.out);
    assert.match(s.out, /\[undeclaredToolOwnerDeps\] STALE @cinatra-ai\/consumer-agent :: owner_tool/);
    const r = runGate(noReason);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /owner_tool has no reason/);
  } finally {
    for (const root of [ok, stale, noReason]) rmSync(root, { recursive: true, force: true });
  }
});

test("live: the shared floor base guard — the introducing change seeds once, growth is refused, a shrink passes, a removed class fails", () => {
  const extensions = {
    "consumer-agent": { packageJson: consumerPkg([], [consume("owner_tool"), consume("unknown_one")]) },
    "owner-connector": { packageJson: ownerPkg },
  };
  const root = makeFixtureRoot({ extensions, baseline: NO_PRODUCES_FINDINGS, inventory: toolInventory });
  const baselinePath = join(root, "scripts", "audit", "extension-produces-deps-gate.baseline.json");
  const consumerPath = join(root, "extensions", "example-org", "consumer-agent", "package.json");
  // The base holds the produced-artifact classes only: the tool classes are new there.
  writeJson(baselinePath, NO_PRODUCES_FINDINGS);
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const seeded = {
    undeclaredToolOwnerDeps: { "@cinatra-ai/consumer-agent": { owner_tool: "seeded with the rule" } },
    unownedTools: { "@cinatra-ai/consumer-agent": { unknown_one: "seeded with the rule" } },
    dynamicToolNames: {},
    undeclaredPortUses: {},
  };
  const env = (ref) => ({ ...NO_BASE_ENV, EXTENSION_PRODUCES_DEPS_BASE: ref });
  try {
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    git("add", "-A");
    git("commit", "-qm", "base-without-tool-classes");

    // (a) the introducing change seeds the classes once.
    writeJson(baselinePath, { ...NO_PRODUCES_FINDINGS, ...seeded });
    const seed = runGate(root, [], env(git("rev-parse", "HEAD").trim()));
    assert.equal(seed.status, 0, seed.out);
    assert.match(seed.out, /undeclaredToolOwnerDeps seed: 1 entries/);
    git("add", "-A");
    git("commit", "-qm", "seeded");
    const seededSha = git("rev-parse", "HEAD").trim();

    // (b) a NEW listed entry against the seeded base is growth: refused, even
    //     though the scan finds it.
    writeFileSync(consumerPath, JSON.stringify(consumerPkg([], [consume("owner_tool"), consume("unknown_one"), consume("unknown_two")])));
    writeJson(baselinePath, {
      ...NO_PRODUCES_FINDINGS,
      ...seeded,
      unownedTools: { "@cinatra-ai/consumer-agent": { unknown_one: "seeded with the rule", unknown_two: "added later" } },
    });
    const grew = runGate(root, [], env(seededSha));
    assert.equal(grew.status, 1, grew.out);
    assert.match(grew.out, /GREW against the base/);
    assert.match(grew.out, /\[unownedTools\] @cinatra-ai\/consumer-agent :: unknown_two/);

    // (c) the pack declares its owner and the entry goes: a shrink passes.
    writeFileSync(consumerPath, JSON.stringify(consumerPkg([ownerEdge], [consume("owner_tool"), consume("unknown_one")])));
    writeJson(baselinePath, { ...NO_PRODUCES_FINDINGS, ...seeded, undeclaredToolOwnerDeps: {} });
    const shrink = runGate(root, [], env(seededSha));
    assert.equal(shrink.status, 0, shrink.out);
    assert.match(shrink.out, /does not grow against the base/);

    // (d) removing a class (to seed it again later) fails.
    writeJson(baselinePath, { ...NO_PRODUCES_FINDINGS, undeclaredToolOwnerDeps: {}, dynamicToolNames: {} });
    const removed = runGate(root, [], env(seededSha));
    assert.equal(removed.status, 1, removed.out);
    assert.match(removed.out, /the baseline has no `unownedTools` map/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the gate decides owners from the inventory and its code names no pack and no tool", () => {
  const ts = require("typescript");
  const source = readFileSync(GATE_SCRIPT, "utf8");
  const sf = ts.createSourceFile("gate.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const literals = [];
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) literals.push(node.text);
    else if (ts.isTemplateExpression(node)) literals.push(node.head.text, ...node.templateSpans.map((s) => s.literal.text));
    ts.forEachChild(node, visit);
  };
  visit(sf);
  // The owner of a tool comes from the generated inventory, read by its path.
  assert.ok(literals.includes("src/lib/authz/__generated__/inventory.json"), "the gate reads the authz inventory");
  const inventory = JSON.parse(readFileSync(join(REPO_ROOT_FOR_TESTS, "src/lib/authz/__generated__/inventory.json"), "utf8"));
  const toolNames = new Set(inventory.primitives.map((p) => p.primitiveName));
  assert.deepEqual(literals.filter((l) => toolNames.has(l)), []);
  assert.deepEqual(literals.filter((l) => /^@[\w-]+\/[\w-]+$/.test(l)), []);
});
