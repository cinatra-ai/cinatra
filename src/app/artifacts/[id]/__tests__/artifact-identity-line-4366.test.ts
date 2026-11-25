/**
 * THE IDENTITY LINE NAMES THE RENDERER THAT DREW THE ROW, WHERE THE DISPLAY
 * DECLARES IT — cinatra#4366, the ratified drawing artifact-review §XI.7 and
 * §XI.8:
 *
 *   "the identity line of every page names the renderer that drew it. A Drupal
 *    page and a WordPress page are one drawing: only the identity line — the
 *    platform it names — tells them apart."
 *
 *   drawn (§XI.8): "@cinatra-ai/website-artifacts:page-snapshot · drawn by
 *   @cinatra-ai/website-artifacts:page-diff · revision rev_c410… · pinned ·
 *   WordPress · Team: Growth · Private · acme.example/pricing"
 *
 * On the artifact's OWN page the pinned marker is drawn only where the revision
 * shown is a review target (cinatra#3092; `w3-artifact-page-header-drawn`); these
 * lines are read with no review standing. Core names no extension: the
 * display's module declares the two facts through two optional exports, read
 * generically. Fixture names stand in for the pack here.
 *
 * AND EVERY OTHER DISPLAY'S LINE IS BYTE-IDENTICAL: a display that declares
 * nothing draws the six facts it always drew.
 */
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  degraded: { degradedMarker: true },
  loads: 0,
}));

const RENDERER = "@fixture/pages:page-diff";
const FACTS = { revision: ["WordPress"], closing: ["acme.example/pricing"] };
const pageModule = {
  default: () => null,
  rendererName: RENDERER,
  identityFacts: (content: unknown) =>
    (content as { text?: string } | null)?.text === "page" ? FACTS : null,
};

vi.mock("@/lib/generated/artifact-renderers", () => {
  const entry = (propsApiVersion: number, load: () => Promise<unknown>) => ({
    resolution: "guardedOptional",
    packageName: "@fixture/pages",
    slot: "detail",
    representations: [],
    propsApiVersion,
    load: async () => {
      mocks.loads += 1;
      return load();
    },
  });
  return {
    GENERATED_ARTIFACT_RENDERERS: {
      "@fixture/pages::detail": entry(5, async () => pageModule),
      "@fixture/plain::detail": entry(1, async () => ({ default: () => null })),
      "@fixture/too-new::detail": entry(99, async () => pageModule),
      "@fixture/throws::detail": entry(5, async () => {
        throw new Error("a present but broken module");
      }),
      "@fixture/absent::detail": entry(5, async () => mocks.degraded),
      "@fixture/no-component::detail": entry(5, async () => ({ ...pageModule, default: "not a component" })),
      "@fixture/quarantined::detail": entry(5, async () => pageModule),
      "@fixture/default-getter-throws::detail": entry(5, async () => ({
        ...pageModule,
        get default(): never {
          throw new Error("a default getter that throws");
        },
      })),
    },
  };
});
vi.mock("@/lib/extension-load-guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/extension-load-guard")>()),
  isDegradedExtensionLoad: (value: unknown) => value === mocks.degraded,
}));

import {
  _resetArtifactRendererQuarantineForTests,
  ARTIFACT_RENDERER_QUARANTINE_THRESHOLD,
  loadArtifactRenderer,
} from "@/lib/artifacts/artifact-renderer-loader";
import type { ArtifactRendererProps } from "@/lib/artifacts/artifact-renderer-props";
import type { ArtifactSummary } from "@/lib/artifacts/artifact-service";
import {
  buildArtifactDetailHeader,
  NO_DISPLAY_IDENTITY,
  type ArtifactDisplayIdentity,
} from "../artifact-detail-header";
import type * as DisplayIdentityModule from "../artifact-display-identity";
import { ExtensionRendererSlot } from "../extension-renderer-slot";
let displayIdentityFromModule!: typeof DisplayIdentityModule.displayIdentityFromModule;
let readArtifactDisplayIdentity!: typeof DisplayIdentityModule.readArtifactDisplayIdentity;
async function loadDisplayIdentity(): Promise<void> {
  ({ displayIdentityFromModule, readArtifactDisplayIdentity } = await import("../artifact-display-identity"));
}

const NOW = new Date("2026-09-02T18:00:00.000Z");
const PAGE_CONTENT = { kind: "text", text: "page" };

function row(over: Partial<ArtifactSummary> = {}): ArtifactSummary {
  return {
    artifactId: "9c0dfce6-b2cb-4dab-8a01-661ca3288b9a",
    latestRepresentationRevisionId: "rev_c410a7",
    objectType: "@fixture/pages:page-snapshot",
    artifactType: "file",
    title: "Pricing",
    mime: "application/json",
    originKind: "agent",
    createdAt: "2026-09-02T17:00:00.000Z",
    updatedAt: "2026-09-02T17:52:00.000Z",
    ownerLevel: "team",
    visibility: "private",
    ownerId: "team_1",
    organizationId: "org_1",
    projectId: null,
    eligibleExtensions: [],
    primaryExtension: "@fixture/pages",
    effectiveIdentity: { kind: "extension", extension: "@fixture/pages" },
    presentationIdentity: { kind: "extension", extension: "@fixture/pages" },
    presentationSuggestions: [],
    sourceUrl: null,
    ...over,
  } as ArtifactSummary;
}

function line(display?: ArtifactDisplayIdentity): string {
  return buildArtifactDetailHeader({
    artifact: row(),
    mime: "application/json",
    revisionId: "rev_c410a7",
    ownerName: "Growth",
    ...(display === undefined ? {} : { display }),
    now: NOW,
  }).metaCells.join(" · ");
}

const TODAY =
  "@fixture/pages:page-snapshot · revision rev_c410… · Team: Growth · Private · application/json · updated 8 minutes ago";

describe("a display that declares nothing draws the line it always drew, byte for byte", () => {
  it("with no display identity handed at all", async () => {
    await loadDisplayIdentity();
    expect(line()).toBe(TODAY);
  });

  it("with the declared-nothing identity", async () => {
    await loadDisplayIdentity();
    expect(line(NO_DISPLAY_IDENTITY)).toBe(TODAY);
    expect(line({ drawnBy: null, facts: null })).toBe(TODAY);
  });
});

describe("a display that declares itself draws the §XI.8 line on its own page", () => {
  it("names the renderer after the type, the platform after the revision, and closes on the address", async () => {
    await loadDisplayIdentity();
    expect(line({ drawnBy: RENDERER, facts: FACTS })).toBe(
      "@fixture/pages:page-snapshot · drawn by @fixture/pages:page-diff · revision rev_c410… · " +
        "WordPress · Team: Growth · Private · acme.example/pricing",
    );
  });

  it("drops the MIME and the updated time only where the display gives the closing cells", async () => {
    await loadDisplayIdentity();
    expect(line({ drawnBy: RENDERER, facts: null })).toBe(
      "@fixture/pages:page-snapshot · drawn by @fixture/pages:page-diff · revision rev_c410… · " +
        "Team: Growth · Private · application/json · updated 8 minutes ago",
    );
    expect(line({ drawnBy: RENDERER, facts: { revision: ["Drupal"], closing: [] } })).toBe(
      "@fixture/pages:page-snapshot · drawn by @fixture/pages:page-diff · revision rev_c410… · " +
        "Drupal · Team: Growth · Private",
    );
  });

  it("keeps the order with no revision to draw", async () => {
    await loadDisplayIdentity();
    const cells = buildArtifactDetailHeader({
      artifact: row(),
      mime: "application/json",
      revisionId: null,
      ownerName: "Growth",
      display: { drawnBy: RENDERER, facts: FACTS },
      now: NOW,
    }).metaCells;
    expect(cells).toEqual([
      "@fixture/pages:page-snapshot",
      "drawn by @fixture/pages:page-diff",
      "WordPress",
      "Team: Growth",
      "Private",
      "acme.example/pricing",
    ]);
  });
});

describe("the module's two optional exports are read generically and strictly", () => {
  it("reads both from a module that declares them", async () => {
    await loadDisplayIdentity();
    expect(displayIdentityFromModule(pageModule, PAGE_CONTENT)).toEqual({ drawnBy: RENDERER, facts: FACTS });
    expect(displayIdentityFromModule(pageModule, { kind: "none" })).toEqual({ drawnBy: RENDERER, facts: null });
  });

  it("declares nothing for a module without them, or for no module", async () => {
    await loadDisplayIdentity();
    for (const mod of [{ default: () => null }, null, undefined, "module", 7]) {
      expect(displayIdentityFromModule(mod, PAGE_CONTENT)).toEqual(NO_DISPLAY_IDENTITY);
    }
  });

  // A "use client" module reaches a server as client references: its string
  // export arrives as a function, and its function export throws when called.
  // Either reads as declared nothing, never as a broken page.
  it("reads a client reference as declared nothing", async () => {
    await loadDisplayIdentity();
    const clientReference = Object.assign(
      () => {
        throw new Error("Attempted to call identityFacts() from the server");
      },
      { $$typeof: Symbol.for("react.client.reference") },
    );
    expect(
      displayIdentityFromModule({ default: () => null, rendererName: clientReference, identityFacts: clientReference }, PAGE_CONTENT),
    ).toEqual(NO_DISPLAY_IDENTITY);
  });

  it("takes no renderer name that is not one clean cell", async () => {
    await loadDisplayIdentity();
    for (const rendererName of [42, "", " padded", "two\nlines", "a · b", "x".repeat(201), "tab\there", " "]) {
      expect(displayIdentityFromModule({ rendererName }, PAGE_CONTENT).drawnBy, JSON.stringify(rendererName)).toBeNull();
    }
    expect(displayIdentityFromModule({ rendererName: "x".repeat(200) }, PAGE_CONTENT).drawnBy).toBe("x".repeat(200));
  });

  it("takes no facts that are not two short lists of clean cells", async () => {
    await loadDisplayIdentity();
    const answers: unknown[] = [
      null,
      "WordPress",
      ["WordPress"],
      { revision: ["WordPress"] },
      { closing: [] },
      { revision: "WordPress", closing: [] },
      { revision: [1], closing: [] },
      { revision: ["Word\npress"], closing: [] },
      { revision: ["a", "b", "c", "d", "e"], closing: [] },
      { revision: [], closing: ["acme.example · pricing"] },
    ];
    for (const answer of answers) {
      expect(displayIdentityFromModule({ identityFacts: () => answer }, PAGE_CONTENT).facts, JSON.stringify(answer)).toBeNull();
    }
    expect(displayIdentityFromModule({ identityFacts: () => ({ revision: [], closing: [] }) }, PAGE_CONTENT).facts).toEqual({
      revision: [],
      closing: [],
    });
  });

  it("survives an export that throws, a getter that throws, and a promise", async () => {
    await loadDisplayIdentity();
    const rejected = Promise.reject(new Error("later"));
    const hostile = {
      get rendererName(): never {
        throw new Error("getter");
      },
    };
    expect(displayIdentityFromModule({ identityFacts: () => { throw new Error("now"); } }, PAGE_CONTENT).facts).toBeNull();
    expect(displayIdentityFromModule(hostile, PAGE_CONTENT)).toEqual(NO_DISPLAY_IDENTITY);
    expect(displayIdentityFromModule({ identityFacts: () => rejected }, PAGE_CONTENT).facts).toBeNull();
    await Promise.resolve();
  });

  it("hands the export the content the page hands the display, and nothing else", async () => {
    await loadDisplayIdentity();
    const seen: unknown[][] = [];
    displayIdentityFromModule({ identityFacts: (...args: unknown[]) => { seen.push(args); return null; } }, PAGE_CONTENT);
    expect(seen).toEqual([[PAGE_CONTENT]]);
  });
});

/** Quarantine a key the way repeated render failures do: the loader's own
 *  process-local counter, at its threshold. */
function quarantine(key: string): void {
  const holder = globalThis as unknown as Record<symbol, Map<string, number> | undefined>;
  const anchor = Symbol.for("@cinatra-ai/host:artifact-renderer-quarantine/v1");
  (holder[anchor] ??= new Map<string, number>()).set(key, ARTIFACT_RENDERER_QUARANTINE_THRESHOLD);
}

describe("the identity is read from the page's one load decision, the one the slot mounts with", () => {
  beforeEach(() => {
    _resetArtifactRendererQuarantineForTests();
    mocks.loads = 0;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  const SNAPSHOT = { propsApiVersion: 5 } as ArtifactRendererProps;
  const decide = (key: string, propsApiVersion = 5) =>
    loadArtifactRenderer({
      generatedKey: key,
      packageName: key.split("::")[0],
      slot: "detail",
      expectedPropsApiVersion: propsApiVersion,
    });
  const read = (decision: ReturnType<typeof decide> | null, propsApiVersion = 5) =>
    readArtifactDisplayIdentity({ decision, content: PAGE_CONTENT, propsApiVersion });
  const mountSlot = (key: string, decision: ReturnType<typeof decide>) =>
    ExtensionRendererSlot({
      generatedKey: key,
      packageName: key.split("::")[0],
      slot: "detail",
      props: SNAPSHOT,
      fallback: "the floor",
      decision,
    });

  it("reads the decided module's declaration", async () => {
    await loadDisplayIdentity();
    expect(await read(decide("@fixture/pages::detail"))).toEqual({ drawnBy: RENDERER, facts: FACTS });
  });

  it("declares nothing for a module that declares nothing", async () => {
    await loadDisplayIdentity();
    expect(await read(decide("@fixture/plain::detail"))).toEqual(NO_DISPLAY_IDENTITY);
  });

  it("declares nothing for every decision the slot does not mount", async () => {
    await loadDisplayIdentity();
    quarantine("@fixture/quarantined::detail");
    for (const key of [
      "@fixture/not-in-this-build::detail",
      "@fixture/too-new::detail",
      "@fixture/throws::detail",
      "@fixture/absent::detail",
      "@fixture/no-component::detail",
      "@fixture/quarantined::detail",
      "@fixture/default-getter-throws::detail",
    ]) {
      expect(await read(decide(key)), key).toEqual(NO_DISPLAY_IDENTITY);
    }
    // A snapshot built below the display's own version is not one it mounts.
    expect(await read(decide("@fixture/pages::detail", 4), 4)).toEqual(NO_DISPLAY_IDENTITY);
  });

  it("declares nothing for no decision (a runtime mount or a floor), and loads nothing", async () => {
    await loadDisplayIdentity();
    expect(await read(null)).toEqual(NO_DISPLAY_IDENTITY);
    expect(mocks.loads).toBe(0);
  });

  // THE RACE THE ONE DECISION CLOSES: a render failure elsewhere can quarantine
  // the key AFTER the header was read. The slot mounts from the same decision,
  // so it draws the very module the header named, and nothing loads twice.
  it("names the renderer exactly where the slot mounts it, even when the key is quarantined in between", async () => {
    await loadDisplayIdentity();
    const key = "@fixture/pages::detail";
    const decision = decide(key);
    const identity = await read(decision);
    quarantine(key);
    const mounted = (await mountSlot(key, decision)) as ReactElement;
    expect(identity.drawnBy).toBe(RENDERER);
    expect(mounted.type).toBe(pageModule.default);
    expect(mocks.loads).toBe(1);
  });

  it("names nothing where the slot floors the same decision", async () => {
    await loadDisplayIdentity();
    const key = "@fixture/pages::detail";
    quarantine(key);
    const decision = decide(key);
    expect(await read(decision)).toEqual(NO_DISPLAY_IDENTITY);
    const floored = (await mountSlot(key, decision)) as ReactElement<{ children?: unknown }>;
    expect(floored.type).not.toBe(pageModule.default);
    expect(mocks.loads).toBe(0);
  });

  it("answers a broken module quietly while the slot, on the same decision, still fails loud", async () => {
    await loadDisplayIdentity();
    for (const key of ["@fixture/throws::detail", "@fixture/default-getter-throws::detail"]) {
      const decision = decide(key);
      expect(await read(decision), key).toEqual(NO_DISPLAY_IDENTITY);
      await expect(mountSlot(key, decision), key).rejects.toThrow();
    }
    expect(mocks.loads).toBe(2);
  });
});

describe("a cell cannot reorder the line: bidirectional and isolate controls, and every control, are no cell", () => {
  const BIDI = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];

  it("takes no renderer name that carries one", async () => {
    await loadDisplayIdentity();
    for (const code of BIDI) {
      const name = `safe${String.fromCodePoint(code)}evil`;
      expect(displayIdentityFromModule({ rendererName: name }, PAGE_CONTENT).drawnBy, code.toString(16)).toBeNull();
    }
  });

  it("takes no facts with a cell that carries one", async () => {
    await loadDisplayIdentity();
    for (const code of BIDI) {
      const answer = { revision: ["WordPress"], closing: [`acme.example${String.fromCodePoint(code)}/pricing`] };
      expect(displayIdentityFromModule({ identityFacts: () => answer }, PAGE_CONTENT).facts, code.toString(16)).toBeNull();
    }
  });

  it("takes no cell with a C1 control, DEL, or a line or paragraph separator", async () => {
    await loadDisplayIdentity();
    for (const code of [0x7f, 0x80, 0x85, 0x9f, 0x2028, 0x2029]) {
      const name = `a${String.fromCodePoint(code)}b`;
      expect(displayIdentityFromModule({ rendererName: name }, PAGE_CONTENT).drawnBy, code.toString(16)).toBeNull();
    }
  });

  it("still takes the clean neighbours of those ranges", async () => {
    await loadDisplayIdentity();
    for (const code of [0x061b, 0x200d, 0x2010, 0x202f, 0x2065, 0x206a]) {
      const name = `a${String.fromCodePoint(code)}b`;
      expect(displayIdentityFromModule({ rendererName: name }, PAGE_CONTENT).drawnBy, code.toString(16)).toBe(name);
    }
  });
});

describe("each export is read apart, and every throw declares nothing of its own part", () => {
  it("reads facts from a module that names no renderer, and draws them without the name", async () => {
    await loadDisplayIdentity();
    const declared = displayIdentityFromModule({ default: () => null, identityFacts: () => FACTS }, PAGE_CONTENT);
    expect(declared).toEqual({ drawnBy: null, facts: FACTS });
    expect(line(declared)).toBe(
      "@fixture/pages:page-snapshot · revision rev_c410… · WordPress · Team: Growth · Private · acme.example/pricing",
    );
  });

  it("keeps the name when the facts export's getter throws", async () => {
    await loadDisplayIdentity();
    const mod = {
      rendererName: RENDERER,
      get identityFacts(): never {
        throw new Error("a later export getter that throws");
      },
    };
    expect(displayIdentityFromModule(mod, PAGE_CONTENT)).toEqual({ drawnBy: RENDERER, facts: null });
  });

  it("keeps the name when the answer's then getter, or a later getter on it, throws", async () => {
    await loadDisplayIdentity();
    const thenThrows = {
      revision: ["WordPress"],
      closing: [],
      get then(): never {
        throw new Error("a then getter that throws");
      },
    };
    const closingThrows = {
      revision: ["WordPress"],
      get closing(): never {
        throw new Error("a closing getter that throws");
      },
    };
    for (const answer of [thenThrows, closingThrows]) {
      expect(
        displayIdentityFromModule({ rendererName: RENDERER, identityFacts: () => answer }, PAGE_CONTENT),
      ).toEqual({ drawnBy: RENDERER, facts: null });
    }
  });
});
