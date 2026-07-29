/**
 * GATED upstream boundary contract test.
 *
 * Our conservative constant `ANTHROPIC_SKILL_MAX_UPLOAD_BYTES = 30,000,000`
 * (decimal MB, "under 30 MB", rejected at the boundary) is only allowed to
 * change on EVIDENCE from the real API. This test probes the true accept/reject
 * boundary of `POST /v1/skills` by uploading canonical bundles that straddle the
 * constant, then asserting the constant matches what the API actually enforces.
 *
 * It is GATED OFF by default (no live key in CI, and we never fabricate a live
 * round-trip). Run it deliberately with a real key:
 *
 *   ANTHROPIC_SKILL_BOUNDARY_LIVE=1 ANTHROPIC_API_KEY=sk-... \
 *     pnpm --filter @cinatra-ai/llm test anthropic-skill-boundary.contract
 *
 * On a green run that DISAGREES with the constant, update
 * `ANTHROPIC_SKILL_MAX_UPLOAD_BYTES` and this expectation together — that is the
 * ONLY sanctioned way the boundary constant moves.
 */
import { describe, it, expect } from "vitest";
import {
  FetchAnthropicCustomSkillsClient,
  type AnthropicSkillUpload,
} from "../tools/anthropic-custom-skills-client";
import {
  ANTHROPIC_SKILL_MAX_UPLOAD_BYTES,
  buildCanonicalSkillZip,
} from "../tools/anthropic-skill-content-hash";

const LIVE = process.env.ANTHROPIC_SKILL_BOUNDARY_LIVE === "1";
const KEY = process.env.ANTHROPIC_API_KEY ?? "";

/** Build a canonical bundle whose UNCOMPRESSED total is exactly `bytes`. */
function bundleOfUncompressedSize(bytes: number, rootDir: string): AnthropicSkillUpload {
  const skillMd = Buffer.from(`---\nname: ${rootDir}\n---\n`);
  const padLen = bytes - skillMd.length;
  const zip = buildCanonicalSkillZip({
    skillMd,
    bundledFiles: [{ relPath: "pad.bin", bytes: Buffer.alloc(Math.max(0, padLen), 0x61) }],
    rootDir,
  });
  return { displayTitle: `boundary-probe-${rootDir}`, rootDir, zipBytes: zip.zipBytes };
}

describe.skipIf(!LIVE || !KEY)("Anthropic Skills API boundary (LIVE, gated)", () => {
  it("accepts just under 30,000,000 and rejects at/over it (probes the real limit)", async () => {
    const client = new FetchAnthropicCustomSkillsClient(KEY);

    // Just under the constant should be accepted.
    const under = bundleOfUncompressedSize(ANTHROPIC_SKILL_MAX_UPLOAD_BYTES - 1_000, "boundary-under");
    await expect(client.createSkill(under)).resolves.toMatchObject({
      skillId: expect.any(String),
    });

    // At/over the constant should be rejected by the API.
    const over = bundleOfUncompressedSize(ANTHROPIC_SKILL_MAX_UPLOAD_BYTES, "boundary-over");
    await expect(client.createSkill(over)).rejects.toThrow();

    // The constant must reflect the observed limit; if this assertion fails on a
    // live run, move BOTH the constant and this expectation together.
    expect(ANTHROPIC_SKILL_MAX_UPLOAD_BYTES).toBe(30_000_000);
  });
});

// Always-present marker so the gated suite is discoverable even when skipped.
describe("Anthropic Skills API boundary (constant guard)", () => {
  it("keeps the conservative decimal-MB boundary until live evidence says otherwise", () => {
    expect(ANTHROPIC_SKILL_MAX_UPLOAD_BYTES).toBe(30_000_000);
  });
});
