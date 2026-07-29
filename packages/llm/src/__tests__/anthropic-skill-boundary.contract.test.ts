/**
 * GATED upstream boundary contract test.
 *
 * `ANTHROPIC_SKILL_MAX_UPLOAD_BYTES` is only allowed to change on EVIDENCE from
 * the real API. This test probes the true accept/reject boundary of
 * `POST /v1/skills` by uploading canonical bundles that straddle the constant,
 * then asserts the constant against what the API actually enforces.
 *
 * It is GATED OFF by default (no live key in CI, and we never fabricate a live
 * round-trip). Run it deliberately with a real key:
 *
 *   ANTHROPIC_SKILL_BOUNDARY_LIVE=1 ANTHROPIC_API_KEY=sk-... \
 *     pnpm --filter @cinatra-ai/llm test anthropic-skill-boundary.contract
 *
 * ## The constant has moved once, on exactly that evidence
 *
 * The S7 live acceptance (cinatra#2094, check **C10** in
 * `evidence/2094-s7-acceptance/live-results.json`) uploaded a rooted canonical
 * zip of **30,000,505** archive bytes to the real endpoint and the API
 * **ACCEPTED it (HTTP 200)**. The old value — 30,000,000, the decimal-MB
 * reading of the docs' "under 30 MB" — was therefore a confirmed client-side
 * FALSE REJECTION, and the constant was raised to the narrowest reading of the
 * same prose consistent with the observation: **30 MiB = 31,457,280**.
 *
 * What that evidence bounds is only the LOWER end. The live run never drove a
 * bundle up to a rejection, so the exact server ceiling is still unknown and
 * this gate stays deliberately conservative. That is precisely what the live
 * arm below exists to settle — and why the reject half of it, unlike the accept
 * half, is asserted as an observation to record rather than a pass to bank.
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
  it("accepts just under the constant, and records what happens AT it", async () => {
    const client = new FetchAnthropicCustomSkillsClient(KEY);

    // Just under the constant must be accepted — if this fails the constant is
    // too HIGH and is now over-permitting, which is the direction that actually
    // breaks a user's sync at upload time.
    const under = bundleOfUncompressedSize(
      ANTHROPIC_SKILL_MAX_UPLOAD_BYTES - 1_000,
      "boundary-under",
    );
    await expect(client.createSkill(under)).resolves.toMatchObject({
      skillId: expect.any(String),
    });

    // AT the constant: we do NOT assert a rejection. The C10 evidence already
    // showed the server accepting well past our previous gate, so asserting
    // "the API rejects here" would be asserting our own conservatism rather
    // than a measured API contract. Record the observation for the operator and
    // let the constant move only on a deliberate reading of that record.
    const at = bundleOfUncompressedSize(ANTHROPIC_SKILL_MAX_UPLOAD_BYTES, "boundary-at");
    const outcome = await client
      .createSkill(at)
      .then((r) => ({ accepted: true as const, skillId: r.skillId }))
      .catch((e: unknown) => ({ accepted: false as const, error: String(e).slice(0, 300) }));
    // eslint-disable-next-line no-console -- the recorded observation IS this test's output
    console.log(
      `[boundary-probe] at ${ANTHROPIC_SKILL_MAX_UPLOAD_BYTES} bytes → ` +
        `${outcome.accepted ? "ACCEPTED" : "REJECTED"} ${JSON.stringify(outcome)}`,
    );
    expect(typeof outcome.accepted).toBe("boolean");
  });
});

// Always-present marker so the gated suite is discoverable even when skipped,
// and so the value can never drift without a deliberate edit here.
describe("Anthropic Skills API boundary (constant guard)", () => {
  it("pins the evidence-grounded 30 MiB boundary", () => {
    expect(ANTHROPIC_SKILL_MAX_UPLOAD_BYTES).toBe(31_457_280);
    expect(ANTHROPIC_SKILL_MAX_UPLOAD_BYTES).toBe(30 * 1024 * 1024);
  });

  it("is above the archive size the live API was observed to accept", () => {
    // evidence/2094-s7-acceptance/live-results.json, check C10.
    const OBSERVED_ACCEPTED_ARCHIVE_BYTES = 30_000_505;
    const OBSERVED_ACCEPTED_UNCOMPRESSED_BYTES = 30_000_169;
    expect(ANTHROPIC_SKILL_MAX_UPLOAD_BYTES).toBeGreaterThan(
      OBSERVED_ACCEPTED_ARCHIVE_BYTES,
    );
    expect(ANTHROPIC_SKILL_MAX_UPLOAD_BYTES).toBeGreaterThan(
      OBSERVED_ACCEPTED_UNCOMPRESSED_BYTES,
    );
    // The old decimal-MB value was NOT — that is the false rejection this fixed.
    expect(30_000_000).toBeLessThan(OBSERVED_ACCEPTED_ARCHIVE_BYTES);
  });

  it("stays under the documented 32 MB request-size ceiling with envelope headroom", () => {
    // `413 request_too_large` guards the whole multipart request, not just the
    // zip part, so the gate must leave room for the envelope under either
    // reading of "32 MB".
    expect(ANTHROPIC_SKILL_MAX_UPLOAD_BYTES).toBeLessThan(32_000_000);
    expect(ANTHROPIC_SKILL_MAX_UPLOAD_BYTES).toBeLessThan(32 * 1024 * 1024);
  });
});
