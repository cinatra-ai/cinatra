// host-display-floor-gate tests (cinatra#3821, class 7 and the static half of
// class 8).
//
// Every class has its own test that is red first. The fixture trees live under
// a temporary directory and are removed after the suite; every package, type,
// key and component in them uses the owner `@example-org/…`. The last block is
// the TEST OF RECORD: it runs the gate's own scan over the real tree and holds
// the committed floor against it, so the root suite refuses a grown or stale
// floor on every pull request of the application.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BASELINE_REL,
  REPO_ROOT,
  SECTIONS,
  UNASSIGNED,
  checkBaseGuard,
  checkFloor,
  composeBaseline,
  diffGrown,
  diffShrunk,
  ownerProblems,
  scanHostDisplayFloor,
  sectionCounts,
} from "../host-display-floor-gate.mjs";

const FIXTURE_TIMEOUT = 60_000;
const RECORD_TIMEOUT = 120_000;

// ---------------------------------------------------------------------------
// The fixture tree: the dispatch, the review mount, one consumer page, two host
// handlers, a kind table with one host step renderer and one schema-floor kind.
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

const PICK_HANDLER = `export type HandlerKind =
  | "markdown"
  | "text"
  | "pdf"
  | "image"
  | "video"
  | "audio"
  | "fallback";

export function pickHandler(mime: string): HandlerKind {
  if (mime === "text/markdown") return "markdown";
  if (mime === "text/plain") return "text";
  return "fallback";
}
`;

const DISPATCH = `import { type HandlerKind } from "./pick-handler";

type WidgetSlot = "detail" | "preview";
type WidgetIdentity = { kind: "extension"; extension: string } | { kind: "no-primary" };

export interface SemanticRendererResolution { packageName: string; generatedKey: string; built: boolean }
export type RepresentationRendererResolution =
  | { tier: "extension"; packageName: string; generatedKey: string; pattern: string; slot: WidgetSlot; built: boolean }
  | { tier: "first-party"; handler: Exclude<HandlerKind, "fallback"> };
export interface ArtifactRenderDispatchInput {
  identity: WidgetIdentity;
  semantic: SemanticRendererResolution | null;
  representation: RepresentationRendererResolution | null;
}
export type ArtifactRenderDispatch =
  | { kind: "semantic"; packageName: string; generatedKey: string }
  | { kind: "representation"; packageName: string; generatedKey: string; pattern: string }
  | { kind: "mime"; handler: Exclude<HandlerKind, "fallback"> }
  | { kind: "requires-rebuild"; packageName: string; slot: WidgetSlot }
  | { kind: "fallback" };

export function pickArtifactRenderer(input: ArtifactRenderDispatchInput): ArtifactRenderDispatch {
  if (input.identity.kind === "extension" && input.semantic && input.semantic.packageName === input.identity.extension) {
    if (input.semantic.built) {
      return { kind: "semantic", packageName: input.semantic.packageName, generatedKey: input.semantic.generatedKey };
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
      return { kind: "requires-rebuild", packageName: input.representation.packageName, slot: input.representation.slot };
    }
    return { kind: "mime", handler: input.representation.handler };
  }
  return { kind: "fallback" };
}
`;

const reviewModule = (forms = `"markdown" | "text"`) => `export type ReviewFormArm = ${forms};
export type ReviewTargetMount =
  | { kind: "build-map"; slot: "detail"; packageName: string; generatedKey: string }
  | { kind: "form"; slot: "detail"; arm: "first-party"; form: ReviewFormArm }
  | { kind: "floor"; slot: "detail"; packageName: string | null };

export function formMount(form: ReviewFormArm): ReviewTargetMount {
  return { kind: "form", slot: "detail", arm: "first-party", form };
}
`;

const PAGE = `import { pickArtifactRenderer, type ArtifactRenderDispatchInput } from "./renderer-dispatch";
import { WidgetHandler } from "./handlers/widget-handler";
import { FloorCard } from "./handlers/floor-card";
import { SharedFrame } from "@/components/shared-frame";

export function WidgetPage({ input }: { input: ArtifactRenderDispatchInput }) {
  const dispatch = pickArtifactRenderer(input);
  const floor = <FloorCard />;
  switch (dispatch.kind) {
    case "semantic":
    case "representation":
      return <SharedFrame>{dispatch.generatedKey}</SharedFrame>;
    case "mime":
      switch (dispatch.handler) {
        case "markdown":
          return <WidgetHandler />;
        default:
          return floor;
      }
    case "fallback":
    default:
      return floor;
  }
}
`;

const WIDGET_HANDLER = `const WIDGET_LIMIT = 10;

export function WidgetHandler() {
  const items = ["a", "b"].slice(0, WIDGET_LIMIT);
  return <section>{items.join(",")}</section>;
}
`;

const KIND_TABLE = (extra = "") => `import { SchemaOnlyFloorRenderer } from "./schema-field-renderer";
import { WidgetStepRenderer } from "./widget-step-renderer";
${extra ? `import { OtherStepRenderer } from "./other-step-renderer";\n` : ""}
const WIDGET_KIND_TABLE: Record<string, { renderer: unknown }> = {
  "widget-step": { renderer: WidgetStepRenderer },
  "floor-step": { renderer: SchemaOnlyFloorRenderer },
${extra}};

export function knownFieldRendererKinds(): readonly string[] {
  return Object.keys(WIDGET_KIND_TABLE).sort();
}
`;

const BASE = {
  "tsconfig.json": TSCONFIG,
  "src/app/artifacts/[id]/pick-handler.ts": PICK_HANDLER,
  "src/app/artifacts/[id]/renderer-dispatch.ts": DISPATCH,
  "src/lib/artifacts/artifact-review-preparation.ts": reviewModule(),
  "src/app/artifacts/[id]/page.tsx": PAGE,
  "src/app/artifacts/[id]/handlers/widget-handler.tsx": WIDGET_HANDLER,
  "src/app/artifacts/[id]/handlers/floor-card.tsx": `export function FloorCard() {\n  return <div>floor</div>;\n}\n`,
  "src/app/artifacts/[id]/handlers/__tests__/widget-handler.test.tsx": `import { WidgetHandler } from "../widget-handler";\nexport const probe = WidgetHandler;\n`,
  "src/components/shared-frame.tsx": `export function SharedFrame({ children }: { children?: unknown }) {\n  return <div>{children as never}</div>;\n}\n`,
  "src/components/other-screen.tsx": `import { SharedFrame } from "./shared-frame";\nexport const OtherScreen = () => <SharedFrame />;\n`,
  "packages/agents/src/register-default-renderers.ts": KIND_TABLE(),
  "packages/agents/src/schema-field-renderer.tsx": `export function SchemaOnlyFloorRenderer() {\n  return <div />;\n}\n`,
  "packages/agents/src/widget-step-renderer.tsx": `import { useState } from "react";\n\nexport function WidgetStepRenderer() {\n  const [v] = useState(0);\n  return <div>{v}</div>;\n}\n`,
  "packages/agents/src/other-step-renderer.tsx": `export function OtherStepRenderer() {\n  return <div />;\n}\n`,
};

const roots = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function makeTree(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "host-display-floor-"));
  roots.push(root);
  const files = { ...BASE, ...overrides };
  for (const [rel, text] of Object.entries(files)) {
    if (text === null) continue;
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

/** The floor of a tree with every owner filled, as a committed baseline would hold it. */
function committedOf(live) {
  const { baseline } = composeBaseline(null, live);
  for (const s of SECTIONS) for (const v of Object.values(baseline[s])) {
    v.owner = "@example-org/widget-artifacts";
    if (s === "displays") v.removedBy = "@example-org/widget-artifacts#1";
  }
  return baseline;
}

let base;
let committed;
beforeAll(() => {
  base = scanHostDisplayFloor(makeTree());
  committed = committedOf(base);
}, FIXTURE_TIMEOUT);

// ---------------------------------------------------------------------------

describe("T-C1 the closed list of the host's handler kinds", () => {
  it("the fixture's closed list is read with the type checker", () => {
    expect(Object.keys(base.handlerKinds)).toEqual([
      "dispatch :: audio",
      "dispatch :: image",
      "dispatch :: markdown",
      "dispatch :: pdf",
      "dispatch :: text",
      "dispatch :: video",
      "review-form :: markdown",
      "review-form :: text",
    ]);
  });

  it("a seventh handler kind and a third review form are new keys, refused", () => {
    const live = scanHostDisplayFloor(
      makeTree({
        "src/app/artifacts/[id]/pick-handler.ts": PICK_HANDLER.replace(`| "audio"`, `| "audio"\n  | "widget"`),
        "src/lib/artifacts/artifact-review-preparation.ts": reviewModule(`"markdown" | "text" | "widget"`),
      }),
    );
    const { grown } = checkFloor(committed, live);
    expect(grown).toContain("handlerKinds :: dispatch :: widget (0 -> 1)");
    expect(grown).toContain("handlerKinds :: review-form :: widget (0 -> 1)");
  }, FIXTURE_TIMEOUT);

  it("a union with one member fewer is stale", () => {
    const live = scanHostDisplayFloor(
      makeTree({ "src/app/artifacts/[id]/pick-handler.ts": PICK_HANDLER.replace(`  | "video"\n`, "") }),
    );
    const { grown, stale } = checkFloor(committed, live);
    expect(grown).toEqual([]);
    expect(stale).toEqual(["handlerKinds :: dispatch :: video (1 -> 0)"]);
  }, FIXTURE_TIMEOUT);
});

describe("T-C2 the floor set of the host's displays", () => {
  it("the fixture's floor holds the two host handlers, never the shared chrome", () => {
    expect(Object.keys(base.displays)).toEqual([
      "src/app/artifacts/[id]/handlers/floor-card.tsx",
      "src/app/artifacts/[id]/handlers/widget-handler.tsx",
    ]);
    expect(Object.keys(base.stepRenderers)).toEqual([
      "widget-step :: packages/agents/src/widget-step-renderer.tsx",
    ]);
  });

  it("a new file under the handlers directory that draws one content form: a new display, refused, and the handler's imports grown", () => {
    const live = scanHostDisplayFloor(
      makeTree({
        "src/app/artifacts/[id]/handlers/widget-display.tsx": `export function WidgetDisplay() {\n  return <article />;\n}\n`,
        "src/app/artifacts/[id]/handlers/widget-handler.tsx": `import { WidgetDisplay } from "./widget-display";\n\n${WIDGET_HANDLER.replace(
          "return <section>",
          "return <WidgetDisplay />;\n  return <section>",
        )}`,
      }),
    );
    const { grown } = checkFloor(committed, live);
    expect(grown).toContain("displays :: src/app/artifacts/[id]/handlers/widget-display.tsx (0 -> 1)");
    expect(grown).toContain(
      "ceilings :: src/app/artifacts/[id]/handlers/widget-handler.tsx :: import :: src/app/artifacts/[id]/handlers/widget-display (0 -> 1)",
    );
  }, FIXTURE_TIMEOUT);

  const VIEW = `import type { ArtifactRenderDispatch } from "./renderer-dispatch";
import { WidgetPanel } from "@/components/widget-panel";

export function WidgetView({ dispatch }: { dispatch: ArtifactRenderDispatch }) {
  switch (dispatch.kind) {
    case "fallback":
      return <WidgetPanel />;
    default:
      return null;
  }
}
`;
  const PANEL = `export function WidgetPanel() {\n  return <aside />;\n}\n`;

  it("a component mounted in a host branch and imported by no other module is a new display", () => {
    const live = scanHostDisplayFloor(
      makeTree({ "src/app/artifacts/[id]/widget-view.tsx": VIEW, "src/components/widget-panel.tsx": PANEL }),
    );
    expect(checkFloor(committed, live).grown).toContain("displays :: src/components/widget-panel.tsx (0 -> 1)");
  }, FIXTURE_TIMEOUT);

  it("the same component imported also by an unrelated module is shared chrome, not a display", () => {
    const live = scanHostDisplayFloor(
      makeTree({
        "src/app/artifacts/[id]/widget-view.tsx": VIEW,
        "src/components/widget-panel.tsx": PANEL,
        "src/components/elsewhere.tsx": `import { WidgetPanel } from "./widget-panel";\nexport const Elsewhere = () => <WidgetPanel />;\n`,
      }),
    );
    expect(Object.keys(live.displays)).not.toContain("src/components/widget-panel.tsx");
    expect(checkFloor(committed, live).grown).toEqual([]);
  }, FIXTURE_TIMEOUT);

  it("a component mounted in a host branch whose module cannot be resolved is a scanner error, never a pass", () => {
    const root = makeTree({ "src/app/artifacts/[id]/widget-view.tsx": VIEW });
    expect(() => scanHostDisplayFloor(root)).toThrow(
      'src/app/artifacts/[id]/widget-view.tsx: the module "@/components/widget-panel" of the mounted component WidgetPanel cannot be resolved',
    );
  }, FIXTURE_TIMEOUT);

  it("a display mounted under `if (isWidgetType(row.objectType))` is found", () => {
    const live = scanHostDisplayFloor(
      makeTree({
        "src/app/widget-rows/row-view.tsx": `import type { ArtifactRenderDispatch } from "@/app/artifacts/[id]/renderer-dispatch";
import { WidgetTypeCard } from "./widget-type-card";
import { isWidgetType } from "./widget-type";

export function RowView({ row, dispatch }: { row: { objectType: string }; dispatch: ArtifactRenderDispatch }) {
  if (isWidgetType(row.objectType)) {
    return <WidgetTypeCard />;
  }
  return <div>{dispatch.kind}</div>;
}
`,
        "src/app/widget-rows/widget-type-card.tsx": `export function WidgetTypeCard() {\n  return <div />;\n}\n`,
        "src/app/widget-rows/widget-type.ts": `export const isWidgetType = (t: string) => t === "@example-org/widget-artifacts:widget";\n`,
      }),
    );
    expect(checkFloor(committed, live).grown).toContain("displays :: src/app/widget-rows/widget-type-card.tsx (0 -> 1)");
  }, FIXTURE_TIMEOUT);

  it("a kind whose renderer is a component of the host's own is a new step renderer, refused", () => {
    const live = scanHostDisplayFloor(
      makeTree({
        "packages/agents/src/register-default-renderers.ts": KIND_TABLE(`  "other-step": { renderer: OtherStepRenderer },\n`),
      }),
    );
    const { grown } = checkFloor(committed, live);
    expect(grown).toContain("stepRenderers :: other-step :: packages/agents/src/other-step-renderer.tsx (0 -> 1)");
  }, FIXTURE_TIMEOUT);
});

describe("T-C3 the ceilings of a host display", () => {
  it("a grown host display: the ceiling is red — a new top-level declaration", () => {
    const live = scanHostDisplayFloor(
      makeTree({
        "src/app/artifacts/[id]/handlers/widget-handler.tsx": `${WIDGET_HANDLER}\nexport const WIDGET_READING = "none";\n`,
      }),
    );
    expect(checkFloor(committed, live).grown).toEqual([
      "ceilings :: src/app/artifacts/[id]/handlers/widget-handler.tsx :: topLevel (2 -> 3)",
    ]);
  }, FIXTURE_TIMEOUT);

  it("a grown host display: the ceiling is red — a new value import", () => {
    const live = scanHostDisplayFloor(
      makeTree({
        "src/app/artifacts/[id]/handlers/floor-card.tsx": `import { widgetFormat } from "@/lib/widget-format";\n\nexport function FloorCard() {\n  return <div>{widgetFormat("floor")}</div>;\n}\n`,
        "src/lib/widget-format.ts": `export const widgetFormat = (s: string) => s;\n`,
      }),
    );
    expect(checkFloor(committed, live).grown).toEqual([
      "ceilings :: src/app/artifacts/[id]/handlers/floor-card.tsx :: import :: src/lib/widget-format (0 -> 1)",
    ]);
  }, FIXTURE_TIMEOUT);

  it("a line added inside an existing function, or a type-only import, leaves both measures unchanged", () => {
    const live = scanHostDisplayFloor(
      makeTree({
        "src/app/artifacts/[id]/handlers/widget-handler.tsx": `import type { ArtifactRenderDispatch } from "../renderer-dispatch";\n\n${WIDGET_HANDLER.replace(
          "const items",
          "const unused: ArtifactRenderDispatch | null = null;\n  void unused;\n  const items",
        )}`,
      }),
    );
    const { grown, stale } = checkFloor(committed, live);
    expect(grown).toEqual([]);
    expect(stale).toEqual([]);
  }, FIXTURE_TIMEOUT);
});

describe("T-C4 the mechanics of the floor", () => {
  it("a removed display is stale and fails until the floor is ratcheted down", () => {
    const live = scanHostDisplayFloor(
      makeTree({
        "src/app/artifacts/[id]/handlers/floor-card.tsx": null,
        "src/app/artifacts/[id]/page.tsx": PAGE.replace(`import { FloorCard } from "./handlers/floor-card";\n`, "").replace(
          "const floor = <FloorCard />;",
          "const floor = null;",
        ),
      }),
    );
    const { grown, stale } = checkFloor(committed, live);
    expect(grown).toEqual([]);
    expect(stale).toContain("displays :: src/app/artifacts/[id]/handlers/floor-card.tsx (1 -> 0)");
    expect(stale).toContain("ceilings :: src/app/artifacts/[id]/handlers/floor-card.tsx (1 -> 0)");
    const ratchet = composeBaseline(committed, live);
    expect(ratchet.grown).toEqual([]);
    expect(Object.keys(ratchet.baseline.displays)).toEqual(["src/app/artifacts/[id]/handlers/widget-handler.tsx"]);
    expect(checkFloor(ratchet.baseline, live)).toEqual({ grown: [], stale: [], owners: [] });
  }, FIXTURE_TIMEOUT);

  it("--write-baseline refuses a grown floor and writes a new key with owner UNASSIGNED", () => {
    const live = scanHostDisplayFloor(
      makeTree({
        "src/app/artifacts/[id]/handlers/widget-display.tsx": `export function WidgetDisplay() {\n  return <article />;\n}\n`,
      }),
    );
    const refused = composeBaseline(committed, live);
    expect(refused.baseline).toBeNull();
    expect(refused.grown).toContain("displays :: src/app/artifacts/[id]/handlers/widget-display.tsx (0 -> 1)");
    const introducing = composeBaseline(null, live);
    expect(introducing.baseline.displays["src/app/artifacts/[id]/handlers/widget-display.tsx"]).toEqual({
      owner: UNASSIGNED,
      removedBy: UNASSIGNED,
    });
  }, FIXTURE_TIMEOUT);

  it("an entry whose owner is empty or UNASSIGNED fails", () => {
    const copy = JSON.parse(JSON.stringify(committed));
    copy.displays["src/app/artifacts/[id]/handlers/widget-handler.tsx"].owner = UNASSIGNED;
    copy.hostMounts["src/lib/artifacts/artifact-review-preparation.ts :: form-mount"].owner = "";
    expect(ownerProblems(copy)).toEqual([
      "displays :: src/app/artifacts/[id]/handlers/widget-handler.tsx",
      "hostMounts :: src/lib/artifacts/artifact-review-preparation.ts :: form-mount",
    ]);
    expect(ownerProblems(committed)).toEqual([]);
  });

  it("a `kind: \"mime\"` literal outside the declaring module is a mimeConstructions finding", () => {
    expect(base.mimeConstructions).toEqual({});
    const live = scanHostDisplayFloor(
      makeTree({
        "src/lib/widget-choice.ts": `export const widgetChoice = () => ({ kind: "mime", handler: "markdown" }) as const;\n`,
      }),
    );
    expect(checkFloor(committed, live).grown).toEqual(["mimeConstructions :: src/lib/widget-choice.ts :: mime (0 -> 1)"]);
  }, FIXTURE_TIMEOUT);

  it("a quoted `kind` key, or a comment before its value, hides no site from the static half", () => {
    const live = scanHostDisplayFloor(
      makeTree({
        "src/lib/widget-quoted.ts": `export const a = () => ({ "kind": "mime", handler: "markdown" }) as const;
export const b = () => ({ kind /* the host's own */: "mime", handler: "text" }) as const;
export const c = () => ({ "kind": "form", slot: "detail", arm: "first-party", form: "markdown" }) as const;
`,
      }),
    );
    expect(checkFloor(committed, live).grown).toEqual([
      "mimeConstructions :: src/lib/widget-quoted.ts :: mime (0 -> 2)",
      "hostMounts :: src/lib/widget-quoted.ts :: form-mount (0 -> 1)",
    ]);
  }, FIXTURE_TIMEOUT);

  it("a new first-party form mount site is a hostMounts finding", () => {
    expect(base.hostMounts).toEqual({ "src/lib/artifacts/artifact-review-preparation.ts :: form-mount": { count: 1 } });
    const live = scanHostDisplayFloor(
      makeTree({
        "src/lib/widget-mount.ts": `export const widgetMount = (arm: "first-party") => ({ kind: "form", slot: "detail", arm, form: "markdown" });\n`,
      }),
    );
    expect(checkFloor(committed, live).grown).toEqual(["hostMounts :: src/lib/widget-mount.ts :: form-mount (0 -> 1)"]);
  }, FIXTURE_TIMEOUT);

  describe("the base guard (HOST_DISPLAY_FLOOR_BASE)", () => {
    let repo;
    let before;
    let after;
    const git = (...args) =>
      execFileSync(
        "git",
        ["-c", "user.name=fixture", "-c", "user.email=fixture@example.org", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args],
        { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ).trim();
    beforeAll(() => {
      repo = mkdtempSync(join(tmpdir(), "host-display-floor-git-"));
      roots.push(repo);
      git("init", "-q");
      writeFileSync(join(repo, "README.md"), "fixture\n");
      git("add", "README.md");
      git("commit", "-q", "-m", "no baseline yet");
      before = git("rev-parse", "HEAD");
      mkdirSync(join(repo, dirname(BASELINE_REL)), { recursive: true });
      writeFileSync(join(repo, BASELINE_REL), JSON.stringify(committed, null, 2) + "\n");
      git("add", BASELINE_REL);
      git("commit", "-q", "-m", "the floor");
      after = git("rev-parse", "HEAD");
    }, FIXTURE_TIMEOUT);

    it("refuses a flag-like reference", () => {
      const r = checkBaseGuard(repo, "-x", committed);
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/flag-like/);
    });

    it("refuses an unresolvable reference", () => {
      const r = checkBaseGuard(repo, "refs/heads/example-org-absent", committed);
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/did not resolve/);
    });

    it("refuses a committed floor grown against the base", () => {
      const grown = JSON.parse(JSON.stringify(committed));
      grown.displays["src/app/artifacts/[id]/handlers/widget-display.tsx"] = {
        owner: "@example-org/widget-artifacts",
        removedBy: "@example-org/widget-artifacts#1",
      };
      const r = checkBaseGuard(repo, after, grown);
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/GREW/);
      expect(r.reason).toContain("displays :: src/app/artifacts/[id]/handlers/widget-display.tsx (0 -> 1)");
      expect(checkBaseGuard(repo, after, committed)).toEqual({ ok: true });
    });

    it("imposes nothing when the base holds no baseline (the introducing change)", () => {
      expect(checkBaseGuard(repo, before, committed)).toEqual({ ok: true, introducing: true });
    });
  });
});

// ---------------------------------------------------------------------------
// THE TEST OF RECORD. The gates run on every pull request of the application,
// beside the sibling gates: this block runs in the root suite (`pnpm test:root`).
// ---------------------------------------------------------------------------

describe("test of record: the host display floor over the real tree", () => {
  let live;
  let committedFloor;
  let scanSeconds;
  beforeAll(() => {
    const started = Date.now();
    live = scanHostDisplayFloor(REPO_ROOT);
    scanSeconds = (Date.now() - started) / 1000;
    committedFloor = JSON.parse(readFileSync(join(REPO_ROOT, BASELINE_REL), "utf8"));
  }, RECORD_TIMEOUT);

  it("the scan completed (its time recorded)", () => {
    console.info(`[host-display-floor test of record] scan ${scanSeconds.toFixed(1)} s`);
    expect(scanSeconds).toBeGreaterThan(0);
  });

  for (const section of SECTIONS) {
    it(`${section}: no new entry and no stale entry`, () => {
      const c = sectionCounts(section, committedFloor[section]);
      const l = sectionCounts(section, live[section]);
      expect(diffGrown(c, l), `new in ${section} (a display of the application's own may not grow)`).toEqual([]);
      expect(diffShrunk(c, l), `stale in ${section} (ratchet down with --write-baseline)`).toEqual([]);
    });
  }

  it("every entry names its owner (never empty, never UNASSIGNED)", () => {
    expect(ownerProblems(committedFloor)).toEqual([]);
  });

  it("no host display is chosen outside the dispatch (mimeConstructions is empty)", () => {
    expect(live.mimeConstructions).toEqual({});
    expect(committedFloor.mimeConstructions).toEqual({});
  });
});
