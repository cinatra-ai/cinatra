// Unit tests for the Renovate pnpmfileChecksum repair primitive
// (scripts/ci/repair-pnpmfile-checksum.mjs). Pure cores only — no git, no pnpm,
// no IO. Guards the two invariants the repair must never break:
//   1. the checksum string is exactly what pnpm records
//      (`sha256-<base64(sha256(bytes))>`), so a repaired lockfile satisfies
//      `pnpm install --frozen-lockfile`;
//   2. the repair is surgical and idempotent — it only ever touches the single
//      `pnpmfileChecksum:` line, at pnpm's canonical position, and is a no-op on
//      an already-correct lockfile.
import { describe, expect, it } from "vitest";

import { CHECKSUM_LINE, computeChecksum, repair } from "../repair-pnpmfile-checksum.mjs";

// A minimal but structurally faithful lockfile head: overrides block, one blank
// line, then patchedDependencies — the exact shape the hosted Renovate app
// emits for this repo (checksum line absent).
const RENOVATE_HEAD = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

overrides:
  react: 19.2.7
  ioredis: 5.11.1

patchedDependencies:
  '@a2a-js/sdk@0.3.13': 47e85df1
`;

const CSUM = "sha256-deadbeef00000000000000000000000000000000000=";

describe("computeChecksum", () => {
  it("matches pnpm's sha256-base64 format for a known pnpmfile", () => {
    // Byte-for-byte the trivial pnpmfile whose checksum pnpm 11.1.2 wrote in a
    // controlled run (locks the algorithm + encoding, not just the shape).
    const pnpmfile = '"use strict";\nmodule.exports = { hooks: { readPackage(pkg){ return pkg; } } };\n';
    expect(computeChecksum(Buffer.from(pnpmfile))).toBe(
      "sha256-jkuNd+hPhQ8SrF+fAqkquZaPNXki1T3btifZdiO25X8=",
    );
  });

  it("is deterministic and prefixed", () => {
    const c = computeChecksum(Buffer.from("x"));
    expect(c).toMatch(/^sha256-[A-Za-z0-9+/]+=*$/);
    expect(computeChecksum(Buffer.from("x"))).toBe(c);
  });
});

describe("repair", () => {
  it("inserts the checksum immediately before patchedDependencies", () => {
    const { changed, reason, text } = repair(RENOVATE_HEAD, CSUM);
    expect(changed).toBe(true);
    expect(reason).toBe("inserted");
    // Canonical slot: overrides block -> blank -> checksum -> blank -> patched.
    expect(text).toContain(`  ioredis: 5.11.1\n\npnpmfileChecksum: ${CSUM}\n\npatchedDependencies:`);
    // Exactly one checksum line, and it is a top-level key.
    expect(text.match(/^pnpmfileChecksum:/gm)).toHaveLength(1);
  });

  it("is a no-op when the checksum is already correct", () => {
    const good = repair(RENOVATE_HEAD, CSUM).text;
    const again = repair(good, CSUM);
    expect(again.changed).toBe(false);
    expect(again.reason).toBe("already-correct");
    expect(again.text).toBe(good);
  });

  it("updates a stale checksum in place without moving anything else", () => {
    const good = repair(RENOVATE_HEAD, CSUM).text;
    const stale = good.replace(CSUM, "sha256-stale===");
    const fixed = repair(stale, CSUM);
    expect(fixed.changed).toBe(true);
    expect(fixed.reason).toBe("updated-stale");
    expect(fixed.text).toBe(good);
  });

  it("normalizes a stray double blank line before patchedDependencies", () => {
    const doubleBlank = RENOVATE_HEAD.replace(
      "\n\npatchedDependencies:",
      "\n\n\npatchedDependencies:",
    );
    const fixed = repair(doubleBlank, CSUM);
    expect(fixed.text).toContain(`  ioredis: 5.11.1\n\npnpmfileChecksum: ${CSUM}\n\npatchedDependencies:`);
    // No triple newline survives around the inserted key.
    expect(fixed.text).not.toContain("\n\n\n");
  });

  it("falls back to the lockfileVersion anchor when patchedDependencies is absent", () => {
    const noPatches = "lockfileVersion: '9.0'\n\nimporters:\n  .: {}\n";
    const fixed = repair(noPatches, CSUM);
    expect(fixed.changed).toBe(true);
    expect(fixed.reason).toBe("inserted-after-version");
    expect(fixed.text).toContain(`pnpmfileChecksum: ${CSUM}`);
    expect(fixed.text.startsWith("lockfileVersion: '9.0'\n")).toBe(true);
  });

  it("reports no-anchor rather than corrupting an unrecognizable lockfile", () => {
    const junk = "not a real lockfile\n";
    const fixed = repair(junk, CSUM);
    expect(fixed.changed).toBe(false);
    expect(fixed.reason).toBe("no-anchor");
    expect(fixed.text).toBe(junk);
  });

  it("CHECKSUM_LINE captures the recorded value", () => {
    expect(`pnpmfileChecksum: ${CSUM}`.match(CHECKSUM_LINE)?.[1]).toBe(CSUM);
  });
});
