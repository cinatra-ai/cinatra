// THE FLOOR GATE (cinatra#2931 W4, plan `PLAN: Agents Lifecycle (B)` §5) — unit tests.
// Zero-dep (node:test) to match the gate (a .mjs gate can't import .ts deps).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  InfraError,
  CANONICAL_SOURCES,
  readMimeAllowlist,
  readHandlerMap,
  readConsumedFormArms,
  readDashboardMime,
  readGeneratedRendererEntries,
  representationMatchSpecificity,
  boundRepresentationProviders,
  typeNamespace,
  declaredFormMimes,
  discoverArtifactPacks,
  discoverArtifactPackNames,
  reachableWinners,
  expectedArtifactPackNames,
  missingArtifactPacks,
  inventoryTypes,
  classifyDeclaredTypes,
  diffAgainstBaseline,
  baselineGrowth,
  readBaseBaseline,
} from "../artifact-review-floor-gate.mjs";

const GATE = fileURLToPath(new URL("../artifact-review-floor-gate.mjs", import.meta.url));
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const BASELINE_REL = "scripts/audit/artifact-review-floor.baseline.json";

const src = (rel) => readFileSync(join(REPO_ROOT, rel), "utf8");

function runGate(args) {
  try {
    const stdout = execFileSync(process.execPath, [GATE, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    return { status: e.status, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

/** A throwaway extensions tree: `<root>/cinatra-ai/<dir>/package.json`. */
function fixtureTree(packs) {
  const root = mkdtempSync(join(tmpdir(), "floor-gate-"));
  for (const p of packs) {
    const dir = join(root, "cinatra-ai", p.dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: p.name, cinatra: { kind: "artifact", artifact: p.artifact } }, null, 2),
    );
  }
  return root;
}

// ---------------------------------------------------------------------------
// Rule derivation — read from the canonical source's CURRENT text, FAIL CLOSED.
// ---------------------------------------------------------------------------

test("the MIME allowlist is read from the host's live safe-transport set", () => {
  const allow = readMimeAllowlist(src(CANONICAL_SOURCES.mimeAllowlist));
  assert.ok(allow.has("text/markdown"));
  assert.ok(allow.has("application/pdf"));
  assert.ok(allow.has("image/png"));
  // The two forms the floor gate's own baseline turns on, and the wildcard
  // over-reach a raw pattern would allow: neither is a safe-transport form.
  assert.ok(!allow.has("text/html"));
  assert.ok(!allow.has("image/bmp"));
  assert.ok(!allow.has("application/vnd.cinatra.dashboard+json"));
});

test("the allowlist reader REFUSES a set literal it cannot fully account for", () => {
  const doctored =
    'const PREVIEW_INLINE_MIME_ALLOWLIST: ReadonlySet<string> = new Set([\n  "text/plain",\n  ...EXTRA_MIMES,\n]);';
  assert.throws(() => readMimeAllowlist(doctored), InfraError);
});

test("the MIME->handler arms are the COMPLETE live pickHandler map", () => {
  const map = readHandlerMap(src(CANONICAL_SOURCES.handlerMap));
  assert.deepEqual(
    [...map.entries()].sort(),
    [
      ["text/markdown", "markdown"],
      ["text/plain", "text"],
      ["text/x-markdown", "markdown"],
    ],
    "every host-owned arm is derived — a missed arm would silently classify a live form as a fallback",
  );
});

test("the handler reader REFUSES a statement it cannot parse (no silently narrower map)", () => {
  // The exact silent-narrowing shape: the markdown arm moves behind a set
  // membership test, so a MIME-literal scan of the body would find nothing to
  // complain about while the derived map quietly loses two live forms.
  const doctored = [
    "export function pickHandler(mime: string): HandlerKind {",
    "  if (MARKDOWN_MIMES.has(mime)) return \"markdown\";",
    '  if (mime === "text/plain") return "text";',
    '  return "fallback";',
    "}",
  ].join("\n");
  assert.throws(() => readHandlerMap(doctored), InfraError);

  // A multi-line but still structurally-flat arm is derived, not refused.
  const reformatted = [
    "export function pickHandler(mime: string): HandlerKind {",
    "  if (",
    '    mime === "text/markdown" ||',
    '    mime === "text/x-markdown"',
    '  ) return "markdown";',
    '  return "fallback";',
    "}",
  ].join("\n");
  assert.deepEqual([...readHandlerMap(reformatted).keys()].sort(), ["text/markdown", "text/x-markdown"]);
});

test("the consumed form arms are the COMPLETE set the review binder's rung takes", () => {
  assert.deepEqual([...readConsumedFormArms(src(CANONICAL_SOURCES.reviewBinder))].sort(), ["markdown", "text"]);
});

test("the dashboard form's MIME is read from the host twin writer", () => {
  assert.equal(readDashboardMime(src(CANONICAL_SOURCES.dashboardMime)), "application/vnd.cinatra.dashboard+json");
});

test("every generated build-map entry parses, with the fields the host projection reads", () => {
  const entries = readGeneratedRendererEntries(src(CANONICAL_SOURCES.generatedRenderers));
  assert.ok(entries.length > 5);
  for (const e of entries) {
    assert.match(e.key, /^@[\w/-]+::(detail|preview|listRow)$/);
    assert.ok(["required", "guardedOptional"].includes(e.resolution), e.resolution);
    assert.equal(e.key, `${e.packageName}::${e.slot}`);
  }
});

test("the generated-map reader REFUSES an entry it cannot parse", () => {
  const doctored =
    "export const GENERATED_ARTIFACT_RENDERERS: Record<string, GeneratedArtifactRendererEntry> = {\n" +
    '  "@x/y::detail": { resolution: "required", "packageName":"@x/y","slot":"detail" },\n};';
  assert.throws(() => readGeneratedRendererEntries(doctored), InfraError);
});

// ---------------------------------------------------------------------------
// The mirrored matcher stays byte-equal to its canonical TS source.
// ---------------------------------------------------------------------------

test("representationMatchSpecificity mirrors its canonical TS implementation", () => {
  const ts = src("packages/objects/src/artifact-renderer-registry.ts");
  const m = ts.match(/export function representationMatchSpecificity\([\s\S]*?\n\}/);
  assert.ok(m, "canonical representationMatchSpecificity not found");
  const normalize = (s) =>
    s.replace(/\/\/[^\n]*/g, "").replace(/:\s*(string|number)\b/g, "").replace(/\s+/g, " ").trim();
  assert.equal(normalize(representationMatchSpecificity.toString()), normalize(m[0]).replace(/^export function /, "function "));
});

test("the matcher ranks exact over type-wildcard over */*", () => {
  assert.equal(representationMatchSpecificity("image/png", "image/png"), 3);
  assert.equal(representationMatchSpecificity("image/*", "image/png"), 2);
  assert.equal(representationMatchSpecificity("*/*", "image/png"), 1);
  assert.equal(representationMatchSpecificity("video/*", "image/png"), -1);
});

// ---------------------------------------------------------------------------
// Bound representation providers — the host projection, not the raw manifest.
// ---------------------------------------------------------------------------

const ENTRIES = [
  { key: "@acme/image-artifact::detail", resolution: "required", packageName: "@acme/image-artifact", slot: "detail", representations: ["image/*"] },
  { key: "@acme/snap-artifact::detail", resolution: "guardedOptional", packageName: "@acme/snap-artifact", slot: "detail", representations: ["application/x-snap"] },
  { key: "@acme/image-artifact::preview", resolution: "required", packageName: "@acme/image-artifact", slot: "preview", representations: ["image/*"] },
];
const ALLOW = new Set(["text/markdown", "text/x-markdown", "text/plain", "image/png", "image/webp", "application/pdf"]);

test("a wildcard binds ONLY the safe-transport MIMEs it matches, never the raw pattern", () => {
  const bound = boundRepresentationProviders(ENTRIES, ALLOW, "detail");
  assert.deepEqual([...bound.keys()].sort(), ["image/png", "image/webp"]);
  // A raw pattern would over-reach: a system base points at the preview route,
  // which 415s an unallowlisted MIME, so `image/*` must NOT claim image/bmp.
  assert.equal(bound.get("image/bmp"), undefined);
});

test("a guardedOptional provider is NOT assumed bound (it binds per org, from install rows)", () => {
  const bound = boundRepresentationProviders(ENTRIES, new Set([...ALLOW, "application/x-snap"]), "detail");
  assert.equal(bound.get("application/x-snap"), undefined);
});

test("only the slot the review path resolves at is projected", () => {
  const bound = boundRepresentationProviders(ENTRIES, ALLOW, "detail");
  for (const pkg of bound.values()) assert.equal(pkg, "@acme/image-artifact");
});

// ---------------------------------------------------------------------------
// Inventory.
// ---------------------------------------------------------------------------

test("the identity winner is the type id's NAMESPACE, not the declaring pack", () => {
  assert.equal(typeNamespace("@cinatra-ai/text-artifact:artifact"), "@cinatra-ai/text-artifact");
  assert.equal(typeNamespace("@cinatra-ai/drupal:node"), "@cinatra-ai/drupal");
  assert.equal(typeNamespace("not-a-type"), null);
});

test("declared form MIMEs cover file, connectorRef and the dashboard form", () => {
  assert.deepEqual(
    declaredFormMimes({ file: { mimeTypes: ["text/markdown"] }, connectorRef: { resolvedMimeTypes: ["text/html"] }, dashboard: true }, "application/vnd.x+json"),
    ["text/markdown", "text/html", "application/vnd.x+json"],
  );
});

test("a cross-namespace claim is still a live type; a malformed id is skipped as the bridge skips it", () => {
  const inv = inventoryTypes(
    [
      { packageName: "@acme/drupal-artifacts", types: ["@acme/drupal:node", "bare-id"], accepts: { connectorRef: { resolvedMimeTypes: ["text/html"] } } },
    ],
    "application/vnd.x+json",
  );
  assert.deepEqual(inv.map((e) => e.type), ["@acme/drupal:node"]);
  assert.deepEqual(inv[0].formMimes, ["text/html"]);
});

// ---------------------------------------------------------------------------
// The classifier — the review path's ladder, rung for rung.
// ---------------------------------------------------------------------------

const RULES = {
  mimeAllowlist: ALLOW,
  handlerMap: new Map([["text/markdown", "markdown"], ["text/x-markdown", "markdown"], ["text/plain", "text"]]),
  consumedFormArms: new Set(["markdown", "text"]),
  dashboardMime: "application/vnd.cinatra.dashboard+json",
};
const classify = (packs, generatedEntries = []) => classifyDeclaredTypes({ ...RULES, packs, generatedEntries });

test("RED — a type with no renderer and a form no rung renders IS a floor type", () => {
  const { floorTypes } = classify([
    { packageName: "@acme/thing-artifact", types: ["@acme/thing-artifact:thing"], accepts: { file: { mimeTypes: ["application/x-acme"] } } },
  ]);
  assert.deepEqual(floorTypes.map((f) => f.type), ["@acme/thing-artifact:thing"]);
});

test("a pack with NO display file is not counted when its declared text form renders", () => {
  const { floorTypes } = classify([
    { packageName: "@acme/note-artifact", types: ["@acme/note-artifact:note"], accepts: { file: { mimeTypes: ["text/markdown"] } } },
  ]);
  assert.deepEqual(floorTypes, [], "the form rung renders it — 'not packages missing a display file'");
});

test("a pack with no renderer is not counted when a BOUND system provider covers its form", () => {
  const { floorTypes, rows } = classify(
    [
      { packageName: "@acme/shot-artifact", types: ["@acme/shot-artifact:shot"], accepts: { file: { mimeTypes: ["image/png"] } } },
      { packageName: "@acme/image-artifact", types: ["@acme/image-artifact:image"], accepts: { file: { mimeTypes: ["image/png"] } } },
    ],
    ENTRIES,
  );
  assert.deepEqual(floorTypes, []);
  assert.equal(rows.find((r) => r.type === "@acme/shot-artifact:shot").via, "@acme/image-artifact");
});

test("RED — a form outside the safe-transport set is NOT covered by a wildcard provider", () => {
  const { floorTypes } = classify(
    [{ packageName: "@acme/bmp-artifact", types: ["@acme/bmp-artifact:bmp"], accepts: { file: { mimeTypes: ["image/bmp"] } } }],
    ENTRIES,
  );
  assert.deepEqual(floorTypes.map((f) => f.type), ["@acme/bmp-artifact:bmp"], "image/* must not claim a MIME the preview route refuses");
});

test("a form the build carries no renderer for falls through to the form rung, not a defensive read", () => {
  const { floorTypes, rows } = classify(
    [{ packageName: "@acme/note-artifact", types: ["@acme/note-artifact:note"], accepts: { file: { mimeTypes: ["text/markdown"] } } }],
    [],
  );
  assert.deepEqual(floorTypes, []);
  assert.equal(rows[0].rung, "form:markdown");
});

test("the semantic rung is evaluated at the BASE identity — the type id's namespace definer", () => {
  // The CLAIMING pack ships a detail renderer, but the type lives in another
  // namespace, so at the base identity (no assertion on the row) the winner is
  // that namespace, which ships nothing here. Fail-closed: counted.
  const cross = classify(
    [{ packageName: "@acme/drupal-artifacts", types: ["@acme/drupal:node"], accepts: { connectorRef: { resolvedMimeTypes: ["text/html"] } } }],
    [{ key: "@acme/drupal-artifacts::detail", resolution: "required", packageName: "@acme/drupal-artifacts", slot: "detail", representations: ["text/html"] }],
  );
  assert.deepEqual(cross.floorTypes.map((f) => f.type), ["@acme/drupal:node"]);

  // The control: the SAME pack, owning the type, wins the semantic rung.
  const owned = classify(
    [{ packageName: "@acme/drupal-artifacts", types: ["@acme/drupal-artifacts:node"], accepts: { connectorRef: { resolvedMimeTypes: ["text/html"] } } }],
    [{ key: "@acme/drupal-artifacts::detail", resolution: "required", packageName: "@acme/drupal-artifacts", slot: "detail", representations: ["text/html"] }],
  );
  assert.deepEqual(owned.floorTypes, []);
  assert.equal(owned.rows[0].rung, "semantic");
});

test("a type whose declaring packs name no representation form at all is a floor type", () => {
  const { floorTypes } = classify([
    { packageName: "@acme/void-artifact", types: ["@acme/void-artifact:void"], accepts: {} },
  ]);
  assert.deepEqual(floorTypes.map((f) => f.type), ["@acme/void-artifact:void"]);
});

// ---------------------------------------------------------------------------
// Baseline arithmetic.
// ---------------------------------------------------------------------------

test("a new floor type is `added`; a type that stopped flooring is `stale`", () => {
  const d = diffAgainstBaseline([{ type: "b" }, { type: "c" }], { floorTypes: [{ type: "a" }, { type: "b" }] });
  assert.deepEqual(d.added, ["c"]);
  assert.deepEqual(d.stale, ["a"]);
});

test("the committed baseline may only shrink against the base branch", () => {
  assert.deepEqual(baselineGrowth({ floorTypes: [{ type: "a" }, { type: "z" }] }, { floorTypes: [{ type: "a" }] }), ["z"]);
  assert.deepEqual(baselineGrowth({ floorTypes: [{ type: "a" }] }, { floorTypes: [{ type: "a" }, { type: "z" }] }), []);
});

test("the shrink-only guard FAILS CLOSED on a base ref it cannot read", () => {
  assert.throws(() => readBaseBaseline(REPO_ROOT, "no/such/ref/at/all", BASELINE_REL), InfraError);
});

test("an absent baseline on the base branch is the first landing, not a failure", () => {
  assert.equal(readBaseBaseline(REPO_ROOT, "HEAD", "scripts/audit/no-such-baseline-file.json"), null);
});

// ---------------------------------------------------------------------------
// End to end.
// ---------------------------------------------------------------------------

test("RED-FIRST end to end — a fixture type with no renderer fails the gate", () => {
  const root = fixtureTree([
    { dir: "acme-artifact", name: "@acme/acme-artifact", artifact: { accepts: { file: { mimeTypes: ["application/x-acme"] } }, objectTypes: [{ type: "@acme/acme-artifact:thing", claim: "dedicated" }] } },
  ]);
  const empty = join(root, "empty-baseline.json");
  writeFileSync(empty, JSON.stringify({ floorTypes: [] }));
  try {
    const r = runGate(["--extensions-root", root, "--baseline", empty, "--repo-root", REPO_ROOT, "--allow-partial-fleet"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /NEWLY land on the metadata floor/);
    assert.match(r.stderr, /\+ @acme\/acme-artifact:thing/);
    assert.match(r.stdout, /1 of 1 artifact type would land on the metadata floor/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stale baseline entry fails the gate (the baseline only shrinks)", () => {
  const root = fixtureTree([
    { dir: "note-artifact", name: "@acme/note-artifact", artifact: { accepts: { file: { mimeTypes: ["text/markdown"] } }, objectTypes: [{ type: "@acme/note-artifact:note", claim: "dedicated" }] } },
  ]);
  const stale = join(root, "stale-baseline.json");
  writeFileSync(stale, JSON.stringify({ floorTypes: [{ type: "@acme/gone:type" }] }));
  try {
    const r = runGate(["--extensions-root", root, "--baseline", stale, "--repo-root", REPO_ROOT, "--allow-partial-fleet"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no longer land/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unmaterialized extension tree is INFRA (exit 2), never a silent pass", () => {
  const root = mkdtempSync(join(tmpdir(), "floor-gate-empty-"));
  try {
    const r = runGate(["--extensions-root", root, "--repo-root", REPO_ROOT]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /not materialized/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--json puts nothing but the JSON document on stdout", (t) => {
  if (discoverArtifactPacks(join(REPO_ROOT, "extensions")).length === 0) {
    t.skip("companion extension tree not materialized in this checkout");
    return;
  }
  const r = runGate(["--repo-root", REPO_ROOT, "--json"]);
  const parsed = JSON.parse(r.stdout);
  assert.equal(typeof parsed.count, "number");
  assert.equal(parsed.count, parsed.floorTypes.length);
});

test("GREEN — the shipped fleet equals the committed baseline and reports its count", (t) => {
  if (discoverArtifactPacks(join(REPO_ROOT, "extensions")).length === 0) {
    t.skip("companion extension tree not materialized in this checkout");
    return;
  }
  const r = runGate(["--repo-root", REPO_ROOT]);
  assert.match(r.stdout, /artifact types would land on the metadata floor/);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /OK — no new fallbacks/);
  const baseline = JSON.parse(src(BASELINE_REL));
  // A plain substring check: building a RegExp from a type id would need every
  // metacharacter escaped, and a half-escaped one is worse than none.
  for (const e of baseline.floorTypes) assert.ok(r.stdout.includes(`floor: ${e.type}`), e.type);
});

// ---------------------------------------------------------------------------
// THE BUILD MAP IS THE AUTHORITY for a bundled pack (a dropped `ui` never
// reaches it), so a manifest declaration alone never credits a renderer.
// ---------------------------------------------------------------------------

test("RED — a manifest that DECLARES a renderer absent from the build map is not credited", () => {
  // The malformed / ABI-incompatible `ui` shape: the bridge keeps the pack's
  // types and DROPS the ui, so production resolves no semantic renderer. Reading
  // the manifest would pass this type; reading the build map counts it.
  const pack = {
    packageName: "@acme/bad-artifact",
    types: ["@acme/bad-artifact:thing"],
    accepts: { file: { mimeTypes: ["application/x-acme"] } },
  };
  assert.deepEqual(classify([pack], []).floorTypes.map((f) => f.type), ["@acme/bad-artifact:thing"]);
  // The control: the same pack once the generator emits its renderer.
  const built = [{ key: "@acme/bad-artifact::detail", resolution: "required", packageName: "@acme/bad-artifact", slot: "detail", representations: [] }];
  assert.deepEqual(classify([pack], built).floorTypes, []);
});

test("RED end to end — a manifest-only renderer declaration still fails the gate", () => {
  const root = fixtureTree([
    {
      dir: "bad-artifact",
      name: "@acme/bad-artifact",
      artifact: {
        accepts: { file: { mimeTypes: ["application/x-acme"] } },
        objectTypes: [{ type: "@acme/bad-artifact:thing", claim: "dedicated" }],
        ui: { abiVersion: 1, sdkAbiRange: "^2.4.0", renderers: { detail: { entry: "./src/renderers/detail.tsx", propsApiVersion: 1 } } },
      },
    },
  ]);
  const empty = join(root, "b.json");
  writeFileSync(empty, JSON.stringify({ floorTypes: [] }));
  try {
    const r = runGate(["--extensions-root", root, "--baseline", empty, "--repo-root", REPO_ROOT, "--allow-partial-fleet"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /@acme\/bad-artifact:thing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Reachable winners — an assertion can REMOVE the base renderer.
// ---------------------------------------------------------------------------

test("the reachable winners are the base identity PLUS every pack that claims the type", () => {
  const packs = [
    { packageName: "@acme/o-artifact", types: ["@acme/o-artifact:t"], accepts: {} },
    { packageName: "@acme/c-artifact", types: ["@acme/o-artifact:t"], accepts: {} },
  ];
  assert.deepEqual(reachableWinners("@acme/o-artifact:t", packs), ["@acme/c-artifact", "@acme/o-artifact"]);
});

test("RED — the OWNER renders but a live foreign CLAIMANT does not: the type is counted", () => {
  // The counterexample an assertion makes reachable: an unasserted row presents
  // as the owner and renders; a row asserted onto the claimant resolves no
  // semantic renderer, and its form has no lower rung. Evaluating the base
  // identity ALONE would pass this type.
  const entries = [
    { key: "@acme/o-artifact::detail", resolution: "required", packageName: "@acme/o-artifact", slot: "detail", representations: [] },
  ];
  const owned = { packageName: "@acme/o-artifact", types: ["@acme/o-artifact:t"], accepts: { file: { mimeTypes: ["application/x-acme"] } } };
  const claimant = { packageName: "@acme/c-artifact", types: ["@acme/o-artifact:t"], accepts: { file: { mimeTypes: ["application/x-acme"] } } };

  assert.deepEqual(classify([owned], entries).floorTypes, [], "owner alone: renders");
  assert.deepEqual(
    classify([owned, claimant], entries).floorTypes.map((f) => f.type),
    ["@acme/o-artifact:t"],
    "a live rendererless claimant makes the floor reachable",
  );
});

test("the semantic rung is TYPE-EXACT — a pack's renderer does not cover a type it never claims", () => {
  const entries = [
    { key: "@acme/o-artifact::detail", resolution: "required", packageName: "@acme/o-artifact", slot: "detail", representations: [] },
  ];
  // The pack ships a detail renderer, but for a DIFFERENT type it claims; the
  // type under test is registered by its namespace with no renderer of its own.
  const packs = [
    { packageName: "@acme/o-artifact", types: ["@acme/o-artifact:other"], accepts: { file: { mimeTypes: ["application/x-acme"] } } },
    { packageName: "@acme/w-artifact", types: ["@acme/o-artifact:t"], accepts: { file: { mimeTypes: ["application/x-acme"] } } },
  ];
  assert.deepEqual(classify(packs, entries).floorTypes.map((f) => f.type), ["@acme/o-artifact:t"]);
});

// ---------------------------------------------------------------------------
// Materialization completeness.
// ---------------------------------------------------------------------------

test("the expected fleet is the pinned locks, narrowed to artifact packs", () => {
  const expected = expectedArtifactPackNames(REPO_ROOT);
  assert.ok(expected.size > 5);
  for (const n of expected) assert.match(n, /-artifacts?$/);
});

test("a materialized pack that declares no objectTypes is PRESENT, not missing", () => {
  assert.deepEqual(missingArtifactPacks(new Set(["@a/x-artifact"]), new Set(["@a/x-artifact"])), []);
  assert.deepEqual(missingArtifactPacks(new Set(["@a/x-artifact"]), new Set()), ["@a/x-artifact"]);
});

test("RED — a PARTIALLY materialized tree is INFRA (exit 2), never a pass", () => {
  const root = fixtureTree([
    { dir: "note-artifact", name: "@acme/note-artifact", artifact: { accepts: { file: { mimeTypes: ["text/markdown"] } }, objectTypes: [{ type: "@acme/note-artifact:note", claim: "dedicated" }] } },
  ]);
  try {
    const r = runGate(["--extensions-root", root, "--repo-root", REPO_ROOT]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /PARTIALLY materialized/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the on-disk scan names every artifact pack dir, typed or not", (t) => {
  const shipped = join(REPO_ROOT, "extensions");
  if (discoverArtifactPacks(shipped).length === 0) {
    t.skip("companion extension tree not materialized in this checkout");
    return;
  }
  const names = discoverArtifactPackNames(shipped);
  assert.ok(names.size >= discoverArtifactPacks(shipped).length);
});

// ---------------------------------------------------------------------------
// Remaining parser fail-closed pins.
// ---------------------------------------------------------------------------

test("the handler reader recognizes the allowlist guard by its EXACT identifier", () => {
  const other = [
    "export function pickHandler(mime: string): HandlerKind {",
    '  if (!PREVIEW_INLINE_MIME_ALLOWLIST_NARROWED.has(mime)) return "fallback";',
    '  if (mime === "text/plain") return "text";',
    '  return "fallback";',
    "}",
  ].join("\n");
  assert.throws(() => readHandlerMap(other), InfraError, "a differently-named guard is not the one the classifier models");
});

test("the generated-map reader REFUSES table residue it cannot account for", () => {
  const doctored =
    "export const GENERATED_ARTIFACT_RENDERERS: Record<string, GeneratedArtifactRendererEntry> = {\n" +
    '  "@x/y::detail": { resolution: "required", "packageName":"@x/y","slot":"detail","representations":[] },\n' +
    "  ...EXTRA_RENDERERS,\n};";
  assert.throws(() => readGeneratedRendererEntries(doctored), InfraError);
});
