/**
 * cinatra#2265 gap (a) — DRIFT PIN between the plain-Node bundle-identity twins
 * in `packages/skills/src/cli.mjs` and the canonical ones in
 * `src/lib/skill-bundle-store.ts`.
 *
 * `compileAndRegisterAgentSkillsViaPg` now records the lifecycle revision AND
 * the bundle head for the bundle it compiled, so it has to frame a manifest
 * identity the store will later recompute from those exact rows. It cannot
 * import the store (that module is `server-only` TypeScript and the walker is
 * the shared plain-Node entry), so the helpers are twins — and a twin that
 * drifts would let the CLI stamp `skill_revisions.bundle_digest` /
 * `skill_bundle_heads.bundle_digest` with an identity the store's own
 * `readCurrentSkillBundleFromDatabase` then rejects as a mismatch, failing every
 * read of that skill closed.
 *
 * This suite is intentionally pure (no DB): it compares the two implementations
 * over the same inputs, including the rejection cases.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import {
  agentSkillComputeBundleDigest,
  agentSkillNormalizeBundledRelPath,
  agentSkillBundleRevisionId,
  AGENT_SKILL_ROUTER_PATH,
  AGENT_SKILL_REVISION_PREFIX,
} from "../../../packages/skills/src/cli.mjs";
import {
  computeBundleDigest,
  normalizeBundledRelPath,
  SKILL_ROUTER_PATH,
} from "../skill-bundle-store";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const ROUTER = sha("router");
const REF = sha("reference");
const ASSET = sha("asset");

describe("cinatra#2265 gap (a): cli.mjs bundle-identity twins do not drift", () => {
  it("agrees on the canonical router path", () => {
    expect(AGENT_SKILL_ROUTER_PATH).toBe(SKILL_ROUTER_PATH);
  });

  it.each([
    "SKILL.md",
    "references/guide.md",
    "./references/guide.md",
    "references\\guide.md",
    "a/./b/c.txt",
    "nested/deep/dir/file.bin",
  ])("normalizes %s identically", (input) => {
    expect(agentSkillNormalizeBundledRelPath(input)).toBe(normalizeBundledRelPath(input));
  });

  it.each(["", "/abs/path.md", "../escape.md", "a/../../escape.md", "./", "."])(
    "rejects %s on both sides",
    (input) => {
      expect(() => agentSkillNormalizeBundledRelPath(input)).toThrow();
      expect(() => normalizeBundledRelPath(input)).toThrow();
    },
  );

  it.each([
    [[{ path: "SKILL.md", digest: ROUTER }]],
    [
      [
        { path: "SKILL.md", digest: ROUTER },
        { path: "references/guide.md", digest: REF },
      ],
    ],
    // Order-independence + normalization both feed the identity.
    [
      [
        { path: "assets/logo.png", digest: ASSET },
        { path: "./references/guide.md", digest: REF },
        { path: "SKILL.md", digest: ROUTER },
      ],
    ],
  ])("computes the same bundle digest for %#", (entries) => {
    expect(agentSkillComputeBundleDigest(entries)).toBe(computeBundleDigest(entries));
  });

  it.each([
    [[]],
    // No router.
    [[{ path: "references/guide.md", digest: REF }]],
    // Duplicate normalized path.
    [
      [
        { path: "SKILL.md", digest: ROUTER },
        { path: "./SKILL.md", digest: ROUTER },
      ],
    ],
    // Malformed digest.
    [[{ path: "SKILL.md", digest: "not-a-digest" }]],
  ])("rejects manifest %# on both sides", (entries) => {
    expect(() => agentSkillComputeBundleDigest(entries)).toThrow();
    expect(() => computeBundleDigest(entries)).toThrow();
  });

  it("mints an AUTHORITY-owned revision id — never the store's derived `bundle:` prefix", () => {
    const id = agentSkillBundleRevisionId("custom:agent-x:my-skill", ROUTER);
    expect(id.startsWith(AGENT_SKILL_REVISION_PREFIX)).toBe(true);
    expect(id.startsWith("bundle:")).toBe(false);
    // Deterministic (a re-compile of identical content re-derives it) and keyed
    // by the PAIR, so two skills with byte-identical bundles never collide.
    expect(agentSkillBundleRevisionId("custom:agent-x:my-skill", ROUTER)).toBe(id);
    expect(agentSkillBundleRevisionId("custom:agent-y:my-skill", ROUTER)).not.toBe(id);
    expect(agentSkillBundleRevisionId("custom:agent-x:my-skill", REF)).not.toBe(id);
  });
});
