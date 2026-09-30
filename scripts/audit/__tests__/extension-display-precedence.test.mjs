// extension-display-precedence tests (cinatra#3821, class 8).
//
// AN EXTENSION'S DISPLAY OUTRANKS THE HOST'S OWN ON EVERY SURFACE. Every
// function exported by the module that declares the dispatch type, whose return
// type is that type, is read from the module through the type checker (never
// typed here) and driven with two cases:
//   CASE TYPE — an extension's display is registered for the artifact's type:
//     the result is that semantic display, whatever the representation;
//   CASE REPRESENTATION — an extension's display is registered for the
//     representation: the result is that representation display.
// Any other result — a display of the host's own above all — fails, naming the
// function, the case, the pattern and the parameter values.
//
// Every class has its own test that is red first. The fixtures live under a
// temporary directory and are removed after the suite; their names use the
// owner `@example-org/…`. The last block is the TEST OF RECORD over the real tree.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DISPATCH_MODULE,
  REPO_ROOT,
  buildDispatchModel,
  enumerateDispatchFunctions,
  listDispatchConsumers,
} from "../host-display-floor-gate.mjs";

const FIXTURE_TIMEOUT = 60_000;
const RECORD_TIMEOUT = 120_000;

const TYPE_PACKAGE = "@example-org/widget-artifacts";
const OTHER_PACKAGE = "@example-org/other-display";
const DISPLAY_PACKAGE = "@example-org/text-display";
const PLAIN_TYPE_PACKAGE = "@example-org/plain-type";

// ---------------------------------------------------------------------------
// The precedence check (the two cases).
// ---------------------------------------------------------------------------

function cartesian(domains) {
  return domains.reduce((acc, d) => acc.flatMap((a) => d.map((v) => [...a, v])), [[]]);
}

function show(v) {
  return v === undefined ? "undefined" : JSON.stringify(v);
}

/** Every failure of one enumerated function against both cases, as a message. */
async function precedenceFailures(mod, fnInfo, model) {
  const fn = mod[fnInfo.name];
  if (typeof fn !== "function") return [`${fnInfo.name}: not a function at run time`];
  const failures = [];
  const semantic = { packageName: TYPE_PACKAGE, generatedKey: `${TYPE_PACKAGE}::detail`, built: true };
  const typeRepresentations = [
    null,
    ...model.handlerKinds.map((handler) => ({ tier: "first-party", handler })),
    {
      tier: "extension",
      packageName: OTHER_PACKAGE,
      generatedKey: `${OTHER_PACKAGE}::detail`,
      pattern: model.representationPatterns[0],
      slot: "detail",
      built: true,
    },
  ];
  const representationIdentities = [
    [{ kind: "no-primary" }, null],
    [{ kind: "extension", extension: PLAIN_TYPE_PACKAGE }, null],
  ];
  for (const params of cartesian(fnInfo.domains)) {
    const where = `parameters (${fnInfo.paramNames
      .slice(1)
      .map((n, i) => `${n}=${show(params[i])}`)
      .join(", ")})`;
    for (const representation of typeRepresentations) {
      const r = await fn({ identity: { kind: "extension", extension: TYPE_PACKAGE }, semantic, representation }, ...params);
      if (!(r?.kind === "semantic" && r.packageName === TYPE_PACKAGE && r.generatedKey === semantic.generatedKey)) {
        failures.push(
          `${fnInfo.name} CASE TYPE (an extension's display is registered for the artifact's type): ` +
            `representation ${show(representation)}, ${where} -> ${show(r)}`,
        );
      }
    }
    for (const pattern of model.representationPatterns) {
      for (const [identity, noSemantic] of representationIdentities) {
        const representation = {
          tier: "extension",
          packageName: DISPLAY_PACKAGE,
          generatedKey: `${DISPLAY_PACKAGE}::detail`,
          pattern,
          slot: "detail",
          built: true,
        };
        const r = await fn({ identity, semantic: noSemantic, representation }, ...params);
        if (
          !(r?.kind === "representation" && r.packageName === DISPLAY_PACKAGE && r.generatedKey === representation.generatedKey)
        ) {
          failures.push(
            `${fnInfo.name} CASE REPRESENTATION (an extension's display is registered for the representation): ` +
              `pattern ${pattern}, identity ${show(identity)}, ${where} -> ${show(r)}`,
          );
        }
      }
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------
// Fixture trees.
// ---------------------------------------------------------------------------

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    lib: ["esnext"],
    strict: true,
    module: "esnext",
    moduleResolution: "bundler",
    jsx: "preserve",
    noEmit: true,
    allowImportingTsExtensions: true,
    types: [],
    paths: { "@/*": ["./src/*"] },
  },
});

const REVIEW = `export type ReviewFormArm = "markdown" | "text";
export type ReviewTargetMount =
  | { kind: "build-map"; slot: "detail"; packageName: string; generatedKey: string }
  | { kind: "form"; slot: "detail"; arm: "first-party"; form: ReviewFormArm };
`;

const TYPES = `type HandlerKind = "markdown" | "text" | "pdf" | "image" | "video" | "audio" | "fallback";
type EffectiveIdentity = { kind: "extension"; extension: string } | { kind: "no-primary" };
type ArtifactUiSlot = "detail" | "preview";

export interface SemanticRendererResolution {
  packageName: string;
  generatedKey: string;
  built: boolean;
}
export type RepresentationRendererResolution =
  | { tier: "extension"; packageName: string; generatedKey: string; pattern: string; slot: ArtifactUiSlot; built: boolean }
  | { tier: "first-party"; handler: Exclude<HandlerKind, "fallback"> };
export interface ArtifactRenderDispatchInput {
  identity: EffectiveIdentity;
  semantic: SemanticRendererResolution | null;
  representation: RepresentationRendererResolution | null;
}
export type ArtifactRenderDispatch =
  | { kind: "semantic"; packageName: string; generatedKey: string }
  | { kind: "representation"; packageName: string; generatedKey: string; pattern: string }
  | { kind: "mime"; handler: Exclude<HandlerKind, "fallback"> }
  | { kind: "requires-rebuild"; packageName: string; slot: ArtifactUiSlot }
  | { kind: "fallback" };
`;

// main's pickArtifactRenderer and isSelectionPreparing (src/app/artifacts/[id]/renderer-dispatch.ts),
// code unchanged; its three type imports are replaced by the local unions of TYPES.
const MAIN_FUNCTIONS = `export function pickArtifactRenderer(
  input: ArtifactRenderDispatchInput,
): ArtifactRenderDispatch {
  if (
    input.identity.kind === "extension" &&
    input.semantic &&
    input.semantic.packageName === input.identity.extension
  ) {
    if (input.semantic.built) {
      return {
        kind: "semantic",
        packageName: input.semantic.packageName,
        generatedKey: input.semantic.generatedKey,
      };
    }
    return { kind: "requires-rebuild", packageName: input.semantic.packageName, slot: "detail" };
  }

  if (input.representation) {
    if (input.representation.tier === "extension") {
      if (input.representation.built) {
        return {
          kind: "representation",
          packageName: input.representation.packageName,
          generatedKey: input.representation.generatedKey,
          pattern: input.representation.pattern,
        };
      }
      return {
        kind: "requires-rebuild",
        packageName: input.representation.packageName,
        slot: input.representation.slot,
      };
    }
    return { kind: "mime", handler: input.representation.handler };
  }

  return { kind: "fallback" };
}

export function isSelectionPreparing(_identity: EffectiveIdentity): boolean {
  return false;
}
`;

// The review-target rule of the open change that let the host's own markdown
// display take the place of the extension's (its renderer-dispatch.ts, the
// declarations at :143-201, blob 88bf5c56874780e41bd59de29c445454f5ac7e44),
// code unchanged.
const REVIEW_TARGET_RULE = `export type DeclaredMarkdownForm = Extract<HandlerKind, "markdown">;

export function pickReviewTargetRenderer(
  input: ArtifactRenderDispatchInput,
  declaredMarkdownForm: DeclaredMarkdownForm | null,
): ArtifactRenderDispatch {
  const dispatch = pickArtifactRenderer(input);
  if (declaredMarkdownForm === null) return dispatch;
  if (dispatch.kind !== "representation") return dispatch;
  return { kind: "mime", handler: declaredMarkdownForm };
}
`;

const roots = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function makeTree(files) {
  const root = mkdtempSync(join(tmpdir(), "extension-display-precedence-"));
  roots.push(root);
  const all = {
    "tsconfig.json": TSCONFIG,
    "src/lib/artifacts/artifact-review-preparation.ts": REVIEW,
    ...files,
  };
  for (const [rel, text] of Object.entries(all)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

/** The model, the enumeration and the dispatch module of a tree, as the test of record reads them. */
async function readTree(root) {
  const consumers = listDispatchConsumers(root);
  const model = buildDispatchModel(root, { extraRoots: consumers });
  const enumeration = enumerateDispatchFunctions(model, consumers);
  const mod = await import(join(root, DISPATCH_MODULE));
  return { consumers, model, enumeration, mod };
}

async function failuresOf(tree) {
  const out = {};
  for (const f of tree.enumeration.functions) out[f.name] = await precedenceFailures(tree.mod, f, tree.model);
  return out;
}

// ---------------------------------------------------------------------------

describe("T-D1 the enumeration is read from the module, never typed", () => {
  let tree;
  beforeAll(async () => {
    tree = await readTree(
      makeTree({
        [DISPATCH_MODULE]: `${TYPES}
${MAIN_FUNCTIONS}
export function pickWidgetRenderer(input: ArtifactRenderDispatchInput, mode: string): ArtifactRenderDispatch {
  return mode === "" ? { kind: "fallback" } : pickArtifactRenderer(input);
}

export async function pickWidgetRendererLater(
  input: ArtifactRenderDispatchInput,
  strict: boolean,
): Promise<ArtifactRenderDispatch> {
  return strict ? pickArtifactRenderer(input) : pickArtifactRenderer(input);
}
`,
        "src/app/widget/widget-consumer.ts": `import {
  pickArtifactRenderer,
  type ArtifactRenderDispatch,
  type ArtifactRenderDispatchInput,
} from "@/app/artifacts/[id]/renderer-dispatch";

function chooseWidget(input: ArtifactRenderDispatchInput): ArtifactRenderDispatch {
  if (input.representation === null) return { kind: "fallback" };
  return pickArtifactRenderer(input);
}

export const delegating = (input: ArtifactRenderDispatchInput): ArtifactRenderDispatch => pickArtifactRenderer(input);

export function widgetKind(input: ArtifactRenderDispatchInput): string {
  return chooseWidget(input).kind;
}
`,
      }),
    );
  }, FIXTURE_TIMEOUT);

  it("an exported function returning the dispatch is enumerated, a boolean-returning export is not", () => {
    expect(tree.enumeration.functions.map((f) => f.name)).toEqual([
      "pickArtifactRenderer",
      "pickWidgetRenderer",
      "pickWidgetRendererLater",
    ]);
    const later = tree.enumeration.functions.find((f) => f.name === "pickWidgetRendererLater");
    expect(later.paramNames).toEqual(["input", "strict"]);
    expect([...later.domains[0]].sort()).toEqual([false, true]);
  });

  it("a non-exported dispatch function in a consumer fails by name; a caller that only delegates does not", () => {
    expect(tree.consumers).toEqual(["src/app/widget/widget-consumer.ts"]);
    expect(tree.enumeration.problems).toContain(
      "src/app/widget/widget-consumer.ts :: chooseWidget: a dispatch function outside the dispatch module: cover it here or move it",
    );
    expect(tree.enumeration.problems.some((p) => p.includes(":: delegating:"))).toBe(false);
  });

  it("a function whose second parameter is `string` fails by name as not enumerable", () => {
    expect(tree.enumeration.problems).toContain(
      `${DISPATCH_MODULE} :: pickWidgetRenderer: the parameter "mode" (string) is not a finite union of literal types, so the test cannot enumerate it`,
    );
    expect(tree.enumeration.problems).toHaveLength(2);
  });

  it("an overloaded dispatch function fails by name as not enumerable", async () => {
    const overloaded = await readTree(
      makeTree({
        [DISPATCH_MODULE]: `${TYPES}
${MAIN_FUNCTIONS}
export function pickWidgetByMode(input: ArtifactRenderDispatchInput, mode: "extension"): ArtifactRenderDispatch;
export function pickWidgetByMode(input: ArtifactRenderDispatchInput, mode: "host"): ArtifactRenderDispatch;
export function pickWidgetByMode(input: ArtifactRenderDispatchInput, mode: "extension" | "host"): ArtifactRenderDispatch {
  return mode === "host" ? { kind: "fallback" } : pickArtifactRenderer(input);
}
`,
      }),
    );
    expect(overloaded.enumeration.problems).toEqual([
      `${DISPATCH_MODULE} :: pickWidgetByMode: it declares 2 call signatures, so the test cannot enumerate it`,
    ]);
  }, FIXTURE_TIMEOUT);
});

describe("T-D2 the review-target rule that puts the host's markdown display above the extension's is red", () => {
  let tree;
  let failures;
  beforeAll(async () => {
    tree = await readTree(
      makeTree({ [DISPATCH_MODULE]: `${TYPES}\n${MAIN_FUNCTIONS}\n${REVIEW_TARGET_RULE}` }),
    );
    failures = await failuresOf(tree);
  }, FIXTURE_TIMEOUT);

  it("the enumeration names both functions", () => {
    expect(tree.enumeration.functions.map((f) => f.name)).toEqual(["pickArtifactRenderer", "pickReviewTargetRenderer"]);
    expect(tree.enumeration.problems).toEqual([]);
    const rule = tree.enumeration.functions.find((f) => f.name === "pickReviewTargetRenderer");
    expect(rule.paramNames).toEqual(["input", "declaredMarkdownForm"]);
    expect([...rule.domains[0]].sort()).toEqual(["markdown", null]);
  });

  it("the precedence check reports pickReviewTargetRenderer for CASE REPRESENTATION with the parameter value markdown", () => {
    const rule = failures.pickReviewTargetRenderer;
    expect(rule.length).toBeGreaterThan(0);
    expect(rule.every((f) => f.startsWith("pickReviewTargetRenderer CASE REPRESENTATION"))).toBe(true);
    expect(rule.every((f) => f.includes(`declaredMarkdownForm="markdown"`))).toBe(true);
    expect(rule.some((f) => f.includes("pattern text/markdown") && f.includes(`{"kind":"mime","handler":"markdown"}`))).toBe(
      true,
    );
  });

  it("pickArtifactRenderer passes both cases", () => {
    expect(failures.pickArtifactRenderer).toEqual([]);
  });
});

describe("T-D3 the two cases", () => {
  const dispatchWith = (body) => `${TYPES}
export function pickArtifactRenderer(input: ArtifactRenderDispatchInput): ArtifactRenderDispatch {
  const rep = input.representation;
${body}
  return { kind: "fallback" };
}
`;
  const SEMANTIC = `  if (input.identity.kind === "extension" && input.semantic && input.semantic.built) {
    return { kind: "semantic", packageName: input.semantic.packageName, generatedKey: input.semantic.generatedKey };
  }
`;
  const PROVIDER = `  if (rep && rep.tier === "extension" && rep.built) {
    return { kind: "representation", packageName: rep.packageName, generatedKey: rep.generatedKey, pattern: rep.pattern };
  }
`;
  const FIRST_PARTY = `  if (rep && rep.tier === "first-party") return { kind: "mime", handler: rep.handler };
`;
  const MARKDOWN_DEFAULT = `  if (rep && rep.tier === "extension" && rep.pattern === "text/markdown") return { kind: "mime", handler: "markdown" };
`;

  it("a first-party default that outranks the semantic display is refused by CASE TYPE", async () => {
    const f = await failuresOf(await readTree(makeTree({ [DISPATCH_MODULE]: dispatchWith(FIRST_PARTY + SEMANTIC + PROVIDER) })));
    expect(f.pickArtifactRenderer.length).toBe(6);
    expect(f.pickArtifactRenderer.every((m) => m.startsWith("pickArtifactRenderer CASE TYPE"))).toBe(true);
    expect(f.pickArtifactRenderer.some((m) => m.includes(`{"kind":"mime","handler":"markdown"}`))).toBe(true);
  }, FIXTURE_TIMEOUT);

  it("a first-party default below the semantic display is not refused by CASE TYPE", async () => {
    const f = await failuresOf(await readTree(makeTree({ [DISPATCH_MODULE]: dispatchWith(SEMANTIC + FIRST_PARTY + PROVIDER) })));
    expect(f.pickArtifactRenderer).toEqual([]);
  }, FIXTURE_TIMEOUT);

  it("a first-party default that outranks an extension provider is refused by CASE REPRESENTATION", async () => {
    const f = await failuresOf(
      await readTree(makeTree({ [DISPATCH_MODULE]: dispatchWith(SEMANTIC + MARKDOWN_DEFAULT + PROVIDER + FIRST_PARTY) })),
    );
    expect(f.pickArtifactRenderer).toHaveLength(2);
    expect(f.pickArtifactRenderer.every((m) => m.startsWith("pickArtifactRenderer CASE REPRESENTATION"))).toBe(true);
    expect(f.pickArtifactRenderer.every((m) => m.includes("pattern text/markdown"))).toBe(true);
  }, FIXTURE_TIMEOUT);
});

// ---------------------------------------------------------------------------
// THE TEST OF RECORD. The gates run on every pull request of the application,
// beside the sibling gates: this block runs in the root suite (`pnpm test:root`).
// ---------------------------------------------------------------------------

describe("test of record: an extension's display outranks the host's own on every dispatch function", () => {
  let tree;
  let failures;
  let seconds;
  beforeAll(async () => {
    const started = Date.now();
    tree = await readTree(REPO_ROOT);
    failures = await failuresOf(tree);
    seconds = (Date.now() - started) / 1000;
  }, RECORD_TIMEOUT);

  it("at least one dispatch function is enumerated from the dispatch module", () => {
    console.info(
      `[extension-display-precedence test of record] ${tree.enumeration.functions.map((f) => f.name).join(", ")} ` +
        `(${seconds.toFixed(1)} s; patterns ${tree.model.representationPatterns.join(", ")})`,
    );
    expect(tree.enumeration.functions.length).toBeGreaterThan(0);
  });

  it("every dispatch function is enumerable and none stands outside the dispatch module", () => {
    expect(tree.enumeration.problems).toEqual([]);
  });

  it("every enumerated function passes both cases with every parameter value", () => {
    expect(Object.values(failures).flat()).toEqual([]);
  });
});
