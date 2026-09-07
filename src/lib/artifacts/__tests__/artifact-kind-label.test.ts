import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  artifactKindLabelFor,
  artifactKindLabelPackageId,
  resolveArtifactKindLabel,
} from "../artifact-kind-label";
import { GENERATED_ARTIFACT_KIND_LABELS } from "@/lib/generated/artifact-kind-labels";

const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");

// THE ONE host function. A pack's artifact kind label is DECLARED by the pack
// (`cinatra.displayName`, carried into the generated map by the manifest
// generator); the host's package-id derivation survives ONLY as the never-blank
// floor for a pack that declares none, and a floor result says so.

describe("artifactKindLabelPackageId — one normalization for every id form", () => {
  it("reduces a type id, a versioned id and a bare package id to the same package", () => {
    expect(artifactKindLabelPackageId("@cinatra-ai/zip-artifact")).toBe("@cinatra-ai/zip-artifact");
    expect(artifactKindLabelPackageId("@cinatra-ai/zip-artifact:archive")).toBe(
      "@cinatra-ai/zip-artifact",
    );
    expect(artifactKindLabelPackageId("@cinatra-ai/zip-artifact@1.2.0")).toBe(
      "@cinatra-ai/zip-artifact",
    );
  });
});

describe("resolveArtifactKindLabel — declared beats derived", () => {
  it("returns the pack's DECLARED label, not the package-id guess", () => {
    // The derivation would read "Zip Artifact"; the pack declares "Archive".
    expect(resolveArtifactKindLabel("@cinatra-ai/zip-artifact")).toEqual({
      label: "Archive",
      source: "declared",
    });
    expect(artifactKindLabelFor("@cinatra-ai/zip-artifact:archive")).toBe("Archive");
    expect(artifactKindLabelFor("@cinatra-ai/pdf-artifact")).toBe("PDF");
    expect(artifactKindLabelFor("@cinatra-ai/slide-deck-artifact")).toBe("Slide Deck");
  });

  it("falls back to the derivation ONLY when nothing is declared, and marks the floor", () => {
    const undeclared = resolveArtifactKindLabel("@acme/support-desk:case");
    expect(undeclared).toEqual({ label: "Support Desk", source: "floor" });
    expect(resolveArtifactKindLabel("@cinatra-ai/email:draft")).toEqual({
      label: "Email",
      source: "floor",
    });
    expect(resolveArtifactKindLabel("@cinatra-ai/prospect-lists:list")).toEqual({
      label: "Prospect Lists",
      source: "floor",
    });
  });

  it("floors to the trimmed id when there is nothing left to humanize", () => {
    expect(resolveArtifactKindLabel("plain")).toEqual({ label: "Plain", source: "floor" });
    expect(artifactKindLabelFor("@acme/")).toBe("@acme/");
    // Never blank for any id carrying a non-whitespace character, padding and
    // all — and a padded DECLARED id still finds its declaration rather than
    // missing the key and quietly flooring.
    expect(artifactKindLabelFor("  @acme/support-desk  ")).toBe("Support Desk");
    expect(resolveArtifactKindLabel("  @cinatra-ai/zip-artifact  ")).toEqual({
      label: "Archive",
      source: "declared",
    });
    // Whitespace alone is not an id any surface holds: it renders nothing at
    // all rather than the stray space the earlier floor leaked.
    expect(artifactKindLabelFor("   ")).toBe("");
    expect(artifactKindLabelFor("")).toBe("");
  });

  it("floors the two id forms the three deleted copies disagreed on, ONE way", () => {
    // The deleted client-surface copies rendered "Foo@1.2.0" and "Support_desk";
    // the deleted inventory copy rendered "Foo" and "Support Desk". One floor
    // keeps the strictest of the three, so no version string and no raw
    // underscore reaches a reader on any surface.
    expect(resolveArtifactKindLabel("@acme/foo@1.2.0")).toEqual({ label: "Foo", source: "floor" });
    expect(resolveArtifactKindLabel("@acme/support_desk:case")).toEqual({
      label: "Support Desk",
      source: "floor",
    });
  });

  it("floors a pack whose declaration the generated map does not carry", () => {
    // A pack installed at RUNTIME registers through the package-store rescan,
    // which carries no display name, so it is absent from the generated map and
    // floors — and SAYS floor, which is the diagnostic that names the gap
    // instead of presenting the guess as the pack's own word.
    expect(GENERATED_ARTIFACT_KIND_LABELS["@acme/runtime-installed-artifact"]).toBeUndefined();
    expect(resolveArtifactKindLabel("@acme/runtime-installed-artifact")).toEqual({
      label: "Runtime Installed Artifact",
      source: "floor",
    });
  });
});

describe("the generated map is the declaration road, not a host roster", () => {
  it("carries the label each shipped artifact pack declares", () => {
    expect(GENERATED_ARTIFACT_KIND_LABELS["@cinatra-ai/zip-artifact"]).toBe("Archive");
    expect(GENERATED_ARTIFACT_KIND_LABELS["@cinatra-ai/json-artifact"]).toBe("JSON");
    expect(GENERATED_ARTIFACT_KIND_LABELS["@cinatra-ai/cms-snapshot-artifact"]).toBe(
      "CMS Snapshot",
    );
  });

  it("holds only artifact packs — the host keeps no roster of anything else", () => {
    for (const pkg of Object.keys(GENERATED_ARTIFACT_KIND_LABELS)) {
      expect(pkg, pkg).toMatch(/-artifacts?$/);
    }
  });
});

describe("the host holds exactly ONE kind-label derivation", () => {
  it("the three former copies are gone from their files", () => {
    expect(read("src/components/artifacts/library-mode.tsx")).not.toMatch(
      /export function extensionDisplayName/,
    );
    expect(read("src/lib/artifacts/review-surface-model.ts")).not.toMatch(
      /export function reviewTypeLabel/,
    );
    expect(read("src/lib/artifacts/type-definitions-inventory.ts")).not.toMatch(
      /export function humanizeExtensionPackage/,
    );
  });

  it("every surface that names a kind CALLS the one function", () => {
    // The CALL, not merely the name: a bare `/artifactKindLabelFor/` would go on
    // passing from a leftover import or a comment after the rendering call was
    // removed, so each surface pins the expression it actually carries.
    const calls: ReadonlyArray<readonly [string, RegExp]> = [
      ["src/components/artifacts/library-mode.tsx", /label: artifactKindLabelFor\(e\)/],
      ["src/components/artifacts/library-mode.tsx", /\{artifactKindLabelFor\(identity\.extension\)\}/],
      ["src/lib/artifacts/type-definitions-inventory.ts", /artifactKindLabelFor\(definer\)/],
      ["src/lib/artifacts/type-definitions-inventory.ts", /artifactKindLabelFor\(pkg\)/],
      ["src/lib/artifacts/installed-type-picker.ts", /artifactKindLabelFor\(/],
      ["src/lib/lifecycle/run-window-frame.ts", /artifactKindLabelFor\(read\.artifact\.objectType\)/],
      ["src/lib/lifecycle/lifecycle-target-headers.ts", /artifactKindLabelFor\(artifact\.objectType\)/],
      ["src/app/artifacts/[id]/page.tsx", /artifactKindLabelFor\(artifact\.objectType\)/],
    ];
    for (const [rel, call] of calls) {
      expect(read(rel), `${rel} ${String(call)}`).toMatch(call);
    }
  });

  it("the review surface model keeps NO kind-label projection of its own", () => {
    const RSM = read("src/lib/artifacts/review-surface-model.ts");
    expect(RSM).not.toMatch(/reviewTypeLabel/);
    expect(RSM).not.toMatch(/charAt\(0\)\.toUpperCase\(\)/);
  });
});

describe("the review line and the artifact page header name the same pack the same way", () => {
  it("the page header draws the kind label from the row's own object type", () => {
    expect(read("src/app/artifacts/[id]/page.tsx")).toMatch(
      /artifactKindLabelFor\(artifact\.objectType\)/,
    );
  });

  it("the review line draws it from the same object type through the same function", () => {
    expect(read("src/lib/lifecycle/lifecycle-target-headers.ts")).toMatch(
      /artifactKindLabelFor\(artifact\.objectType\)/,
    );
    expect(read("src/lib/lifecycle/run-window-frame.ts")).toMatch(
      /artifactKindLabelFor\(read\.artifact\.objectType\)/,
    );
  });

  it("so neither surface can word one pack its own way", () => {
    // NOT `f(x) === f(x)` — that holds of any function and pins nothing.
    // Parity holds because both surfaces spell the SAME call over the SAME
    // field, so what is pinned is the expression each source actually carries,
    // exactly once, plus the fact that the shared function is total on it.
    const call = /artifactKindLabelFor\(\s*(?:read\.)?artifact\.objectType\s*\)/g;
    for (const rel of [
      "src/app/artifacts/[id]/page.tsx",
      "src/lib/lifecycle/lifecycle-target-headers.ts",
      "src/lib/lifecycle/run-window-frame.ts",
    ]) {
      expect(read(rel).match(call)?.length ?? 0, rel).toBe(1);
    }
    expect(artifactKindLabelFor("@cinatra-ai/zip-artifact:archive")).toBe("Archive");
    expect(artifactKindLabelFor("@acme/support-desk:case")).toBe("Support Desk");
  });
});
