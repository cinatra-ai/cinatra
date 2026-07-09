// reconcile + registryRepoNamesFrom — the pure core of
// extension-registry-reconcile.mjs (cinatra#1120).
import { describe, expect, it, vi } from "vitest";

import { classifyOrphans, reconcile, registryRepoNamesFrom, safeLabel } from "../extension-registry-reconcile.mjs";

describe("safeLabel (log-safety / workflow-command-injection guard)", () => {
  it("passes valid GitHub repo names through unchanged", () => {
    expect(safeLabel("openai-connector")).toBe("openai-connector");
    expect(safeLabel("mcp-client-registry-connector")).toBe("mcp-client-registry-connector");
    expect(safeLabel("a.b_c-1")).toBe("a.b_c-1");
  });

  it("redacts a name that could inject a second workflow command", () => {
    expect(safeLabel("evil\n::error::pwned")).toBe("<redacted-invalid-name>");
    expect(safeLabel("evil%0A::set-output")).toBe("<redacted-invalid-name>");
    expect(safeLabel("has space")).toBe("<redacted-invalid-name>");
    expect(safeLabel("")).toBe("<redacted-invalid-name>");
  });
});

describe("registryRepoNamesFrom", () => {
  it("derives repo names from https and ssh git URLs, with/without .git", () => {
    const names = registryRepoNamesFrom({
      "@cinatra-ai/openai-connector": "https://github.com/cinatra-ai/openai-connector.git",
      "@cinatra-ai/mcp-client-connector": "https://github.com/cinatra-ai/mcp-client-registry-connector.git",
      "@cinatra-ai/obj-form": { url: "git@github.com:cinatra-ai/obj-form-connector" },
    });
    expect(names.sort()).toEqual(["mcp-client-registry-connector", "obj-form-connector", "openai-connector"]);
  });
});

describe("reconcile", () => {
  const base = {
    orgRepos: ["openai-connector", "wordpress-agent", "cinatra", "docs"],
    registryRepoNames: ["openai-connector", "wordpress-agent"],
    allowlist: ["cinatra", "docs"],
    hasExtensionKind: () => false,
  };

  it("is clean when every installable repo is registered and nothing is an orphan candidate", () => {
    const { missing, orphanCandidates } = reconcile(base);
    expect(missing).toEqual([]);
    expect(orphanCandidates).toEqual([]);
  });

  it("flags a public installable-extension repo that is unregistered and not allowlisted", () => {
    const hasExtensionKind = vi.fn((name) => name === "brand-new-connector");
    const { missing } = reconcile({
      ...base,
      orgRepos: [...base.orgRepos, "brand-new-connector"],
      hasExtensionKind,
    });
    expect(missing).toEqual(["brand-new-connector"]);
    // Only the narrow candidate set is probed (registered/allowlisted repos are not).
    expect(hasExtensionKind).not.toHaveBeenCalledWith("openai-connector");
    expect(hasExtensionKind).not.toHaveBeenCalledWith("cinatra");
  });

  it("does NOT flag an unregistered public repo that lacks cinatra.kind (e.g. plain tooling)", () => {
    const { missing } = reconcile({
      ...base,
      orgRepos: [...base.orgRepos, "some-tool"],
      hasExtensionKind: (name) => name !== "some-tool" && false, // always false here
    });
    expect(missing).toEqual([]);
  });

  it("respects the allowlist even when a candidate DOES carry cinatra.kind", () => {
    const { missing } = reconcile({
      ...base,
      orgRepos: [...base.orgRepos, "wordpress-plugin"],
      allowlist: [...base.allowlist, "wordpress-plugin"],
      hasExtensionKind: (name) => name === "wordpress-plugin", // would classify, but excluded
    });
    expect(missing).toEqual([]);
  });

  it("surfaces a registered repo absent from the public enumeration as an orphan CANDIDATE", () => {
    const { orphanCandidates } = reconcile({
      ...base,
      registryRepoNames: [...base.registryRepoNames, "deleted-connector"],
    });
    expect(orphanCandidates).toEqual(["deleted-connector"]);
  });

  it("does NOT surface a candidate for a registered repo still in the public enumeration", () => {
    const { orphanCandidates } = reconcile(base);
    expect(orphanCandidates).not.toContain("openai-connector");
  });
});

describe("classifyOrphans (log-safe orphan classification)", () => {
  it("names a GONE repo, WITHHOLDS a non-public one, ignores a public gap, and skips unknowns", () => {
    const probe = (name) =>
      ({
        "deleted-connector": "gone",
        "made-private-connector": "nonpublic",
        "missed-by-pagination": "public",
        "flaky-probe-connector": "unknown",
      })[name];
    const { gone, nonPublic, unresolved } = classifyOrphans(
      ["deleted-connector", "made-private-connector", "missed-by-pagination", "flaky-probe-connector"],
      probe,
    );
    expect(gone).toEqual(["deleted-connector"]);
    expect(nonPublic).toEqual(["made-private-connector"]); // counted; name withheld at print time
    expect(unresolved).toEqual(["flaky-probe-connector"]);
    // a "public" probe is an enumeration gap, never an orphan
    expect([...gone, ...nonPublic, ...unresolved]).not.toContain("missed-by-pagination");
  });
});
