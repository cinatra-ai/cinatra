// computeDevLock — the pure core of update-dev-extension-lock.mjs
// (cinatra#141). The CLI shell adds only fs/ls-remote IO; everything
// partition-shaped is decided here.
import { describe, expect, it } from "vitest";

import { computeDevLock } from "../update-dev-extension-lock.mjs";

const SHA_OLD = "0".repeat(40);
const SHA_NEW = "f".repeat(40);

const config = {
  "@cinatra-ai/nango-connector": { url: "https://github.com/cinatra-ai/nango-connector.git" },
  "@cinatra-ai/resend-connector": { url: "https://github.com/cinatra-ai/resend-connector.git" },
  "@cinatra-ai/web-research-agent": "https://github.com/cinatra-ai/web-research-agent.git", // string-form entry
};
const requiredLockNames = new Set(["@cinatra-ai/nango-connector"]);

describe("computeDevLock", () => {
  it("targets EXACTLY the non-required universe, sorted, {packageName, repo, resolvedSha} only", () => {
    const resolved = [];
    const { packages, resolvedCount, keptCount } = computeDevLock({
      config,
      requiredLockNames,
      resolveHead: ({ pkgName }) => {
        resolved.push(pkgName);
        return SHA_NEW;
      },
    });
    expect(packages.map((p) => p.packageName)).toEqual([
      "@cinatra-ai/resend-connector",
      "@cinatra-ai/web-research-agent",
    ]);
    expect(packages[0]).toEqual({
      packageName: "@cinatra-ai/resend-connector",
      repo: "cinatra-ai/resend-connector",
      resolvedSha: SHA_NEW,
    });
    expect(resolved).not.toContain("@cinatra-ai/nango-connector"); // required-lock package never re-pinned here
    expect(resolvedCount).toBe(2);
    expect(keptCount).toBe(0);
  });

  it("--select re-resolves only the selected target; others keep their existing pin", () => {
    const { packages, resolvedCount, keptCount } = computeDevLock({
      config,
      requiredLockNames,
      existingPackages: [
        { packageName: "@cinatra-ai/resend-connector", repo: "cinatra-ai/resend-connector", resolvedSha: SHA_OLD },
        { packageName: "@cinatra-ai/web-research-agent", repo: "cinatra-ai/web-research-agent", resolvedSha: SHA_OLD },
      ],
      select: ["resend-connector"], // short name accepted
      resolveHead: () => SHA_NEW,
    });
    expect(packages.find((p) => p.packageName === "@cinatra-ai/resend-connector").resolvedSha).toBe(SHA_NEW);
    expect(packages.find((p) => p.packageName === "@cinatra-ai/web-research-agent").resolvedSha).toBe(SHA_OLD);
    expect(resolvedCount).toBe(1);
    expect(keptCount).toBe(1);
  });

  it("--select is fail-closed: a token matching no non-required target throws", () => {
    expect(() =>
      computeDevLock({ config, requiredLockNames, select: ["nope-connector"], resolveHead: () => SHA_NEW }),
    ).toThrow(/matches no non-required/);
    // a required-lock package is NOT a valid selection target either:
    expect(() =>
      computeDevLock({ config, requiredLockNames, select: ["nango-connector"], resolveHead: () => SHA_NEW }),
    ).toThrow(/matches no non-required/);
  });

  it("an unselected target with NO existing pin throws (never silently unpinned)", () => {
    expect(() =>
      computeDevLock({
        config,
        requiredLockNames,
        existingPackages: [],
        select: ["resend-connector"],
        resolveHead: () => SHA_NEW,
      }),
    ).toThrow(/NO existing pin/);
  });

  it("a kept (unselected) pin whose repo no longer matches the config is refused (retarget needs a re-pin)", () => {
    expect(() =>
      computeDevLock({
        config,
        requiredLockNames,
        existingPackages: [
          // resolved against a DIFFERENT repo than config now names:
          { packageName: "@cinatra-ai/web-research-agent", repo: "cinatra-ai/old-research-agent", resolvedSha: SHA_OLD },
          { packageName: "@cinatra-ai/resend-connector", repo: "cinatra-ai/resend-connector", resolvedSha: SHA_OLD },
        ],
        select: ["resend-connector"],
        resolveHead: () => SHA_NEW,
      }),
    ).toThrow(/must be re-pinned/);
  });

  it("a kept (unselected) pin with a corrupt sha is refused (never copied forward)", () => {
    expect(() =>
      computeDevLock({
        config,
        requiredLockNames,
        existingPackages: [
          { packageName: "@cinatra-ai/web-research-agent", repo: "cinatra-ai/web-research-agent", resolvedSha: "garbage" },
          { packageName: "@cinatra-ai/resend-connector", repo: "cinatra-ai/resend-connector", resolvedSha: SHA_OLD },
        ],
        select: ["resend-connector"],
        resolveHead: () => SHA_NEW,
      }),
    ).toThrow(/not a 40-hex commit sha/);
  });

  it("a dropped config entry simply disappears from the lock (prune-by-recompute)", () => {
    const { packages } = computeDevLock({
      config: { "@cinatra-ai/resend-connector": { url: "https://github.com/cinatra-ai/resend-connector.git" } },
      requiredLockNames,
      existingPackages: [
        { packageName: "@cinatra-ai/gone-connector", repo: "cinatra-ai/gone-connector", resolvedSha: SHA_OLD },
      ],
      resolveHead: () => SHA_NEW,
    });
    expect(packages.map((p) => p.packageName)).toEqual(["@cinatra-ai/resend-connector"]);
  });

  it("a non-40-hex resolved head throws", () => {
    expect(() => computeDevLock({ config, requiredLockNames, resolveHead: () => "main" })).toThrow(/40-hex/);
  });

  it("a non-github config URL throws (the lock pins github slugs)", () => {
    expect(() =>
      computeDevLock({
        config: { "@cinatra-ai/x-connector": { url: "https://gitlab.com/x/y.git" } },
        requiredLockNames,
        resolveHead: () => SHA_NEW,
      }),
    ).toThrow(/unsupported repo URL/);
  });
});
