// cinatra#1062 — readLlmRequirementFromMount: reads an installed agent's
// declared OAS metadata.cinatra.llm from the runtime mount, best-effort and
// non-fatal, validated through the canonical OasCinatraLlmSchema.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mount = vi.hoisted(() => ({ dir: "" }));
vi.mock("../agent-runtime-mount", () => ({
  resolveAgentRuntimeMountDir: () => mount.dir,
}));

import { readLlmRequirementFromMount } from "../read-llm-requirement-from-mount";

function writeOas(slug: string, oas: unknown): void {
  const dir = join(mount.dir, "cinatra-ai", slug, "cinatra");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "oas.json"), typeof oas === "string" ? oas : JSON.stringify(oas));
}

beforeEach(() => {
  mount.dir = mkdtempSync(join(tmpdir(), "llm-req-mount-"));
});

describe("readLlmRequirementFromMount (cinatra#1062)", () => {
  it("returns the validated metadata.cinatra.llm block for an in-repo agent", async () => {
    writeOas("media-transcript-agent", {
      component_type: "Flow",
      metadata: {
        cinatra: {
          type: "flow",
          llm: {
            preferredProvider: "gemini",
            preferredModel: "gemini-2.5-flash",
            capabilityRequired: "media_input",
          },
        },
      },
    });
    await expect(
      readLlmRequirementFromMount("@cinatra-ai/media-transcript-agent", "0.1.3"),
    ).resolves.toEqual({
      preferredProvider: "gemini",
      preferredModel: "gemini-2.5-flash",
      capabilityRequired: "media_input",
    });
  });

  it("returns undefined when the OAS declares no llm block (no signal)", async () => {
    writeOas("plain-agent", { component_type: "Flow", metadata: { cinatra: { type: "flow" } } });
    await expect(readLlmRequirementFromMount("@cinatra-ai/plain-agent", "1.0.0")).resolves.toBeUndefined();
  });

  it("returns undefined for a non-@cinatra-ai package (no mount source)", async () => {
    await expect(readLlmRequirementFromMount("@acme/thing", "1.0.0")).resolves.toBeUndefined();
  });

  it("returns undefined when the OAS file is absent (non-fatal)", async () => {
    await expect(
      readLlmRequirementFromMount("@cinatra-ai/never-installed-agent", "9.9.9"),
    ).resolves.toBeUndefined();
  });

  it("returns undefined on unreadable / non-JSON OAS (non-fatal)", async () => {
    writeOas("broken-json-agent", "{ this is not json");
    await expect(
      readLlmRequirementFromMount("@cinatra-ai/broken-json-agent", "1.0.0"),
    ).resolves.toBeUndefined();
  });

  it("returns undefined for a malformed llm block (unknown provider) rather than passing garbage through", async () => {
    writeOas("bad-llm-agent", {
      component_type: "Flow",
      metadata: { cinatra: { llm: { preferredProvider: "not-a-provider" } } },
    });
    await expect(
      readLlmRequirementFromMount("@cinatra-ai/bad-llm-agent", "1.0.0"),
    ).resolves.toBeUndefined();
  });
});
