// cinatra#3033 (CELL4, the kind chip beside the title). app-artifact-review
// §XI.10: a re-typed row "reads as the claiming extension's row — its type on
// the mono line, its extension on the tag"; app-artifacts §II: "a muted
// extension label naming the type's defining extension".
//
// A type id in ANOTHER package's namespace that exactly one artifact pack
// claims is named by that claiming pack's own declaration, carried by the
// manifest generator as the claims map. A bare package id, a versioned id and a
// type no pack claims keep exactly today's answer.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  artifactKindLabelFor,
  resolveArtifactKindLabel,
  resolveArtifactKindLabelFrom,
} from "../artifact-kind-label";
import {
  GENERATED_ARTIFACT_KIND_CLAIMS,
  GENERATED_ARTIFACT_KIND_LABELS,
} from "@/lib/generated/artifact-kind-labels";

const EXPECTED_CLAIMS: Record<string, string> = {
  "@cinatra-ai/brand-voice:guide": "@cinatra-ai/brand-voice-artifact",
  "@cinatra-ai/drupal:node": "@cinatra-ai/drupal-artifacts",
  "@cinatra-ai/email:body": "@cinatra-ai/email-artifacts",
  "@cinatra-ai/email:received-reply": "@cinatra-ai/email-artifacts",
  "@cinatra-ai/email:recipient": "@cinatra-ai/email-artifacts",
  "@cinatra-ai/email:sent-email": "@cinatra-ai/email-artifacts",
  "@cinatra-ai/linkedin:post-draft": "@cinatra-ai/linkedin-artifacts",
  "@cinatra-ai/marketing-icp:profile": "@cinatra-ai/marketing-icp-artifact",
};

type PackJson = {
  name: string;
  cinatra: { displayName?: string; artifact?: { objectTypes?: Array<{ type?: string }> } };
};

function readPack(packageName: string): PackJson {
  const [scope, local] = packageName.replace(/^@/, "").split("/");
  const file = path.join(process.cwd(), "extensions", scope!, local!, "package.json");
  return JSON.parse(readFileSync(file, "utf8")) as PackJson;
}

describe("a claimed type id is named by the pack that claims it", () => {
  it.each([
    ["@cinatra-ai/brand-voice:guide", "Brand Voice"],
    ["@cinatra-ai/drupal:node", "Drupal Artifacts"],
    ["@cinatra-ai/email:body", "Email Artifacts"],
    ["@cinatra-ai/email:received-reply", "Email Artifacts"],
    ["@cinatra-ai/email:recipient", "Email Artifacts"],
    ["@cinatra-ai/email:sent-email", "Email Artifacts"],
    ["@cinatra-ai/linkedin:post-draft", "LinkedIn Artifacts"],
    ["@cinatra-ai/marketing-icp:profile", "Marketing ICP"],
  ])("%s reads %s, declared", (typeId, label) => {
    expect(resolveArtifactKindLabel(typeId)).toEqual({ label, source: "declared" });
  });

  it("the LinkedIn post draft's chip reads LinkedIn Artifacts", () => {
    expect(artifactKindLabelFor("@cinatra-ai/linkedin:post-draft")).toBe("LinkedIn Artifacts");
  });
});

describe("the claims map carries the packs' own claims", () => {
  it("holds exactly the eight cross-namespace claims of the pinned packs", () => {
    expect(GENERATED_ARTIFACT_KIND_CLAIMS).toEqual(EXPECTED_CLAIMS);
  });

  it("every claim is the claiming pack's own objectTypes entry and its label its own displayName", () => {
    for (const [typeId, claimant] of Object.entries(EXPECTED_CLAIMS)) {
      const pack = readPack(claimant);
      expect(pack.name, typeId).toBe(claimant);
      const declared = (pack.cinatra.artifact?.objectTypes ?? []).map((t) => t.type);
      expect(declared, typeId).toContain(typeId);
      expect(GENERATED_ARTIFACT_KIND_LABELS[claimant], claimant).toBe(pack.cinatra.displayName);
    }
  });
});

describe("the package-id road and the unclaimed types keep today's answer", () => {
  it.each([
    ["@cinatra-ai/email", "Email"],
    ["@cinatra-ai/linkedin", "Linkedin"],
    ["@cinatra-ai/drupal", "Drupal"],
    ["@cinatra-ai/marketing-icp", "Marketing Icp"],
    ["@cinatra-ai/email@1.2.0", "Email"],
    ["@cinatra-ai/email:draft", "Email"],
  ])("%s floors to %s", (id, label) => {
    expect(resolveArtifactKindLabel(id)).toEqual({ label, source: "floor" });
  });

  it("the claiming packs' own ids read their declarations", () => {
    expect(artifactKindLabelFor("@cinatra-ai/linkedin-artifacts")).toBe("LinkedIn Artifacts");
    expect(artifactKindLabelFor("@cinatra-ai/email-artifacts")).toBe("Email Artifacts");
  });

  it("own-namespace types and an undeclared pack keep their labels", () => {
    expect(artifactKindLabelFor("@cinatra-ai/blog-idea-artifact:blog-idea")).toBe("Blog Idea");
    expect(artifactKindLabelFor("@cinatra-ai/blog-post-artifact:post")).toBe("Blog Post");
    expect(artifactKindLabelFor("@cinatra-ai/blog-image-artifact:blog-image")).toBe("Blog Image");
    expect(artifactKindLabelFor("@cinatra-ai/markdown-artifact:artifact")).toBe("Markdown");
    expect(resolveArtifactKindLabel("@acme/support-desk:case")).toEqual({
      label: "Support Desk",
      source: "floor",
    });
  });
});

describe("resolveArtifactKindLabelFrom — the pure resolver over injected maps", () => {
  const labels = {
    "@x/claimer-artifacts": "Claimer",
    "@x/owner": "Owner Declared",
  };
  const claims = {
    "@x/ns:thing": "@x/claimer-artifacts",
    "@x/owner:thing": "@x/claimer-artifacts",
    "@x/ns:silent": "@x/silent-artifacts",
  };

  it("names a claimed type id by its claimant's declaration", () => {
    expect(resolveArtifactKindLabelFrom("@x/ns:thing", labels, claims)).toEqual({
      label: "Claimer",
      source: "declared",
    });
  });

  it("the id's own package declaration wins over a claim naming another pack", () => {
    expect(resolveArtifactKindLabelFrom("@x/owner:thing", labels, claims)).toEqual({
      label: "Owner Declared",
      source: "declared",
    });
  });

  it("a bare package id whose namespace carries claims floors", () => {
    expect(resolveArtifactKindLabelFrom("@x/ns", labels, claims)).toEqual({
      label: "Ns",
      source: "floor",
    });
  });

  it("a versioned package id floors", () => {
    expect(resolveArtifactKindLabelFrom("@x/ns@1.2.0", labels, claims)).toEqual({
      label: "Ns",
      source: "floor",
    });
  });

  it("an unclaimed type id in a claimed namespace floors", () => {
    expect(resolveArtifactKindLabelFrom("@x/ns:other", labels, claims)).toEqual({
      label: "Ns",
      source: "floor",
    });
  });

  it("a claimant that declares no label floors", () => {
    expect(resolveArtifactKindLabelFrom("@x/ns:silent", labels, claims)).toEqual({
      label: "Ns",
      source: "floor",
    });
  });

  it("a padded claimed type id still finds its claim", () => {
    expect(resolveArtifactKindLabelFrom("  @x/ns:thing  ", labels, claims)).toEqual({
      label: "Claimer",
      source: "declared",
    });
  });
});
