// THE DISPATCH MATRIX (cinatra#3319, acceptance 8).
//
// "A dispatch matrix test covers, on both the artifact detail and the review:
//  typed and representation-only `text/plain`, `text/markdown`,
//  `text/x-markdown`, JSON, binary, image and PDF, the dashboard pointer, the
//  Drupal reference, a missing module, an ABI mismatch and a renderer exception,
//  asserting extension provenance and, on failure, no core artifact body."
//
// TYPED means the row carries its pack's own object type and that pack is the
// winner — the semantic rung. REPRESENTATION-ONLY means no winner ships a
// display and the media type alone has to find one. Both roads are driven for
// every row, and the row's expectation names the PACKAGE that answered, which is
// the provenance: a row that resolves to no package resolves to a floor, and a
// floor draws a host diagnostic over the host's never-blank node — never a core
// rendering of the artifact.
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolve as resolvePath } from "node:path";

import type { EffectiveIdentity } from "@cinatra-ai/objects/effective-identity";
import { registerArtifactExtensionDir } from "@cinatra-ai/objects/register-artifact-extensions";
import { matcherManifestRegistry, objectTypeRegistry } from "@cinatra-ai/objects/registry";
import {
  semanticRendererRegistry,
  representationProviderRegistry,
} from "@cinatra-ai/objects/artifact-renderer-registry";

import type { ActorContext } from "@/lib/authz/actor-context";
import type { ArtifactSummary } from "@/lib/artifacts/artifact-service";
import type { ArtifactRendererProps } from "@/lib/artifacts/artifact-renderer-props";
import { runtimeAssetRegistry } from "@/lib/artifacts/runtime-renderer-registry";

import { _resetFirstPartySeedForTests } from "../renderer-resolution";
import { resolveArtifactDisplayMount } from "../renderer-resolution";
import { bindArtifactReviewPorts } from "../review-target-prepare";

vi.mock("@/lib/artifacts/artifact-renderer-loader", () => ({
  loadArtifactRenderer: vi.fn(),
}));
const { loadArtifactRenderer } = await import("@/lib/artifacts/artifact-renderer-loader");
const { ExtensionRendererSlot } = await import("../extension-renderer-slot");

const REPO_ROOT = resolvePath(__dirname, "..", "..", "..", "..", "..");

/** THE PACKS A TYPED ROW IS TYPED BY. A typed row resolves through the semantic
 * rung, and that rung reads the registry the installed fleet writes — so the
 * matrix registers the real pinned packs rather than inventing registrations. */
const FLEET = [
  "text-artifact",
  "markdown-artifact",
  "json-artifact",
  "binary-artifact",
  "image-artifact",
  "pdf-artifact",
  "dashboard-artifact",
  "drupal-artifacts",
] as const;

function registerFleet(): void {
  for (const slug of FLEET) {
    registerArtifactExtensionDir(resolvePath(REPO_ROOT, "extensions/cinatra-ai", slug));
  }
}

const ORG = "org_3319_matrix";
const actor = { actorType: "human", userId: "u" } as unknown as ActorContext;
const NO_WINNER: EffectiveIdentity = { kind: "no-primary" };
const winner = (extension: string): EffectiveIdentity => ({ kind: "extension", extension });

function summary(objectType: string, identity: EffectiveIdentity): ArtifactSummary {
  return {
    artifactId: "art_1",
    objectType,
    effectiveIdentity: identity,
    presentationIdentity: identity,
  } as unknown as ArtifactSummary;
}

function pageRoad(artifact: ArtifactSummary, mime: string) {
  return resolveArtifactDisplayMount({
    orgId: ORG,
    baseType: artifact.objectType,
    identity: artifact.presentationIdentity,
    mime,
    propsApiVersion: 1,
  });
}
function reviewRoad(artifact: ArtifactSummary, mime: string) {
  const { resolveMount } = bindArtifactReviewPorts({ orgId: ORG, actor });
  return Promise.resolve(resolveMount({ artifact, mime, propsApiVersion: 1 }));
}

/** label, objectType, identity, mime, the package that must answer (null = a
 *  floor: nothing installed draws this row). */
type Row = readonly [string, string, EffectiveIdentity, string, string | null];

const TYPED: readonly Row[] = [
  ["typed text/plain", "@cinatra-ai/text-artifact:artifact", winner("@cinatra-ai/text-artifact"), "text/plain", "@cinatra-ai/text-artifact"],
  ["typed text/markdown", "@cinatra-ai/markdown-artifact:artifact", winner("@cinatra-ai/markdown-artifact"), "text/markdown", "@cinatra-ai/markdown-artifact"],
  ["typed text/x-markdown", "@cinatra-ai/markdown-artifact:artifact", winner("@cinatra-ai/markdown-artifact"), "text/x-markdown", "@cinatra-ai/markdown-artifact"],
  ["typed JSON", "@cinatra-ai/json-artifact:artifact", winner("@cinatra-ai/json-artifact"), "application/json", "@cinatra-ai/json-artifact"],
  ["typed binary", "@cinatra-ai/binary-artifact:artifact", winner("@cinatra-ai/binary-artifact"), "application/octet-stream", "@cinatra-ai/binary-artifact"],
  ["typed image", "@cinatra-ai/image-artifact:image", winner("@cinatra-ai/image-artifact"), "image/png", "@cinatra-ai/image-artifact"],
  ["typed PDF", "@cinatra-ai/pdf-artifact:document", winner("@cinatra-ai/pdf-artifact"), "application/pdf", "@cinatra-ai/pdf-artifact"],
];

const REPRESENTATION_ONLY: readonly Row[] = [
  // NOTHING claims text/plain as a representation: the text pack accepts it but
  // declares only `text/csv` for its display. That declaration is the pack's own
  // (the acceptance item names it as work in the pack's repository), so an
  // untyped plain-text row honestly reaches the floor here rather than a core
  // viewer standing in for the pack.
  ["representation-only text/plain", "@acme/x:row", NO_WINNER, "text/plain", null],
  ["representation-only text/markdown", "@acme/x:row", NO_WINNER, "text/markdown", "@cinatra-ai/markdown-artifact"],
  // The host's one canonicalisation: the legacy spelling reaches the same pack.
  ["representation-only text/x-markdown", "@acme/x:row", NO_WINNER, "text/x-markdown", "@cinatra-ai/markdown-artifact"],
  ["representation-only JSON", "@acme/x:row", NO_WINNER, "application/json", "@cinatra-ai/json-artifact"],
  // `application/octet-stream` is not a safe-transport form, so no system base
  // binds a provider for it: an untyped binary row is a floor, and the binary
  // base answers it through its TYPE (the typed row above).
  ["representation-only binary", "@acme/x:row", NO_WINNER, "application/octet-stream", null],
  ["representation-only image", "@acme/x:row", NO_WINNER, "image/png", "@cinatra-ai/image-artifact"],
  ["representation-only PDF", "@acme/x:row", NO_WINNER, "application/pdf", "@cinatra-ai/pdf-artifact"],
];

const REFERENCES: readonly Row[] = [
  ["the dashboard pointer", "@cinatra-ai/dashboard-artifact:dashboard", winner("@cinatra-ai/dashboard-artifact"), "application/vnd.cinatra.dashboard+json", null],
  ["the Drupal reference", "@cinatra-ai/drupal:node", NO_WINNER, "text/html", null],
];

afterEach(() => {
  for (const slug of FLEET) {
    objectTypeRegistry.removeByPackage("@cinatra-ai/" + slug);
    matcherManifestRegistry.removeByPackage("@cinatra-ai/" + slug);
  }
  semanticRendererRegistry._clearForTests();
  representationProviderRegistry._clearForTests(true);
  runtimeAssetRegistry._clearForTests();
  _resetFirstPartySeedForTests();
  vi.mocked(loadArtifactRenderer).mockReset();
});

async function bothRoads(row: Row) {
  const [, objectType, identity, mime] = row;
  registerFleet();
  const artifact = summary(objectType, identity);
  return Promise.all([pageRoad(artifact, mime), reviewRoad(artifact, mime)]);
}

describe.each([
  ["the artifact detail", 0],
  ["the review", 1],
] as const)("acceptance 8 — %s road", (_road, index) => {
  it.each([...TYPED, ...REPRESENTATION_ONLY, ...REFERENCES])(
    "%s",
    async (...row) => {
      const expected = row[4];
      const answers = await bothRoads(row as unknown as Row);
      const mount = answers[index] as { kind: string; packageName?: string | null; generatedKey?: string };
      if (expected === null) {
        // NO CORE ARTIFACT BODY: the answer is a floor naming no package, so the
        // surface has nothing to draw but its own diagnostic over the host's
        // never-blank node.
        expect(mount.kind).toBe("floor");
        expect(mount.packageName ?? null).toBeNull();
        return;
      }
      // EXTENSION PROVENANCE: the package that answered, and the module key it
      // answered with — both read off the mount, never assumed.
      expect(mount.kind).toBe("build-map");
      expect(mount.packageName).toBe(expected);
      expect(mount.generatedKey).toBe(`${expected}::detail`);
    },
  );
});

describe("acceptance 8 — a missing module", () => {
  it("a claimant this build does not carry floors as requires-rebuild on both roads, naming the package", async () => {
    const PKG = "@acme/never-built";
    semanticRendererRegistry.register({ objectTypeId: `${PKG}:thing`, packageName: PKG });
    const [page, review] = await bothRoads([
      "missing module",
      `${PKG}:thing`,
      winner(PKG),
      "application/vnd.acme.opaque",
      null,
    ] as const as unknown as Row);
    for (const mount of [page, review] as Array<{ kind: string; packageName?: string | null; reason?: string }>) {
      expect(mount.kind).toBe("floor");
      expect(mount.packageName).toBe(PKG);
      expect(mount.reason).toBe("requires-rebuild");
    }
  });
});

describe("acceptance 8 — an ABI mismatch and a renderer exception draw no core artifact body", () => {
  const props = { propsApiVersion: 1, artifact: { id: "a" } } as unknown as ArtifactRendererProps;
  const HOST_FLOOR = { __hostDiagnostic: true } as unknown as React.ReactNode;

  it("an ABI mismatch degrades to the host's own floor node plus a sanitized notice", async () => {
    vi.mocked(loadArtifactRenderer).mockResolvedValue({
      ok: false,
      failureClass: "abi-incompatible",
    } as never);
    const el = (await ExtensionRendererSlot({
      generatedKey: "@acme/x::detail",
      packageName: "@acme/x",
      slot: "detail",
      props,
      fallback: HOST_FLOOR,
    })) as { props: { children: unknown[] } };
    const children = el.props.children as Array<{ props?: Record<string, unknown> } | unknown>;
    // The notice names package + slot + class only, and the caller's node — the
    // host diagnostic — is what stands under it.
    expect(children[1]).toBe(HOST_FLOOR);
    expect((children[0] as { props: Record<string, unknown> }).props.failureClass).toBe(
      "abi-incompatible",
    );
  });

  it("a renderer that throws is NOT swallowed into a core body — it reaches the route's error boundary", async () => {
    const Boom = () => {
      throw new Error("renderer exploded");
    };
    vi.mocked(loadArtifactRenderer).mockResolvedValue({
      ok: true,
      Component: Boom,
      negotiatedPropsApiVersion: 1,
    } as never);
    const el = (await ExtensionRendererSlot({
      generatedKey: "@acme/x::detail",
      packageName: "@acme/x",
      slot: "detail",
      props,
      fallback: HOST_FLOOR,
    })) as { type: (p: unknown) => unknown; props: unknown };
    expect(el.type).toBe(Boom);
    expect(() => el.type(el.props)).toThrow(/renderer exploded/);
  });
});
