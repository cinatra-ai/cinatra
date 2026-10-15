/**
 * The scripted image provider: the image tool's stand-in on a credential-free
 * development stack.
 *
 * Three things are pinned here. Its resolution reads the scripted test flag and
 * the explicit development runtime that `assertScriptedProviderNotProduction`
 * enforces, and answers `null` everywhere else (a production build included).
 * It answers one constant placeholder PNG, marked as a development placeholder
 * by its provider name, its model and a tEXt comment in the bytes. And the
 * keyed image providers keep their order: `resolveDefaultImageProvider` still
 * walks only them, flag or no flag, so the scripted provider is never a member
 * of that walk.
 */
import { inflateSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";

const { surfaces, storedImageDefault } = vi.hoisted(() => ({
  surfaces: new Map<string, unknown>(),
  storedImageDefault: { value: null as string | null },
}));

vi.mock("@/lib/llm-provider-surfaces", () => ({
  getLlmProviderSurface: () => null,
  getLlmProviderAdapterSurface: (provider: string) => {
    const adapter = surfaces.get(provider);
    return adapter ? { createAdapter: async () => adapter } : null;
  },
}));
vi.mock("@/lib/database", () => ({
  readDefaultLlmProviderFromDatabase: () => "openai",
  readLlmProviderFailoverPolicyFromDatabase: () => "exact",
  readDefaultImageProviderFromDatabase: () => storedImageDefault.value,
}));
vi.mock("@/lib/external-mcp-registry", () => ({
  buildRegisteredExternalMcpServerTools: vi.fn(async () => []),
  buildSingleExternalMcpTool: vi.fn(async () => null),
}));
vi.mock("@/lib/external-mcp-toolbox-loader.server", () => ({
  loadExternalMcpToolboxBySlug: vi.fn(async () => null),
  loadExternalMcpToolboxByServerId: vi.fn(async () => null),
}));
vi.mock("../mcp-access", () => ({
  withoutReservedFirstPartyLabelTools: vi.fn((tools: unknown[]) => tools),
  buildLlmMcpServerTool: vi.fn(),
  buildExternalMcpServerTools: vi.fn(),
}));

import { resolveDefaultImageProvider } from "../registry";
import {
  SCRIPTED_PLACEHOLDER_IMAGE_MIME,
  SCRIPTED_PLACEHOLDER_IMAGE_MODEL,
  SCRIPTED_PLACEHOLDER_IMAGE_PNG_BASE64,
  resolveScriptedImageProvider,
} from "../scripted-test-provider";

const DEVELOPMENT = {
  CINATRA_TEST_LLM_PROVIDER: "scripted",
  CINATRA_RUNTIME_MODE: "development",
  NODE_ENV: "development",
};

afterEach(() => {
  surfaces.clear();
  storedImageDefault.value = null;
  vi.unstubAllEnvs();
});

describe("the scripted image provider resolves only under the flag in an explicit development runtime", () => {
  it("resolves under the flag in an explicit development runtime, as the scripted provider", () => {
    const provider = resolveScriptedImageProvider({ ...DEVELOPMENT });
    expect(provider).not.toBeNull();
    expect(provider?.provider).toBe("scripted");
  });

  it("is not resolved under a production build with the flag on, whatever the runtime mode says", () => {
    for (const mode of ["development", "production", undefined]) {
      expect(
        resolveScriptedImageProvider({
          CINATRA_TEST_LLM_PROVIDER: "scripted",
          CINATRA_RUNTIME_MODE: mode,
          NODE_ENV: "production",
        }),
      ).toBeNull();
    }
  });

  it("is not resolved with the flag off, in a development runtime or a production build", () => {
    for (const flag of [undefined, "", "1", "true", "Scripted"]) {
      for (const nodeEnv of ["development", "production"]) {
        expect(
          resolveScriptedImageProvider({
            CINATRA_TEST_LLM_PROVIDER: flag,
            CINATRA_RUNTIME_MODE: "development",
            NODE_ENV: nodeEnv,
          }),
        ).toBeNull();
      }
    }
  });

  it("is not resolved when the runtime mode is not an explicit development one", () => {
    for (const mode of [undefined, "", "production", "Development", "dev"]) {
      expect(
        resolveScriptedImageProvider({
          CINATRA_TEST_LLM_PROVIDER: "scripted",
          CINATRA_RUNTIME_MODE: mode,
          NODE_ENV: "development",
        }),
      ).toBeNull();
    }
  });

  it("refuses a picture once its runtime is no longer an explicit development one", async () => {
    const env: Record<string, string | undefined> = { ...DEVELOPMENT };
    const provider = resolveScriptedImageProvider(env);
    if (!provider) throw new Error("the provider did not resolve in a development runtime");
    env.NODE_ENV = "production";
    await expect(provider.generateImage({ prompt: "a lighthouse at dusk" })).rejects.toThrow(
      /not an explicit development runtime/,
    );
    env.NODE_ENV = "development";
    env.CINATRA_TEST_LLM_PROVIDER = "";
    await expect(provider.generateImage({ prompt: "a lighthouse at dusk" })).rejects.toThrow(
      /CINATRA_TEST_LLM_PROVIDER is not set/,
    );
  });
});

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** CRC-32 as the PNG specification defines it (polynomial 0xEDB88320). */
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

type PngChunk = { type: string; data: Buffer; crcOk: boolean };

function readChunks(png: Buffer): PngChunk[] {
  const chunks: PngChunk[] = [];
  let at = PNG_SIGNATURE.length;
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const typeAndData = png.subarray(at + 4, at + 8 + length);
    const crc = png.readUInt32BE(at + 8 + length);
    chunks.push({
      type: typeAndData.subarray(0, 4).toString("latin1"),
      data: Buffer.from(typeAndData.subarray(4)),
      crcOk: crc32(Buffer.from(typeAndData)) === crc,
    });
    at += 12 + length;
  }
  return chunks;
}

describe("the placeholder picture is a valid PNG marked as a development placeholder", () => {
  it("answers the constant placeholder as image/png under the placeholder model, whatever it is asked", async () => {
    const provider = resolveScriptedImageProvider({ ...DEVELOPMENT });
    if (!provider) throw new Error("the provider did not resolve in a development runtime");
    const first = await provider.generateImage({ prompt: "a lighthouse at dusk" });
    const second = await provider.generateImage({ prompt: "a harbour", model: "gpt-image-1" });
    for (const answer of [first, second]) {
      expect(answer).toEqual({
        imageData: SCRIPTED_PLACEHOLDER_IMAGE_PNG_BASE64,
        mimeType: "image/png",
        model: SCRIPTED_PLACEHOLDER_IMAGE_MODEL,
      });
    }
    expect(SCRIPTED_PLACEHOLDER_IMAGE_MIME).toBe("image/png");
    expect(SCRIPTED_PLACEHOLDER_IMAGE_MODEL).toMatch(/placeholder/);
  });

  it("is a well-formed PNG: signature, chunk checksums, an 8x8 greyscale header and pixel data that inflates", () => {
    const png = Buffer.from(SCRIPTED_PLACEHOLDER_IMAGE_PNG_BASE64, "base64");
    expect(png.byteLength).toBe(181);
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    const chunks = readChunks(png);
    expect(chunks.map((c) => c.type)).toEqual(["IHDR", "tEXt", "IDAT", "IEND"]);
    expect(chunks.every((c) => c.crcOk)).toBe(true);
    const ihdr = chunks[0].data;
    expect(ihdr.readUInt32BE(0)).toBe(8);
    expect(ihdr.readUInt32BE(4)).toBe(8);
    expect([...ihdr.subarray(8)]).toEqual([8, 0, 0, 0, 0]);
    // Eight rows of one filter byte and eight one-byte pixels.
    expect(inflateSync(chunks[2].data).byteLength).toBe(8 * (1 + 8));
  });

  it("carries a tEXt comment naming it a development placeholder", () => {
    const png = Buffer.from(SCRIPTED_PLACEHOLDER_IMAGE_PNG_BASE64, "base64");
    const text = readChunks(png).find((c) => c.type === "tEXt");
    const [keyword, value] = (text?.data.toString("latin1") ?? "").split("\0");
    expect(keyword).toBe("Comment");
    expect(value).toMatch(/development placeholder/);
    expect(value).toMatch(/scripted test provider/);
  });
});

function imageAdapter(provider: string) {
  return {
    provider,
    defaultModel: `${provider}-default`,
    generate: vi.fn(),
    stream: vi.fn(),
    generateImage: vi.fn(async () => ({ imageData: "x", mimeType: "image/png" })),
  };
}

function textOnlyAdapter(provider: string) {
  return { provider, defaultModel: `${provider}-default`, generate: vi.fn(), stream: vi.fn() };
}

describe("the keyed image providers keep their order with the scripted flag on", () => {
  function flagOnInDevelopment() {
    vi.stubEnv("CINATRA_TEST_LLM_PROVIDER", "scripted");
    vi.stubEnv("CINATRA_RUNTIME_MODE", "development");
    vi.stubEnv("NODE_ENV", "development");
  }

  it("picks the first image-capable keyed provider in the order openai, anthropic, gemini", async () => {
    flagOnInDevelopment();
    surfaces.set("openai", textOnlyAdapter("openai"));
    surfaces.set("anthropic", imageAdapter("anthropic"));
    surfaces.set("gemini", imageAdapter("gemini"));
    expect((await resolveDefaultImageProvider())?.provider).toBe("anthropic");

    surfaces.set("openai", imageAdapter("openai"));
    expect((await resolveDefaultImageProvider())?.provider).toBe("openai");
  });

  it("puts the stored default image provider first", async () => {
    flagOnInDevelopment();
    surfaces.set("openai", imageAdapter("openai"));
    surfaces.set("gemini", imageAdapter("gemini"));
    storedImageDefault.value = "gemini";
    expect((await resolveDefaultImageProvider())?.provider).toBe("gemini");
  });

  it("answers null with no image-capable keyed provider: the scripted provider is not a member of the keyed walk", async () => {
    flagOnInDevelopment();
    expect(await resolveDefaultImageProvider()).toBeNull();
    surfaces.set("openai", textOnlyAdapter("openai"));
    expect(await resolveDefaultImageProvider()).toBeNull();
  });
});
