// computeDivergence — the pure core of extension-pin-divergence-report.mjs
// (cinatra#141; the floating-HEAD canary's bump-cadence signal).
import { describe, expect, it } from "vitest";

import { computeDivergence } from "../extension-pin-divergence-report.mjs";

const PIN = "a".repeat(40);
const MOVED = "b".repeat(40);

const entry = (pkgName, pinnedSha = PIN) => ({
  pkgName,
  url: `https://github.com/cinatra-ai/${pkgName.split("/")[1]}.git`,
  branch: "main",
  pinnedSha,
  source: "cinatra-dev-extensions.lock.json",
});

describe("computeDivergence", () => {
  it("classifies match / diverged / unresolvable per repo", () => {
    const entries = [entry("@cinatra-ai/in-sync-connector"), entry("@cinatra-ai/moved-connector"), entry("@cinatra-ai/gone-connector")];
    const heads = {
      "@cinatra-ai/in-sync-connector": PIN,
      "@cinatra-ai/moved-connector": MOVED,
    };
    const rows = computeDivergence({
      entries,
      lsRemoteHead: ({ url }) => {
        const name = `@cinatra-ai/${url.match(/cinatra-ai\/(.+)\.git$/)[1]}`;
        if (!(name in heads)) throw new Error("ls-remote failed");
        return heads[name];
      },
    });
    expect(rows.map((r) => r.status)).toEqual(["match", "diverged", "unresolvable"]);
    expect(rows[1].headSha).toBe(MOVED);
    expect(rows[2].headSha).toBeNull();
  });

  it("treats a malformed head (not 40-hex) as unresolvable, never as a match", () => {
    const rows = computeDivergence({
      entries: [entry("@cinatra-ai/weird-connector")],
      lsRemoteHead: () => "not-a-sha",
    });
    expect(rows[0].status).toBe("unresolvable");
  });
});
