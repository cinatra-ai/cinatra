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
  writeVendorOas("cinatra-ai", slug, oas);
}

function writeVendorOas(vendor: string, slug: string, oas: unknown): void {
  const dir = join(mount.dir, vendor, slug, "cinatra");
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

  it("resolves an operator/third-party-vendor agent's own mounted OAS (multi-vendor, cinatra#1196)", async () => {
    // Same slug as a first-party agent, but published under an operator vendor.
    // Pre-#1196 the `@cinatra-ai`-only regex rejected this before any read; now
    // the shared resolver derives `<mount>/marcushorndt-local/media-transcript-agent/
    // cinatra/oas.json` from the package's OWN vendor scope.
    writeVendorOas("marcushorndt-local", "media-transcript-agent", {
      component_type: "Flow",
      metadata: {
        cinatra: {
          llm: { preferredProvider: "openai", preferredModel: "gpt-5.5" },
        },
      },
    });
    await expect(
      readLlmRequirementFromMount("@marcushorndt-local/media-transcript-agent", "0.1.0"),
    ).resolves.toEqual({ preferredProvider: "openai", preferredModel: "gpt-5.5" });
  });

  it("does not cross vendors: a first-party slug does not resolve an operator's OAS", async () => {
    // Only the operator vendor's copy exists on disk; the first-party package
    // name must resolve its OWN (absent) path, not the operator's file.
    writeVendorOas("marcushorndt-local", "solo-agent", {
      component_type: "Flow",
      metadata: { cinatra: { llm: { preferredProvider: "openai" } } },
    });
    await expect(
      readLlmRequirementFromMount("@cinatra-ai/solo-agent", "0.1.0"),
    ).resolves.toBeUndefined();
  });

  it("returns undefined for an uninstalled third-party package (no mount source)", async () => {
    await expect(readLlmRequirementFromMount("@acme/thing", "1.0.0")).resolves.toBeUndefined();
  });

  it("returns undefined (fail-closed) for an unscoped/malformed package name", async () => {
    await expect(readLlmRequirementFromMount("bare-name", "1.0.0")).resolves.toBeUndefined();
    await expect(readLlmRequirementFromMount("@nope", "1.0.0")).resolves.toBeUndefined();
  });

  it("does NOT cache a MISS: a same-version package installed after a probe still resolves", async () => {
    // A pre-install probe must not pin `undefined` for the process lifetime —
    // otherwise the LLM-provider preflight fails OPEN once the package lands.
    await expect(
      readLlmRequirementFromMount("@cinatra-ai/late-install-agent", "2.0.0"),
    ).resolves.toBeUndefined();
    // Same slug + SAME version now materializes on the mount.
    writeOas("late-install-agent", {
      component_type: "Flow",
      metadata: { cinatra: { llm: { preferredProvider: "openai" } } },
    });
    await expect(
      readLlmRequirementFromMount("@cinatra-ai/late-install-agent", "2.0.0"),
    ).resolves.toEqual({ preferredProvider: "openai" });
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
