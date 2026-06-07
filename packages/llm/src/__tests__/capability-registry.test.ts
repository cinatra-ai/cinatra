import { describe, expect, it } from "vitest";
import {
  resolveAttachmentCapability,
  CAPABILITY_RULES,
} from "../attachments/capability-registry";

// Capability matrix snapshot. Pure +
// deterministic. Decision A: PDF/image/text broadly ingestible; Office/
// archive NOT (no extraction path); size + unknown model/provider →
// structured reason, never a silent yes.

describe("resolveAttachmentCapability", () => {
  it("OpenAI gpt-5 ingests PDF + images → openai_input_file", () => {
    const pdf = resolveAttachmentCapability({
      provider: "openai",
      model: "gpt-5.5",
      mime: "application/pdf",
    });
    expect(pdf).toMatchObject({ ingestible: true, nativeKind: "openai_input_file" });
    const png = resolveAttachmentCapability({
      provider: "openai",
      model: "gpt-5.4",
      mime: "image/png",
    });
    expect(png.ingestible).toBe(true);
  });

  it("Anthropic claude: PDF/image/text/csv all ingestible (Decision A aligned)", () => {
    for (const mime of [
      "application/pdf",
      "image/png",
      "text/plain",
      "text/markdown",
      "text/csv",
    ]) {
      expect(
        resolveAttachmentCapability({
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          mime,
        }).ingestible,
      ).toBe(true);
    }
  });

  it("Gemini ingests audio/video; nativeKind gemini_file_data", () => {
    const v = resolveAttachmentCapability({
      provider: "gemini",
      model: "gemini-2.5-flash",
      mime: "video/mp4",
    });
    expect(v).toMatchObject({ ingestible: true, nativeKind: "gemini_file_data" });
  });

  it("Office/zip is NEVER natively ingestible (no extraction path)", () => {
    for (const provider of ["openai", "anthropic", "gemini"] as const) {
      const d = resolveAttachmentCapability({
        provider,
        model:
          provider === "openai"
            ? "gpt-5.5"
            : provider === "anthropic"
              ? "claude-sonnet-4-6"
              : "gemini-2.5-flash",
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      });
      expect(d.ingestible).toBe(false);
    }
  });

  it("oversize → structured reason; unknown provider/model → reason (never silent yes)", () => {
    const big = resolveAttachmentCapability({
      provider: "openai",
      model: "gpt-5.5",
      mime: "application/pdf",
      size: 999 * 1024 * 1024,
    });
    expect(big.ingestible).toBe(false);
    if (!big.ingestible) expect(big.reason).toMatch(/exceeds/);
    const unknown = resolveAttachmentCapability({
      provider: "openai",
      model: "some-future-model",
      mime: "application/pdf",
    });
    expect(unknown.ingestible).toBe(false);
  });

  it("registry is non-empty and every rule has a native kind", () => {
    expect(CAPABILITY_RULES.length).toBeGreaterThanOrEqual(3);
    for (const r of CAPABILITY_RULES) {
      expect(r.nativeKind).toBeTruthy();
      expect(r.maxBytes).toBeGreaterThan(0);
    }
  });
});
