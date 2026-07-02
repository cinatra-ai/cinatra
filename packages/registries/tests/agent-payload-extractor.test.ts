// Agent payload path resolver.
//
// Unit tests for `readAgentPayloadFromExtractedPackage` (the pure local-file
// half of `extractAgentPackage`). This is the seam that fixes cinatra#579: the
// marketplace agent detail page 500'd for ALL 33 published `@cinatra-ai/*-agent`
// packages because the extractor hardcoded a root `agent.json` read, while every
// published agent ships its payload at `cinatra/oas.json`. These tests pin the
// resolution order (cinatra/oas.json → legacy root agent.json → null) so a
// payload-less tarball degrades instead of throwing ENOENT.
//
// Mirrors `readme-extractor.test.ts`: write files into a temp dir, then assert
// the pure reader's behavior — no live Verdaccio required.

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readAgentPayloadFromExtractedPackage } from "../src/verdaccio/client";

/**
 * A representative slice of a real published agent's `cinatra/oas.json` — an OAS
 * Flow document, NOT the legacy structured agent.json payload. Shaped after
 * `@cinatra-ai/blog-idea-generator-agent` and the works-after fixture.
 */
const OAS_PAYLOAD = {
  component_type: "Flow",
  id: "blog-idea-generator",
  name: "blog-idea-generator",
  description: "Generates blog post ideas.",
  metadata: {
    cinatra: {
      packageName: "@cinatra-ai/blog-idea-generator-agent",
      packageVersion: "0.1.0",
    },
  },
  inputs: [],
  outputs: [],
} as const;

const LEGACY_AGENT_PAYLOAD = {
  formatVersion: 1,
  packageName: "@legacy/agent",
  packageVersion: "0.0.1",
  title: "Legacy Agent",
} as const;

describe("readAgentPayloadFromExtractedPackage", () => {
  let workspace: string;

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "agent-payload-extractor-test-"));
  });

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("reads the payload from cinatra/oas.json (the published-agent layout)", async () => {
    // The exact failure in #579: every published agent ships cinatra/oas.json
    // and NO root agent.json. This must resolve to the OAS document.
    const pkgDir = await mkdtemp(join(workspace, "oas-"));
    await mkdir(join(pkgDir, "cinatra"), { recursive: true });
    await writeFile(
      join(pkgDir, "cinatra", "oas.json"),
      JSON.stringify(OAS_PAYLOAD),
      "utf8",
    );

    const payload = await readAgentPayloadFromExtractedPackage(pkgDir);

    expect(payload).toEqual(OAS_PAYLOAD);
  });

  it("falls back to a legacy root agent.json when no cinatra/oas.json exists", async () => {
    const pkgDir = await mkdtemp(join(workspace, "legacy-"));
    await writeFile(
      join(pkgDir, "agent.json"),
      JSON.stringify(LEGACY_AGENT_PAYLOAD),
      "utf8",
    );

    const payload = await readAgentPayloadFromExtractedPackage(pkgDir);

    expect(payload).toEqual(LEGACY_AGENT_PAYLOAD);
  });

  it("prefers cinatra/oas.json over a legacy root agent.json when both exist", async () => {
    const pkgDir = await mkdtemp(join(workspace, "both-"));
    await mkdir(join(pkgDir, "cinatra"), { recursive: true });
    await writeFile(
      join(pkgDir, "cinatra", "oas.json"),
      JSON.stringify(OAS_PAYLOAD),
      "utf8",
    );
    await writeFile(
      join(pkgDir, "agent.json"),
      JSON.stringify(LEGACY_AGENT_PAYLOAD),
      "utf8",
    );

    const payload = await readAgentPayloadFromExtractedPackage(pkgDir);

    expect(payload).toEqual(OAS_PAYLOAD);
  });

  it("returns null (does NOT throw ENOENT) when the package ships neither payload file", async () => {
    // The pre-fix bug: a payload-less tarball ENOENT'd and 500'd the whole
    // detail page. Returning null lets the read-only detail path render
    // manifest-only.
    const pkgDir = await mkdtemp(join(workspace, "none-"));
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "@x/y", version: "1.0.0" }),
      "utf8",
    );

    const payload = await readAgentPayloadFromExtractedPackage(pkgDir);

    expect(payload).toBeNull();
  });

  it("throws on a present-but-corrupt payload (a real fault, not a missing-payload degrade)", async () => {
    const pkgDir = await mkdtemp(join(workspace, "corrupt-"));
    await mkdir(join(pkgDir, "cinatra"), { recursive: true });
    await writeFile(join(pkgDir, "cinatra", "oas.json"), "{ not valid json", "utf8");

    await expect(
      readAgentPayloadFromExtractedPackage(pkgDir),
    ).rejects.toThrow();
  });
});
